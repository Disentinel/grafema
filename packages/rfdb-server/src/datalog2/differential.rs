//! Gate A differential harness — v1 top-down vs v2 semi-naive over the REAL dataset.
//!
//! This is the Gate A acceptance signal (plan §"Gate A conformance manifest" → Pilot):
//! the ~51 datalog guarantee rules are evaluated by BOTH engines over the SAME committed
//! snapshot of the production dogfood store, and their violation id-sets are compared
//! rule-by-rule.
//!
//! It lives as a `#[cfg(test)]` module INSIDE the crate (not in `tests/`) on purpose: the
//! v2 eval entry [`crate::datalog2::evaluate`] and the real [`LsmStorageView`] are
//! `pub(crate)` (invariant I10 — storage is reachable only through the module-private
//! `StorageView`). An external integration-test crate cannot reach them without widening
//! the v2 production surface, which Gate A forbids. The Gate A plan explicitly sanctions a
//! `#[cfg(test)]` module "if integration deps are awkward".
//!
//! Both engines read the SAME store:
//! - **v1**: [`crate::graph::GraphEngineV2`] opened on the temp copy → `&dyn GraphStore`
//!   driven through the production `violation(X)` query path (mirrors
//!   `rfdb_server::execute_check_guarantee`).
//! - **v2**: a second read-only open of the SAME temp dir as `MultiShardStore` +
//!   `ManifestStore`, captured into an [`LsmStorageView`] pinned at the published manifest
//!   version, run through [`crate::datalog2::evaluate`].
//!
//! The run is a MEASUREMENT harness: it prints a per-rule table and a tally and does NOT
//! hard-assert all-match (the run/triage stage interprets mismatches). The one hard
//! invariant it does enforce is that the harness itself produced a comparison for every
//! datalog rule it loaded — a silent zero-rule run would be a false green.

#![cfg(test)]

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::datalog::{parse_atom, parse_program, EvalLimits, Evaluator, Value};
use crate::datalog2::builtin::Stats;
use crate::datalog2::events::EventLog;
use crate::datalog2::evaluate;
use crate::datalog2::storage_glue::{LsmStorageView, StorageView};
use crate::graph::{GraphEngineV2, GraphStore};
use crate::storage_v2::manifest::ManifestStore;
use crate::storage_v2::multi_shard::MultiShardStore;

// ── Dataset / guarantees location ──────────────────────────────────

/// Absolute path to a repo-relative artifact. `CARGO_MANIFEST_DIR` is
/// `<repo>/packages/rfdb-server`, so the repo root is two levels up.
fn repo_path(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join(rel)
}

/// Recursively copy a directory tree (the on-disk `.rfdb` store) into `dst`.
///
/// Used to take the harness off the live store: the production DB carries a `LOCK` file and
/// may be held open by a running server, so we read a fresh copy to avoid contention. Only
/// regular files and directories appear in a store dir; symlinks are not produced by the
/// writer, so a plain copy is faithful.
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&from, &to)?;
        } else if ty.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

// ── Guarantee-rule extraction (datalog-only) ───────────────────────

/// One loaded guarantee: its name and the raw rule program text (which may contain several
/// `violation(X) :- …` clauses for a multi-line block-scalar body).
#[derive(Debug, Clone)]
struct DatalogRule {
    name: String,
    program: String,
}

