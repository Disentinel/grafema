//! P2 equivalence differential: FactStore ≡ StorageView / multi_shard (spec
//! equivalence_plan, all 12 pairs), both sides on the SAME version-pinned
//! `ReadSnapshot`.
//!
//! - Sides: the [`LsmFactStore`] adapter vs the executor's `StorageView` oracle
//!   (`BorrowedLsmStorageView` built over the IDENTICAL pinned snapshot) and the
//!   raw `multi_shard` `*_at` surface.
//! - Comparison: result MULTISETS via sorted canonical string rows per pair
//!   (`assert_multiset_eq` dumps the first divergent row); the FactStore side is
//!   canon-ordered, the oracle side exec-ordered — the two ORDERS are never
//!   interleaved (P1 call C4), only the multisets are compared.
//! - Fixtures: a handcrafted corpus (multi-type nodes, edge metadata, reserved-key
//!   metadata, `column: 0`, `$legacy` records) plus a generated mixed corpus
//!   (~2000 nodes / ~5000 edges). Both run non-ignored in `cargo test --lib`.
//! - The full real-base variant is `#[ignore]`d (run once for the round-007
//!   ledger): it opens a READ-ONLY /tmp copy of the production base and records
//!   per-pair digests.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::Path;

use super::lsm::{LsmFactStore, LEGACY_AUTHOR};
use super::{
    AssertBatch, FactGroup, FactRow, FactStore, GroupFact, SortOrder, PERSPECTIVE_MAIN, TX_OPEN,
};
use crate::datalog::Value;
use crate::derive::storage_glue::{
    BorrowedLsmStorageView, EdgeOrder, Relation, Row, SortOrder as GlueOrder, StorageView,
};
use crate::storage_v2::types::{EdgeRecordV2, NodeRecordV2};

// ── helpers ────────────────────────────────────────────────────────

fn assert_multiset_eq(label: &str, mut left: Vec<String>, mut right: Vec<String>) {
    left.sort();
    right.sort();
    if left != right {
        let first_divergence = left
            .iter()
            .zip(right.iter())
            .position(|(a, b)| a != b)
            .map(|i| {
                format!(
                    "index {}: fact-side {:?} vs oracle-side {:?}",
                    i, left[i], right[i]
                )
            })
            .unwrap_or_else(|| {
                format!(
                    "lengths differ: fact-side {} vs oracle-side {}",
                    left.len(),
                    right.len()
                )
            });
        panic!("differential pair '{label}' diverged — {first_divergence}");
    }
}

fn node_repr(id: u128, ty: &str) -> String {
    format!("{id}|{ty}")
}

fn edge_repr(src: u128, dst: u128, ty: &str) -> String {
    format!("{src}|{dst}|{ty}")
}

fn attr_repr(id: u128, key: &str, value: &str) -> String {
    format!("{id}|{key}|{value}")
}

fn fact_node_repr(row: &FactRow) -> String {
    match &row.key.tuple[..] {
        [Value::Id(id), Value::Str(ty)] => node_repr(*id, ty),
        other => panic!("node/type tuple shape: {other:?}"),
    }
}

/// Edge rows normalized to (src, dst, ty) — `incoming` tuples are (dst, src, ty).
fn fact_edge_repr(row: &FactRow, incoming: bool) -> String {
    match &row.key.tuple[..] {
        [Value::Id(a), Value::Id(b), Value::Str(ty)] => {
            if incoming {
                edge_repr(*b, *a, ty)
            } else {
                edge_repr(*a, *b, ty)
            }
        }
        other => panic!("edge/incoming tuple shape: {other:?}"),
    }
}

fn fact_attr_repr(row: &FactRow) -> String {
    match &row.key.tuple[..] {
        [Value::Id(id), Value::Str(k), Value::Str(v)] => attr_repr(*id, k, v),
        other => panic!("attr tuple shape: {other:?}"),
    }
}

fn pred(fs: &LsmFactStore, name: &str) -> crate::derive::catalog::CatalogPredicateId {
    fs.catalog().get(name).expect("base predicate").id
}

fn run(
    fs: &LsmFactStore,
    s: &super::Snapshot,
    name: &str,
    o: SortOrder,
    prefix: &[Value],
) -> Vec<FactRow> {
    fs.prefix_scan(s, pred(fs, name), PERSPECTIVE_MAIN, o, prefix)
        .expect("readable run")
        .collect()
}

fn digest(label: &str, mut rows: Vec<String>) -> String {
    rows.sort();
    let mut hasher = blake3::Hasher::new();
    for r in &rows {
        hasher.update(r.as_bytes());
        hasher.update(b"\n");
    }
    format!(
        "{label}: {} rows, blake3 {}",
        rows.len(),
        hasher.finalize().to_hex()
    )
}

// ── the 12 pairs ───────────────────────────────────────────────────

