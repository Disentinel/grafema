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
    let mut already = std::collections::BTreeMap::new();
    already.insert(id_a.clone(), canon_clause(&b));

    let err = encode_rules_to_records_beside(&[&a], &already)
        .expect_err("a collision must be refused, not merged");
    assert_eq!(err.code, E_REFLECT_ENCODE, "{err}");

    // Positive control: the SAME clause under the same id is idempotence, not a collision.
    let mut same = std::collections::BTreeMap::new();
    same.insert(id_a.clone(), canon_clause(&a));
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
    assert_eq!(index.len(), 1);
    assert_eq!(index.get(&rule_id(&rule)).map(String::as_str), Some(canon_clause(&rule).as_str()));
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