/// Parse the `guarantees:` list out of `guarantees.yaml`, keeping only entries with
/// `check: datalog`, and surface each one's `rule:` program text.
///
/// We hand-parse the small, regular subset this file uses rather than pull in a YAML crate
/// (none is in the dependency tree). Three `rule:` value forms occur in the file and are
/// all handled:
///   - single-line single-quoted: `rule: 'violation(X) :- … .'`
///   - literal block scalar:      `rule: |` followed by indented clause lines
///   - folded block scalar:       `rule: >-` followed by indented continuation lines
///
/// A list item starts at a line whose first non-space char is `-`. Within an item we track
/// `name:` and `check:`; when we hit `rule:` we read its (possibly multi-line) value. An
/// item is emitted only if its `check` was `datalog`.
fn load_datalog_rules(yaml: &str) -> Vec<DatalogRule> {
    let lines: Vec<&str> = yaml.lines().collect();
    let mut out = Vec::new();

    // Per-item accumulators.
    let mut cur_name: Option<String> = None;
    let mut cur_check: Option<String> = None;
    let mut cur_rule: Option<String> = None;

    let indent_of = |s: &str| s.len() - s.trim_start().len();

    let flush = |out: &mut Vec<DatalogRule>,
                 name: &mut Option<String>,
                 check: &mut Option<String>,
                 rule: &mut Option<String>| {
        if check.as_deref() == Some("datalog") {
            if let (Some(n), Some(r)) = (name.clone(), rule.clone()) {
                if !r.trim().is_empty() {
                    out.push(DatalogRule {
                        name: n,
                        program: r,
                    });
                }
            }
        }
        *name = None;
        *check = None;
        *rule = None;
    };

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim_start();

        // A new list item ("- name: …" or "-\n  name: …") closes the previous one.
        let is_item_start = {
            let t = trimmed.trim_end();
            t == "-" || t.starts_with("- ")
        };
        if is_item_start {
            flush(&mut out, &mut cur_name, &mut cur_check, &mut cur_rule);
        }

        // Normalize "- key: value" to "key: value" for field detection on the item line.
        let field_line = if let Some(rest) = trimmed.strip_prefix("- ") {
            rest
        } else {
            trimmed
        };

        if let Some(rest) = field_line.strip_prefix("name:") {
            cur_name = Some(unquote_scalar(rest.trim()));
        } else if let Some(rest) = field_line.strip_prefix("check:") {
            cur_check = Some(unquote_scalar(rest.trim()));
        } else if let Some(rest) = field_line.strip_prefix("rule:") {
            let val = rest.trim();
            if val == "|" || val == "|-" || val == ">" || val == ">-" || val == "|+" || val == ">+"
            {
                // Block scalar: consume the indented body that follows.
                let folded = val.starts_with('>');
                let rule_indent = indent_of(line);
                let mut body_lines: Vec<String> = Vec::new();
                let mut j = i + 1;
                while j < lines.len() {
                    let bl = lines[j];
                    if bl.trim().is_empty() {
                        body_lines.push(String::new());
                        j += 1;
                        continue;
                    }
                    if indent_of(bl) <= rule_indent {
                        break; // dedent → end of block scalar
                    }
                    body_lines.push(bl.trim_start().to_string());
                    j += 1;
                }
                let program = if folded {
                    // Folded: join non-empty lines with spaces (blank lines → newline).
                    body_lines.join(" ")
                } else {
                    body_lines.join("\n")
                };
                cur_rule = Some(program);
                i = j;
                continue;
            } else {
                cur_rule = Some(unquote_scalar(val));
            }
        }

        i += 1;
    }
    // Flush the final item.
    flush(&mut out, &mut cur_name, &mut cur_check, &mut cur_rule);

    out
}

/// Strip YAML scalar quoting (single or double) from a one-line value. Single-quoted YAML
/// only escapes `'` as `''`; the rule bodies use no such escapes, so a quote-strip suffices.
fn unquote_scalar(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2 {
        let b = s.as_bytes();
        if (b[0] == b'\'' && b[s.len() - 1] == b'\'')
            || (b[0] == b'"' && b[s.len() - 1] == b'"')
        {
            return s[1..s.len() - 1].to_string();
        }
    }
    s.to_string()
}

// ── Per-engine evaluation ──────────────────────────────────────────

/// Run one guarantee program through the v1 top-down engine and collect the violation
/// id-set. Mirrors `rfdb_server::execute_check_guarantee` (the production `check` path):
/// parse the program, load every rule, query `violation(X)`, project `X`.
fn v1_violations(engine: &dyn GraphStore, program_src: &str) -> Result<BTreeSet<u128>, String> {
    let program = parse_program(program_src).map_err(|e| format!("v1 parse: {e}"))?;
    let violation_query =
        parse_atom("violation(X)").map_err(|e| format!("v1 query parse: {e}"))?;

    let mut evaluator = Evaluator::with_limits(engine, EvalLimits::none());
    for rule in program.rules() {
        evaluator.add_rule(rule.clone());
    }
    let bindings = evaluator.query(&violation_query)?;

    let mut ids = BTreeSet::new();
    for b in &bindings {
        if let Some(v) = b.get("X") {
            // `as_id` resolves Value::Id directly and Value::Str numerically, matching how
            // the v2 side reads its violation column.
            if let Some(id) = v.as_id() {
                ids.insert(id);
            }
        }
    }
    Ok(ids)
}