/// Run read pairs 1–9 + 12 over `fs` and return per-pair digests (for the
/// real-base ledger record). `sample_cap` bounds the per-id probes (pairs 4–6):
/// `None` = exhaustive (fixtures), `Some(n)` = ≥n sampled pairs (real base).
fn read_differential(fs: &LsmFactStore, sample_cap: Option<usize>) -> Vec<String> {
    let s = fs.snapshot();
    let pinned = fs.read_snapshot_of(&s);
    let store = fs.store_read();
    let view = BorrowedLsmStorageView::new(&store, pinned.clone());
    let mut digests = Vec::new();

    // ── Fact-level cross-path coherence oracle (round-008 R1) ──
    // One fid must carry the SAME synthesized assertion on EVERY read path:
    // every keyed probe below is checked against the FULL runs' provenance
    // (author/tick), not just its tuple repr. This is what the review's edge
    // re-assert reproduction diverged on (keyed edge scans dedup oldest-first,
    // the full run newest-first) before the edge_winner resolution.
    let mut full_prov: std::collections::HashMap<u128, (crate::derive::catalog::AuthorId, u64)> =
        std::collections::HashMap::new();
    for name in ["node", "type", "edge", "incoming", "attr"] {
        for row in run(fs, &s, name, SortOrder::Forward, &[]) {
            assert_eq!(row.assertions.len(), 1, "full run: one assertion per row");
            let a = &row.assertions[0];
            full_prov.insert(row.fid, (a.author, a.tick));
        }
    }
    let check_prov = |label: &str, rows: &[FactRow]| {
        for row in rows {
            let a = &row.assertions[0];
            let want = full_prov.get(&row.fid).unwrap_or_else(|| {
                panic!("{label}: keyed fid {:x} absent from the full runs", row.fid)
            });
            assert_eq!(
                &(a.author, a.tick),
                want,
                "{label}: fid {:x} — keyed-path assertion (author/tick) diverges from the full run",
                row.fid
            );
        }
    };

    // ── pair 1: sorted_run(node) ≡ StorageView node run ──
    let fact_nodes: Vec<String> = run(fs, &s, "node", SortOrder::Forward, &[])
        .iter()
        .map(fact_node_repr)
        .collect();
    let oracle_nodes: Vec<String> = view
        .sorted_run(Relation::Nodes, GlueOrder::NodeById)
        .map(|row| match row {
            Row::Node(n) => node_repr(n.id, &n.node_type),
            Row::Edge(_) => panic!("node run yielded an edge"),
        })
        .collect();
    assert_multiset_eq("1: node full run", fact_nodes.clone(), oracle_nodes.clone());
    // type/2 serves the same (id, type) pairs (both backed by eval_node today).
    let fact_types: Vec<String> = run(fs, &s, "type", SortOrder::Forward, &[])
        .iter()
        .map(fact_node_repr)
        .collect();
    assert_multiset_eq(
        "1b: type full run ≡ node full run",
        fact_types,
        oracle_nodes.clone(),
    );
    digests.push(digest("pair1_nodes", fact_nodes));

    // ── pair 2: prefix_scan(type, Reverse, [ty]) ≡ scan_nodes_by_type, EVERY type ──
    let distinct_types: BTreeSet<String> = view
        .sorted_run(Relation::Nodes, GlueOrder::NodeById)
        .map(|row| match row {
            Row::Node(n) => n.node_type,
            Row::Edge(_) => unreachable!(),
        })
        .collect();
    let mut pair2_rows = Vec::new();
    // §2.3 conflict accounting: the oracle's type scan filters BEFORE
    // newest-wins dedup, so a duplicate-id record whose WINNER carries a
    // different type leaks into the scan (39 ids on the measured base). The
    // fact side is winner-coherent (prefix_scan ⊆ sorted_run, §7.2), so the
    // differential asserts: fact side ≡ oracle side MINUS rows whose winner
    // type differs — every exclusion is individually verified against the
    // winner point lookup, and the total is recorded (0 on conflict-free
    // fixtures; the §2.3 class on the real base). Ledger round-007 C22.
    let mut pair2_shadowed_total = 0usize;
    let no_such = "NO_SUCH_TYPE".to_string();
    for ty in distinct_types.iter().chain([&no_such]) {
        let fact_rows = run(
            fs,
            &s,
            "type",
            SortOrder::Reverse,
            &[Value::Str(ty.clone())],
        );
        check_prov(&format!("2: type probe '{ty}'"), &fact_rows);
        let fact_side: Vec<String> = fact_rows.iter().map(fact_node_repr).collect();
        let mut oracle_winner_side: Vec<String> = Vec::new();
        for n in view.scan_nodes_by_type(ty) {
            let winner_ty = view.get_node(n.id).map(|w| w.node_type).unwrap_or_default();
            if winner_ty == *ty {
                oracle_winner_side.push(node_repr(n.id, &n.node_type));
            } else {
                // The documented §2.3 leak: a shadowed record of a duplicate id.
                pair2_shadowed_total += 1;
            }
        }
        assert_multiset_eq(
            &format!("2: type reverse probe '{ty}'"),
            fact_side.clone(),
            oracle_winner_side,
        );
        pair2_rows.extend(fact_side);
    }
    digests.push(digest("pair2_by_type", pair2_rows));
    digests.push(format!(
        "pair2_shadowed_duplicate_rows (§2.3 conflict class): {pair2_shadowed_total}"
    ));

    // ── pair 3: sorted_run(edge) ≡ edge run; per-type ≡ scan_edges_by_type;
    //           incoming full run ≡ same multiset ──
    let fact_edges: Vec<String> = run(fs, &s, "edge", SortOrder::Forward, &[])
        .iter()
        .map(|r| fact_edge_repr(r, false))
        .collect();
    let oracle_edges: Vec<String> = view
        .sorted_run(Relation::Edges, GlueOrder::EdgeSrcTypeDst)
        .map(|row| match row {
            Row::Edge(e) => edge_repr(e.src, e.dst, &e.edge_type),
            Row::Node(_) => panic!("edge run yielded a node"),
        })
        .collect();
    assert_multiset_eq("3: edge full run", fact_edges.clone(), oracle_edges.clone());
    let fact_incoming: Vec<String> = run(fs, &s, "incoming", SortOrder::Forward, &[])
        .iter()
        .map(|r| fact_edge_repr(r, true))
        .collect();
    assert_multiset_eq(
        "3b: incoming full run ≡ edge multiset",
        fact_incoming,
        oracle_edges,
    );
    let distinct_edge_types: BTreeSet<String> = view
        .sorted_run(Relation::Edges, GlueOrder::EdgeSrcTypeDst)
        .map(|row| match row {
            Row::Edge(e) => e.edge_type,
            Row::Node(_) => unreachable!(),
        })
        .collect();
    for ty in &distinct_edge_types {
        // Filter the ONE cached full run (same rows; avoids re-projecting per type).
        let suffix = format!("|{ty}");
        let fact_side: Vec<String> = fact_edges
            .iter()
            .filter(|repr| repr.ends_with(&suffix))
            .cloned()
            .collect();
        let oracle_side: Vec<String> = view
            .scan_edges_by_type(ty, EdgeOrder::Forward)
            .map(|e| edge_repr(e.src, e.dst, &e.edge_type))
            .collect();
        assert_multiset_eq(&format!("3c: edges of type '{ty}'"), fact_side, oracle_side);
    }
    digests.push(digest("pair3_edges", fact_edges.clone()));

    // ── pairs 4+5: keyed probes ≡ edges_from / edges_to (+ raw *_at union) ──
    let all_ids: Vec<u128> = view
        .sorted_run(Relation::Nodes, GlueOrder::NodeById)
        .map(|row| match row {
            Row::Node(n) => n.id,
            Row::Edge(_) => unreachable!(),
        })
        .collect();
    // (id, type) probe pairs: every real (src, t) plus zero-fanout ids and an
    // absent id; capped for the real base (spec: ≥1000 sampled pairs).
    let mut probe_pairs: Vec<(u128, String)> = Vec::new();
    {
        let mut seen = HashSet::new();
        for repr in &fact_edges {
            let mut parts = repr.split('|');
            let src: u128 = parts.next().unwrap().parse().unwrap();
            let _dst = parts.next().unwrap();
            let ty = parts.next().unwrap().to_string();
            if seen.insert((src, ty.clone())) {
                probe_pairs.push((src, ty));
            }
        }
        let cap = sample_cap.unwrap_or(usize::MAX);
        probe_pairs.truncate(cap.saturating_sub(cap / 5).max(1));
        // Zero-fanout + absent probes.
        let some_type = distinct_edge_types
            .iter()
            .next()
            .cloned()
            .unwrap_or_else(|| "CALLS".to_string());
        for id in all_ids.iter().take(cap / 5 + 1) {
            probe_pairs.push((*id, "NO_SUCH_EDGE_TYPE".to_string()));
        }
        probe_pairs.push((u128::MAX - 1, some_type));
    }
    for (id, ty) in &probe_pairs {
        let out_rows = run(fs, &s, "edge", SortOrder::Forward, &[Value::Id(*id)]);
        let in_rows = run(fs, &s, "incoming", SortOrder::Forward, &[Value::Id(*id)]);
        // Keyed edge paths carry the full run's provenance (round-008 R1).
        check_prov(&format!("4: edge keyed ({id})"), &out_rows);
        check_prov(&format!("5: incoming keyed ({id})"), &in_rows);
        // 4: outgoing.
        let fact_out: Vec<String> = out_rows
            .iter()
            .filter(|r| r.key.tuple[2] == Value::Str(ty.clone()))
            .map(|r| fact_edge_repr(r, false))
            .collect();
        let oracle_out: Vec<String> = view
            .edges_from(*id, ty)
            .iter()
            .map(|e| edge_repr(e.src, e.dst, &e.edge_type))
            .collect();
        assert_multiset_eq(&format!("4: edges_from({id}, {ty})"), fact_out, oracle_out);
        // 5: incoming.
        let fact_in: Vec<String> = in_rows
            .iter()
            .filter(|r| r.key.tuple[2] == Value::Str(ty.clone()))
            .map(|r| fact_edge_repr(r, true))
            .collect();
        let oracle_in: Vec<String> = view
            .edges_to(*id, ty)
            .iter()
            .map(|e| edge_repr(e.src, e.dst, &e.edge_type))
            .collect();
        assert_multiset_eq(&format!("5: edges_to({id}, {ty})"), fact_in, oracle_in);
        // 4b/5b: the un-filtered prefix ≡ the raw *_at surface.
        let fact_out_all: Vec<String> = out_rows.iter().map(|r| fact_edge_repr(r, false)).collect();
        let raw_out: Vec<String> = store
            .get_outgoing_edges_at(&pinned, *id, None)
            .iter()
            .map(|e| edge_repr(e.src, e.dst, &e.edge_type))
            .collect();
        assert_multiset_eq(
            &format!("4b: get_outgoing_edges_at({id})"),
            fact_out_all,
            raw_out,
        );
        let fact_in_all: Vec<String> = in_rows.iter().map(|r| fact_edge_repr(r, true)).collect();
        let raw_in: Vec<String> = store
            .get_incoming_edges_at(&pinned, *id, None)
            .iter()
            .map(|e| edge_repr(e.src, e.dst, &e.edge_type))
            .collect();
        assert_multiset_eq(
            &format!("5b: get_incoming_edges_at({id})"),
            fact_in_all,
            raw_in,
        );
    }
    digests.push(digest(
        "pair45_probes",
        probe_pairs
            .iter()
            .map(|(i, t)| format!("{i}|{t}"))
            .collect(),
    ));

    // ── pair 6: point lookups ≡ get_node (present + absent) ──
    let id_cap = sample_cap.unwrap_or(usize::MAX);
    let absent_id = u128::MAX - 2;
    for id in all_ids.iter().take(id_cap).chain([&absent_id]) {
        let point_rows = run(fs, &s, "node", SortOrder::Forward, &[Value::Id(*id)]);
        check_prov(&format!("6: node point ({id})"), &point_rows);
        let fact_side: Vec<String> = point_rows.iter().map(fact_node_repr).collect();
        let oracle_side: Vec<String> = view
            .get_node(*id)
            .map(|n| vec![node_repr(n.id, &n.node_type)])
            .unwrap_or_default();
        assert_multiset_eq(
            &format!("6: get_node({id})"),
            fact_side.clone(),
            oracle_side,
        );
        // get_fact on the projected fid agrees (None ≡ empty).
        for row in point_rows {
            let fetched = fs.get_fact(&s, row.fid).expect("projected fid resolves");
            assert_eq!(fetched.key, row.key, "6b: get_fact({id})");
        }
    }

    // ── pair 7: attr projection ≡ privileged fields + non-reserved metadata ──
    let mut pair7_rows = Vec::new();
    let mut sampled_kv: BTreeMap<(String, String), ()> = BTreeMap::new();
    for id in all_ids.iter().take(id_cap) {
        let rec = store
            .get_node_at(&pinned, *id)
            .expect("node listed in the run exists");
        let mut expected: Vec<String> = Vec::new();
        if !rec.name.is_empty() {
            expected.push(attr_repr(*id, "name", &rec.name));
            sampled_kv.insert(("name".into(), rec.name.clone()), ());
        }
        if !rec.file.is_empty() {
            expected.push(attr_repr(*id, "file", &rec.file));
            sampled_kv.insert(("file".into(), rec.file.clone()), ());
        }
        if !rec.semantic_id.is_empty() {
            expected.push(attr_repr(*id, "semantic_id", &rec.semantic_id));
        }
        // Ground truth for the blob: the oracle's node_metadata point probe.
        let blob = view.node_metadata(*id).unwrap_or_default();
        let mut meta_source: Option<String> = None;
        let mut meta_generation: Option<u64> = None;
        if !blob.is_empty() {
            if let Ok(serde_json::Value::Object(map)) =
                serde_json::from_str::<serde_json::Value>(&blob)
            {
                for (k, v) in &map {
                    if k == "_source" {
                        meta_source = v.as_str().map(str::to_string);
                        continue;
                    }
                    if k == "_generation" {
                        meta_generation = v
                            .as_u64()
                            .or_else(|| v.as_str().and_then(|x| x.parse().ok()));
                        continue;
                    }
                    // Blob copies of the column-authoritative keys are NOT attr
                    // facts (round-008 R2): today's dispatch (`attr_to_query` /
                    // `first_class_attr`) serves name/file from the record
                    // columns, and an equal-value blob copy would be the same
                    // fid twice (§2.2). The columns above are the ground truth.
                    if matches!(k.as_str(), "name" | "file" | "semantic_id") {
                        continue;
                    }
                    let scalar = match v {
                        serde_json::Value::String(x) => {
                            sampled_kv.insert((k.clone(), x.clone()), ());
                            Some(x.clone())
                        }
                        serde_json::Value::Number(n) => Some(n.to_string()),
                        serde_json::Value::Bool(b) => Some(b.to_string()),
                        _ => None,
                    };
                    if let Some(x) = scalar {
                        expected.push(attr_repr(*id, k, &x));
                    }
                }
            }
        }
        let fact_side_rows = run(fs, &s, "attr", SortOrder::Forward, &[Value::Id(*id)]);
        check_prov(&format!("7: attr keyed ({id})"), &fact_side_rows);
        let fact_side: Vec<String> = fact_side_rows.iter().map(fact_attr_repr).collect();
        assert_multiset_eq(&format!("7: attrs of {id}"), fact_side.clone(), expected);
        // Losslessness of the _source/_generation MOVE (§6.2 «0 доп. фактов»):
        // absent as attrs (asserted by the multiset equality above — expected
        // never contains them) AND present as author/tick.
        for row in &fact_side_rows {
            let a = &row.assertions[0];
            assert_eq!(
                fs.author_name(a.author).as_deref(),
                Some(meta_source.as_deref().unwrap_or(LEGACY_AUTHOR)),
                "7b: author of {id} attrs"
            );
            assert_eq!(
                a.tick,
                meta_generation.unwrap_or(0),
                "7b: tick of {id} attrs"
            );
        }
        pair7_rows.extend(fact_side);
    }
    // Reverse side: attr value probes ≡ nodes_by_attr (string-valued keys —
    // numeric/bool values are covered by the forward multiset above).
    // Each reverse probe materializes the full attr projection (no native attr
    // index — prefix_scan is honestly false); cap the sampled (k, v) probes.
    let kv_cap = sample_cap.map(|c| c / 10).unwrap_or(usize::MAX);
    let mut pair7_shadowed_total = 0usize;
    for ((k, v), ()) in sampled_kv.iter().take(kv_cap) {
        let fact_side: Vec<String> =
            run(fs, &s, "attr", SortOrder::Reverse, &[Value::Str(k.clone())])
                .iter()
                .filter(|r| r.key.tuple[2] == Value::Str(v.clone()))
                .map(|r| match &r.key.tuple[0] {
                    Value::Id(id) => id.to_string(),
                    other => panic!("attr subject: {other:?}"),
                })
                .collect();
        // Same §2.3 accounting as pair 2: an oracle hit whose WINNER record
        // does not carry attr (k, v) is a shadowed duplicate-id record leaking
        // through the attr scan; the fact side is winner-coherent. Each
        // exclusion is verified against the winner-anchored forward projection
        // (itself proven against get_node_at + node_metadata in pair 7 above).
        let mut oracle_winner_side: Vec<String> = Vec::new();
        for n in view.nodes_by_attr(k, v) {
            let winner_has_kv = run(fs, &s, "attr", SortOrder::Forward, &[Value::Id(n.id)])
                .iter()
                .any(|r| {
                    r.key.tuple[1] == Value::Str(k.clone())
                        && r.key.tuple[2] == Value::Str(v.clone())
                });
            if winner_has_kv {
                oracle_winner_side.push(n.id.to_string());
            } else {
                pair7_shadowed_total += 1;
            }
        }
        assert_multiset_eq(
            &format!("7c: nodes_by_attr({k}, {v})"),
            fact_side,
            oracle_winner_side,
        );
    }
    digests.push(format!(
        "pair7_shadowed_duplicate_rows (§2.3 conflict class): {pair7_shadowed_total}"
    ));
    digests.push(digest("pair7_attrs", pair7_rows));

    // ── pair 8: synthesis audit + live_filter identity on the full run ──
    let mut all_rows: Vec<FactRow> = Vec::new();
    for name in ["node", "type", "edge", "incoming", "attr"] {
        all_rows.extend(run(fs, &s, name, SortOrder::Forward, &[]));
    }
    for row in &all_rows {
        assert_eq!(
            row.assertions.len(),
            1,
            "8: exactly one synthesized assertion"
        );
        let a = &row.assertions[0];
        assert_eq!(a.fid, row.fid);
        assert_eq!(a.tx_created, 0);
        assert_eq!(a.tx_invalidated, TX_OPEN);
        assert!(a.tag.is_bool());
        assert!(fs.author_name(a.author).is_some(), "8: author interned");
        assert_eq!(
            fs.tuple(&s, row.fid).expect("8: fid round-trips"),
            row.key.tuple
        );
    }
    let survivors = fs
        .live_filter(&s, Box::new(all_rows.clone().into_iter()))
        .count();
    assert_eq!(survivors, all_rows.len(), "8: empty supersedes ⟹ identity");

    // ── pair 9: counts ──
    assert_eq!(
        run(fs, &s, "node", SortOrder::Forward, &[]).len(),
        store.node_count_at(&pinned),
        "9: node count"
    );
    assert_eq!(
        run(fs, &s, "edge", SortOrder::Forward, &[]).len(),
        store.edge_count_at(&pinned),
        "9: edge count"
    );
    let per_type = store.count_by_type_at(&pinned);
    for (ty, count) in &per_type {
        assert_eq!(
            run(
                fs,
                &s,
                "type",
                SortOrder::Reverse,
                &[Value::Str(ty.clone())]
            )
            .len(),
            *count,
            "9: count of type '{ty}'"
        );
    }
    digests.push(digest(
        "pair9_counts",
        vec![format!(
            "nodes {} edges {} types {}",
            store.node_count_at(&pinned),
            store.edge_count_at(&pinned),
            per_type.len()
        )],
    ));

    // ── pair 12: perspective non-interference floor ──
    let other = fs.intern_perspective("other");
    for name in ["node", "type", "edge", "incoming", "attr"] {
        let rows: Vec<FactRow> = fs
            .sorted_run(&s, pred(fs, name), other, SortOrder::Forward)
            .expect("readable")
            .collect();
        assert!(
            rows.is_empty(),
            "12: '{name}' must be EMPTY for persp 'other'"
        );
        let probe: Vec<FactRow> = fs
            .prefix_scan(
                &s,
                pred(fs, name),
                other,
                SortOrder::Forward,
                &[Value::Id(1)],
            )
            .expect("readable")
            .collect();
        assert!(
            probe.is_empty(),
            "12: '{name}' probe must be EMPTY for persp 'other'"
        );
    }

    // pair 10 (state sha) runs in its own tests: cross-process determinism,
    // compaction invariance, write variance, declaration-order permutation.
    let sha = fs.canonical_state_sha(&s);
    digests.push(format!("pair10_state_sha: {}", hex32(&sha)));
    digests
}

