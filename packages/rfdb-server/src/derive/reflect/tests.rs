//! Rules-as-data tests.
//!
//! The measurements this slice stands on:
//!
//! * reachability — a reserved reflected record written through the ordinary commit path
//!   is visible to the EXECUTOR's view, before and after a flush;
//! * isolation — those records add not one row to any base relation;
//! * round trip — every shipped rule pack survives encode → store → decode;
//! * the four reference outcomes of an incomplete reflection.

use std::collections::HashMap;

use super::*;
use crate::datalog::{Atom, Literal, Rule, Term, Value};
use crate::derive::storage_glue::{BorrowedLsmStorageView, Relation, SortOrder, StorageView};
use crate::storage_v2::manifest::ManifestStore;
use crate::storage_v2::multi_shard::MultiShardStore;
use crate::storage_v2::types::NodeRecordV2;

// ── Helpers ────────────────────────────────────────────────────────

fn ordinary_node(semantic_id: &str, node_type: &str, name: &str, file: &str) -> NodeRecordV2 {
    let hash = blake3::hash(semantic_id.as_bytes());
    NodeRecordV2 {
        semantic_id: semantic_id.to_string(),
        id: u128::from_le_bytes(hash.as_bytes()[0..16].try_into().unwrap()),
        node_type: node_type.to_string(),
        name: name.to_string(),
        file: file.to_string(),
        content_hash: 0,
        metadata: String::new(),
    }
}

/// A real `storage_v2` database on disk (NOT ephemeral — the reachability claim is about a
/// database that actually flushes to segments), plus the exact view type the executor gets
/// handed in production (`BorrowedLsmStorageView`, `graph/engine_v2.rs:553`).
struct Db {
    _dir: tempfile::TempDir,
    store: MultiShardStore,
    manifest: ManifestStore,
}

impl Db {
    fn new() -> Db {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = MultiShardStore::create(dir.path(), 4).expect("store");
        let manifest = ManifestStore::create(dir.path()).expect("manifest");
        Db { _dir: dir, store, manifest }
    }

    /// Commit through the ORDINARY node path — reflected records get no privileged write
    /// route; that is the point of the reachability claim.
    fn commit(&mut self, nodes: Vec<NodeRecordV2>) {
        self.store
            .commit_batch_ext(nodes, vec![], &[], HashMap::new(), &mut self.manifest, &[])
            .expect("commit");
    }

    fn flush(&mut self) {
        self.store.flush_all(&mut self.manifest).expect("flush");
    }

    fn view(&self) -> BorrowedLsmStorageView<'_> {
        BorrowedLsmStorageView::new(&self.store, self.store.snapshot(&self.manifest))
    }

    /// Drop the live store and manifest and OPEN THE SAME BYTES AGAIN — a process
    /// restart, as far as the store is concerned. Nothing in-memory survives it, so
    /// anything readable afterwards was really on disk.
    fn reopen(&mut self) {
        self.flush();
        let path = self._dir.path().to_path_buf();
        self.manifest = ManifestStore::open(&path).expect("reopen manifest");
        self.store = MultiShardStore::open(&path, &self.manifest).expect("reopen store");
    }
}

fn base_node_row_count(view: &dyn StorageView) -> usize {
    view.sorted_run(Relation::Nodes, SortOrder::NodeById).count()
}

// ── Step 1: the reflected store is reachable from the executor's view ──

/// A reserved reflected record committed through the ordinary node path must be readable
/// through the door the executor uses ([`StorageView::reflected_facts`]) — both while it
/// still sits in the write buffer and after it has been flushed to a segment.
///
/// This is the load-bearing premise of the whole slice: the `facts` layer would fail it
/// (nothing in the server reaches `LsmFactStore`, and its record vocabulary rejects any
/// predicate outside node/attr/edge/supersedes).
#[test]
fn reflected_records_are_reachable_from_the_executor_view_before_and_after_flush() {
    let mut db = Db::new();
    let fact = ReflectedFact::new(REL_RULE, vec![rofl_atom("r0000dead")]);
    let rec = fact.to_node_record().expect("record");
    let fact_id = rec.id;

    db.commit(vec![rec]);

    let before: Vec<(u128, String)> = db.view().reflected_facts();
    assert_eq!(before.len(), 1, "the record must be visible before any flush");
    assert_eq!(before[0].0, fact_id);
    assert_eq!(
        ReflectedFact::from_metadata_json(&before[0].1).expect("decode"),
        fact,
        "the blob must round-trip the tuple"
    );

    db.flush();

    let after: Vec<(u128, String)> = db.view().reflected_facts();
    assert_eq!(after.len(), 1, "the record must survive the flush");
    assert_eq!(after[0].0, fact_id);
}

// ── Step 2: isolation — reflected records leak into no base relation ──

/// Writing rules into the graph must not change what a rule can SEE. Every base-relation
/// read point is measured against the same graph without the reflected records:
/// `node/2`'s sorted run, the typed scan, the bound-id point lookup and the attr
/// generators (by type, by name, by file).
///
/// This test FAILS before the `storage_glue` filters exist: `snapshot_node_rows_by_id`
/// hands out every live node without discrimination, so a program would find its own rules
/// in `node(X, T)`.
#[test]
fn reflected_records_add_no_row_to_any_base_relation() {
    // Baseline: the graph WITHOUT any reflected record.
    let mut plain = Db::new();
    plain.commit(vec![
        ordinary_node("a.js->FUNCTION->f", "FUNCTION", "f", "a.js"),
        ordinary_node("b.js->CLASS->C", "CLASS", "C", "b.js"),
    ]);
    plain.flush();
    let plain_rows = base_node_row_count(&plain.view());

    // The same graph PLUS a reflected program.
    let mut db = Db::new();
    let rule = parse_one("p(X) :- node(X, \"FUNCTION\").");
    let mut records = vec![
        ordinary_node("a.js->FUNCTION->f", "FUNCTION", "f", "a.js"),
        ordinary_node("b.js->CLASS->C", "CLASS", "C", "b.js"),
    ];
    let reflected = encode_rules_to_records(&[&rule]).expect("encode");
    assert!(reflected.len() >= 3, "rule/1 + conclusion_lit/3 + premise_lit/3 at least");
    let reflected_ids: Vec<u128> = reflected.iter().map(|r| r.id).collect();
    records.extend(reflected);
    db.commit(records);
    db.flush();

    let view = db.view();
    assert_eq!(
        base_node_row_count(&view),
        plain_rows,
        "node/2 must have exactly as many rows as the graph without the reflected records"
    );
    assert_eq!(
        view.scan_nodes_by_type(REFLECT_NODE_TYPE).count(),
        0,
        "the typed scan must not serve the reserved type"
    );
    for id in &reflected_ids {
        assert!(view.get_node(*id).is_none(), "the bound-id lookup must not resolve a reflected record");
    }
    assert_eq!(
        view.nodes_by_attr("type", REFLECT_NODE_TYPE).len(),
        0,
        "the attr generator must not resolve the reserved type"
    );
    assert_eq!(
        view.nodes_by_attr("file", REFLECT_FILE).len(),
        0,
        "the attr generator must not resolve the reserved virtual file"
    );
    assert_eq!(
        view.nodes_by_attr("name", REL_CONCLUSION_LIT).len(),
        0,
        "the attr generator must not resolve a reflected record by its relation name"
    );

    // Positive control: the ordinary nodes ARE still reachable through all of it, so the
    // zeros above measure isolation and not a broken view.
    assert_eq!(view.scan_nodes_by_type("FUNCTION").count(), 1);
    assert_eq!(view.nodes_by_attr("type", "FUNCTION").len(), 1);
    assert_eq!(view.nodes_by_attr("file", "a.js").len(), 1);

    // …and the reflected records are reachable through their own door.
    assert_eq!(view.reflected_facts().len(), reflected_ids.len());
}