/// Run one guarantee program through the v2 semi-naive engine over the SAME snapshot and
/// collect the violation id-set. Uses the single eval entry (I8) with limits-off (the
/// dataset is small enough) and a discarding event log (the harness does not inspect the
/// trace). The `violation` facts' first column is the offending node id.
fn v2_violations(
    view: &LsmStorageView,
    stats: Stats,
    program_src: &str,
) -> Result<BTreeSet<u128>, String> {
    let eval = evaluate(view, program_src, stats, EvalLimits::none(), EventLog::discard())
        .map_err(|e| format!("v2 eval ({}): {e}", e.code()))?;

    let mut ids = BTreeSet::new();
    for row in eval.facts("violation") {
        if let Some(v) = row.first() {
            let id = match v {
                Value::Id(id) => Some(*id),
                Value::Str(s) => s.parse::<u128>().ok(),
            };
            if let Some(id) = id {
                ids.insert(id);
            }
        }
    }
    Ok(ids)
}

// ── The differential ───────────────────────────────────────────────

/// Differential: run all `check: datalog` guarantee rules through v1 and v2 over one real,
/// version-pinned snapshot of the dogfood store and compare per-rule violation id-sets.
///
/// Measurement only — prints a per-rule table and a tally; mismatches are NOT a hard
/// failure here (the run/triage stage interprets them). The only hard assertions guard the
/// harness's own integrity: the dataset opened and at least one datalog rule was compared.
// Heavy manual harness: copies the real .grafema/grafema.rfdb (100k+ nodes) and runs BOTH
// engines over every guarantee rule. Not a CI unit test. Run explicitly with:
//   cargo test --lib datalog2_differential_against_real_dataset -- --ignored --nocapture
#[test]
#[ignore = "manual real-data differential; run with --ignored"]
fn datalog2_differential_against_real_dataset() {
    let dataset = repo_path(".grafema/grafema.rfdb");
    if !dataset.join("db_config.json").exists() {
        // The real dogfood store is required for this harness. Its absence is an
        // environment problem, not a code problem: fail loudly with the looked-for path.
        panic!(
            "real dataset not found at {} (expected a MultiShardStore dir with db_config.json)",
            dataset.display()
        );
    }

    // 1. Copy the store to a fresh temp dir so we never touch the live LOCK / a running
    //    server's files.
    let tmp = tempfile::tempdir().expect("create temp dir");
    let work = tmp.path().join("grafema.rfdb");
    copy_dir_all(&dataset, &work).expect("copy real dataset into temp dir");
    // A copied LOCK file is just a 0-byte marker; remove it so a fresh open is clean.
    let _ = std::fs::remove_file(work.join("LOCK"));

    // 2a. v1 side: open the copy through the GraphStore adapter.
    let engine = GraphEngineV2::open(&work).expect("open dataset via GraphEngineV2 (v1 side)");

    // 2b. v2 side: a second, independent, read-only open of the SAME bytes, captured into a
    //     version-pinned LsmStorageView. (Two opens of the same on-disk dir are safe for
    //     read-only differential use; both observe the same published manifest version.)
    let manifest = ManifestStore::open(&work).expect("open manifest (v2 side)");
    let store = MultiShardStore::open(&work, &manifest).expect("open store (v2 side)");
    let store = Arc::new(store);
    let view = LsmStorageView::capture(store.clone(), &manifest);

    // Relation magnitudes for the v2 planner cost model, taken from the same snapshot.
    let snap = store.snapshot(&manifest);
    let total_nodes = store.find_nodes_at(&snap, None, None).len() as u64;
    let total_edges = store.iter_all_edges_at(&snap).len() as u64;
    let stats = Stats {
        total_nodes,
        total_edges,
    };

    // 3. Load the datalog guarantee rules.
    let yaml_path = repo_path(".grafema/guarantees.yaml");
    let yaml = std::fs::read_to_string(&yaml_path).expect("read guarantees.yaml");
    let rules = load_datalog_rules(&yaml);

    assert!(
        !rules.is_empty(),
        "no datalog guarantee rules loaded from {} — the harness would vacuously pass",
        yaml_path.display()
    );

    eprintln!(
        "\n=== datalog2 differential — real dataset ===\n\
         dataset (temp copy): {}\n\
         snapshot version: {} | live nodes: {} | live edges: {}\n\
         datalog rules: {}\n",
        work.display(),
        view.generation(),
        total_nodes,
        total_edges,
        rules.len(),
    );

    // 4. Per-rule comparison.
    println!(
        "{:<34} {:>9} {:>9}  {}",
        "rule", "v1_count", "v2_count", "RESULT"
    );
    println!("{}", "-".repeat(70));

    let mut matched = 0usize;
    let mut mismatched = 0usize;
    let mut v1_errors = 0usize;
    let mut v2_errors = 0usize;
    let mut both_errors = 0usize;
    // Per-rule accounting: each rule lands in exactly one bucket so the integrity guard
    // below sums to rules.len() (BOTH_ERR must not double-count v1 and v2).
    let mut compared = 0usize;

    for rule in &rules {
        compared += 1;
        let v1 = v1_violations(&engine, &rule.program);
        let v2 = v2_violations(&view, stats, &rule.program);

        match (&v1, &v2) {
            (Ok(s1), Ok(s2)) => {
                let same = s1 == s2;
                if same {
                    matched += 1;
                } else {
                    mismatched += 1;
                }
                let verdict = if same { "MATCH" } else { "MISMATCH" };
                println!(
                    "{:<34} {:>9} {:>9}  {}",
                    truncate(&rule.name, 34),
                    s1.len(),
                    s2.len(),
                    verdict
                );
                if !same {
                    // Surface the symmetric difference to make triage cheap.
                    let only_v1: Vec<&u128> = s1.difference(s2).take(5).collect();
                    let only_v2: Vec<&u128> = s2.difference(s1).take(5).collect();
                    println!(
                        "    └─ only-v1 (≤5): {:?}  only-v2 (≤5): {:?}",
                        only_v1, only_v2
                    );
                }
            }
            (Err(e1), Ok(s2)) => {
                v1_errors += 1;
                println!(
                    "{:<34} {:>9} {:>9}  {}",
                    truncate(&rule.name, 34),
                    "ERR",
                    s2.len(),
                    "V1_ERR"
                );
                println!("    └─ v1 error: {e1}");
            }
            (Ok(s1), Err(e2)) => {
                v2_errors += 1;
                println!(
                    "{:<34} {:>9} {:>9}  {}",
                    truncate(&rule.name, 34),
                    s1.len(),
                    "ERR",
                    "V2_ERR"
                );
                println!("    └─ v2 error: {e2}");
            }
            (Err(e1), Err(e2)) => {
                both_errors += 1;
                println!(
                    "{:<34} {:>9} {:>9}  {}",
                    truncate(&rule.name, 34),
                    "ERR",
                    "ERR",
                    "BOTH_ERR"
                );
                println!("    └─ v1 error: {e1}");
                println!("    └─ v2 error: {e2}");
            }
        }
    }

    println!("{}", "-".repeat(70));
    println!(
        "TALLY  rules={} match={} mismatch={} v1_err={} v2_err={} both_err={}",
        rules.len(),
        matched,
        mismatched,
        v1_errors,
        v2_errors,
        both_errors
    );
    eprintln!(
        "TALLY  rules={} match={} mismatch={} v1_err={} v2_err={} both_err={}\n",
        rules.len(),
        matched,
        mismatched,
        v1_errors,
        v2_errors,
        both_errors
    );

    // Harness-integrity guard only: a comparison ran for every rule, each landing in
    // exactly one outcome bucket. This is NOT the all-match assertion (deferred to the
    // triage stage by design).
    assert_eq!(
        matched + mismatched + v1_errors + v2_errors + both_errors,
        compared,
        "every loaded datalog rule must be compared exactly once"
    );
    assert_eq!(
        compared,
        rules.len(),
        "every loaded datalog rule must be visited"
    );
}