fn hex32(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ── fixtures ───────────────────────────────────────────────────────

fn meta(pairs: &[(&str, serde_json::Value)]) -> String {
    let mut map = serde_json::Map::new();
    for (k, v) in pairs {
        map.insert((*k).to_string(), v.clone());
    }
    serde_json::Value::Object(map).to_string()
}

fn node_rec(id: u128, ty: &str, name: &str, file: &str, metadata: &str) -> NodeRecordV2 {
    NodeRecordV2 {
        semantic_id: if name.is_empty() {
            String::new()
        } else {
            format!("{file}->{ty}->{name}")
        },
        id,
        node_type: ty.to_string(),
        name: name.to_string(),
        file: file.to_string(),
        content_hash: 0,
        metadata: metadata.to_string(),
    }
}

fn edge_rec(src: u128, dst: u128, ty: &str, metadata: &str) -> EdgeRecordV2 {
    EdgeRecordV2 {
        src,
        dst,
        edge_type: ty.to_string(),
        metadata: metadata.to_string(),
    }
}

/// Handcrafted corpus: multi-type nodes, edge metadata, reserved-key metadata,
/// `column: 0`, records missing `_source`/`_generation` (the `$legacy` path),
/// empty names, nested objects.
fn handcrafted() -> (Vec<NodeRecordV2>, Vec<EdgeRecordV2>) {
    let nodes = vec![
        node_rec(
            11,
            "FUNCTION",
            "fn1",
            "a/f.js",
            &meta(&[
                ("_source", "analyzer".into()),
                ("_generation", 3u64.into()),
                ("line", 5u64.into()),
                ("column", 0u64.into()),
                ("async", true.into()),
                ("nested", serde_json::json!({"a": 1})),
                ("callback", "handler".into()),
            ]),
        ),
        node_rec(
            22,
            "FUNCTION",
            "fn2",
            "a/f.js",
            &meta(&[("_source", "enricher".into()), ("_generation", 7u64.into())]),
        ),
        node_rec(33, "CLASS", "", "b/g.js", ""),
        node_rec(
            44,
            "CLASS",
            "cls",
            "b/g.js",
            &meta(&[("_generation", "9".into())]),
        ),
        node_rec(
            55,
            "http:route",
            "GET /x",
            "c/r.js",
            &meta(&[
                ("_source", "js_http_routes".into()),
                ("method", "GET".into()),
            ]),
        ),
        // Round-008 R2: a legacy blob carrying column-colliding keys — a
        // DIFFERING "name"/"semantic_id" copy and an EQUAL "file" copy. The
        // columns are authoritative; neither copy may mint a second attr fact.
        node_rec(
            66,
            "METHOD",
            "colName",
            "d/h.js",
            &meta(&[
                ("_source", "analyzer".into()),
                ("name", "blobName".into()),
                ("file", "d/h.js".into()),
                ("semantic_id", "blob->sid".into()),
                ("kind", "getter".into()),
            ]),
        ),
    ];
    let edges = vec![
        edge_rec(
            11,
            22,
            "CALLS",
            &meta(&[("_source", "analyzer".into()), ("_generation", 3u64.into())]),
        ),
        edge_rec(11, 33, "CONTAINS", ""),
        edge_rec(22, 33, "CALLS", &meta(&[("_source", "enricher".into())])),
        edge_rec(33, 44, "IMPORTS", &meta(&[("qualifier", "default".into())])),
        edge_rec(55, 11, "HANDLED_BY", &meta(&[("_generation", 2u64.into())])),
    ];
    (nodes, edges)
}

/// Generated mixed corpus: ~2000 nodes / ~5000 edges with varied types, files,
/// metadata (numbers, bools, strings, missing provenance), deterministic PRNG.
fn generated() -> (Vec<NodeRecordV2>, Vec<EdgeRecordV2>) {
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }
    }
    let mut rng = Rng(0x5eed_cafe_f00d_0001);
    let types = [
        "FUNCTION",
        "CLASS",
        "METHOD",
        "VARIABLE",
        "CALL",
        "http:route",
    ];
    let sources = ["analyzer", "enricher", "rust-globals", "js_http_routes"];
    let edge_types = ["CALLS", "CONTAINS", "IMPORTS", "DEPENDS_ON", "HANDLED_BY"];
    let mut nodes = Vec::new();
    for i in 0..2000u64 {
        let ty = types[(rng.next() % types.len() as u64) as usize];
        let file = format!("src/mod{}/file{}.js", i % 7, i % 23);
        let mut pairs: Vec<(&str, serde_json::Value)> = Vec::new();
        let roll = rng.next() % 10;
        if roll < 8 {
            pairs.push(("_source", sources[(rng.next() % 4) as usize].into()));
        }
        if roll < 7 {
            pairs.push(("_generation", (rng.next() % 5 + 1).into()));
        }
        if rng.next() % 2 == 0 {
            pairs.push(("line", (rng.next() % 500).into()));
            pairs.push(("column", (rng.next() % 3).into()));
        }
        if rng.next() % 3 == 0 {
            pairs.push(("exportedAs", format!("sym{}", rng.next() % 40).into()));
        }
        if rng.next() % 5 == 0 {
            pairs.push(("async", (rng.next() % 2 == 0).into()));
        }
        let metadata = if pairs.is_empty() {
            String::new()
        } else {
            meta(&pairs)
        };
        nodes.push(node_rec(
            1000 + i as u128,
            ty,
            &format!("entity{i}"),
            &file,
            &metadata,
        ));
    }
    let mut edges = Vec::new();
    let mut seen = HashSet::new();
    while edges.len() < 5000 {
        let src = 1000 + (rng.next() % 2000) as u128;
        let dst = 1000 + (rng.next() % 2000) as u128;
        let ty = edge_types[(rng.next() % edge_types.len() as u64) as usize];
        if !seen.insert((src, dst, ty)) {
            continue;
        }
        let metadata = if rng.next() % 3 == 0 {
            meta(&[("_source", "analyzer".into()), ("_generation", 1u64.into())])
        } else {
            String::new()
        };
        edges.push(edge_rec(src, dst, ty, &metadata));
    }
    (nodes, edges)
}