/// The FIFTH read point: the bound-id METADATA lookup, which `node_attr/3` reads through
/// (`derive/builtin.rs`) — NOT `get_node`, so the four checks above do not cover it.
///
/// It is the worst one to leave open, because the blob IS the reflected tuple: a program
/// that hits it reads the content of its own rules. And the id is no secret — it is a pure
/// function of the tuple ([`ReflectedFact::fact_id`]), so anyone who knows the rule can
/// compute the id and write it into a program as a constant.
#[test]
fn the_bound_id_metadata_lookup_does_not_serve_a_reflected_tuple() {
    let mut db = Db::new();
    let ordinary = {
        let mut n = ordinary_node("a.js->FUNCTION->f", "FUNCTION", "f", "a.js");
        n.metadata = r#"{"line":42}"#.to_string();
        n
    };
    let ordinary_id = ordinary.id;
    let rule = parse_one("p(X) :- node(X, \"FUNCTION\").");
    let reflected = encode_rules_to_records(&[&rule]).expect("encode");
    let reflected_ids: Vec<u128> = reflected.iter().map(|r| r.id).collect();
    assert!(!reflected_ids.is_empty());
    let mut records = vec![ordinary];
    records.extend(reflected);
    db.commit(records);
    db.flush();

    let view = db.view();
    for id in &reflected_ids {
        assert_eq!(
            view.node_metadata(*id),
            None,
            "node_metadata served the reflected tuple of {id:032x} — `node_attr/3` reads \
             exactly this point"
        );
    }
    // Positive control on the same view: an ORDINARY node's blob still comes back, so the
    // `None`s above measure the filter and not a dead lookup.
    assert_eq!(view.node_metadata(ordinary_id).as_deref(), Some(r#"{"line":42}"#));
}

// ── Step 3/4: encoding and idempotent writing ──────────────────────

fn parse_one(src: &str) -> Rule {
    let program = crate::derive::parser_ext::parse_ext_program(src).expect("parse");
    program.items.into_iter().next().expect("one rule").rule
}

/// The encoder's output on a concrete rule, spelled out fact by fact. The term alphabet is
/// the reference's (`vendor/rofl-v0/src/reflect.ts:60-107`): `$lit(rel, persp, args,
/// temporal)`, `$var("Name")`, `$cons`/`$nil`, `$not`.
#[test]
fn encode_rule_emits_exactly_projection_t() {
    // RFDB spells negation `\+` (`datalog/parser.rs:262`), not the reference's word `not`.
    let rule = parse_one("p(X, Y) :- edge(X, Y, \"CALLS\"), \\+ node(Y, \"STUB\").");
    let (id, facts) = encode_rule(&rule).expect("encode");
    assert_eq!(id, rule_id(&rule));

    let names: Vec<&str> = facts.iter().map(|f| f.predicate.as_str()).collect();
    assert_eq!(
        names,
        vec![REL_RULE, REL_CONCLUSION_LIT, REL_PREMISE_LIT, REL_PREMISE_LIT],
        "Projection T is three relations and nothing else — no concludes/has_premise/premise_pos"
    );

    // rule(Id)
    assert_eq!(facts[0].args, vec![rofl_atom(&id)]);
    // conclusion_lit(Id, 1, $lit(p, main, $cons($var("X"), $cons($var("Y"), $nil)), $now))
    assert_eq!(facts[1].args[1], Value::Int(1));
    assert_eq!(
        facts[1].args[2],
        reify_atom(&Atom::new("p", vec![Term::var("X"), Term::var("Y")])).unwrap()
    );
    // premise_lit(Id, 1, …) and premise_lit(Id, 2, $not(…)) — numbered from 1.
    assert_eq!(facts[2].args[1], Value::Int(1));
    assert_eq!(facts[3].args[1], Value::Int(2));
    let neg = &facts[3].args[2];
    match neg {
        Value::Term(t) => assert_eq!(t.functor, "$not", "a negative premise reifies as $not"),
        other => panic!("expected $not, got {other:?}"),
    }
}

/// The rule id is content-addressed over the canonical clause, so two spellings of one
/// clause reflect onto ONE rule and re-encoding is idempotent at the storage level.
#[test]
fn re_encoding_the_same_program_writes_no_duplicate_record() {
    let mut db = Db::new();
    let rule = parse_one("p(X) :- node(X, \"FUNCTION\").");
    let spaced = parse_one("p( X ) :-  node( X , \"FUNCTION\" ) .");
    assert_eq!(rule_id(&rule), rule_id(&spaced), "whitespace must not change rule identity");

    let first = encode_rules_to_records(&[&rule]).expect("encode");
    let n = first.len();
    db.commit(first);
    db.flush();
    assert_eq!(db.view().reflected_facts().len(), n);

    let second = encode_rules_to_records(&[&spaced]).expect("encode again");
    db.commit(second);
    db.flush();
    let after = db.view().reflected_facts();
    assert_eq!(after.len(), n, "re-encoding must not create a second copy");
}

// ── Step 5: decoding ───────────────────────────────────────────────

/// Every rule pack this build ships must survive encode → store → decode unchanged, up to
/// the canonical clause order [`decode_rules`] imposes. A single lost or reordered premise
/// fails it.
///
/// The pack count is pinned rather than lower-bounded: a shrinking registry would silently
/// weaken this test into proving nothing, and the count is exactly what
/// `derive::stdlib::STDLIB_PACKS` ships (MEASURED as 40, not the 42 quoted in older notes).
#[test]
fn every_shipped_rule_pack_round_trips_through_the_store() {
    let packs = crate::derive::stdlib::STDLIB_PACKS;
    assert_eq!(packs.len(), 40, "the shipped pack registry changed size");

    let mut checked = 0usize;
    for (name, source) in packs {
        let program = crate::derive::parser_ext::parse_ext_program(source)
            .unwrap_or_else(|e| panic!("pack {name} must parse: {e}"));
        let rules = program.rules();

        let mut db = Db::new();
        let records = encode_rules_to_records(&rules)
            .unwrap_or_else(|e| panic!("pack {name} must encode: {e}"));
        db.commit(records);
        db.flush();

        let decoded = decode_rules(&db.view());
        assert!(
            decoded.diagnostics.is_empty(),
            "pack {name} decoded with diagnostics: {:?}",
            decoded.diagnostics
        );

        let mut expected: Vec<String> = rules.iter().map(|r| canon_clause(r)).collect();
        expected.sort();
        expected.dedup();
        let got: Vec<String> = decoded.rules.iter().map(canon_clause).collect();
        assert_eq!(got, expected, "pack {name} did not round-trip");

        // Structural equality too — canon text alone could hide a term-kind confusion.
        let mut expected_rules: Vec<(String, Rule)> =
            rules.iter().map(|r| (canon_clause(r), (*r).clone())).collect();
        expected_rules.sort_by(|a, b| a.0.cmp(&b.0));
        expected_rules.dedup_by(|a, b| a.0 == b.0);
        let expected_structs: Vec<Rule> = expected_rules.into_iter().map(|(_, r)| r).collect();
        assert_eq!(decoded.rules, expected_structs, "pack {name} decoded to different rule ASTs");
        checked += 1;
    }
    assert_eq!(checked, packs.len(), "only {checked} packs were checked");
}

/// The four outcomes of an INCOMPLETE reflection, reproduced from the reference
/// (`vendor/rofl-v0/src/reflect.ts:200-213`). They are not identical and must not be
/// "fixed" into one another — `p3-malformed-sibling` stands on exactly this asymmetry.
#[test]
fn an_incomplete_reflection_has_the_four_reference_outcomes() {
    let rule = parse_one("p(X) :- node(X, \"FUNCTION\"), attr(X, \"file\", F).");
    let (id, facts) = encode_rule(&rule).expect("encode");

    let decode_from = |kept: Vec<ReflectedFact>| -> DecodedRules {
        let mut db = Db::new();
        let records: Vec<NodeRecordV2> =
            kept.iter().map(|f| f.to_node_record().expect("record")).collect();
        db.commit(records);
        db.flush();
        decode_rules(&db.view())
    };

    // Control: the complete set decodes to exactly the rule.
    let full = decode_from(facts.clone());
    assert_eq!(full.rules, vec![rule.clone()]);
    assert!(full.diagnostics.is_empty());

    // (1) no `rule/1` — invisible, and NO diagnostic (the enumerator runs over it).
    let no_enum: Vec<ReflectedFact> =
        facts.iter().filter(|f| f.predicate != REL_RULE).cloned().collect();
    let r1 = decode_from(no_enum);
    assert!(r1.rules.is_empty(), "without rule/1 the rule must be invisible");
    assert!(r1.diagnostics.is_empty(), "and silent: {:?}", r1.diagnostics);

    // (2) no `conclusion_lit` — skipped WITH a diagnostic.
    let no_head: Vec<ReflectedFact> =
        facts.iter().filter(|f| f.predicate != REL_CONCLUSION_LIT).cloned().collect();
    let r2 = decode_from(no_head);
    assert!(r2.rules.is_empty());
    assert_eq!(r2.diagnostics, vec![format!("rule {id}: missing conclusion reflection; skipped")]);

    // (3) NO premise at all — the rule silently becomes an unconditional fact. The most
    // dangerous edge, and it is the reference's behavior, so it is reproduced, not fixed.
    let no_body: Vec<ReflectedFact> =
        facts.iter().filter(|f| f.predicate != REL_PREMISE_LIT).cloned().collect();
    let r3 = decode_from(no_body);
    assert_eq!(r3.rules.len(), 1);
    assert!(r3.rules[0].body().is_empty(), "an empty premise set yields an unconditional rule");
    assert!(r3.diagnostics.is_empty(), "and it is silent: {:?}", r3.diagnostics);

    // (4) SOME premises missing — a shorter body executes, no diagnostic; holes in the
    // numbering collapse rather than shift the surviving premises.
    let mut dropped_second = Vec::new();
    for f in &facts {
        let is_second_premise =
            f.predicate == REL_PREMISE_LIT && f.args.get(1) == Some(&Value::Int(1));
        if !is_second_premise {
            dropped_second.push(f.clone());
        }
    }
    let r4 = decode_from(dropped_second);
    assert_eq!(r4.rules.len(), 1);
    assert_eq!(r4.rules[0].body().len(), 1, "one premise dropped ⇒ a one-premise rule");
    assert_eq!(
        r4.rules[0].body()[0],
        rule.body()[1].clone(),
        "the SURVIVING premise must be the one that was kept, not a shifted neighbour"
    );
    assert!(r4.diagnostics.is_empty(), "and it is silent: {:?}", r4.diagnostics);
}

/// An undecodable reflection is skipped WITH a diagnostic — never silently, and never
/// taking the rest of the store down with it.
#[test]
fn an_undecodable_reflection_is_skipped_with_a_diagnostic() {
    let good = parse_one("p(X) :- node(X, \"FUNCTION\").");
    let (_gid, good_facts) = encode_rule(&good).expect("encode");

    // A rule whose head reflection is not a `$lit` at all.
    let bad_id = "rdeadbeef";
    let mut facts = good_facts.clone();
    facts.push(ReflectedFact::new(REL_RULE, vec![rofl_atom(bad_id)]));
    facts.push(ReflectedFact::new(
        REL_CONCLUSION_LIT,
        vec![rofl_atom(bad_id), Value::Int(1), Value::Str("not a literal".into())],
    ));

    let mut db = Db::new();
    let records: Vec<NodeRecordV2> =
        facts.iter().map(|f| f.to_node_record().expect("record")).collect();
    db.commit(records);
    db.flush();

    let decoded = decode_rules(&db.view());
    assert_eq!(decoded.rules, vec![good], "the healthy rule must survive its broken neighbour");
    assert_eq!(decoded.diagnostics.len(), 1);
    assert!(
        decoded.diagnostics[0].starts_with(&format!("rule {bad_id}: undecodable reflection")),
        "unexpected diagnostic: {}",
        decoded.diagnostics[0]
    );
}

/// A perspective or a temporal scope this slice does not implement must be REFUSED with a
/// diagnostic, not quietly reinterpreted as `main` / `$now`.
#[test]
fn a_foreign_perspective_is_refused_rather_than_reinterpreted() {
    let head_in_audit = functor(
        "$lit",
        vec![
            rofl_atom("p"),
            rofl_atom("audit"),
            reify_list(vec![functor("$var", vec![Value::Str("X".into())]).unwrap()]).unwrap(),
            rofl_atom(REFLECT_TEMPORAL),
        ],
    )
    .unwrap();
    let err = unreify_atom(&head_in_audit).expect_err("a foreign perspective must be refused");
    assert_eq!(err.code, E_REFLECT_DECODE);
    assert!(err.detail.contains("perspective"), "{}", err.detail);
}

/// Terms that Projection T cannot represent are refused at ENCODE time with a code — the
/// encoder never emits a lossy approximation.
#[test]
fn an_unrepresentable_term_is_refused_at_encode_time() {
    let rule = Rule::fact(Atom::new("p", vec![Term::Lit(Value::Str("ambiguous".into()))]));
    let err = encode_rule(&rule).expect_err("a Lit(Str) must be refused");
    assert_eq!(err.code, E_REFLECT_ENCODE);
}

/// Every value variant the storage blob can carry must survive the JSON round trip
/// bit-for-bit — including an i64 past 2^53 and a float, which a naive JSON number encoding
/// would corrupt.
#[test]
fn every_value_variant_round_trips_through_the_metadata_blob() {
    let deep = functor(
        "$lit",
        vec![
            rofl_atom("p"),
            rofl_atom("main"),
            reify_list(vec![Value::Str("s".into()), Value::Int(-7)]).unwrap(),
            rofl_atom("$now"),
        ],
    )
    .unwrap();
    let fact = ReflectedFact::new(
        "probe",
        vec![
            Value::Id(0x0123_4567_89ab_cdef_0123_4567_89ab_cdefu128),
            Value::Str("escapes: \" \\ \n ✓".into()),
            Value::Int(9_007_199_254_740_993), // 2^53 + 1: unrepresentable as a JS number
            Value::float(1.5),
            Value::big_int_from_decimal("340282366920938463463374607431768211457").unwrap(),
            deep,
        ],
    );
    let blob = fact.to_metadata_json();
    let back = ReflectedFact::from_metadata_json(&blob).expect("round trip");
    assert_eq!(back, fact);
    assert_eq!(back.fact_id().unwrap(), fact.fact_id().unwrap());
}

/// A rule with a wildcard — RFDB has one, ROFL v0 does not — must round-trip. Without
/// `$wild` a large share of the shipped packs would silently lose a term.
#[test]
fn a_wildcard_term_round_trips() {
    let rule = parse_one("p(X) :- edge(X, _, \"CALLS\").");
    let (_, facts) = encode_rule(&rule).expect("encode");
    let head = &facts[2].args[2];
    let back = unreify_body_elem(head).expect("decode");
    assert_eq!(back, Literal::Positive(Atom::new("edge", vec![
        Term::var("X"),
        Term::Wildcard,
        Term::Const("CALLS".into()),
    ])));
}

// ── Ordering, identity and the write-side gates ────────────────────

/// A CONTESTED slot — one rule id, two `conclusion_lit` facts in slot 1 — must resolve the
/// way the reference resolves it, and the reference's answer is not "whatever the storage
/// hands us last".
///
/// The reference's `Store.relAll` walks a per-relation index kept canonically sorted by
/// `factKey = rel[persp](canonTerm(args))` at all times (`store.ts:48-59`), so its
/// documented "last one wins" means *lexicographically greatest FACT KEY*, independent of
/// insertion order. Sorting the scan by the content-addressed node id instead is equally
/// deterministic but ARBITRARY — a BLAKE3 hash orders unrelated to the key.
///
/// Ground truth, measured on the reference (probe `/tmp/fix-tiebreak-oracle.mts`, run from
/// `packages/rofl-conformance` with `node --experimental-strip-types`, positive control
/// `load.ok = true` first), in BOTH insertion orders:
///
/// ```text
/// keyA=$lit(h,main,$cons($var("X"),$nil),$now)
/// keyB=$lit(zzz,main,$cons($var("X"),$nil),$now)
/// WINNER = ["zzz[main](?X)@now :- a[main](?X)@now"]     (both orders)
/// keyA=$lit(aaa,…) keyB=$lit(bbb,…) WINNER = ["bbb[main](?X)@now :- …"]  (both orders)
/// ```
///
/// The pair is SEARCHED FOR rather than hard-coded, and the search demands a pair on which
/// the two candidate orders DISAGREE: greater fact key but smaller node id. On a hard-coded
/// pair a hash order agrees with the key order half the time, so the test would pass under
/// the wrong rule by luck — it did, on `h`/`zzz`, until this search replaced it.
#[test]
fn a_contested_conclusion_slot_resolves_the_way_the_reference_resolves_it() {
    const RID: &str = "rCONTEST";
    let premise = {
        let r = parse_one("h(X) :- a(X).");
        reify_body_elem(&r.body()[0]).expect("reify")
    };
    let conclusion = |pred: &str| -> (ReflectedFact, u128) {
        let rule = parse_one(&format!("{pred}(X) :- a(X)."));
        let head = reify_atom(rule.head()).expect("reify");
        let f = ReflectedFact::new(
            REL_CONCLUSION_LIT,
            vec![rofl_atom(RID), Value::Int(1), head],
        );
        let id = f.fact_id().expect("id");
        (f, id)
    };

    // Search for a discriminating pair: `hi` has the greater fact key AND the smaller node
    // id, so key order and id order name different winners.
    let candidates: Vec<(String, ReflectedFact, u128)> = (0..60)
        .map(|i| {
            let pred = format!("p{i}");
            let (f, id) = conclusion(&pred);
            (pred, f, id)
        })
        .collect();
    let mut found: Option<(&(String, ReflectedFact, u128), &(String, ReflectedFact, u128))> = None;
    'outer: for a in &candidates {
        for b in &candidates {
            if a.1.fact_key() < b.1.fact_key() && a.2 < b.2 {
                // a: smaller key, smaller id  → b: greater key, GREATER id. Not discriminating.
                continue;
            }
            if a.1.fact_key() < b.1.fact_key() && a.2 > b.2 {
                found = Some((a, b));
                break 'outer;
            }
        }
    }
    let (lo, hi) = found.expect(
        "no discriminating pair among 60 candidates — the search itself is broken, since a \
         hash order disagrees with a key order about half the time",
    );

    for order in [[&lo.1, &hi.1], [&hi.1, &lo.1]] {
        let mut facts = vec![ReflectedFact::new(REL_RULE, vec![rofl_atom(RID)])];
        for f in order {
            facts.push((*f).clone());
        }
        facts.push(ReflectedFact::new(
            REL_PREMISE_LIT,
            vec![rofl_atom(RID), Value::Int(1), premise.clone()],
        ));

        let mut db = Db::new();
        let records: Vec<NodeRecordV2> =
            facts.iter().map(|f| f.to_node_record().expect("record")).collect();
        db.commit(records);
        db.flush();
        let decoded = decode_rules(&db.view());

        assert_eq!(decoded.rules.len(), 1, "one enumerated id ⇒ one rule");
        assert_eq!(
            decoded.rules[0].head().predicate(),
            hi.0,
            "the reference keeps the greater FACT KEY ('{}' over '{}'); this pair was chosen \
             because the node-id order says the opposite ({:032x} < {:032x}), so picking \
             '{}' means the scan is still ordered by hash",
            hi.0,
            lo.0,
            hi.2,
            lo.2,
            lo.0
        );
    }
}

/// The scan key IS the reference's `factKey`, spelled out — the property the tie-break
/// above rests on. Measured against the reference's own `canonTerm` output (same probe):
/// `$lit(h,main,$cons($var("X"),$nil),$now)`.
#[test]
fn the_scan_key_is_the_references_fact_key() {
    let rule = parse_one("h(X) :- a(X).");
    let head = reify_atom(rule.head()).expect("reify");
    let fact =
        ReflectedFact::new(REL_CONCLUSION_LIT, vec![rofl_atom("rabc"), Value::Int(1), head]);
    assert_eq!(
        fact.fact_key(),
        r#"conclusion_lit[main](rabc,1,$lit(h,main,$cons($var("X"),$nil),$now))"#
    );
}

/// The fact id carries the PERSPECTIVE, per the fact model
/// (`fid = BLAKE3(canon(perspective, predicate, tuple))`, `derive/canon.rs:4`) and the
/// reference's `factKey` (`store.ts:25-27`).
///
/// Nothing collides today — the perspective is the constant `main` — so this is checked
/// structurally: the id must NOT be the hash of the bare tuple, which is what leaving the
/// perspective out would produce, and which would alias two perspectives' facts onto one
/// node the day perspectives land.
#[test]
fn the_fact_id_is_keyed_by_perspective() {
    let fact = ReflectedFact::new(REL_RULE, vec![rofl_atom("rabc")]);
    let bare = {
        let term = crate::datalog::TermBlob::new(
            fact.predicate.clone(),
            fact.args.clone().into_boxed_slice(),
        )
        .expect("term");
        let mut bytes = Vec::new();
        crate::derive::canon::canon_bytes(
            &Value::Term(std::sync::Arc::new(term)),
            &mut bytes,
        )
        .expect("canon");
        u128::from_le_bytes(blake3::hash(&bytes).as_bytes()[0..16].try_into().unwrap())
    };
    assert_ne!(
        fact.fact_id().expect("id"),
        bare,
        "the id must be keyed by perspective, not by the bare tuple"
    );
    // Still content-addressed: same fact, same id.
    assert_eq!(fact.fact_id().unwrap(), fact.clone().fact_id().unwrap());
}

/// Two DIFFERENT clauses under one rule id must be REFUSED at encode time.
///
/// The rule id is the reference's: `r` + a 32-bit FNV-1a of the canonical clause. Thirty-two
/// bits is a birthday bound, not a guarantee, and reflection is additive — a collision
/// would merge the two clauses' premises into a rule nobody wrote, silently, because the
/// decoder assembles a rule from every fact carrying its id.
#[test]
fn two_clauses_under_one_rule_id_are_refused_at_encode_time() {
    let a = parse_one("h(X) :- a(X).");
    let b = parse_one("zzz(X) :- c(X).");
    let id_a = rule_id(&a);

    // Simulate the collision by declaring `a`'s id already taken by `b`'s clause.
    let mut already = StoreRuleIndex::default();
    already.canon_by_rule_id.insert(id_a.clone(), canon_clause(&b));

    let err = encode_rules_to_records_beside(&[&a], &already)
        .expect_err("a collision must be refused, not merged");
    assert_eq!(err.code, E_REFLECT_ENCODE, "{err}");

    // Positive control: the SAME clause under the same id is idempotence, not a collision.
    let mut same = StoreRuleIndex::default();
    same.canon_by_rule_id.insert(id_a.clone(), canon_clause(&a));
    assert!(encode_rules_to_records_beside(&[&a], &same).is_ok());

    // …and the plain entry (empty store) still encodes both rules side by side.
    assert!(encode_rules_to_records(&[&a, &b]).is_ok());
}

/// `rule_index` reports what the store CLAIMS (enumerated id → decoded clause) — the input
/// the collision gate needs.
#[test]
fn the_rule_index_reports_what_the_store_claims() {
    let rule = parse_one("p(X) :- node(X, \"FUNCTION\").");
    let records = encode_rules_to_records(&[&rule]).expect("encode");
    let mut db = Db::new();
    db.commit(records);
    db.flush();

    let index = rule_index(&db.view());
    assert_eq!(index.canon_by_rule_id.len(), 1);
    assert_eq!(
        index.canon_by_rule_id.get(&rule_id(&rule)).map(String::as_str),
        Some(canon_clause(&rule).as_str())
    );
    assert!(index.claims.is_empty(), "a store with no supersession carries no claims");
}

/// A program Projection T cannot carry WHOLE is refused rather than reflected minus the
/// parts that do not fit.
///
/// Annotations are not only a write-back concern: `@materialize` / `@materialize_node` feed
/// the stratifier (`derive/stratify.rs:205-233` — a materialized type is a cross-run
/// producer and earns a dependency edge), so a store built by dropping them could stratify
/// differently from the text it came from, and with negation that changes the ANSWER, not
/// just the write-back.
#[test]
fn a_program_projection_t_cannot_carry_whole_is_refused() {
    let plain = crate::derive::parser_ext::parse_ext_program("p(X) :- node(X, \"FUNCTION\").")
        .expect("parse");
    assert!(refuse_unreflectable_program(&plain).is_ok(), "positive control: a plain program");

    let annotated = crate::derive::parser_ext::parse_ext_program(
        "@materialize(edge_type=\"REACHES\")\np(X, Y) :- edge(X, Y, \"CALLS\").",
    )
    .expect("parse");
    let err = refuse_unreflectable_program(&annotated).expect_err("annotations must refuse");
    assert_eq!(err.code, E_REFLECT_MODE, "{err}");
}

/// A skipped reflection reaches the OBSERVER, not just the return value.
///
/// The engine-level sibling of this test (`graph/engine_v2.rs`) cannot check this: the
/// engine installs [`crate::derive::events::EventLog::discard`], so the trace it would
/// inspect does not exist there. This is the level where a sink can be installed, so this
/// is where the claim "a skip is never silent" is actually measured — one
/// [`crate::derive::events::EventKind::ReflectSkipped`] carrying the decoder's diagnostic
/// verbatim, emitted before the fixpoint, on the same trace the answer is.
///
/// Both controls are here on purpose:
/// * positive — the healthy neighbour still answers (rows are non-empty), so the event is
///   not the report of a wholesale decode failure;
/// * negative — the same store WITHOUT the broken rule emits NO such event, so the
///   assertion is not satisfied by an event the decoder emits unconditionally.
#[test]
fn a_skipped_reflection_is_emitted_on_the_event_trace() {
    use crate::derive::events::{EventKind, EventLog, SharedMemSink};

    fn run(with_broken: bool) -> (Vec<String>, usize) {
        let mut db = Db::new();
        db.commit(vec![
            ordinary_node("fnA", "FUNCTION", "fnA", "f.js"),
            ordinary_node("fnB", "FUNCTION", "fnB", "f.js"),
        ]);

        let healthy = parse_one("p(X) :- node(X, \"FUNCTION\").");
        let (_id, mut facts) = encode_rule(&healthy).expect("encode");
        if with_broken {
            // A head reflection that is not a literal at all: `rule/1` names it, so the
            // decoder must SEE it, and `conclusion_lit` is unusable, so it must SKIP it.
            let bad = "rdeadbeef";
            facts.push(ReflectedFact::new(REL_RULE, vec![rofl_atom(bad)]));
            facts.push(ReflectedFact::new(
                REL_CONCLUSION_LIT,
                vec![rofl_atom(bad), Value::Int(1), Value::Str("not a literal".into())],
            ));
        }
        let records: Vec<NodeRecordV2> =
            facts.iter().map(|f| f.to_node_record().expect("record")).collect();
        db.commit(records);
        db.flush();

        let sink = SharedMemSink::new();
        let stats = crate::derive::builtin::Stats {
            total_nodes: 2,
            total_edges: 0,
            ..Default::default()
        };
        let eval = crate::derive::evaluate_in(
            &db.view(),
            "",
            crate::derive::RuleSource::Store,
            stats,
            crate::datalog::EvalLimits::none(),
            EventLog::with_sink(Box::new(sink.clone())),
        )
        .expect("evaluate from store");

        let skips: Vec<String> = sink
            .events()
            .into_iter()
            .filter_map(|e| match e.kind {
                EventKind::ReflectSkipped { detail } => Some(detail),
                _ => None,
            })
            .collect();
        (skips, eval.facts("p").len())
    }

    let (clean_skips, clean_rows) = run(false);
    assert!(
        clean_skips.is_empty(),
        "negative control: a healthy store must emit no skip, got {clean_skips:?}"
    );
    assert_eq!(clean_rows, 2, "negative control: the healthy rule answers");

    let (skips, rows) = run(true);
    assert_eq!(
        skips.len(),
        1,
        "exactly one skip must reach the trace, got {skips:?}"
    );
    assert!(
        skips[0].contains("rdeadbeef"),
        "the diagnostic must name the rule it dropped, got {:?}",
        skips[0]
    );
    assert_eq!(
        rows, 2,
        "positive control: the healthy neighbour still answers"
    );
}

// ── Supersession: the acceptance criterion of the rules-as-data slice ──
//
// «superseding rule → old derivations superseded, history intact; no retract API exists.»
//
// Every test below carries the control the criterion needs and is easy to fake without: a
// superseded rule stops deriving, so the WRONG answer and the BROKEN answer are both the
// empty set. So each measurement pins a NON-EMPTY answer before and a DIFFERENT NON-EMPTY
// answer after, and where the counts allow it, the "both rules still live" count too — the
// fixture is chosen so 2 / 1 / 3 / 0 mean four distinct things.

/// A store holding a program, ready to be superseded: two FUNCTIONs and one CLASS, so
/// "the old rule" answers 2, "the new rule" answers 1, "both" answers 3 and "broken"
/// answers 0 — four outcomes no two of which can be confused.
fn supersession_fixture() -> Db {
    let mut db = Db::new();
    db.commit(vec![
        ordinary_node("a.js->FUNCTION->f", "FUNCTION", "f", "a.js"),
        ordinary_node("a.js->FUNCTION->g", "FUNCTION", "g", "a.js"),
        ordinary_node("b.js->CLASS->C", "CLASS", "C", "b.js"),
    ]);
    db
}

/// Derive `p` out of the STORE's rules and return the rows.
fn store_mode_p(db: &Db) -> Vec<Box<[Value]>> {
    let stats = crate::derive::builtin::Stats {
        total_nodes: 3,
        total_edges: 0,
        ..Default::default()
    };
    let eval = crate::derive::evaluate_in(
        &db.view(),
        "",
        crate::derive::RuleSource::Store,
        stats,
        crate::datalog::EvalLimits::none(),
        crate::derive::events::EventLog::discard(),
    )
    .expect("evaluate from store");
    eval.facts("p")
}

/// Reflect a program's clauses into `db` the way `reflect_program` does — through
/// [`rule_index`], so the supersession gate sees exactly what the store claims.
fn reflect_into(db: &mut Db, source: &str) -> Result<usize, ReflectError> {
    let program = crate::derive::parser_ext::parse_ext_program(source).expect("parse");
    let rules = program.rules();
    let already = rule_index(&db.view());
    let records = encode_rules_to_records_beside(&rules, &already)?;
    let n = records.len();
    db.commit(records);
    db.flush();
    Ok(n)
}

/// (а) of the criterion: a rule declared as superseding the old one takes the old one's
/// DERIVATIONS out of force.
///
/// The two controls the criterion is worthless without:
/// * before — the same query at the same place answers 2 (non-empty), so the store and the
///   evaluator were working;
/// * after — it answers 1 (non-empty, and a DIFFERENT row: the CLASS, not the FUNCTIONs),
///   so the emptiness of the old rule is not the emptiness of a broken pipeline.
///
/// And 3 is spelled out as the failure it would be: additive reflection with no
/// supersession leaves both clauses live and answers 3.
#[test]
fn a_superseding_rule_takes_the_old_derivations_out_of_force() {
    let mut db = supersession_fixture();
    let old = parse_one("p(X) :- node(X, \"FUNCTION\").");
    let old_id = rule_id(&old);
    reflect_into(&mut db, "p(X) :- node(X, \"FUNCTION\").").expect("reflect the old rule");

    let before = store_mode_p(&db);
    assert_eq!(before.len(), 2, "positive control BEFORE: the old rule derives both FUNCTIONs");

    reflect_into(
        &mut db,
        &format!("p(X) :- node(X, \"CLASS\").\nsupersedes(\"{old_id}\")."),
    )
    .expect("reflect the superseding rule");

    let after = store_mode_p(&db);
    assert_eq!(
        after.len(),
        1,
        "positive control AFTER: the new rule derives the one CLASS — 3 would mean the old \
         rule is still live, 0 would mean nothing derived at all. Got {after:?}"
    );
    // Not just a different COUNT — a different row.
    assert_ne!(after[0], before[0], "the surviving derivation must be the new rule's");
    assert_ne!(after[0], before[1], "the surviving derivation must be the new rule's");
}

/// (б) of the criterion: HISTORY INTACT. The superseded rule is still in the store — its
/// facts are still there, and it still decodes into the clause that used to run.
///
/// Kept as its own test on purpose. "It stopped deriving" and "it is still on record" are
/// two different claims, and the second one is the one a deletion would silently fail.
#[test]
fn the_superseded_rule_stays_in_the_store_and_still_decodes() {
    let mut db = supersession_fixture();
    let old = parse_one("p(X) :- node(X, \"FUNCTION\").");
    let old_id = rule_id(&old);
    reflect_into(&mut db, "p(X) :- node(X, \"FUNCTION\").").expect("reflect");

    let facts_before = db.view().reflected_facts().len();
    let enumerator_fid = ReflectedFact::new(REL_RULE, vec![rofl_atom(&old_id)])
        .fact_id()
        .expect("fid");
    assert!(
        db.view().reflected_facts().iter().any(|(id, _)| *id == enumerator_fid),
        "control: the rule's enumerator fact is in the store before the supersession"
    );

    reflect_into(
        &mut db,
        &format!("p(X) :- node(X, \"CLASS\").\nsupersedes(\"{old_id}\")."),
    )
    .expect("reflect the superseding rule");

    // Nothing left. The store only grew.
    let facts_after = db.view().reflected_facts().len();
    assert!(
        facts_after > facts_before,
        "supersession must ADD records, never remove them: {facts_before} → {facts_after}"
    );
    assert!(
        db.view().reflected_facts().iter().any(|(id, _)| *id == enumerator_fid),
        "the superseded rule's enumerator fact must still be in the store"
    );

    // And it is still readable AS A RULE, not just as bytes.
    let decoded = decode_rules(&db.view());
    assert_eq!(
        decoded.superseded_ids,
        vec![old_id.clone()],
        "the decoder must report the superseded rule as history, not drop it"
    );
    assert_eq!(
        decoded.superseded_rules,
        vec![old],
        "the history entry must decode to the clause that used to run"
    );
    assert_eq!(decoded.rules.len(), 1, "exactly one rule is in force");
    assert_eq!(decoded.claims.len(), 1, "one claim, and it is on the record too");

    // The write door still knows the dead id is taken — a new clause colliding with it
    // would merge its premises with facts that never went away.
    assert!(
        rule_index(&db.view()).canon_by_rule_id.contains_key(&old_id),
        "a superseded rule keeps its id reserved"
    );
}

/// (б) again, past the one event that can quietly undo it: COMPACTION.
///
/// «History intact until the first compaction» is not history. Compaction folds segments
/// and applies tombstones, so a store that keeps a superseded rule only because nothing has
/// rewritten the segments yet has not proven anything.
#[test]
fn the_superseded_rule_survives_a_full_compaction() {
    use crate::storage_v2::compaction::types::CompactionConfig;

    let mut db = supersession_fixture();
    let old = parse_one("p(X) :- node(X, \"FUNCTION\").");
    let old_id = rule_id(&old);
    reflect_into(&mut db, "p(X) :- node(X, \"FUNCTION\").").expect("reflect");
    reflect_into(
        &mut db,
        &format!("p(X) :- node(X, \"CLASS\").\nsupersedes(\"{old_id}\")."),
    )
    .expect("reflect the superseding rule");

    let before = db.view().reflected_facts().len();
    assert!(before >= 7, "control: the store carries both rules and the claim, got {before}");

    // `segment_threshold: 1` + `l1_fanout: 1.0` is the FULL merge — the policy that
    // rewrites every run and physically drops what it decides is obsolete.
    let result = db
        .store
        .compact(&mut db.manifest, &CompactionConfig { segment_threshold: 1, l1_fanout: 1.0 })
        .expect("compact");
    assert!(
        !result.shards_compacted.is_empty(),
        "control: the compaction must actually have run, got {result:?}"
    );

    let after = db.view().reflected_facts().len();
    assert_eq!(after, before, "compaction must not drop a reflected record");

    let decoded = decode_rules(&db.view());
    assert_eq!(
        decoded.superseded_rules,
        vec![old],
        "the superseded rule must still decode AFTER the merge rewrote the segments"
    );
    assert_eq!(store_mode_p(&db).len(), 1, "and the live answer is unchanged by compaction");
}

/// The gate above locks a FORM (a directive must arrive with a rule). This test states
/// what that buys — and, just as importantly, what it does not.
///
/// A superseding rule that happens to derive NOTHING on today's data is accepted, and the
/// live answer really does go to zero. Read on its own that looks like the retraction the
/// spec forbids: «take this rule out, put nothing in its place». It is not, and the
/// difference is mechanical rather than rhetorical — SOMETHING was put in its place, and
/// the store can be asked what:
///
///   * the replacement is on record as a rule in force, with its clause;
///   * the superseded rule is on record as history, with the clause that used to run;
///   * the claim names which rule replaced which;
///   * and because supersession is a live-claim law and not a «dead» bit, superseding the
///     replacement brings the original back — which a deletion could never do.
///
/// A gate on «the replacement must derive something» is deliberately NOT added: derivability
/// is a property of the data, so such a gate would refuse a program today and accept the
/// identical one tomorrow.
#[test]
fn a_superseding_rule_that_derives_nothing_is_still_a_supersession() {
    let mut db = supersession_fixture();
    let old = parse_one("p(X) :- node(X, \"FUNCTION\").");
    let old_id = rule_id(&old);
    let vacuous = parse_one("p(X) :- node(X, \"NOSUCHTYPE\").");
    let vacuous_id = rule_id(&vacuous);
    reflect_into(&mut db, "p(X) :- node(X, \"FUNCTION\").").expect("reflect");
    assert_eq!(store_mode_p(&db).len(), 2, "control: the old rule answers 2 before");

    reflect_into(
        &mut db,
        &format!("p(X) :- node(X, \"NOSUCHTYPE\").\nsupersedes(\"{old_id}\")."),
    )
    .expect("a replacement that derives nothing is still a replacement");

    // The live answer really did go to zero — this test is not dodging the uncomfortable
    // half of the measurement.
    assert_eq!(store_mode_p(&db).len(), 0, "the old rule is out of force");

    // And here is what makes it a supersession and not a retraction.
    let decoded = decode_rules(&db.view());
    assert_eq!(
        decoded.ids,
        vec![vacuous_id.clone()],
        "a successor is IN FORCE — the store is not left ruleless"
    );
    assert_eq!(
        decoded.superseded_ids,
        vec![old_id.clone()],
        "and the old rule is history, not absence"
    );
    assert_eq!(
        decoded.superseded_rules,
        vec![old.clone()],
        "history still decodes to the clause that used to run"
    );
    assert_eq!(
        decoded.claims,
        vec![(vacuous_id.clone(), old_id.clone())],
        "the record says exactly which rule replaced which"
    );

    // The sharpest evidence: supersede the replacement and the original is back. A rule
    // that had been RETRACTED could not return.
    reflect_into(
        &mut db,
        &format!("p(X) :- node(X, \"CLASS\").\nsupersedes(\"{vacuous_id}\")."),
    )
    .expect("supersede the replacement");
    assert_eq!(
        store_mode_p(&db).len(),
        3,
        "the original (2 FUNCTIONs) is live again beside the new rule (1 CLASS) — 1 would \
         mean the original stayed dead, 0 that the store broke"
    );
}

/// (б) again, past the OTHER event that can quietly undo it: a RESTART.
///
/// The compaction test above proves the record survives a segment rewrite; it does not
/// prove it survives being read back from scratch. Everything in the fixture up to that
/// point has passed through one live `MultiShardStore` — memtables, caches and all — so a
/// history that lived only in memory would have looked exactly the same. Here the store
/// and the manifest are dropped and re-opened on the same bytes, and history is asked for
/// again on the other side.
#[test]
fn the_superseded_rule_survives_a_restart() {
    let mut db = supersession_fixture();
    let old = parse_one("p(X) :- node(X, \"FUNCTION\").");
    let old_id = rule_id(&old);
    reflect_into(&mut db, "p(X) :- node(X, \"FUNCTION\").").expect("reflect");
    reflect_into(
        &mut db,
        &format!("p(X) :- node(X, \"CLASS\").\nsupersedes(\"{old_id}\")."),
    )
    .expect("reflect the superseding rule");

    let before = db.view().reflected_facts().len();
    assert!(before >= 7, "control: the store carries both rules and the claim, got {before}");
    assert_eq!(store_mode_p(&db).len(), 1, "control: the new rule is the one in force");

    db.reopen();

    // (б): the superseded rule is still on record, and still decodes to the clause that
    // used to run — read off disk by a store that never saw it written.
    let decoded = decode_rules(&db.view());
    assert_eq!(
        decoded.superseded_ids,
        vec![old_id.clone()],
        "the superseded rule must still be reported as history after a restart"
    );
    assert_eq!(
        decoded.superseded_rules,
        vec![old],
        "and it must still decode to the clause that used to run"
    );
    assert_eq!(decoded.rules.len(), 1, "exactly one rule is in force after the restart");
    assert_eq!(decoded.claims.len(), 1, "the supersession claim is on disk too");
    assert_eq!(
        db.view().reflected_facts().len(),
        before,
        "the restart must not have lost a single reflected record"
    );

    // (а) survived with it: the old rule is still OUT of force, not resurrected by the
    // reload. 2 here would be the old rule answering again, 0 a store read that failed.
    assert_eq!(store_mode_p(&db).len(), 1, "the supersession is still in effect");

    // And the write door still knows the dead id is taken.
    assert!(
        rule_index(&db.view()).canon_by_rule_id.contains_key(&old_id),
        "a superseded rule keeps its id reserved across a restart"
    );
}

/// The recursion, not a flag: supersede the SUPERSEDER and the first rule is back in force.
///
/// This is the fact layer's §2.4 rule verbatim — an utterance is live unless a LIVE
/// utterance supersedes it — and it is the sharpest evidence that supersession here is that
/// law rather than a "dead" bit written onto a record. A bit could not come back.
#[test]
fn superseding_the_superseder_brings_the_first_rule_back() {
    let mut db = supersession_fixture();
    let r1 = parse_one("p(X) :- node(X, \"FUNCTION\").");
    let r2 = parse_one("p(X) :- node(X, \"CLASS\").");
    let (id1, id2) = (rule_id(&r1), rule_id(&r2));

    reflect_into(&mut db, "p(X) :- node(X, \"FUNCTION\").").expect("reflect r1");
    assert_eq!(store_mode_p(&db).len(), 2, "control: r1 alone answers 2");

    reflect_into(&mut db, &format!("p(X) :- node(X, \"CLASS\").\nsupersedes(\"{id1}\")."))
        .expect("r2 supersedes r1");
    assert_eq!(store_mode_p(&db).len(), 1, "control: r2 alone answers 1");

    // A third rule supersedes r2. r2's claim on r1 dies with it, so r1 is live again — and
    // r3 adds nothing of its own, so the answer must be r1's 2, not 0 and not 3.
    reflect_into(
        &mut db,
        &format!("p(X) :- node(X, \"FUNCTION\"), node(X, \"FUNCTION\").\nsupersedes(\"{id2}\")."),
    )
    .expect("r3 supersedes r2");

    let decoded = decode_rules(&db.view());
    assert_eq!(
        decoded.superseded_ids,
        vec![id2],
        "only r2 is out of force now; r1 came back when the claim against it died"
    );
    assert_eq!(
        store_mode_p(&db).len(),
        2,
        "r1 derives both FUNCTIONs again — 1 would mean r2 still live, 0 a broken store"
    );
}

/// «No retract — supersede only», enforced at the write door rather than asserted in a
/// comment: a supersession with no rule to carry it is REFUSED.
///
/// What this gate actually holds, stated precisely because the loose version of it is
/// wrong: a supersession must ARRIVE WITH A REPLACEMENT RULE. A program that is nothing
/// but `supersedes(rX).` names no successor, so the store would end up with a rule out of
/// force and no record of what replaced it — a deletion with extra steps.
///
/// What it deliberately does NOT hold: that the replacement must DERIVE something. A rule
/// deriving nothing today is a property of the DATA, not of the rule — add a matching node
/// tomorrow and the same clause fires — so a gate on derivability would refuse legitimate
/// rules today and pass the identical program tomorrow. The invariant that survives that
/// is the one measured in
/// [`a_superseding_rule_that_derives_nothing_is_still_a_supersession`]: whatever the
/// replacement derives, it is ON RECORD, and the audit trail names it as the successor.
#[test]
fn a_supersession_with_no_superseding_rule_is_refused() {
    let mut db = supersession_fixture();
    let old_id = rule_id(&parse_one("p(X) :- node(X, \"FUNCTION\")."));
    reflect_into(&mut db, "p(X) :- node(X, \"FUNCTION\").").expect("reflect");
    assert_eq!(store_mode_p(&db).len(), 2, "control: the rule answers before the attempt");

    let err = reflect_into(&mut db, &format!("supersedes(\"{old_id}\")."))
        .expect_err("a bare retraction must be refused");
    assert_eq!(err.code, E_REFLECT_SUPERSEDE, "{err}");

    assert_eq!(
        store_mode_p(&db).len(),
        2,
        "and the refusal changed nothing: the rule still answers"
    );

    // Positive control: the SAME directive with a rule beside it is accepted.
    reflect_into(
        &mut db,
        &format!("p(X) :- node(X, \"CLASS\").\nsupersedes(\"{old_id}\")."),
    )
    .expect("the same directive, carried by a rule, is legal");
    assert_eq!(store_mode_p(&db).len(), 1);
}

/// A supersession must resolve its victim in the store it is written against, or a typo
/// would be indistinguishable from a supersession that worked — the fact layer's D11
/// boundary, in Projection T's vocabulary.
#[test]
fn a_supersession_of_a_rule_the_store_does_not_carry_is_refused() {
    let mut db = supersession_fixture();
    reflect_into(&mut db, "p(X) :- node(X, \"FUNCTION\").").expect("reflect");

    let err = reflect_into(&mut db, "p(X) :- node(X, \"CLASS\").\nsupersedes(\"rdeadbeef\").")
        .expect_err("an unknown victim must be refused");
    assert_eq!(err.code, E_REFLECT_SUPERSEDE, "{err}");
    assert_eq!(store_mode_p(&db).len(), 2, "the refusal wrote nothing");

    // Positive control: the same shape with a victim that IS there goes through.
    let real = rule_id(&parse_one("p(X) :- node(X, \"FUNCTION\")."));
    reflect_into(&mut db, &format!("p(X) :- node(X, \"CLASS\").\nsupersedes(\"{real}\")."))
        .expect("a known victim is legal");
    assert_eq!(store_mode_p(&db).len(), 1);
}

/// A cycle is refused at the WRITE door, which is what keeps the read side total.
///
/// Mutual supersession has no single answer — "A in force, B out" and "B in force, A out"
/// both satisfy the recursion — so the fact layer makes cycles unbuildable by strict tick
/// monotonicity. Projection T has no tick, so it checks the graph instead
/// ([`crate::facts::supersession_order`]) and refuses.
#[test]
fn a_supersession_cycle_is_refused_at_the_write_door() {
    let mut db = supersession_fixture();
    let r1 = parse_one("p(X) :- node(X, \"FUNCTION\").");
    let r2 = parse_one("p(X) :- node(X, \"CLASS\").");
    let (id1, id2) = (rule_id(&r1), rule_id(&r2));

    reflect_into(&mut db, "p(X) :- node(X, \"FUNCTION\").").expect("reflect r1");
    reflect_into(&mut db, &format!("p(X) :- node(X, \"CLASS\").\nsupersedes(\"{id1}\")."))
        .expect("r2 supersedes r1");
    assert_eq!(store_mode_p(&db).len(), 1, "control: r2 is in force, r1 is not");

    // Now ask r1 to supersede r2 — closing the cycle r1 → r2 → r1.
    let err = reflect_into(
        &mut db,
        &format!("p(X) :- node(X, \"FUNCTION\").\nsupersedes(\"{id2}\")."),
    )
    .expect_err("a cycle must be refused");
    assert_eq!(err.code, E_REFLECT_SUPERSEDE, "{err}");
    assert_eq!(
        store_mode_p(&db).len(),
        1,
        "the refusal wrote nothing: the store is as it was"
    );

    // Positive control: a THIRD rule superseding r2 is not a cycle and is accepted.
    reflect_into(
        &mut db,
        &format!("p(X) :- node(X, \"FUNCTION\"), node(X, \"FUNCTION\").\nsupersedes(\"{id2}\")."),
    )
    .expect("an acyclic claim is legal");
    assert_eq!(store_mode_p(&db).len(), 2, "r1 is back, r2 is out");
}

/// The directive is a DIRECTIVE: it is never enumerated, never encoded as a rule and never
/// executed. A `supersedes` clause that leaked through as an ordinary ground fact would be
/// a rule nobody wrote, deriving into a reserved relation.
#[test]
fn the_supersede_directive_is_never_executed_as_a_rule() {
    let mut db = supersession_fixture();
    let old_id = rule_id(&parse_one("p(X) :- node(X, \"FUNCTION\")."));
    reflect_into(&mut db, "p(X) :- node(X, \"FUNCTION\").").expect("reflect");
    reflect_into(
        &mut db,
        &format!("p(X) :- node(X, \"CLASS\").\nsupersedes(\"{old_id}\")."),
    )
    .expect("reflect");

    let decoded = decode_rules(&db.view());
    assert!(
        decoded
            .rules
            .iter()
            .chain(decoded.superseded_rules.iter())
            .all(|r| r.head().predicate() != REL_SUPERSEDES),
        "no decoded rule may have the reserved head; got {:?}",
        decoded.rules
    );
    // Control: the claim IS in the store — it just is not a rule.
    assert_eq!(decoded.claims.len(), 1);
}

/// The reserved name is refused in shapes that are not a directive, rather than executed as
/// a user predicate — a program whose supersession quietly became an ordinary fact would
/// answer with the old rule still live and nothing would say so.
#[test]
fn the_reserved_name_in_a_non_directive_shape_is_refused() {
    let with_body = crate::derive::parser_ext::parse_ext_program(
        "supersedes(X) :- node(X, \"FUNCTION\").",
    )
    .expect("parse");
    let err = split_supersede_directives(&with_body.rules()).expect_err("a body is not a directive");
    assert_eq!(err.code, E_REFLECT_SUPERSEDE, "{err}");

    let wrong_arity =
        crate::derive::parser_ext::parse_ext_program("supersedes(\"ra\", \"rb\").").expect("parse");
    let err = split_supersede_directives(&wrong_arity.rules())
        .expect_err("the surface takes exactly one argument");
    assert_eq!(err.code, E_REFLECT_SUPERSEDE, "{err}");

    let non_ground =
        crate::derive::parser_ext::parse_ext_program("supersedes(X).").expect("parse");
    let err = split_supersede_directives(&non_ground.rules())
        .expect_err("a variable is not a rule id");
    assert_eq!(err.code, E_REFLECT_SUPERSEDE, "{err}");

    // Positive control: the directive shape splits cleanly and leaves the rule alone.
    let good = crate::derive::parser_ext::parse_ext_program(
        "p(X) :- node(X, \"CLASS\").\nsupersedes(\"rc66425ca\").",
    )
    .expect("parse");
    let (ordinary, victims) = split_supersede_directives(&good.rules()).expect("split");
    assert_eq!(ordinary.len(), 1);
    assert_eq!(victims, vec!["rc66425ca".to_string()]);
}

/// A supersession declaration cannot be EVALUATED as text: it names a rule in the store,
/// and as text there is no store — the rule it was meant to take out of force would keep
/// answering with no error attached.
#[test]
fn a_supersede_directive_cannot_be_evaluated_as_text() {
    let db = supersession_fixture();
    let stats = crate::derive::builtin::Stats {
        total_nodes: 3,
        total_edges: 0,
        ..Default::default()
    };
    let run = |src: &str| {
        crate::derive::evaluate_in(
            &db.view(),
            src,
            crate::derive::RuleSource::Text,
            stats.clone(),
            crate::datalog::EvalLimits::none(),
            crate::derive::events::EventLog::discard(),
        )
    };

    // Positive control: the same program WITHOUT the directive evaluates and answers.
    let ok = run("p(X) :- node(X, \"CLASS\").").expect("text mode evaluates");
    assert_eq!(ok.facts("p").len(), 1);

    let err = run("p(X) :- node(X, \"CLASS\").\nsupersedes(\"rc66425ca\").")
        .expect_err("text mode must refuse a supersession declaration");
    assert_eq!(err.code(), E_REFLECT_SUPERSEDE, "{err}");
}
