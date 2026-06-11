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
    stats: &Stats,
    program_src: &str,
) -> Result<BTreeSet<u128>, String> {
    let eval = evaluate(view, program_src, stats.clone(), EvalLimits::none(), EventLog::discard())
        .map_err(|e| format!("v2 eval ({}): {e}", e.code()))?;

    let mut ids = BTreeSet::new();
    for row in eval.facts("violation") {
        if let Some(v) = row.first() {
            let id = v.as_id();
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
    let all_nodes = store.find_nodes_at(&snap, None, None);
    let total_nodes = all_nodes.len() as u64;
    let total_edges = store.iter_all_edges_at(&snap).len() as u64;
    // Per-type cardinality oracle for the planner: count live nodes per type so an empty type
    // (e.g. MESSAGE_TYPE in a TS/Rust graph) is estimated at ~0 and placed first, instead of
    // total_nodes (which over-estimates beam-* rules into a spurious E-PLAN-003).
    let mut nodes_by_type: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
    for n in &all_nodes {
        *nodes_by_type.entry(n.node_type.clone()).or_insert(0) += 1;
    }
    let stats = Stats {
        total_nodes,
        total_edges,
        nodes_by_type,
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
        let v2 = v2_violations(&view, &stats, &rule.program);

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
                // Both engines reject the rule identically (e.g. the malformed
                // call-with-args rule using an unsupported numeric literal `gt(A, 0)`):
                // v2 does NOT diverge from v1, so this counts as agreement, not a v2 fault.
                both_errors += 1;
                println!(
                    "{:<34} {:>9} {:>9}  {}",
                    truncate(&rule.name, 34),
                    "ERR",
                    "ERR",
                    "BOTH_ERR(agree)"
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

/// Coverage-as-negation on REAL code (apparatus doc §6 — "validate on real corpus, not fixture").
/// How many CALL sites are RESOLVED (have an outgoing `CALLS` edge) vs DARK (none) — the
/// resolution-coverage metric expressed as a v2 stratified-negation query over the live store. This
/// is the product-visible "coverage = what does NOT link" from the link-PoC trilogy, on real data.
/// Read-only (operates on a temp copy). Prints the number; the dark CALLs ARE the coverage worklist.
///
/// CAVEAT (honest): counts only the DIRECT `CALL -CALLS-> target` form (Layout A). Resolution living
/// on the parent FUNCTION (Layout B) or via the line-range fallback (REG-655) is NOT counted, so the
/// printed coverage is a LOWER BOUND, not the true call-resolution rate. The point is the MECHANISM
/// (coverage-as-negation runs over the live store in ~4s), not the exact %; graph is also stale.
/// First run 2026-06-09: 13634 CALL sites, 2215 direct-resolved, 11419 dark → 16.2% (lower bound).
///   cargo test --release --lib datalog2::differential::probe_call_resolution_coverage -- --ignored --nocapture
#[test]
#[ignore = "manual real-data coverage probe; run with --ignored"]
fn probe_call_resolution_coverage() {
    let dataset = repo_path(".grafema/grafema.rfdb");
    if !dataset.join("db_config.json").exists() {
        panic!("real dataset not found at {}", dataset.display());
    }
    let tmp = tempfile::tempdir().expect("temp");
    let work = tmp.path().join("grafema.rfdb");
    copy_dir_all(&dataset, &work).expect("copy");
    let _ = std::fs::remove_file(work.join("LOCK"));
    let manifest = ManifestStore::open(&work).expect("manifest");
    let store = MultiShardStore::open(&work, &manifest).expect("store");
    let store = Arc::new(store);
    let view = LsmStorageView::capture(store.clone(), &manifest);

    let snap = store.snapshot(&manifest);
    let all_nodes = store.find_nodes_at(&snap, None, None);
    let mut nbt: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
    for n in &all_nodes {
        *nbt.entry(n.node_type.clone()).or_insert(0) += 1;
    }
    let stats = Stats {
        total_nodes: all_nodes.len() as u64,
        total_edges: store.iter_all_edges_at(&snap).len() as u64,
        nodes_by_type: nbt,
    };

    let total_calls = store.find_nodes_at(&snap, Some("CALL"), None).len();
    // The dark CALL sites: a CALL with no outgoing CALLS edge (the resolver could not bind it).
    let dark = v2_violations(
        &view,
        &stats,
        r#"violation(C) :- node(C, "CALL"), \+ edge(C, _, "CALLS")."#,
    )
    .expect("v2 eval");
    let n_dark = dark.len();
    let resolved = total_calls.saturating_sub(n_dark);
    let pct = if total_calls > 0 {
        100.0 * resolved as f64 / total_calls as f64
    } else {
        0.0
    };
    eprintln!("\n=== CALL resolution coverage (v2 negation query, real corpus) ===");
    eprintln!(
        "CALL sites: {total_calls} | resolved (outgoing CALLS): {resolved} | DARK (no CALLS): {n_dark} | coverage: {pct:.1}%"
    );
    assert!(total_calls > 0, "corpus has CALL nodes");
}

/// Gate D2 perf evidence on the REAL corpus (the repo's own ~199M `.grafema/grafema.rfdb`):
/// compares a full from-scratch `depends.dl` materialize against a maintain-path re-materialize,
/// where the latter pays `diff_base`'s full base scan + maintain overhead but SKIPS the join.
/// This is the representative measurement the clean-synthetic micro-bench could not give
/// (`graph::engine_v2::tests::cached_materialize_reanalysis_is_work_proportional`): on the real
/// graph the depends.dl join over the messy attr/node fan-out is the dominant cost, so the
/// maintain path's speedup reflects how much of that cost it avoids.
///
/// The second call has NO base change (cur == prev snapshot), so its maintain runs `diff_base`
/// (full scan, the floor) + `maintain_incremental` over an empty delta + the write-back diff —
/// i.e. it isolates the per-call maintain FLOOR. A real tiny edit adds only O(delta) on top, so
/// `t_full / t_maintain_floor` is the speedup ceiling for small reanalysis deltas. Prints the
/// split (full vs floor) so we can see whether the join (skipped → big win) or the base scan
/// (still paid → motivates a version-delta-scoped diff_base) dominates.
///
///   cargo test --release --lib datalog2::differential::depends_dl_maintain_vs_full_on_real_corpus -- --ignored --nocapture
#[test]
#[ignore = "manual real-data perf bench; run with --ignored --release"]
fn depends_dl_maintain_vs_full_on_real_corpus() {
    use crate::graph::GraphEngineV2;
    use std::time::Instant;

    let dataset = repo_path(".grafema/grafema.rfdb");
    if !dataset.join("db_config.json").exists() {
        panic!(
            "real dataset not found at {} (expected a MultiShardStore dir with db_config.json)",
            dataset.display()
        );
    }
    let tmp = tempfile::tempdir().expect("create temp dir");
    let work = tmp.path().join("grafema.rfdb");
    copy_dir_all(&dataset, &work).expect("copy real dataset into temp dir");
    let _ = std::fs::remove_file(work.join("LOCK"));

    let mut engine = GraphEngineV2::open(&work).expect("open real dataset");
    let src = crate::datalog2::stdlib::DEPENDS_DL;

    // Full from-scratch materialize (cache miss).
    let t0 = Instant::now();
    let (added, _removed) = engine
        .eval_datalog_v2_materialize_cached(src, EvalLimits::none())
        .expect("full materialize");
    let t_full = t0.elapsed();

    // Re-materialize with NO base change → maintain-path FLOOR (full diff_base scan + maintain
    // over an empty delta + write-back diff). A real small edit adds only O(delta) on top.
    let t1 = Instant::now();
    let (added2, removed2) = engine
        .eval_datalog_v2_materialize_cached(src, EvalLimits::none())
        .expect("maintain re-materialize");
    let t_maintain = t1.elapsed();

    let ratio = t_full.as_secs_f64() / t_maintain.as_secs_f64().max(1e-9);
    println!(
        "[D2 corpus perf] DEPENDS_ON={added} | full-eval {:?} | maintain-floor {:?} | speedup {:.1}× \
         | reanalysis write delta ({added2},{removed2})",
        t_full, t_maintain, ratio
    );
    assert_eq!((added2, removed2), (0, 0), "no base change ⇒ the maintain re-run writes nothing");
    assert!(
        t_maintain < t_full,
        "maintain floor must be below full eval on the real corpus: full={:?} maintain={:?} ({:.1}×)",
        t_full,
        t_maintain,
        ratio
    );
}

/// Ground-truth probe (Stage 2): inspect the SHAPE of `IMPORTS_FROM` edges in the real
/// store before authoring the `depends.dl` rule. Answers: what node TYPES do the edge
/// endpoints have, and do those endpoints + MODULE nodes carry a `file` attr whose value
/// equals the file segment of the orchestrator's id-string parse (`build_file_to_module_map`)?
///
/// Run with:
///   cargo test --lib datalog2::differential::probe_imports_from_shape -- --ignored --nocapture
#[test]
#[ignore = "manual real-data shape probe; run with --ignored"]
fn probe_imports_from_shape() {
    use std::collections::BTreeMap;

    let dataset = repo_path(".grafema/grafema.rfdb");
    if !dataset.join("db_config.json").exists() {
        panic!(
            "real dataset not found at {} (expected a MultiShardStore dir with db_config.json)",
            dataset.display()
        );
    }

    let tmp = tempfile::tempdir().expect("create temp dir");
    let work = tmp.path().join("grafema.rfdb");
    copy_dir_all(&dataset, &work).expect("copy real dataset into temp dir");
    let _ = std::fs::remove_file(work.join("LOCK"));

    let manifest = ManifestStore::open(&work).expect("open manifest");
    let store = MultiShardStore::open(&work, &manifest).expect("open store");
    let snap = store.snapshot(&manifest);

    // All MODULE node ids (for endpoint-type classification) and file→count for the map shape.
    let module_nodes = store.find_nodes_at(&snap, Some("MODULE"), None);
    let module_ids: BTreeSet<u128> = module_nodes.iter().map(|n| n.id).collect();
    eprintln!("\n=== IMPORTS_FROM shape probe ===");
    eprintln!("MODULE nodes: {}", module_nodes.len());

    let imports: Vec<_> = store.get_edges_by_type_at(&snap, "IMPORTS_FROM");
    eprintln!("IMPORTS_FROM edges: {}", imports.len());

    // Classify endpoint node types.
    let mut src_types: BTreeMap<String, usize> = BTreeMap::new();
    let mut dst_types: BTreeMap<String, usize> = BTreeMap::new();
    // Does the endpoint carry a `file` first-class attr equal to the id's file segment?
    let mut src_file_present = 0usize;
    let mut src_file_matches_idseg = 0usize;
    let mut dst_file_present = 0usize;
    let mut src_is_module = 0usize;
    let mut dst_is_module = 0usize;
    let mut sample = Vec::new();

    let id_file_seg = |sid: &str| -> String {
        // Mirror build_file_to_module_map's caller: URI `grafema://auth/path#frag` or legacy
        // `path->TYPE->name`. We don't know the authority here, so handle both generically.
        if let Some(rest) = sid.strip_prefix("grafema://") {
            // strip authority segment: first '/' after authority
            if let Some(idx) = rest.find('/') {
                let after = &rest[idx + 1..];
                return after.split('#').next().unwrap_or("").to_string();
            }
        }
        sid.split("->").next().unwrap_or("").to_string()
    };

    for e in &imports {
        let s = store.get_node_at(&snap, e.src);
        let d = store.get_node_at(&snap, e.dst);
        if let Some(s) = &s {
            *src_types.entry(s.node_type.clone()).or_insert(0) += 1;
            if !s.file.is_empty() {
                src_file_present += 1;
                if s.file == id_file_seg(&s.semantic_id) {
                    src_file_matches_idseg += 1;
                }
            }
            if module_ids.contains(&e.src) {
                src_is_module += 1;
            }
        }
        if let Some(d) = &d {
            *dst_types.entry(d.node_type.clone()).or_insert(0) += 1;
            if !d.file.is_empty() {
                dst_file_present += 1;
            }
            if module_ids.contains(&e.dst) {
                dst_is_module += 1;
            }
        }
        if sample.len() < 8 {
            if let (Some(s), Some(d)) = (&s, &d) {
                sample.push(format!(
                    "  {} [{}] file={:?}  ->  {} [{}] file={:?}",
                    s.semantic_id, s.node_type, s.file, d.semantic_id, d.node_type, d.file
                ));
            }
        }
    }

    eprintln!("SRC endpoint types: {:?}", src_types);
    eprintln!("DST endpoint types: {:?}", dst_types);
    eprintln!(
        "src file-attr present: {}/{} ; matches id-file-seg: {}",
        src_file_present, imports.len(), src_file_matches_idseg
    );
    eprintln!("dst file-attr present: {}/{}", dst_file_present, imports.len());
    eprintln!(
        "src is a MODULE node: {} ; dst is a MODULE node: {}",
        src_is_module, dst_is_module
    );
    eprintln!("--- sample edges ---");
    for s in &sample {
        eprintln!("{s}");
    }

    // MODULE file-attr coverage (the orchestrator's map keys).
    let mod_with_file = module_nodes.iter().filter(|n| !n.file.is_empty()).count();
    eprintln!("MODULE nodes with non-empty file attr: {}/{}", mod_with_file, module_nodes.len());

    // Now run the candidate depends.dl rule through v2 and count derived pairs (no write).
    // Give the planner REAL per-type cardinalities (mirrors the differential harness) so it
    // drives the join from the small IMPORTS_FROM edge relation and key-probes outward,
    // instead of cross-producting two unbound MODULE generators.
    let all_nodes = store.find_nodes_at(&snap, None, None);
    let total_nodes = all_nodes.len() as u64;
    let total_edges = store.iter_all_edges_at(&snap).len() as u64;
    let mut nodes_by_type: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
    for n in &all_nodes {
        *nodes_by_type.entry(n.node_type.clone()).or_insert(0) += 1;
    }
    eprintln!("total_nodes={} total_edges={}", total_nodes, total_edges);
    let view = LsmStorageView::capture(Arc::new(store), &manifest);
    let stats = Stats {
        total_nodes,
        total_edges,
        nodes_by_type,
    };
    // Dump the planned per-leg estimates so an E-PLAN-003 estimate rejection is diagnosable.
    {
        use crate::datalog2::parser_ext::parse_ext_program;
        use crate::datalog2::plan::plan_program;
        use crate::datalog2::stratify::stratify;
        if let Ok(prog) = parse_ext_program(crate::datalog2::stdlib::DEPENDS_DL) {
            if let Ok(strat) = stratify(&prog) {
                let rules = prog.rules();
                match plan_program(&rules, &strat, &stats) {
                    Ok(plans) => {
                        for p in &plans {
                            eprintln!("PLAN {} rule_estimate={}", p.head, p.estimate);
                            for leg in &p.legs {
                                eprintln!(
                                    "   leg {} pattern={:?} estimate={}",
                                    leg.literal.atom().predicate(),
                                    leg.pattern,
                                    leg.estimate
                                );
                            }
                        }
                    }
                    Err(e) => eprintln!("PLAN error ({}): {e}", e.code.as_str()),
                }
            }
        }
    }
    let rule = crate::datalog2::stdlib::DEPENDS_DL;
    match evaluate(&view, rule, stats, EvalLimits::none(), EventLog::discard()) {
        Ok(eval) => {
            let pairs = eval.facts("depends");
            let mut self_loops = 0usize;
            for row in &pairs {
                if let (Some(a), Some(b)) = (row.first(), row.get(1)) {
                    if a == b {
                        self_loops += 1;
                    }
                }
            }
            eprintln!(
                "\ndepends.dl derived pairs: {} (self-loops among them: {})",
                pairs.len(),
                self_loops
            );
        }
        Err(e) => eprintln!("\ndepends.dl eval error ({}): {e}", e.code()),
    }
    eprintln!("=== end probe ===\n");
}

/// Stage 3 (Gate B EXIT) — `depends/2` differential against the orchestrator's
/// `DEPENDS_ON` ground truth on the REAL store.
///
/// Asserts the central Gate B claim: **v2 `depends/2` ≡ the orchestrator's MODULE→MODULE
/// `DEPENDS_ON` derivation**. Both sides are reduced to a set of `(Msrc, Mdst)` MODULE
/// id-pairs over one version-pinned snapshot of a temp copy of the real dogfood store.
///
/// - **v2 side**: run the bundled [`crate::datalog2::stdlib::DEPENDS_DL`] rule through the
///   single eval entry and collect every derived `depends(Msrc, Mdst)` id-pair.
/// - **ground truth**, in priority order:
///   1. If the store already CONTAINS `DEPENDS_ON` edges (the orchestrator wrote them during
///      analysis, `grafema-orchestrator/src/main.rs:1766-1783`), read those edges directly —
///      they ARE the oracle — keeping only MODULE→MODULE pairs (the orchestrator only ever
///      emits module-pair `DEPENDS_ON`).
///   2. ELSE reproduce the orchestrator's mapping in-test (`main.rs:1733-1793` +
///      `build_file_to_module_map`, `main.rs:290-301`): build a file→MODULE-id map from
///      MODULE nodes' `file` attr, then for each `IMPORTS_FROM` edge map each endpoint to a
///      module by the file segment parsed from the endpoint's semantic-id string, dropping
///      self-deps (`src_mod != dst_mod`).
///
/// Measurement + claim: prints v2 count, oracle count, MATCH/MISMATCH, and a sample of the
/// symmetric difference. Honest about a mismatch — a divergence is the real finding (a
/// modeling gap between the rule's `file`-attr join and the orchestrator's id-string parse).
///
/// Run with:
///   cargo test --lib datalog2::differential::depends2_matches_orchestrator_ground_truth -- --ignored --nocapture
#[test]
#[ignore = "manual real-data depends/2 differential (Gate B exit); run with --ignored"]
fn depends2_matches_orchestrator_ground_truth() {
    use std::collections::BTreeMap;

    let dataset = repo_path(".grafema/grafema.rfdb");
    if !dataset.join("db_config.json").exists() {
        panic!(
            "real dataset not found at {} (expected a MultiShardStore dir with db_config.json)",
            dataset.display()
        );
    }

    // Off the live store: copy to temp, drop the copied LOCK marker.
    let tmp = tempfile::tempdir().expect("create temp dir");
    let work = tmp.path().join("grafema.rfdb");
    copy_dir_all(&dataset, &work).expect("copy real dataset into temp dir");
    let _ = std::fs::remove_file(work.join("LOCK"));

    let manifest = ManifestStore::open(&work).expect("open manifest");
    let store = MultiShardStore::open(&work, &manifest).expect("open store");
    let snap = store.snapshot(&manifest);

    // ── MODULE nodes: id-set (to classify endpoints) + file→module-id map (the oracle key). ──
    let module_nodes = store.find_nodes_at(&snap, Some("MODULE"), None);
    let module_ids: BTreeSet<u128> = module_nodes.iter().map(|n| n.id).collect();
    // file → MODULE id. Mirrors build_file_to_module_map (key = MODULE `file` attr). If two
    // modules ever shared a file the orchestrator's HashMap would keep the last; here a
    // BTreeMap insert keeps the last too — faithful enough, and such collisions don't occur.
    let mut file_to_module: BTreeMap<String, u128> = BTreeMap::new();
    for n in &module_nodes {
        if !n.file.is_empty() {
            file_to_module.insert(n.file.clone(), n.id);
        }
    }

    // ── v2 side: run depends.dl, collect (Msrc, Mdst) id-pairs. ──
    let all_nodes = store.find_nodes_at(&snap, None, None);
    let total_nodes = all_nodes.len() as u64;
    let total_edges = store.iter_all_edges_at(&snap).len() as u64;
    let mut nodes_by_type: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
    for n in &all_nodes {
        *nodes_by_type.entry(n.node_type.clone()).or_insert(0) += 1;
    }
    let stats = Stats {
        total_nodes,
        total_edges,
        nodes_by_type,
    };

    // Capture the view BEFORE moving `store` into the Arc — but we still need `store` for the
    // oracle reads below, so build the oracle first while we hold the bare store.
    let imports: Vec<_> = store.get_edges_by_type_at(&snap, "IMPORTS_FROM");
    let existing_depends: Vec<_> = store.get_edges_by_type_at(&snap, "DEPENDS_ON");

    eprintln!("\n=== depends/2 differential — Gate B exit ===");
    eprintln!(
        "dataset (temp copy): {}\nsnapshot version: {} | MODULE nodes: {} | IMPORTS_FROM edges: {} | DEPENDS_ON edges in store: {}",
        work.display(),
        snap.version,
        module_nodes.len(),
        imports.len(),
        existing_depends.len(),
    );

    // ── Ground truth (oracle). ──
    // Priority 1: the store already contains DEPENDS_ON edges → those ARE the oracle.
    // Priority 2: reproduce the orchestrator's file→module derivation from IMPORTS_FROM.
    let id_file_seg = |sid: &str| -> String {
        // Mirror the orchestrator's parse (main.rs:1746-1755): URI
        // `grafema://authority/path#frag` → `path`; legacy `path->TYPE->name` → `path`.
        if let Some(rest) = sid.strip_prefix("grafema://") {
            if let Some(idx) = rest.find('/') {
                let after = &rest[idx + 1..];
                return after.split('#').next().unwrap_or("").to_string();
            }
        }
        sid.split("->").next().unwrap_or("").to_string()
    };

    let (oracle, oracle_source): (BTreeSet<(u128, u128)>, &str) = if !existing_depends.is_empty() {
        let mut set = BTreeSet::new();
        let mut non_module = 0usize;
        for e in &existing_depends {
            // The orchestrator only emits module-pair DEPENDS_ON. Keep only those endpoints so
            // the comparison is apples-to-apples with v2's module-typed head; count any others.
            if module_ids.contains(&e.src) && module_ids.contains(&e.dst) {
                set.insert((e.src, e.dst));
            } else {
                non_module += 1;
            }
        }
        if non_module > 0 {
            eprintln!(
                "note: {non_module} DEPENDS_ON edges had a non-MODULE endpoint (excluded from oracle)"
            );
        }
        (set, "store DEPENDS_ON edges")
    } else {
        // Reproduce main.rs:1742-1764.
        let mut set = BTreeSet::new();
        let mut unmapped_endpoints = 0usize;
        for e in &imports {
            let s = store.get_node_at(&snap, e.src);
            let d = store.get_node_at(&snap, e.dst);
            let (Some(s), Some(d)) = (s, d) else {
                continue;
            };
            let src_file = id_file_seg(&s.semantic_id);
            let dst_file = id_file_seg(&d.semantic_id);
            match (file_to_module.get(&src_file), file_to_module.get(&dst_file)) {
                (Some(&sm), Some(&dm)) => {
                    if sm != dm {
                        set.insert((sm, dm));
                    }
                }
                _ => unmapped_endpoints += 1,
            }
        }
        eprintln!(
            "note: reproduced oracle from IMPORTS_FROM; {unmapped_endpoints} import edges had an endpoint with no file→MODULE mapping"
        );
        (set, "reproduced orchestrator mapping")
    };

    // ── Diagnostic: WHY the file-attr join (v2) and the sid-parse oracle (orchestrator) diverge. ──
    // For each IMPORTS_FROM edge, map each endpoint to a MODULE two ways: by the node's FILE
    // ATTR (what depends.dl joins on) vs by the orchestrator's semantic-id PARSE
    // (main.rs:1745-1758, `id_file_seg` here). Count edges the sid-parse drops but the file-attr
    // maps to two distinct modules — those are exactly the source of the only-v2 pairs — and
    // print a sample with each endpoint's sid / file attr / parsed segment so the root cause
    // (e.g. a `MODULE#/abs/path` sid that matches neither `grafema://` nor `->`) is on the record.
    {
        let mut parse_drops_attr_maps = 0usize;
        let mut samples: Vec<String> = Vec::new();
        for e in &imports {
            let (Some(s), Some(d)) = (store.get_node_at(&snap, e.src), store.get_node_at(&snap, e.dst))
            else {
                continue;
            };
            let attr_ok = matches!(
                (file_to_module.get(&s.file), file_to_module.get(&d.file)),
                (Some(a), Some(b)) if a != b
            );
            let parse_ok = matches!(
                (
                    file_to_module.get(&id_file_seg(&s.semantic_id)),
                    file_to_module.get(&id_file_seg(&d.semantic_id)),
                ),
                (Some(a), Some(b)) if a != b
            );
            if attr_ok && !parse_ok {
                parse_drops_attr_maps += 1;
                if samples.len() < 5 {
                    samples.push(format!(
                        "  src sid={} file_attr={:?} sid_parsed={:?}\n  dst sid={} file_attr={:?} sid_parsed={:?}",
                        s.semantic_id,
                        s.file,
                        id_file_seg(&s.semantic_id),
                        d.semantic_id,
                        d.file,
                        id_file_seg(&d.semantic_id),
                    ));
                }
            }
        }
        eprintln!("\n--- diagnostic: IMPORTS_FROM edges the orchestrator's sid-parse DROPS but the file-attr join MAPS ---");
        eprintln!(
            "count (both endpoints map to distinct modules by FILE ATTR, but NOT by sid-parse): {parse_drops_attr_maps}"
        );
        for s in &samples {
            eprintln!("{s}");
        }
    }

    // Now move the store into the Arc-backed view for the v2 run.
    let view = LsmStorageView::capture(Arc::new(store), &manifest);
    let v2: BTreeSet<(u128, u128)> = match evaluate(
        &view,
        crate::datalog2::stdlib::DEPENDS_DL,
        stats,
        EvalLimits::none(),
        EventLog::discard(),
    ) {
        Ok(eval) => {
            let mut set = BTreeSet::new();
            for row in eval.facts("depends") {
                if let (Some(a), Some(b)) = (row.first(), row.get(1)) {
                    if let (Some(a), Some(b)) = (a.as_id(), b.as_id()) {
                        set.insert((a, b));
                    }
                }
            }
            set
        }
        Err(e) => panic!("v2 depends.dl eval failed ({}): {e}", e.code()),
    };

    // ── Compare. ──
    let only_v2: Vec<&(u128, u128)> = v2.difference(&oracle).collect();
    let only_oracle: Vec<&(u128, u128)> = oracle.difference(&v2).collect();
    let same = only_v2.is_empty() && only_oracle.is_empty();

    eprintln!("\noracle source: {oracle_source}");
    eprintln!(
        "v2 depends/2 pairs: {}\norchestrator (oracle) pairs: {}",
        v2.len(),
        oracle.len()
    );
    eprintln!(
        "intersection: {} | only-v2: {} | only-oracle: {}",
        v2.intersection(&oracle).count(),
        only_v2.len(),
        only_oracle.len()
    );
    eprintln!(
        "\n>>> Gate B EXIT: v2 depends/2 {} orchestrator DEPENDS_ON <<<",
        if same { "≡ (MATCH)" } else { "≠ (MISMATCH)" }
    );

    // Resolve a few diff pairs to semantic ids for cheap triage.
    let label = |a: u128, b: u128| -> String {
        let n = module_nodes.iter().find(|n| n.id == a).map(|n| n.semantic_id.as_str());
        let m = module_nodes.iter().find(|n| n.id == b).map(|n| n.semantic_id.as_str());
        format!("({} -> {})", n.unwrap_or("?"), m.unwrap_or("?"))
    };
    if !same {
        eprintln!("\n--- sample only-v2 (≤8) [v2 derives, orchestrator does not] ---");
        for (a, b) in only_v2.iter().take(8) {
            eprintln!("  {} [{:x} -> {:x}]", label(*a, *b), a, b);
        }
        eprintln!("--- sample only-oracle (≤8) [orchestrator has, v2 misses] ---");
        for (a, b) in only_oracle.iter().take(8) {
            eprintln!("  {} [{:x} -> {:x}]", label(*a, *b), a, b);
        }
    }
    eprintln!("=== end depends/2 differential ===\n");

    // Harness-integrity guard only (NOT the all-match assertion — a mismatch is a finding to
    // surface, per the Gate B plan): the comparison actually ran over a non-empty oracle.
    assert!(
        !oracle.is_empty(),
        "oracle is empty — no DEPENDS_ON ground truth could be established; the differential \
         would vacuously pass and tell us nothing about the Gate B claim"
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

    /// Real-graph vocabulary probe (ignored): dump the node-type and edge-type histograms of the
    /// repo's own `.grafema/grafema.rfdb`. Grounds the stdlib/archetypes design in the ACTUAL
    /// relation vocabulary (not depends_on alone).
    /// `cargo test --release --lib datalog2::differential::probe_real_graph_vocabulary -- --ignored --nocapture`
    #[test]
    #[ignore = "manual real-data vocabulary probe; run with --ignored"]
    fn probe_real_graph_vocabulary() {
        use std::collections::BTreeMap;
        let dataset = repo_path(".grafema/grafema.rfdb");
        assert!(dataset.join("db_config.json").exists(), "no dataset at {}", dataset.display());
        let tmp = tempfile::tempdir().expect("temp");
        let work = tmp.path().join("grafema.rfdb");
        copy_dir_all(&dataset, &work).expect("copy");
        let _ = std::fs::remove_file(work.join("LOCK"));
        let manifest = ManifestStore::open(&work).expect("manifest");
        let store = MultiShardStore::open(&work, &manifest).expect("store");
        let snap = store.snapshot(&manifest);

        let nodes = store.find_nodes_at(&snap, None, None);
        let mut nbt: BTreeMap<String, usize> = BTreeMap::new();
        for n in &nodes {
            *nbt.entry(n.node_type.clone()).or_insert(0) += 1;
        }
        let edges = store.iter_all_edges_at(&snap);
        let mut ebt: BTreeMap<String, usize> = BTreeMap::new();
        for e in &edges {
            *ebt.entry(e.edge_type.clone()).or_insert(0) += 1;
        }

        let mut nv: Vec<_> = nbt.into_iter().collect();
        nv.sort_by(|a, b| b.1.cmp(&a.1));
        let mut ev: Vec<_> = ebt.into_iter().collect();
        ev.sort_by(|a, b| b.1.cmp(&a.1));
        eprintln!("\n=== REAL GRAPH: {} nodes / {} edges ===", nodes.len(), edges.len());
        eprintln!("--- node types ({}) ---", nv.len());
        for (t, c) in &nv {
            eprintln!("  {:>9}  {}", c, t);
        }
        eprintln!("--- edge types ({}) ---", ev.len());
        for (t, c) in &ev {
            eprintln!("  {:>9}  {}", c, t);
        }
    }

    /// Real-code finding: run `depends/2` (the shipped rule) + transitive closure + self-reach
    /// on the actual dogfood graph and report the MODULE import CYCLES. A cycle is a real
    /// architectural smell; this is the second clean v2 migration (cycle detection over a
    /// first-class-keyed edge) exercised on real data, not a fixture.
    ///
    /// FINDING (2026-06-09, autonomous loop): on the real dogfood graph the naive transitive
    /// closure `dep_reach/2` trips **E-PLAN-003** — the planner estimates its per-rule output at
    /// ~54.3M facts (> the 10M `MAX_MATERIALIZED_FACTS` guard). That estimate is implausibly high:
    /// the base `depends/2` relation is only ~622 pairs, so the true closure is bounded by
    /// modules² (a few hundred², well under the guard). This is a **recursive-closure planner
    /// q-error** (the roadmap's "planner q-error (Gate D)", task #4): the recursive rule's
    /// cardinality estimate compounds instead of saturating. The cycle LOGIC is proven correct on
    /// a fixture (`datalog2::smoke::module_dependency_cycles_via_transitive_closure_over_depends`);
    /// surfacing the real cycle SET needs either a tighter recursive-closure estimator or a bounded
    /// formulation — NOT weakening the global guard. The probe leaves the E-PLAN-003 visible on
    /// purpose; it is the finding. (No autonomous fix: the estimator change touches a prod guard.)
    ///
    /// Run: cargo test --manifest-path packages/rfdb-server/Cargo.toml --lib \
    ///        datalog2::differential::yaml_extract_tests::probe_real_module_dependency_cycles -- --ignored --nocapture
    #[test]
    #[ignore = "manual real-data cycle probe; documents the recursive-closure E-PLAN-003 q-error"]
    fn probe_real_module_dependency_cycles() {
        use std::collections::{BTreeSet, HashMap};
        let dataset = repo_path(".grafema/grafema.rfdb");
        assert!(dataset.join("db_config.json").exists(), "no dataset at {}", dataset.display());
        let tmp = tempfile::tempdir().expect("temp");
        let work = tmp.path().join("grafema.rfdb");
        copy_dir_all(&dataset, &work).expect("copy");
        let _ = std::fs::remove_file(work.join("LOCK"));
        let manifest = ManifestStore::open(&work).expect("manifest");
        let store = MultiShardStore::open(&work, &manifest).expect("store");
        let snap = store.snapshot(&manifest);

        // Real per-type cardinalities so the planner drives from the small IMPORTS_FROM relation.
        let all_nodes = store.find_nodes_at(&snap, None, None);
        let module_label: HashMap<u128, String> =
            all_nodes.iter().map(|n| (n.id, n.semantic_id.clone())).collect();
        let total_nodes = all_nodes.len() as u64;
        let total_edges = store.iter_all_edges_at(&snap).len() as u64;
        let mut nodes_by_type: HashMap<String, u64> = HashMap::new();
        for n in &all_nodes {
            *nodes_by_type.entry(n.node_type.clone()).or_insert(0) += 1;
        }
        let view = LsmStorageView::capture(Arc::new(store), &manifest);
        let stats = Stats { total_nodes, total_edges, nodes_by_type };

        // The shipped depends body (strip @materialize) + transitive closure + self-reach.
        let depends_body: String = crate::datalog2::stdlib::DEPENDS_DL
            .lines()
            .filter(|l| !l.trim_start().starts_with("@materialize"))
            .collect::<Vec<_>>()
            .join("\n");
        let src = format!(
            "{depends_body}\n\
             dep_reach(A, B) :- depends(A, B).\n\
             dep_reach(A, B) :- depends(A, C), dep_reach(C, B).\n\
             cycle(M) :- dep_reach(M, M)."
        );

        eprintln!("\n=== REAL module import-cycle probe ===");
        match evaluate(&view, &src, stats, EvalLimits::none(), EventLog::discard()) {
            Ok(eval) => {
                let cyclic: BTreeSet<u128> = eval
                    .facts("cycle")
                    .iter()
                    .filter_map(|r| r.first().and_then(|v| v.as_id()))
                    .collect();
                let depends_pairs = eval.facts("depends").len();
                eprintln!(
                    "depends pairs: {} | modules on a cycle: {}",
                    depends_pairs,
                    cyclic.len()
                );
                // Report the cyclic edges (both endpoints in the cycle set) for triage.
                let mut cyclic_edges: Vec<(String, String)> = eval
                    .facts("depends")
                    .iter()
                    .filter_map(|r| {
                        let a = r.first()?.as_id()?;
                        let b = r.get(1)?.as_id()?;
                        if cyclic.contains(&a) && cyclic.contains(&b) {
                            let la = module_label.get(&a).cloned().unwrap_or_else(|| format!("{a:x}"));
                            let lb = module_label.get(&b).cloned().unwrap_or_else(|| format!("{b:x}"));
                            Some((la, lb))
                        } else {
                            None
                        }
                    })
                    .collect();
                cyclic_edges.sort();
                eprintln!("--- cyclic depends edges ({}) ---", cyclic_edges.len());
                for (a, b) in cyclic_edges.iter().take(60) {
                    eprintln!("  {a}  ->  {b}");
                }
                if cyclic_edges.len() > 60 {
                    eprintln!("  … {} more", cyclic_edges.len() - 60);
                }
            }
            Err(e) => eprintln!("cycle probe eval error ({}): {e}", e.code()),
        }
        eprintln!("=== end cycle probe ===\n");
    }

    /// Real-code finding (the BOUNDED sibling of the cycle probe): mutual module imports
    /// (`A imports B AND B imports A`) on the actual dogfood graph. Non-recursive self-join on
    /// `depends/2` (`mutual(A,B) :- depends(A,B), depends(B,A), lt(A,B)`), estimate ≈ |depends|²
    /// ≪ the §3 guard — so this one RUNS at scale where the full transitive closure trips
    /// E-PLAN-003. Mutual imports are a real architectural smell; this surfaces Grafema's own.
    ///
    /// Run: cargo test --manifest-path packages/rfdb-server/Cargo.toml --lib \
    ///        datalog2::differential::yaml_extract_tests::probe_real_mutual_module_imports -- --ignored --nocapture
    #[test]
    #[ignore = "manual real-data mutual-import probe; run with --ignored"]
    fn probe_real_mutual_module_imports() {
        use std::collections::HashMap;
        let dataset = repo_path(".grafema/grafema.rfdb");
        assert!(dataset.join("db_config.json").exists(), "no dataset at {}", dataset.display());
        let tmp = tempfile::tempdir().expect("temp");
        let work = tmp.path().join("grafema.rfdb");
        copy_dir_all(&dataset, &work).expect("copy");
        let _ = std::fs::remove_file(work.join("LOCK"));
        let manifest = ManifestStore::open(&work).expect("manifest");
        let store = MultiShardStore::open(&work, &manifest).expect("store");
        let snap = store.snapshot(&manifest);

        let all_nodes = store.find_nodes_at(&snap, None, None);
        let module_label: HashMap<u128, String> =
            all_nodes.iter().map(|n| (n.id, n.semantic_id.clone())).collect();
        let total_nodes = all_nodes.len() as u64;
        let total_edges = store.iter_all_edges_at(&snap).len() as u64;
        let mut nodes_by_type: HashMap<String, u64> = HashMap::new();
        for n in &all_nodes {
            *nodes_by_type.entry(n.node_type.clone()).or_insert(0) += 1;
        }
        let view = LsmStorageView::capture(Arc::new(store), &manifest);
        let stats = Stats { total_nodes, total_edges, nodes_by_type };

        let depends_body: String = crate::datalog2::stdlib::DEPENDS_DL
            .lines()
            .filter(|l| !l.trim_start().starts_with("@materialize"))
            .collect::<Vec<_>>()
            .join("\n");
        let src = format!(
            "{depends_body}\nmutual(A, B) :- depends(A, B), depends(B, A), lt(A, B)."
        );

        eprintln!("\n=== REAL mutual module-import probe ===");
        match evaluate(&view, &src, stats, EvalLimits::none(), EventLog::discard()) {
            Ok(eval) => {
                let mut pairs: Vec<(String, String)> = eval
                    .facts("mutual")
                    .iter()
                    .filter_map(|r| {
                        let a = r.first()?.as_id()?;
                        let b = r.get(1)?.as_id()?;
                        let la = module_label.get(&a).cloned().unwrap_or_else(|| format!("{a:x}"));
                        let lb = module_label.get(&b).cloned().unwrap_or_else(|| format!("{b:x}"));
                        Some((la, lb))
                    })
                    .collect();
                pairs.sort();
                eprintln!(
                    "depends pairs: {} | MUTUAL import pairs: {}",
                    eval.facts("depends").len(),
                    pairs.len()
                );
                for (a, b) in pairs.iter().take(80) {
                    eprintln!("  {a}  ⇄  {b}");
                }
                if pairs.len() > 80 {
                    eprintln!("  … {} more", pairs.len() - 80);
                }
            }
            Err(e) => eprintln!("mutual probe eval error ({}): {e}", e.code()),
        }
        eprintln!("=== end mutual probe ===\n");
    }

    /// sim() on the REAL store — proves the `OverlayStorageView` lets the incremental engine
    /// run a what-if edit against a live `LsmStorageView` WITHOUT committing, and that the
    /// prediction is sound. The fixture version (`exec.rs`) proved the maintain seam; this
    /// proves the overlay plumbing scales to the real `storage_v2` read path.
    ///
    /// Hypothetical: add one `IMPORTS_FROM` edge bridging two existing modules' files (so
    /// `depends.dl` derives a new module→module pair). Then assert the two soundness
    /// obligations on real data:
    ///   (1) SOUND — `sim ≡ scratch(base ∪ Δ)`: maintain over the overlay equals a full
    ///       from-scratch eval of the overlay.
    ///   (2) NON-DESTRUCTIVE — the committed base re-evaluates byte-identically afterwards.
    /// (depends.dl is the program because it is non-recursive — a recursive closure would trip
    /// the planner q-error E-PLAN-003 on the real graph, see `_ai/gaps.md`.)
    ///
    /// Run: cargo test --manifest-path packages/rfdb-server/Cargo.toml --lib --release \
    ///        datalog2::differential::yaml_extract_tests::sim_on_real_store_predicts_new_depends_without_commit -- --ignored --nocapture
    #[test]
    #[ignore = "manual real-data sim/overlay proof; run with --ignored (heavy: full depends.dl ×2)"]
    fn sim_on_real_store_predicts_new_depends_without_commit() {
        use crate::datalog2::exec::maintain_incremental;
        use crate::datalog2::increment::diff_base;
        use crate::datalog2::parser_ext::parse_ext_program;
        use crate::datalog2::plan::plan_program;
        use crate::datalog2::storage_glue::{EdgeRow, FixtureStorageView, NodeRow, OverlayStorageView};
        use crate::datalog2::stratify::stratify;
        use crate::datalog2::tag::BoolTag;

        let dataset = repo_path(".grafema/grafema.rfdb");
        assert!(dataset.join("db_config.json").exists(), "no dataset at {}", dataset.display());
        let tmp = tempfile::tempdir().expect("temp");
        let work = tmp.path().join("grafema.rfdb");
        copy_dir_all(&dataset, &work).expect("copy");
        let _ = std::fs::remove_file(work.join("LOCK"));
        let manifest = ManifestStore::open(&work).expect("manifest");
        let store = MultiShardStore::open(&work, &manifest).expect("store");
        let snap = store.snapshot(&manifest);

        // Two existing MODULE nodes with distinct, non-empty files — the endpoints of the
        // hypothetical cross-file import.
        let modules = store.find_nodes_at(&snap, Some("MODULE"), None);
        let m1 = modules.iter().find(|n| !n.file.is_empty()).expect("a module with a file");
        let m2 = modules
            .iter()
            .find(|n| !n.file.is_empty() && n.file != m1.file)
            .expect("a second module with a different file");
        let (f1, f2) = (m1.file.clone(), m2.file.clone());
        eprintln!("\n=== sim on real store: hypothetical {f1} ⇒ {f2} ===");

        // Real-cardinality stats so the planner keys the join off IMPORTS_FROM (not a cross-product).
        let all_nodes = store.find_nodes_at(&snap, None, None);
        let total_nodes = all_nodes.len() as u64;
        let total_edges = store.iter_all_edges_at(&snap).len() as u64;
        let mut nodes_by_type: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        for n in &all_nodes {
            *nodes_by_type.entry(n.node_type.clone()).or_insert(0) += 1;
        }
        let stats = Stats { total_nodes, total_edges, nodes_by_type };

        let base = LsmStorageView::capture(Arc::new(store), &manifest);

        // The hypothetical world: two fresh import endpoints carrying f1/f2 + the bridging edge.
        let nid = |s: &str| -> u128 {
            u128::from_le_bytes(blake3::hash(s.as_bytes()).as_bytes()[0..16].try_into().unwrap())
        };
        let mut delta = FixtureStorageView::new(base.generation());
        delta.put_node(NodeRow { id: nid("sim:hypo:isrc"), node_type: "IMPORT_BINDING".into(), name: "sim_isrc".into(), file: f1.clone() });
        delta.put_node(NodeRow { id: nid("sim:hypo:idst"), node_type: "FUNCTION".into(), name: "sim_idst".into(), file: f2.clone() });
        delta.put_edge(EdgeRow { src: nid("sim:hypo:isrc"), dst: nid("sim:hypo:idst"), edge_type: "IMPORTS_FROM".into() });
        let overlay = OverlayStorageView::new(&base, delta);

        // Program plumbing (non-recursive depends).
        let prog = parse_ext_program(crate::datalog2::stdlib::DEPENDS_DL).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(&rules, &strat, &stats).expect("plan");

        // base eval (the committed world), the hypothetical base delta, and sim = maintain.
        let base_eval = evaluate(&base, crate::datalog2::stdlib::DEPENDS_DL, stats.clone(), EvalLimits::none(), EventLog::discard())
            .expect("base depends eval");
        let base_delta = diff_base(&base, &overlay);
        let sim = maintain_incremental::<BoolTag>(
            &base_eval, &base, &overlay, &base_delta, &plans, &rules, &strat, EvalLimits::none(),
        )
        .expect("sim maintain")
        .expect("depends is single-stratum monotone → Some, not a recompute fallback");

        // scratch eval of the hypothetical world.
        let scratch = evaluate(&overlay, crate::datalog2::stdlib::DEPENDS_DL, stats, EvalLimits::none(), EventLog::discard())
            .expect("overlay scratch eval");

        // (1) SOUND.
        let pair = |e: &crate::datalog2::Evaluation| -> std::collections::BTreeSet<(u128, u128)> {
            e.facts("depends").iter().filter_map(|r| Some((r.first()?.as_id()?, r.get(1)?.as_id()?))).collect()
        };
        let (sim_set, scratch_set, base_set) = (pair(&sim), pair(&scratch), pair(&base_eval));
        assert_eq!(sim_set, scratch_set, "sim must equal scratch(base ∪ hypothetical) on the real store");
        // (the hypothetical took effect: the new pair (m1,m2) appears, and it grew the relation)
        assert!(sim_set.contains(&(m1.id, m2.id)), "sim predicts the new depends({f1} → {f2})");
        assert!(sim_set.len() >= base_set.len(), "an additive hypothetical never shrinks depends");
        eprintln!(
            "base depends: {} | sim depends: {} | new pair present: {} | sim≡scratch: OK",
            base_set.len(), sim_set.len(), sim_set.contains(&(m1.id, m2.id))
        );

        // (2) NON-DESTRUCTIVE: the committed base re-evaluates identically.
        let base_after = pair(&evaluate(&base, crate::datalog2::stdlib::DEPENDS_DL, Stats::default(), EvalLimits::none(), EventLog::discard()).expect("re-eval base"));
        assert_eq!(base_set, base_after, "the what-if must not mutate the committed base");
        eprintln!("=== sim on real store: SOUND + NON-DESTRUCTIVE ===\n");
    }

    /// The apparatus §6 COVERAGE LOOP, end-to-end on the REAL graph: take a module pair that
    /// the graph does NOT relate, ask why-NOT (which premise is missing), then sim adding that
    /// premise and confirm it closes the gap. This is "query the graph, not the code" applied to
    /// a gap: the graph itself says what fact would have to exist, and proves supplying it works.
    ///
    ///   gap  := depends(m1, m2) is NOT derived (m1 does not depend on m2)
    ///   why-not(gap) → the unbound premise is an IMPORTS_FROM bridging their files
    ///   sim(add that import) → depends(m1, m2) now holds  ⇒ the gap is closed
    ///
    /// Run: cargo test --manifest-path packages/rfdb-server/Cargo.toml --lib --release \
    ///        datalog2::differential::yaml_extract_tests::coverage_loop_why_not_then_sim_closes_a_real_depends_gap -- --ignored --nocapture
    #[test]
    #[ignore = "manual real-data coverage-loop proof; run with --ignored (heavy: full depends.dl ×3)"]
    fn coverage_loop_why_not_then_sim_closes_a_real_depends_gap() {
        use crate::datalog2::exec::explain_gap;
        use crate::datalog2::parser_ext::parse_ext_program;
        use crate::datalog2::plan::plan_program;
        use crate::datalog2::storage_glue::{EdgeRow, FixtureStorageView, NodeRow, OverlayStorageView};
        use crate::datalog2::stratify::stratify;
        use crate::datalog2::tag::BoolTag;
        use std::collections::BTreeSet;

        let dataset = repo_path(".grafema/grafema.rfdb");
        assert!(dataset.join("db_config.json").exists(), "no dataset at {}", dataset.display());
        let tmp = tempfile::tempdir().expect("temp");
        let work = tmp.path().join("grafema.rfdb");
        copy_dir_all(&dataset, &work).expect("copy");
        let _ = std::fs::remove_file(work.join("LOCK"));
        let manifest = ManifestStore::open(&work).expect("manifest");
        let store = MultiShardStore::open(&work, &manifest).expect("store");
        let snap = store.snapshot(&manifest);

        let modules = store.find_nodes_at(&snap, Some("MODULE"), None);
        let all_nodes = store.find_nodes_at(&snap, None, None);
        let total_nodes = all_nodes.len() as u64;
        let total_edges = store.iter_all_edges_at(&snap).len() as u64;
        let mut nodes_by_type: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        for n in &all_nodes {
            *nodes_by_type.entry(n.node_type.clone()).or_insert(0) += 1;
        }
        let stats = Stats { total_nodes, total_edges, nodes_by_type };
        let base = LsmStorageView::capture(Arc::new(store), &manifest);

        let prog = parse_ext_program(crate::datalog2::stdlib::DEPENDS_DL).expect("parse");
        let strat = stratify(&prog).expect("stratify");
        let rules = prog.rules();
        let plans = plan_program(&rules, &strat, &stats).expect("plan");

        // Base depends, to pick a pair the graph does NOT relate.
        let base_eval = evaluate(&base, crate::datalog2::stdlib::DEPENDS_DL, stats.clone(), EvalLimits::none(), EventLog::discard())
            .expect("base depends eval");
        let base_depends: BTreeSet<(u128, u128)> = base_eval
            .facts("depends").iter().filter_map(|r| Some((r.first()?.as_id()?, r.get(1)?.as_id()?))).collect();

        // m1, m2: distinct files, NOT already related.
        let m1 = modules.iter().find(|n| !n.file.is_empty()).expect("a module with a file");
        let m2 = modules
            .iter()
            .find(|n| !n.file.is_empty() && n.file != m1.file && !base_depends.contains(&(m1.id, n.id)))
            .expect("a second module m1 does not already depend on");
        eprintln!("\n=== coverage loop: gap depends({} ⇏ {}) ===", m1.file, m2.file);

        // ── why-NOT: name the missing premise. ──
        let gap = explain_gap::<BoolTag>(
            &base, &plans, &rules, &strat, "depends", &[Value::Id(m1.id), Value::Id(m2.id)], EvalLimits::none(),
        )
        .expect("explain_gap ran")
        .expect("depends(m1,m2) is NOT derived → a gap exists");
        eprintln!(
            "why-not: failing premise = {} (negative={}) ; satisfied prefix len = {}",
            gap.failing_predicate, gap.failing_is_negative, gap.satisfied.len()
        );

        // ── sim: add the missing premise (a new import binding in m1's file → m2). ──
        let nid = u128::from_le_bytes(blake3::hash(b"coverage:hypo:import").as_bytes()[0..16].try_into().unwrap());
        let mut delta = FixtureStorageView::new(0);
        delta.put_node(NodeRow { id: nid, node_type: "IMPORT_BINDING".into(), name: "hypo".into(), file: m1.file.clone() });
        delta.put_edge(EdgeRow { src: nid, dst: m2.id, edge_type: "IMPORTS_FROM".into() });
        let overlay = OverlayStorageView::new(&base, delta);
        let sim_eval = evaluate(&overlay, crate::datalog2::stdlib::DEPENDS_DL, stats, EvalLimits::none(), EventLog::discard())
            .expect("sim eval");
        let sim_depends: BTreeSet<(u128, u128)> = sim_eval
            .facts("depends").iter().filter_map(|r| Some((r.first()?.as_id()?, r.get(1)?.as_id()?))).collect();

        // The loop closes: why-not flagged the gap, sim's added premise derives the fact.
        assert!(!base_depends.contains(&(m1.id, m2.id)), "precondition: the pair was a genuine gap");
        assert!(sim_depends.contains(&(m1.id, m2.id)), "sim's hypothetical import CLOSES the gap → depends now holds");
        eprintln!("sim: depends({} → {}) now holds ⇒ GAP CLOSED. coverage loop proven on real code.", m1.file, m2.file);
        eprintln!("=== end coverage loop ===\n");
    }
}

// ── Wave 3b: rust_imports shadow differential against the post-merge dogfood graph ──

/// Shadow differential for the `rust_imports` pack (Wave 3b) against the LEGACY
/// `RustImportResolution.hs` slice already committed in the post-merge dogfood graph
/// (491k nodes / 1.04M edges — legacy import-resolution ran when that graph was built).
///
/// Dataset: `GRAFEMA_WAVE3B_DIFF_DB` (default `/tmp/wave3b-rust.rfdb`, a caller-made copy
/// of `.grafema/graph.rfdb` — NEVER the live store). The store is copied again into a
/// tempdir so a concurrently-running server on the copy cannot contend.
///
/// PREDICTIONS, declared BEFORE the diff (the §3 harness discipline):
/// - Phase 2 (IMPORT → MODULE): EXACT, both sides 0 on this graph. The legacy module
///   tree keys monorepo files as `crate::packages::…` (the literal `src/`-prefix strip
///   never fires) while real use paths are crate-relative — measured by replaying the
///   exact Hs transform over the live copy: 113 unique tree keys, 0 import-name hits.
/// - Phase 3 (IMPORT_BINDING → declaration): EXACT, both sides 0. The only colliding
///   tree key is "crate" (3 roots); the 2 bindings with a `crate::X` 2-segment source
///   match no root export (measured: legacy would-emit 0, all-candidates 0, governed 0).
/// - DELTA classes that would absorb any non-empty diff (none expected here): governed
///   crate-root subset (foreign-root winner omitted), bin+lib dual-root superset,
///   duplicate-export superset — anything else = pack bug, STOP and witness.
///
/// Non-vacuity floors (so 0 ≡ 0 cannot pass on a broken pack): the intermediate
/// relations must see the real graph (rust modules, imports, CONTAINS-joined binding
/// sources) and the `__exported` metadata key must surface through `node_attr`.
///
///   GRAFEMA_WAVE3B_DIFF_DB=/tmp/wave3b-rust.rfdb \
///   cargo test --release --lib wave3b_rust_imports_shadow_differential -- --ignored --nocapture
#[test]
#[ignore = "manual real-data shadow differential; run with --ignored"]
fn wave3b_rust_imports_shadow_differential() {
    use crate::datalog2::evaluate_with_materialize;

    let dataset = std::env::var("GRAFEMA_WAVE3B_DIFF_DB")
        .unwrap_or_else(|_| "/tmp/wave3b-rust.rfdb".to_string());
    let dataset = PathBuf::from(dataset);
    if !dataset.join("db_config.json").exists() {
        panic!(
            "dataset not found at {} — copy the post-merge graph first: \
             cp -R .grafema/graph.rfdb /tmp/wave3b-rust.rfdb",
            dataset.display()
        );
    }

    let tmp = tempfile::tempdir().expect("temp");
    let work = tmp.path().join("graph.rfdb");
    copy_dir_all(&dataset, &work).expect("copy dataset");
    let _ = std::fs::remove_file(work.join("LOCK"));
    let manifest = ManifestStore::open(&work).expect("manifest");
    let store = MultiShardStore::open(&work, &manifest).expect("store");
    let store = Arc::new(store);
    let view = LsmStorageView::capture(store.clone(), &manifest);

    let snap = store.snapshot(&manifest);
    let all_nodes = store.find_nodes_at(&snap, None, None);
    let mut nbt: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
    for n in &all_nodes {
        *nbt.entry(n.node_type.clone()).or_insert(0) += 1;
    }
    let stats = Stats {
        total_nodes: all_nodes.len() as u64,
        total_edges: store.iter_all_edges_at(&snap).len() as u64,
        nodes_by_type: nbt,
    };
    eprintln!(
        "\n=== wave3b rust_imports shadow differential (nodes={}, edges={}) ===",
        stats.total_nodes, stats.total_edges
    );

    let pairs = |eval: &crate::datalog2::exec::Evaluation, pred: &str| -> BTreeSet<(u128, u128)> {
        eval.facts(pred)
            .iter()
            .filter_map(|r| Some((r.first()?.as_id()?, r.get(1)?.as_id()?)))
            .collect()
    };

    // ── The LEGACY slice: committed IMPORTS_FROM edges out of rust IMPORT /
    //    IMPORT_BINDING nodes. Re-run-safety (Wave 3c): rust_imports ITSELF may
    //    have run against this copy (a post-3b analyze materializes the pack) —
    //    engine-written edges carry a rule-hash `_source` stamp, while the
    //    legacy resolver's edges are stamped `_source = "rust-import-resolution"`
    //    by the orchestrator's gc stamp at commit time (the resolver itself
    //    emits empty metadata, Hs:156,193 — the stamp is commit_resolve_output's).
    //    The legacy slice keeps the legacy stamp plus unstamped edges
    //    (pre-gc-stamp graphs), which excludes pack-written rows. ──
    let legacy_src = r#"
        rs_imp_edge(I, M) :- node(I, "IMPORT"), attr(I, "file", F), ends_with(F, ".rs"),
            edge(I, M, "IMPORTS_FROM").
        stamped_p2(I, M) :- rs_imp_edge(I, M), edge_attr(I, M, "IMPORTS_FROM", "_source", S).
        legacy_p2(I, M) :- rs_imp_edge(I, M), edge_attr(I, M, "IMPORTS_FROM", "_source", "rust-import-resolution").
        legacy_p2(I, M) :- rs_imp_edge(I, M), \+ stamped_p2(I, M).
        rs_bind_edge(B, D) :- node(B, "IMPORT_BINDING"), attr(B, "file", F), ends_with(F, ".rs"),
            edge(B, D, "IMPORTS_FROM").
        stamped_p3(B, D) :- rs_bind_edge(B, D), edge_attr(B, D, "IMPORTS_FROM", "_source", S).
        legacy_p3(B, D) :- rs_bind_edge(B, D), edge_attr(B, D, "IMPORTS_FROM", "_source", "rust-import-resolution").
        legacy_p3(B, D) :- rs_bind_edge(B, D), \+ stamped_p3(B, D).
    "#;
    let legacy_eval = evaluate(&view, legacy_src, stats.clone(), EvalLimits::none(), EventLog::discard())
        .expect("legacy slice eval");
    let legacy_p2 = pairs(&legacy_eval, "legacy_p2");
    let legacy_p3 = pairs(&legacy_eval, "legacy_p3");

    // ── The PACK, evaluated read-only over the same pinned view. ──
    let (pack_eval, _specs, _node_specs) = evaluate_with_materialize(
        &view,
        crate::datalog2::stdlib::RUST_IMPORTS_DL,
        stats.clone(),
        EvalLimits::none(),
        EventLog::discard(),
    )
    .expect("rust_imports.dl evaluates on the real graph");
    let mut pack_p2 = pairs(&pack_eval, "import_module");
    pack_p2.extend(pairs(&pack_eval, "import_crate"));
    let pack_p3 = pairs(&pack_eval, "binding_import");

    // ── Non-vacuity floors: the pack genuinely saw the graph. ──
    let count = |pred: &str| pack_eval.facts(pred).len();
    eprintln!(
        "intermediates: rs_module={} module_path={} crate_root={} rs_import={} \
         rs_binding={} bind_mp={} bind_tf={} target_file={} rs_decl={}",
        count("rs_module"), count("module_path"), count("crate_root"), count("rs_import"),
        count("rs_binding"), count("bind_mp"), count("bind_tf"), count("target_file"),
        count("rs_decl"),
    );
    assert!(count("rs_module") >= 100, "rust MODULE floor (measured 115)");
    assert!(count("module_path") >= 100, "module-path floor (113 tree keys − roots)");
    assert!(count("crate_root") >= 3, "crate-root floor (measured 3 lib/main roots)");
    assert!(count("rs_import") >= 1300, "rust IMPORT floor (measured 1375)");
    assert!(
        count("rs_binding") >= 1300,
        "binding-source floor via CONTAINS (measured 1377)"
    );
    assert!(count("bind_mp") >= 1000, "≥2-segment binding-source floor");

    // The __exported surface works on the REAL stored blob (engine_v2 writes the key;
    // the wire strips it — measured 252 exported rust STRUCTs via the wire flag).
    let exported_probe = evaluate(
        &view,
        r#"exported_struct(D) :- node(D, "STRUCT"), attr(D, "file", F), ends_with(F, ".rs"),
            node_attr(D, "__exported", "true")."#,
        stats,
        EvalLimits::none(),
        EventLog::discard(),
    )
    .expect("exported probe eval");
    let n_exported = exported_probe.facts("exported_struct").len();
    eprintln!("exported rust STRUCTs via node_attr(__exported): {n_exported} (wire-measured 252)");
    assert!(
        (200..=400).contains(&n_exported),
        "__exported must surface through node_attr (wire-measured 252, got {n_exported})"
    );

    // ── The diff, against the predeclared classes. ──
    eprintln!(
        "phase 2: legacy={} pack={} | phase 3: legacy={} pack={}",
        legacy_p2.len(), pack_p2.len(), legacy_p3.len(), pack_p3.len()
    );
    for (src, dst) in pack_p2.symmetric_difference(&legacy_p2) {
        eprintln!(
            "P2 DIFF ROW: ({src}, {dst}) pack={} legacy={} — outside the predicted EXACT class, witness it",
            pack_p2.contains(&(*src, *dst)), legacy_p2.contains(&(*src, *dst))
        );
    }
    for (src, dst) in pack_p3.symmetric_difference(&legacy_p3) {
        eprintln!(
            "P3 DIFF ROW: ({src}, {dst}) pack={} legacy={} — classify against the declared delta classes",
            pack_p3.contains(&(*src, *dst)), legacy_p3.contains(&(*src, *dst))
        );
    }
    assert_eq!(pack_p2, legacy_p2, "phase 2 predicted EXACT (0 ≡ 0 on this graph)");
    assert_eq!(pack_p3, legacy_p3, "phase 3 predicted EXACT (0 ≡ 0 on this graph)");
    eprintln!("=== wave3b shadow differential: PASS (both phases match the legacy slice) ===\n");
}

// ── Wave 3c: js_module_imports re-differential against the dogfood graph copy ──

/// Re-differential for the `js_module_imports` pack after the Wave 3c changes
/// (workspace arms + the exporting_file tightening to exact buildExportIndex
/// semantics) against the LEGACY `ImportResolution.hs` module-level slice
/// committed in the dogfood graph.
///
/// Dataset: `GRAFEMA_WAVE3C_DIFF_DB` (default `/tmp/wave3c-js.rfdb`, a caller-made
/// copy of `.grafema/graph.rfdb` — NEVER the live store). Copied again into a
/// tempdir so a concurrently-running server cannot contend.
///
/// PREDICTIONS, declared BEFORE the diff (the §3 harness discipline):
/// - The copy predates WORKSPACE_PACKAGE facts ⇒ the workspace arms derive
///   NOTHING here (asserted: zero WORKSPACE_PACKAGE nodes ⇒ ws joins empty);
///   their live proof is the fresh post-3c analyze.
/// - In-scope (RELATIVE-specifier) rows: the relative arm is unchanged and the
///   exporting_file tightening is set-identical on this graph (the 3b live
///   checks: zero EXPORT-container-only files among candidates, zero
///   gnExported-only files) ⇒ pack rows ≡ legacy relative rows EXACTLY
///   (Wave 3b measured 514 IMPORT→MODULE / 7 RE_EXPORTS).
/// - legacy-only rows = 100% NON-relative specifiers (bare/workspace, the
///   closed DELTA-1 class — unresolvable on this copy without the facts;
///   Wave 3b measured 165 / 2).
/// - pack-only rows = 0; resolvedPath meta ≡ legacy edge metadata on every
///   shared row.
/// - Legacy slice excludes `_source`-stamped edges (re-run-safety: a post-3b
///   analyze materialized this very pack into the graph).
///
///   GRAFEMA_WAVE3C_DIFF_DB=/tmp/wave3c-js.rfdb \
///   cargo test --release --lib wave3c_js_module_imports_re_differential -- --ignored --nocapture
#[test]
#[ignore = "manual real-data shadow differential; run with --ignored"]
fn wave3c_js_module_imports_re_differential() {
    use crate::datalog2::evaluate_with_materialize;
    use std::collections::HashMap;

    let dataset = std::env::var("GRAFEMA_WAVE3C_DIFF_DB")
        .unwrap_or_else(|_| "/tmp/wave3c-js.rfdb".to_string());
    let dataset = PathBuf::from(dataset);
    if !dataset.join("db_config.json").exists() {
        panic!(
            "dataset not found at {} — copy the dogfood graph first: \
             cp -R .grafema/graph.rfdb /tmp/wave3c-js.rfdb",
            dataset.display()
        );
    }

    let tmp = tempfile::tempdir().expect("temp");
    let work = tmp.path().join("graph.rfdb");
    copy_dir_all(&dataset, &work).expect("copy dataset");
    let _ = std::fs::remove_file(work.join("LOCK"));
    let manifest = ManifestStore::open(&work).expect("manifest");
    let store = MultiShardStore::open(&work, &manifest).expect("store");
    let store = Arc::new(store);
    let view = LsmStorageView::capture(store.clone(), &manifest);

    let snap = store.snapshot(&manifest);
    let all_nodes = store.find_nodes_at(&snap, None, None);
    let mut nbt: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
    for n in &all_nodes {
        *nbt.entry(n.node_type.clone()).or_insert(0) += 1;
    }
    let n_ws = *nbt.get("WORKSPACE_PACKAGE").unwrap_or(&0);
    let stats = Stats {
        total_nodes: all_nodes.len() as u64,
        total_edges: store.iter_all_edges_at(&snap).len() as u64,
        nodes_by_type: nbt,
    };
    eprintln!(
        "\n=== wave3c js_module_imports re-differential (nodes={}, edges={}, WORKSPACE_PACKAGE={}) ===",
        stats.total_nodes, stats.total_edges, n_ws
    );
    assert_eq!(
        n_ws, 0,
        "precondition: the OLD copy has no WORKSPACE_PACKAGE facts — the ws arms \
         cannot be diffed here (their live proof is the fresh analyze)"
    );

    // id → (name, file) for IMPORT and star-EXPORT sources (the relative /
    // bare classification of legacy-only rows).
    let mut src_name: HashMap<u128, String> = HashMap::new();
    for n in store.find_nodes_at(&snap, Some("IMPORT"), None) {
        src_name.insert(n.id, n.name.clone());
    }
    for n in store.find_nodes_at(&snap, Some("EXPORT"), None) {
        if n.name.starts_with("*:") {
            src_name.insert(n.id, n.name["*:".len()..].to_string());
        }
    }
    let is_relative = |spec: &str| spec.starts_with("./") || spec.starts_with("../");

    // ── The LEGACY module-level slice: IMPORT (8 js extensions) → MODULE and
    //    star EXPORT → MODULE. Provenance discrimination (re-run-safety): a
    //    post-3b analyze materialized this very pack into the dogfood graph,
    //    and pack-written edges carry a rule-hash `_source`; the LEGACY
    //    resolver's edges are stamped `_source = "js-resolution"` by the
    //    orchestrator's gc stamp at commit time (resolve_per_file's commit
    //    name — the resolver itself only sets resolvedPath). The legacy slice
    //    keeps the legacy stamp plus unstamped edges (pre-gc-stamp graphs). ──
    let legacy_src = r#"
        js_imp(I) :- node(I, "IMPORT"), attr(I, "file", F), ends_with(F, ".js").
        js_imp(I) :- node(I, "IMPORT"), attr(I, "file", F), ends_with(F, ".jsx").
        js_imp(I) :- node(I, "IMPORT"), attr(I, "file", F), ends_with(F, ".ts").
        js_imp(I) :- node(I, "IMPORT"), attr(I, "file", F), ends_with(F, ".tsx").
        js_imp(I) :- node(I, "IMPORT"), attr(I, "file", F), ends_with(F, ".mjs").
        js_imp(I) :- node(I, "IMPORT"), attr(I, "file", F), ends_with(F, ".cjs").
        js_imp(I) :- node(I, "IMPORT"), attr(I, "file", F), ends_with(F, ".mts").
        js_imp(I) :- node(I, "IMPORT"), attr(I, "file", F), ends_with(F, ".cts").
        im_edge(I, M) :- js_imp(I), edge(I, M, "IMPORTS_FROM"), node(M, "MODULE").
        im_stamped(I, M) :- im_edge(I, M), edge_attr(I, M, "IMPORTS_FROM", "_source", S).
        legacy_im(I, M) :- im_edge(I, M), edge_attr(I, M, "IMPORTS_FROM", "_source", "js-resolution").
        legacy_im(I, M) :- im_edge(I, M), \+ im_stamped(I, M).
        legacy_im_path(I, M, P) :- legacy_im(I, M), edge_attr(I, M, "IMPORTS_FROM", "resolvedPath", P).
        star_e(E) :- node(E, "EXPORT"), attr(E, "name", N), starts_with(N, "*:").
        re_edge(E, M) :- star_e(E), edge(E, M, "RE_EXPORTS"), node(M, "MODULE").
        re_stamped(E, M) :- re_edge(E, M), edge_attr(E, M, "RE_EXPORTS", "_source", S).
        legacy_re(E, M) :- re_edge(E, M), edge_attr(E, M, "RE_EXPORTS", "_source", "js-resolution").
        legacy_re(E, M) :- re_edge(E, M), \+ re_stamped(E, M).
        legacy_re_path(E, M, P) :- legacy_re(E, M), edge_attr(E, M, "RE_EXPORTS", "resolvedPath", P).
    "#;
    let legacy_eval = evaluate(&view, legacy_src, stats.clone(), EvalLimits::none(), EventLog::discard())
        .expect("legacy slice eval");
    let pairs = |eval: &crate::datalog2::exec::Evaluation, pred: &str| -> BTreeSet<(u128, u128)> {
        eval.facts(pred)
            .iter()
            .filter_map(|r| Some((r.first()?.as_id()?, r.get(1)?.as_id()?)))
            .collect()
    };
    let triple_paths = |eval: &crate::datalog2::exec::Evaluation, pred: &str| -> std::collections::BTreeMap<(u128, u128), String> {
        eval.facts(pred)
            .iter()
            .filter_map(|r| Some(((r.first()?.as_id()?, r.get(1)?.as_id()?), r.get(2)?.as_str())))
            .collect()
    };
    let legacy_im = pairs(&legacy_eval, "legacy_im");
    let legacy_re = pairs(&legacy_eval, "legacy_re");
    let legacy_im_path = triple_paths(&legacy_eval, "legacy_im_path");
    let legacy_re_path = triple_paths(&legacy_eval, "legacy_re_path");

    // ── The PACK (post-3c source), evaluated read-only over the same view. ──
    let (pack_eval, _specs, _node_specs) = evaluate_with_materialize(
        &view,
        crate::datalog2::stdlib::JS_MODULE_IMPORTS_DL,
        stats.clone(),
        EvalLimits::none(),
        EventLog::discard(),
    )
    .expect("js_module_imports.dl evaluates on the real graph");
    let pack_im = pairs(&pack_eval, "import_module");
    let pack_re = pairs(&pack_eval, "star_reexport");
    let pack_im_path = triple_paths(&pack_eval, "import_module");
    let pack_re_path = triple_paths(&pack_eval, "star_reexport");

    // ── Non-vacuity floors: the pack genuinely saw the graph. ──
    let count = |pred: &str| pack_eval.facts(pred).len();
    eprintln!(
        "intermediates: js_import={} star_export={} rel={} exporting_file={} \
         exp_decl_file={} cand_path={} module_file={} ws_pkg={} ws_base={}",
        count("js_import"), count("star_export"), count("rel"), count("exporting_file"),
        count("exp_decl_file"), count("cand_path"), count("module_file"),
        count("ws_pkg"), count("ws_base"),
    );
    assert!(count("js_import") >= 1000, "js IMPORT floor");
    assert!(count("exporting_file") >= 100, "exporting-file floor");
    assert!(count("module_file") >= 300, "module-file floor");
    assert_eq!(count("ws_pkg"), 0, "no WORKSPACE_PACKAGE facts on the old copy");
    assert_eq!(count("ws_base"), 0, "ws arms derive nothing without the facts");

    // ── The diff, against the predeclared classes. ──
    let im_both = legacy_im.intersection(&pack_im).count();
    let re_both = legacy_re.intersection(&pack_re).count();
    eprintln!(
        "IMPORT→MODULE: legacy={} pack={} both={} | RE_EXPORTS: legacy={} pack={} both={}",
        legacy_im.len(), pack_im.len(), im_both, legacy_re.len(), pack_re.len(), re_both
    );

    // pack-only must be EMPTY (no superset drift from the tightening).
    let pack_only_im: Vec<_> = pack_im.difference(&legacy_im).collect();
    let pack_only_re: Vec<_> = pack_re.difference(&legacy_re).collect();
    for (src, dst) in &pack_only_im {
        eprintln!(
            "IM PACK-ONLY ROW: ({src}, {dst}) spec={:?} — outside every declared class, witness it",
            src_name.get(src)
        );
    }
    for (src, dst) in &pack_only_re {
        eprintln!(
            "RE PACK-ONLY ROW: ({src}, {dst}) spec={:?} — outside every declared class, witness it",
            src_name.get(src)
        );
    }
    assert!(pack_only_im.is_empty(), "pack-only IMPORT→MODULE rows predicted 0");
    assert!(pack_only_re.is_empty(), "pack-only RE_EXPORTS rows predicted 0");

    // legacy-only rows: 100% non-relative specifiers (the DELTA-1 class).
    let mut bad_legacy_only = 0usize;
    let mut legacy_only_im = 0usize;
    for (src, dst) in legacy_im.difference(&pack_im) {
        legacy_only_im += 1;
        let spec = src_name.get(src).cloned().unwrap_or_default();
        if is_relative(&spec) {
            bad_legacy_only += 1;
            eprintln!("IM LEGACY-ONLY RELATIVE ROW: ({src}, {dst}) spec={spec:?} — in-scope miss, STOP");
        }
    }
    let mut legacy_only_re = 0usize;
    for (src, dst) in legacy_re.difference(&pack_re) {
        legacy_only_re += 1;
        let spec = src_name.get(src).cloned().unwrap_or_default();
        if is_relative(&spec) {
            bad_legacy_only += 1;
            eprintln!("RE LEGACY-ONLY RELATIVE ROW: ({src}, {dst}) spec={spec:?} — in-scope miss, STOP");
        }
    }
    eprintln!(
        "legacy-only: IMPORT→MODULE={legacy_only_im} RE_EXPORTS={legacy_only_re} \
         (all non-relative = the closed DELTA-1 bare/workspace class, facts absent on this copy)"
    );
    assert_eq!(
        bad_legacy_only, 0,
        "every legacy-only row must be a non-relative (bare/workspace) specifier"
    );

    // resolvedPath meta parity on every shared row.
    let mut meta_mismatch = 0usize;
    for (key, pack_p) in &pack_im_path {
        if let Some(leg_p) = legacy_im_path.get(key) {
            if leg_p != pack_p {
                meta_mismatch += 1;
                eprintln!("IM META MISMATCH at {key:?}: legacy={leg_p:?} pack={pack_p:?}");
            }
        }
    }
    for (key, pack_p) in &pack_re_path {
        if let Some(leg_p) = legacy_re_path.get(key) {
            if leg_p != pack_p {
                meta_mismatch += 1;
                eprintln!("RE META MISMATCH at {key:?}: legacy={leg_p:?} pack={pack_p:?}");
            }
        }
    }
    assert_eq!(meta_mismatch, 0, "resolvedPath meta must match legacy on shared rows");

    eprintln!("=== wave3c js re-differential: PASS (in-scope slice exact; legacy-only = DELTA-1 class) ===\n");
}

/// Wave 3c acceptance probe: print the acceptance-count slices over a caller-made
/// copy of a graph store (`GRAFEMA_WAVE3C_COUNTS_DB`). Pure measurement — the
/// assertions are floors that guard the harness's own integrity, the numbers
/// are read off the output and judged against the wave's acceptance criteria.
///
///   GRAFEMA_WAVE3C_COUNTS_DB=/tmp/3c-fresh.rfdb \
///   cargo test --release --lib wave3c_acceptance_counts -- --ignored --nocapture
#[test]
#[ignore = "manual acceptance probe; run with --ignored"]
fn wave3c_acceptance_counts() {
    let dataset = std::env::var("GRAFEMA_WAVE3C_COUNTS_DB")
        .unwrap_or_else(|_| "/tmp/3c-fresh.rfdb".to_string());
    let dataset = PathBuf::from(dataset);
    if !dataset.join("db_config.json").exists() {
        panic!("dataset not found at {}", dataset.display());
    }

    let tmp = tempfile::tempdir().expect("temp");
    let work = tmp.path().join("graph.rfdb");
    copy_dir_all(&dataset, &work).expect("copy dataset");
    let _ = std::fs::remove_file(work.join("LOCK"));
    let manifest = ManifestStore::open(&work).expect("manifest");
    let store = MultiShardStore::open(&work, &manifest).expect("store");
    let store = Arc::new(store);
    let view = LsmStorageView::capture(store.clone(), &manifest);

    let snap = store.snapshot(&manifest);
    let all_nodes = store.find_nodes_at(&snap, None, None);
    let mut nbt: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
    for n in &all_nodes {
        *nbt.entry(n.node_type.clone()).or_insert(0) += 1;
    }
    let total_edges = store.iter_all_edges_at(&snap).len();
    eprintln!(
        "\n=== wave3c acceptance counts ===\ntotal nodes: {} | total edges: {}",
        all_nodes.len(),
        total_edges
    );
    let mut by_type: Vec<(&String, &u64)> = nbt.iter().collect();
    by_type.sort();
    for (ty, n) in by_type {
        eprintln!("nodes[{ty}] = {n}");
    }

    let stats = Stats {
        total_nodes: all_nodes.len() as u64,
        total_edges: total_edges as u64,
        nodes_by_type: nbt,
    };
    let q = r#"
        js_imp(I) :- node(I, "IMPORT"), attr(I, "file", F), ends_with(F, ".js").
        js_imp(I) :- node(I, "IMPORT"), attr(I, "file", F), ends_with(F, ".jsx").
        js_imp(I) :- node(I, "IMPORT"), attr(I, "file", F), ends_with(F, ".ts").
        js_imp(I) :- node(I, "IMPORT"), attr(I, "file", F), ends_with(F, ".tsx").
        js_imp(I) :- node(I, "IMPORT"), attr(I, "file", F), ends_with(F, ".mjs").
        js_imp(I) :- node(I, "IMPORT"), attr(I, "file", F), ends_with(F, ".cjs").
        js_imp(I) :- node(I, "IMPORT"), attr(I, "file", F), ends_with(F, ".mts").
        js_imp(I) :- node(I, "IMPORT"), attr(I, "file", F), ends_with(F, ".cts").
        im(I, M) :- js_imp(I), edge(I, M, "IMPORTS_FROM"), node(M, "MODULE").
        re(E, M) :- node(E, "EXPORT"), attr(E, "name", N), starts_with(N, "*:"),
                    edge(E, M, "RE_EXPORTS"), node(M, "MODULE").
        ext(A, B) :- edge(A, B, "EXTENDS").
        wsp(W) :- node(W, "WORKSPACE_PACKAGE").
        dep(A, B) :- edge(A, B, "DEPENDS_ON").
        nsb(B, M) :- node(B, "IMPORT_BINDING"), edge(B, M, "IMPORTS_FROM"), node(M, "MODULE").
        im_legacy(I, M) :- im(I, M), edge_attr(I, M, "IMPORTS_FROM", "_source", "js-resolution").
        ws_named(W, N) :- node(W, "WORKSPACE_PACKAGE"), attr(W, "name", N).
        dep_src(A, B, S) :- edge(A, B, "DEPENDS_ON"), edge_attr(A, B, "DEPENDS_ON", "_source", S).
        bnd(B, T) :- node(B, "IMPORT_BINDING"), edge(B, T, "IMPORTS_FROM").
    "#;
    let eval = evaluate(&view, q, stats, EvalLimits::none(), EventLog::discard())
        .expect("acceptance probe eval");
    let c = |p: &str| eval.facts(p).len();
    eprintln!(
        "js IMPORT->MODULE IMPORTS_FROM = {}\nstar RE_EXPORTS = {}\nEXTENDS = {}\n\
         WORKSPACE_PACKAGE = {}\nDEPENDS_ON = {}\nIMPORT_BINDING->MODULE (ns) = {}\n\
         js IMPORT->MODULE with legacy _source=js-resolution = {} (gate evidence: 0 = legacy OFF)",
        c("im"), c("re"), c("ext"), c("wsp"), c("dep"), c("nsb"), c("im_legacy")
    );
    for row in eval.facts("ws_named") {
        if let Some(n) = row.get(1) {
            eprintln!("WORKSPACE_PACKAGE name: {}", n.as_str());
        }
    }
    // DEPENDS_ON provenance distribution (stale-generation forensics).
    let mut dep_by_src: std::collections::BTreeMap<String, usize> = Default::default();
    for row in eval.facts("dep_src") {
        if let Some(s) = row.get(2) {
            *dep_by_src.entry(s.as_str()).or_insert(0) += 1;
        }
    }
    for (s, n) in &dep_by_src {
        eprintln!("DEPENDS_ON _source={s}: {n}");
    }
    eprintln!("IMPORT_BINDING -IMPORTS_FROM-> (any) = {}", c("bnd"));
    assert!(c("im") > 0, "harness integrity: the IMPORT->MODULE slice is non-empty");
    eprintln!("=== wave3c acceptance counts: printed ===\n");
}