// ── the non-ignored differential tests ─────────────────────────────

#[test]
fn differential_pairs_on_handcrafted_fixture() {
    let fs = LsmFactStore::ephemeral(2);
    let (nodes, edges) = handcrafted();
    fs.commit_legacy(nodes, edges, &[]);
    read_differential(&fs, None);
}

#[test]
fn differential_pairs_on_generated_mixed_corpus() {
    let fs = LsmFactStore::ephemeral(4);
    let (nodes, edges) = generated();
    fs.commit_legacy(nodes, edges, &[]);
    // Exhaustive pairs 1-3/7-9/12; per-id probes capped (they are exhaustive on
    // the handcrafted fixture; the generated corpus samples 400 probe pairs).
    read_differential(&fs, Some(400));
}

/// The differential holds ACROSS compaction physics: same logical answers and
/// the same canonical state sha before and after a full merge.
#[test]
fn differential_pairs_survive_compaction() {
    let fs = LsmFactStore::ephemeral(2);
    let (nodes, edges) = handcrafted();
    fs.commit_legacy(nodes, edges, &[]);
    let sha_before = {
        let s = fs.snapshot();
        fs.canonical_state_sha(&s)
    };
    fs.compact(None, super::CompactionTier::FullMerge)
        .expect("compact");
    read_differential(&fs, None);
    let s = fs.snapshot();
    assert_eq!(
        sha_before,
        fs.canonical_state_sha(&s),
        "sha is physics-invariant"
    );
}