/// Right-pad / truncate a rule name to keep the table aligned.
fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max - 1])
    }
}

// ── Unit coverage for the YAML extractor (no dataset needed) ───────

#[cfg(test)]
mod yaml_extract_tests {
    use super::*;

    #[test]
    fn extracts_single_line_and_block_scalar_datalog_rules() {
        let yaml = r#"
guarantees:
  - name: single-line
    check: datalog
    rule: 'violation(X) :- node(X, "FUNCTION"), \+ edge(_, X, "CONTAINS").'
    severity: error

  - name: not-datalog
    check: integration-test
    test: t/x.test.js

  - name: block-literal
    description: >
      multi-clause body
    check: datalog
    rule: |
      violation(X) :- node(X, "db:query"), \+ edge(_, X, "CONTAINS").
      violation(X) :- node(X, "db:connection"), \+ edge(_, X, "CONTAINS").
    severity: error
"#;
        let rules = load_datalog_rules(yaml);
        assert_eq!(rules.len(), 2, "two datalog rules, integration-test skipped");
        assert_eq!(rules[0].name, "single-line");
        assert!(rules[0].program.contains("node(X, \"FUNCTION\")"));
        assert!(!rules[0].program.starts_with('\''), "quotes stripped");

        assert_eq!(rules[1].name, "block-literal");
        let clauses: Vec<&str> = rules[1].program.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(clauses.len(), 2, "both block-scalar clauses captured");
        assert!(rules[1].program.contains("db:query"));
        assert!(rules[1].program.contains("db:connection"));
    }
}
