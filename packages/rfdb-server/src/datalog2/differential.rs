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
}