/// Round-008 R1: the SAME edge key re-asserted with new provenance across two
/// commits (routine reanalysis shape: same key, bumped `_generation`, new
/// `_source`). Every read path must project the NEWEST record's assertion —
/// the full differential (whose keyed pairs now check provenance against the
/// full runs) stays green, before and after compaction physics.
#[test]
fn differential_pairs_after_edge_reassert() {
    let fs = LsmFactStore::ephemeral(2);
    let (nodes, edges) = handcrafted();
    fs.commit_legacy(nodes, edges, &[]);
    fs.commit_legacy(
        vec![],
        vec![edge_rec(
            11,
            22,
            "CALLS",
            &meta(&[
                ("_source", "writer-v2".into()),
                ("_generation", 9u64.into()),
            ]),
        )],
        &[],
    );
    let s = fs.snapshot();
    // The keyed path serves the re-asserted provenance (the review's repro:
    // it served writer-v1/tick 1 — the OLDEST record — before edge_winner).
    let keyed = run(&fs, &s, "edge", SortOrder::Forward, &[Value::Id(11)]);
    let call_row = keyed
        .iter()
        .find(|r| r.key.tuple[1] == Value::Id(22) && r.key.tuple[2] == Value::Str("CALLS".into()))
        .expect("re-asserted edge");
    let a = &call_row.assertions[0];
    assert_eq!(fs.author_name(a.author).as_deref(), Some("writer-v2"));
    assert_eq!(a.tick, 9);
    read_differential(&fs, None);
    // The winner survives compaction physics with the sha unmoved.
    let sha_before = fs.canonical_state_sha(&s);
    fs.compact(None, super::CompactionTier::FullMerge)
        .expect("compact");
    read_differential(&fs, None);
    let s2 = fs.snapshot();
    assert_eq!(sha_before, fs.canonical_state_sha(&s2));
}

/// Round-008 R3: tombstone + re-add coverage at fixture level — a second
/// commit with non-empty `changed_files` tombstones a file's nodes and their
/// outgoing edges, one deleted id is re-added with a DIFFERENT type and fresh
/// provenance, and the full battery agrees with the oracle across the
/// tombstone generation and across compaction.
#[test]
fn differential_pairs_after_tombstone_and_readd() {
    let fs = LsmFactStore::ephemeral(2);
    let (nodes, edges) = handcrafted();
    fs.commit_legacy(nodes, edges, &[]);
    let sha_before = {
        let s = fs.snapshot();
        fs.canonical_state_sha(&s)
    };
    // Reanalysis of a/f.js: nodes 11/22 (and 11's/22's outgoing edges) are
    // tombstoned; 11 is re-added as a METHOD with a new outgoing edge.
    fs.commit_legacy(
        vec![node_rec(
            11,
            "METHOD",
            "fn1v2",
            "a/f.js",
            &meta(&[
                ("_source", "reanalyzer".into()),
                ("_generation", 5u64.into()),
            ]),
        )],
        vec![edge_rec(
            11,
            44,
            "USES",
            &meta(&[
                ("_source", "reanalyzer".into()),
                ("_generation", 5u64.into()),
            ]),
        )],
        &["a/f.js".to_string()],
    );
    let s = fs.snapshot();
    // 22 is GONE from the fact relation; 11 carries its re-added shape and the
    // re-added record's provenance, not the tombstoned generation's.
    let nodes_now = run(&fs, &s, "node", SortOrder::Forward, &[]);
    assert!(
        !nodes_now.iter().any(|r| r.key.tuple[0] == Value::Id(22)),
        "tombstoned node 22 must not project"
    );
    let n11 = nodes_now
        .iter()
        .find(|r| r.key.tuple[0] == Value::Id(11))
        .expect("re-added node");
    assert_eq!(n11.key.tuple[1], Value::Str("METHOD".into()));
    assert_eq!(
        fs.author_name(n11.assertions[0].author).as_deref(),
        Some("reanalyzer")
    );
    assert_eq!(n11.assertions[0].tick, 5);
    // The old outgoing edge died with its file; the new generation's projects.
    let out11 = run(&fs, &s, "edge", SortOrder::Forward, &[Value::Id(11)]);
    assert!(
        !out11.iter().any(|r| r.key.tuple[1] == Value::Id(22)),
        "11→22 CALLS died with its file"
    );
    assert!(
        out11.iter().any(|r| {
            r.key.tuple[1] == Value::Id(44) && r.key.tuple[2] == Value::Str("USES".into())
        }),
        "the re-added generation's edge projects"
    );
    // The oracle's type scan LEAKS the re-added id's OLD record (its id was
    // removed from the tombstones by the re-add, and the scan filters by type
    // before newest-wins dedup) — while node 22's records stay tombstone-
    // filtered on BOTH paths; count_by_type_at agrees with the fact side.
    {
        let pinned = fs.read_snapshot_of(&s);
        let store = fs.store_read();
        let view = BorrowedLsmStorageView::new(&store, pinned.clone());
        let leaked: Vec<_> = view.scan_nodes_by_type("FUNCTION").collect();
        assert_eq!(leaked.len(), 1, "exactly the re-added id's old record");
        assert_eq!(leaked[0].id, 11);
        let counts = store.count_by_type_at(&pinned);
        assert_eq!(counts.get("FUNCTION"), None, "FUNCTION is extinct");
        assert_eq!(counts.get("METHOD"), Some(&2), "re-added 11 + fixture 66");
    }
    // No live winner carries FUNCTION — the fact relation stays coherent.
    assert!(run(
        &fs,
        &s,
        "type",
        SortOrder::Reverse,
        &[Value::Str("FUNCTION".into())]
    )
    .is_empty());
    // The whole battery agrees with the oracle across the tombstone + re-add
    // generation, and the LOGICAL state moved (tombstones are truth here,
    // unlike compaction physics).
    read_differential(&fs, None);
    let s2 = fs.snapshot();
    assert_ne!(sha_before, fs.canonical_state_sha(&s2));
    let sha_after = fs.canonical_state_sha(&s2);
    fs.compact(None, super::CompactionTier::FullMerge)
        .expect("compact");
    read_differential(&fs, None);
    let s3 = fs.snapshot();
    assert_eq!(sha_after, fs.canonical_state_sha(&s3), "physics-invariant");
}

/// Pins the §2.3 duplicate-id conflict class ON A FIXTURE (the real base
/// carries 39 of these): two records under ONE id with different types written
/// in two commits. The fact relation is winner-coherent — the full run carries
/// ONE row (the newest record), the shadowed type's probe does NOT leak it
/// (prefix_scan stays a window of sorted_run, §7.2) — while the storage
/// oracle's filter-before-dedup type scan DOES leak the shadowed record, and
/// `count_by_type_at` (dedup-before-count) agrees with the fact side. The full
/// differential then passes via the explained-exception accounting.
#[test]
fn duplicate_id_conflict_class_is_coherent_and_explained() {
    let fs = LsmFactStore::ephemeral(2);
    let dup: u128 = 9090;
    // Commit 1: the older record (will be shadowed).
    fs.commit_legacy(
        vec![node_rec(
            dup,
            "EXTERNAL_FUNCTION",
            "notElem",
            "__grafema_virtual/haskell-local-refs",
            &meta(&[("_source", "haskell-local-refs".into())]),
        )],
        vec![],
        &[],
    );
    // Commit 2: the newer record under the SAME id — the newest-wins winner —
    // plus an UNRELATED node whose winner type IS the shadowed type, so the
    // per-type probe of "EXTERNAL_FUNCTION" is exercised by the differential.
    let other_ext: u128 = 9091;
    fs.commit_legacy(
        vec![
            node_rec(
                dup,
                "GLOBAL_DEFINITION",
                "notElem",
                "<runtime/haskell>",
                &meta(&[("_source", "analyzer".into()), ("_generation", 2u64.into())]),
            ),
            node_rec(
                other_ext,
                "EXTERNAL_FUNCTION",
                "take",
                "__grafema_virtual/haskell-local-refs",
                &meta(&[("_source", "haskell-local-refs".into())]),
            ),
        ],
        vec![],
        &[],
    );
    let s = fs.snapshot();
    // TWO rows in the full run; the duplicate id carries its winner type.
    let full = run(&fs, &s, "node", SortOrder::Forward, &[]);
    assert_eq!(full.len(), 2);
    let dup_row = full
        .iter()
        .find(|r| r.key.tuple[0] == Value::Id(dup))
        .expect("dup row");
    assert_eq!(
        dup_row.key.tuple[1],
        Value::Str("GLOBAL_DEFINITION".to_string())
    );
    // Winner probe sees it; the SHADOWED type's probe does NOT include the
    // duplicate id (window property) — only the honest EXTERNAL_FUNCTION node.
    assert_eq!(
        run(
            &fs,
            &s,
            "type",
            SortOrder::Reverse,
            &[Value::Str("GLOBAL_DEFINITION".into())]
        )
        .len(),
        1
    );
    let ext_probe = run(
        &fs,
        &s,
        "type",
        SortOrder::Reverse,
        &[Value::Str("EXTERNAL_FUNCTION".into())],
    );
    assert_eq!(ext_probe.len(), 1);
    assert_eq!(ext_probe[0].key.tuple[0], Value::Id(other_ext));
    // The storage oracle LEAKS the shadowed record (filter-before-dedup) while
    // count_by_type_at (dedup-before-count) agrees with the fact side — the
    // documented §2.3 divergence between two production read paths.
    {
        let pinned = fs.read_snapshot_of(&s);
        let store = fs.store_read();
        let view = BorrowedLsmStorageView::new(&store, pinned.clone());
        let leaked: Vec<_> = view.scan_nodes_by_type("EXTERNAL_FUNCTION").collect();
        assert_eq!(leaked.len(), 2, "the shadowed record leaks into the scan");
        assert!(
            leaked.iter().any(|n| n.id == dup),
            "leak IS the duplicate id"
        );
        let counts = store.count_by_type_at(&pinned);
        assert_eq!(counts.get("GLOBAL_DEFINITION"), Some(&1));
        assert_eq!(counts.get("EXTERNAL_FUNCTION"), Some(&1));
    }
    // The full differential passes, explaining the leak (1 shadowed row).
    let digests = read_differential(&fs, None);
    assert!(
        digests
            .iter()
            .any(|d| d.starts_with("pair2_shadowed_duplicate_rows") && d.ends_with(": 1")),
        "the explained-exception accounting must record exactly 1 shadowed row: {digests:?}"
    );
}

// ── pair 11: the write commutativity square ────────────────────────

/// (a) a record written via the LEGACY path reads back through FactStore as its
/// expected fact decomposition; (b) the same logical content written via
/// `assert_batch` reads back identically through BOTH FactStore and the legacy
/// StorageView (with `_source`/`_generation` stamped from author/tick). The two
/// write orders commute.
#[test]
fn write_commutativity_square() {
    // Side A: legacy write.
    let fs_a = LsmFactStore::ephemeral(2);
    let legacy_node = node_rec(
        77,
        "FUNCTION",
        "handler",
        "w/x.js",
        &meta(&[
            ("_source", "writer-test".into()),
            ("_generation", 42u64.into()),
            ("callback", "cb1".into()),
        ]),
    );
    let legacy_edge = edge_rec(
        77,
        78,
        "CALLS",
        &meta(&[
            ("_source", "writer-test".into()),
            ("_generation", 42u64.into()),
        ]),
    );
    let helper_node = node_rec(
        78,
        "FUNCTION",
        "callee",
        "w/x.js",
        &meta(&[
            ("_source", "writer-test".into()),
            ("_generation", 42u64.into()),
        ]),
    );
    fs_a.commit_legacy(
        vec![legacy_node, helper_node.clone()],
        vec![legacy_edge],
        &[],
    );

    // Side B: the same logical content through assert_batch.
    let fs_b = LsmFactStore::ephemeral(2);
    fs_b.commit_legacy(vec![helper_node], vec![], &[]);
    let author = fs_b.intern_author("writer-test");
    let attr = |k: &str, v: &str| GroupFact {
        predicate: pred(&fs_b, "attr"),
        tuple: vec![
            Value::Id(77),
            Value::Str(k.to_string()),
            Value::Str(v.to_string()),
        ]
        .into(),
    };
    fs_b.assert_batch(AssertBatch {
        perspective: PERSPECTIVE_MAIN,
        author,
        tick: 42,
        groups: vec![
            FactGroup::Node {
                facts: vec![
                    GroupFact {
                        predicate: pred(&fs_b, "node"),
                        tuple: vec![Value::Id(77), Value::Str("FUNCTION".into())].into(),
                    },
                    attr("name", "handler"),
                    attr("file", "w/x.js"),
                    attr("semantic_id", "w/x.js->FUNCTION->handler"),
                    attr("callback", "cb1"),
                ],
            },
            FactGroup::Edge {
                fact: GroupFact {
                    predicate: pred(&fs_b, "edge"),
                    tuple: vec![Value::Id(77), Value::Id(78), Value::Str("CALLS".into())].into(),
                },
            },
        ],
    })
    .expect("assert_batch write");

    // The square commutes: identical FactStore row multisets on both sides.
    let sa = fs_a.snapshot();
    let sb = fs_b.snapshot();
    for name in ["node", "type", "edge", "incoming", "attr"] {
        let rows_a: Vec<String> = run(&fs_a, &sa, name, SortOrder::Forward, &[])
            .iter()
            .map(|r| format!("{:?}", r.key.tuple))
            .collect();
        let rows_b: Vec<String> = run(&fs_b, &sb, name, SortOrder::Forward, &[])
            .iter()
            .map(|r| format!("{:?}", r.key.tuple))
            .collect();
        assert_multiset_eq(
            &format!("11: '{name}' legacy-write vs fact-write"),
            rows_a,
            rows_b,
        );
    }
    // Author/tick stamped and read back on side B.
    let row = run(&fs_b, &sb, "node", SortOrder::Forward, &[Value::Id(77)])
        .pop()
        .expect("written node");
    assert_eq!(
        fs_b.author_name(row.assertions[0].author).as_deref(),
        Some("writer-test")
    );
    assert_eq!(row.assertions[0].tick, 42);
    // Legacy StorageView on side B sees the record with stamped provenance.
    {
        let pinned = fs_b.read_snapshot_of(&sb);
        let store = fs_b.store_read();
        let view = BorrowedLsmStorageView::new(&store, pinned);
        let n = view.get_node(77).expect("legacy read of fact-written node");
        assert_eq!(
            (n.node_type.as_str(), n.name.as_str(), n.file.as_str()),
            ("FUNCTION", "handler", "w/x.js")
        );
        let blob = view.node_metadata(77).expect("metadata blob");
        let parsed: serde_json::Value = serde_json::from_str(&blob).expect("valid JSON");
        assert_eq!(parsed["_source"], "writer-test");
        assert_eq!(parsed["_generation"], 42);
        assert_eq!(parsed["callback"], "cb1");
    }
    // And the canonical state shas agree — the strongest commutation witness.
    assert_eq!(fs_a.canonical_state_sha(&sa), fs_b.canonical_state_sha(&sb));
}

// ── pair 10: cross-process sha determinism ─────────────────────────

/// Subprocess helper: prints the sha of the store named by `ROFL_P2_SHA_DIR`.
/// A no-op under normal test runs.
#[test]
fn state_sha_subprocess_helper() {
    let Ok(dir) = std::env::var("ROFL_P2_SHA_DIR") else {
        return;
    };
    let fs = LsmFactStore::open(Path::new(&dir)).expect("open sha dir");
    let s = fs.snapshot();
    println!("ROFL_P2_SHA={}", hex32(&fs.canonical_state_sha(&s)));
}

#[test]
fn state_sha_deterministic_across_two_processes() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path().join("sha-store");
    {
        let fs = LsmFactStore::create(&dir, 2).expect("create durable store");
        let (nodes, edges) = handcrafted();
        fs.commit_legacy(nodes, edges, &[]);
    } // dropped: LOCK released before the second open
    let _ = std::fs::remove_file(dir.join("LOCK"));

    // In-process sha over a fresh open.
    let in_process = {
        let fs = LsmFactStore::open(&dir).expect("reopen");
        let s = fs.snapshot();
        hex32(&fs.canonical_state_sha(&s))
    };
    let _ = std::fs::remove_file(dir.join("LOCK"));

    // Second OS process: this test binary, filtered to the helper.
    let exe = std::env::current_exe().expect("test exe");
    let out = std::process::Command::new(exe)
        .args([
            "facts::differential::state_sha_subprocess_helper",
            "--exact",
            "--nocapture",
        ])
        .env("ROFL_P2_SHA_DIR", &dir)
        .output()
        .expect("spawn helper process");
    assert!(
        out.status.success(),
        "helper failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let other_process = stdout
        .lines()
        .find_map(|l| l.strip_prefix("ROFL_P2_SHA="))
        .unwrap_or_else(|| panic!("no sha line in helper output: {stdout}"));
    assert_eq!(
        in_process, other_process,
        "sha must be process-invariant (§9.2)"
    );
}

// ── the real-base variant (ignored; run once for the round-007 ledger) ──

/// Full-corpus differential over a READ-ONLY copy of the production base.
/// Point it at the copy with `ROFL_P2_REAL_BASE=/tmp/…/graph.rfdb`; per the
/// shared-db discipline the copy is made with the live server checked (lsof)
/// and the original is NEVER opened by this test.
#[test]
#[ignore = "manual real-base differential; set ROFL_P2_REAL_BASE and run with --ignored"]
fn differential_real_base() {
    let dir = std::env::var("ROFL_P2_REAL_BASE")
        .expect("set ROFL_P2_REAL_BASE to a /tmp copy of graph.rfdb");
    let dir = std::path::PathBuf::from(dir);
    assert!(
        dir.join("db_config.json").exists(),
        "not a MultiShardStore dir: {}",
        dir.display()
    );
    let _ = std::fs::remove_file(dir.join("LOCK"));
    let fs = LsmFactStore::open(&dir).expect("open real-base copy");
    let digests = read_differential(&fs, Some(1000));
    println!("── real-base differential digests (round-007 ledger evidence) ──");
    for d in &digests {
        println!("{d}");
    }
}
