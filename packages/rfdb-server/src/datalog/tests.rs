//! Tests for Datalog types and parser

use super::*;

// ============================================================================
// Phase 1: Core Types Tests
// ============================================================================

mod term_tests {
    use super::*;

    #[test]
    fn test_var_creation() {
        let term = Term::var("X");
        assert!(term.is_var());
        assert!(!term.is_const());
        assert_eq!(term.var_name(), Some("X"));
    }

    #[test]
    fn test_const_creation() {
        let term = Term::constant("queue:publish");
        assert!(term.is_const());
        assert!(!term.is_var());
        assert_eq!(term.const_value(), Some("queue:publish"));
    }

    #[test]
    fn test_wildcard() {
        let term = Term::wildcard();
        assert!(term.is_wildcard());
        assert!(!term.is_var());
        assert!(!term.is_const());
    }

    #[test]
    fn test_term_equality() {
        assert_eq!(Term::var("X"), Term::var("X"));
        assert_ne!(Term::var("X"), Term::var("Y"));
        assert_eq!(Term::constant("foo"), Term::constant("foo"));
        assert_ne!(Term::var("X"), Term::constant("X"));
    }
}

mod atom_tests {
    use super::*;

    #[test]
    fn test_atom_creation() {
        let atom = Atom::new("node", vec![Term::var("X"), Term::constant("FUNCTION")]);
        assert_eq!(atom.predicate(), "node");
        assert_eq!(atom.arity(), 2);
    }

    #[test]
    fn test_atom_args() {
        let atom = Atom::new("edge", vec![
            Term::var("A"),
            Term::var("B"),
            Term::constant("CALLS"),
        ]);
        assert_eq!(atom.args()[0], Term::var("A"));
        assert_eq!(atom.args()[2], Term::constant("CALLS"));
    }

    #[test]
    fn test_atom_variables() {
        let atom = Atom::new("path", vec![
            Term::var("X"),
            Term::var("Y"),
            Term::wildcard(),
        ]);
        let vars = atom.variables();
        assert_eq!(vars.len(), 2);
        assert!(vars.contains(&"X".to_string()));
        assert!(vars.contains(&"Y".to_string()));
    }

    #[test]
    fn test_ground_atom() {
        let ground = Atom::new("node", vec![
            Term::constant("n1"),
            Term::constant("FUNCTION"),
        ]);
        assert!(ground.is_ground());

        let non_ground = Atom::new("node", vec![
            Term::var("X"),
            Term::constant("FUNCTION"),
        ]);
        assert!(!non_ground.is_ground());
    }
}

mod literal_tests {
    use super::*;

    #[test]
    fn test_positive_literal() {
        let atom = Atom::new("node", vec![Term::var("X")]);
        let lit = Literal::positive(atom.clone());
        assert!(lit.is_positive());
        assert!(!lit.is_negative());
        assert_eq!(lit.atom(), &atom);
    }

    #[test]
    fn test_negative_literal() {
        let atom = Atom::new("path", vec![Term::var("X"), Term::var("Y")]);
        let lit = Literal::negative(atom.clone());
        assert!(lit.is_negative());
        assert!(!lit.is_positive());
    }
}

mod rule_tests {
    use super::*;

    #[test]
    fn test_fact_creation() {
        // node("n1", "FUNCTION"). - это факт (правило без тела)
        let head = Atom::new("node", vec![
            Term::constant("n1"),
            Term::constant("FUNCTION"),
        ]);
        let rule = Rule::fact(head);
        assert!(rule.is_fact());
        assert!(rule.body().is_empty());
    }

    #[test]
    fn test_rule_creation() {
        // violation(X) :- node(X, "queue:publish"), \+ path(X, _).
        let head = Atom::new("violation", vec![Term::var("X")]);
        let body = vec![
            Literal::positive(Atom::new("node", vec![
                Term::var("X"),
                Term::constant("queue:publish"),
            ])),
            Literal::negative(Atom::new("path", vec![
                Term::var("X"),
                Term::wildcard(),
            ])),
        ];
        let rule = Rule::new(head.clone(), body);
        assert!(!rule.is_fact());
        assert_eq!(rule.head(), &head);
        assert_eq!(rule.body().len(), 2);
    }

    #[test]
    fn test_rule_variables() {
        let head = Atom::new("result", vec![Term::var("X"), Term::var("Y")]);
        let body = vec![
            Literal::positive(Atom::new("edge", vec![
                Term::var("X"),
                Term::var("Z"),
            ])),
            Literal::positive(Atom::new("edge", vec![
                Term::var("Z"),
                Term::var("Y"),
            ])),
        ];
        let rule = Rule::new(head, body);
        let vars = rule.all_variables();
        assert_eq!(vars.len(), 3); // X, Y, Z
    }

    #[test]
    fn test_rule_safety() {
        // Safe: all head variables appear in positive body literals
        let safe_rule = Rule::new(
            Atom::new("result", vec![Term::var("X")]),
            vec![Literal::positive(Atom::new("node", vec![Term::var("X")]))],
        );
        assert!(safe_rule.is_safe());

        // Unsafe: X in head but only in negative literal
        let unsafe_rule = Rule::new(
            Atom::new("result", vec![Term::var("X")]),
            vec![Literal::negative(Atom::new("node", vec![Term::var("X")]))],
        );
        assert!(!unsafe_rule.is_safe());
    }
}

mod program_tests {
    use super::*;

    #[test]
    fn test_program_creation() {
        let rules = vec![
            Rule::fact(Atom::new("node", vec![
                Term::constant("n1"),
                Term::constant("FUNCTION"),
            ])),
            Rule::new(
                Atom::new("violation", vec![Term::var("X")]),
                vec![Literal::positive(Atom::new("node", vec![Term::var("X")]))],
            ),
        ];
        let program = Program::new(rules);
        assert_eq!(program.rules().len(), 2);
    }

    #[test]
    fn test_program_predicates() {
        let rules = vec![
            Rule::fact(Atom::new("node", vec![Term::constant("n1")])),
            Rule::new(
                Atom::new("violation", vec![Term::var("X")]),
                vec![Literal::positive(Atom::new("node", vec![Term::var("X")]))],
            ),
        ];
        let program = Program::new(rules);
        let preds = program.defined_predicates();
        assert!(preds.contains("node"));
        assert!(preds.contains("violation"));
    }
}

// ============================================================================
// Phase 2: Parser Tests
// ============================================================================

mod parser_tests {
    use super::*;

    #[test]
    fn test_parse_term_var() {
        let term = parse_term("X").unwrap();
        assert_eq!(term, Term::var("X"));
    }

    #[test]
    fn test_parse_term_const() {
        let term = parse_term("\"queue:publish\"").unwrap();
        assert_eq!(term, Term::constant("queue:publish"));
    }

    #[test]
    fn test_parse_term_wildcard() {
        let term = parse_term("_").unwrap();
        assert!(term.is_wildcard());
    }

    #[test]
    fn test_parse_atom() {
        let atom = parse_atom("node(X, \"FUNCTION\")").unwrap();
        assert_eq!(atom.predicate(), "node");
        assert_eq!(atom.arity(), 2);
        assert_eq!(atom.args()[0], Term::var("X"));
        assert_eq!(atom.args()[1], Term::constant("FUNCTION"));
    }

    #[test]
    fn test_parse_atom_no_args() {
        let atom = parse_atom("fact").unwrap();
        assert_eq!(atom.predicate(), "fact");
        assert_eq!(atom.arity(), 0);
    }

    #[test]
    fn test_parse_literal_positive() {
        let lit = parse_literal("node(X)").unwrap();
        assert!(lit.is_positive());
    }

    #[test]
    fn test_parse_literal_negative() {
        let lit = parse_literal("\\+ path(X, Y)").unwrap();
        assert!(lit.is_negative());
        assert_eq!(lit.atom().predicate(), "path");
    }

    #[test]
    fn test_parse_fact() {
        let rule = parse_rule("node(\"n1\", \"FUNCTION\").").unwrap();
        assert!(rule.is_fact());
    }

    #[test]
    fn test_parse_rule() {
        let rule = parse_rule("violation(X) :- node(X, \"queue:publish\"), \\+ path(X, _).").unwrap();
        assert_eq!(rule.head().predicate(), "violation");
        assert_eq!(rule.body().len(), 2);
        assert!(rule.body()[0].is_positive());
        assert!(rule.body()[1].is_negative());
    }

    #[test]
    fn test_parse_program() {
        let source = r#"
            node("n1", "FUNCTION").
            node("n2", "FUNCTION").
            connected(X, Y) :- edge(X, Y).
            connected(X, Z) :- edge(X, Y), connected(Y, Z).
        "#;
        let program = parse_program(source).unwrap();
        assert_eq!(program.rules().len(), 4);
    }

    #[test]
    fn test_parse_error_invalid_syntax() {
        let result = parse_rule("invalid syntax here");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_query_single_atom() {
        let literals = parse_query("node(X, \"FUNCTION\")").unwrap();
        assert_eq!(literals.len(), 1);
        assert!(literals[0].is_positive());
        assert_eq!(literals[0].atom().predicate(), "node");
    }

    #[test]
    fn test_parse_query_conjunction() {
        let literals = parse_query("node(X, \"http:request\"), attr(X, \"url\", U)").unwrap();
        assert_eq!(literals.len(), 2);
        assert_eq!(literals[0].atom().predicate(), "node");
        assert_eq!(literals[1].atom().predicate(), "attr");
    }

    #[test]
    fn test_parse_query_with_negation() {
        let literals = parse_query("node(X, \"type\"), \\+ path(X, _)").unwrap();
        assert_eq!(literals.len(), 2);
        assert!(literals[0].is_positive());
        assert!(literals[1].is_negative());
    }

    #[test]
    fn test_parse_query_three_atoms() {
        let literals = parse_query("node(X, \"A\"), edge(X, Y, \"CALLS\"), node(Y, \"B\")").unwrap();
        assert_eq!(literals.len(), 3);
    }

    #[test]
    fn test_parse_query_rejects_unconsumed_input() {
        // A rule sent as a query should fail, not silently ignore the body
        let err = parse_query("violation(X) :- node(X, \"http:route\").").unwrap_err();
        assert!(
            err.message.contains("unexpected input after query"),
            "expected 'unexpected input' error, got: {}",
            err.message,
        );
        assert_eq!(err.position, 13); // position of ":-"
    }

    #[test]
    fn test_parse_query_accepts_valid_input() {
        // Trailing whitespace should be fine
        assert!(parse_query("node(X, \"http:route\")  ").is_ok());
        // Single atom
        assert!(parse_query("node(X, \"type\")").is_ok());
        // Conjunction
        assert!(parse_query("node(X, \"A\"), attr(X, \"k\", V)").is_ok());
    }
}

// ============================================================================
// Phase 3: Evaluator Tests
// ============================================================================

mod eval_tests {
    use super::*;
    use crate::graph::{GraphEngineV2, GraphStore};
    use crate::storage::{NodeRecord, EdgeRecord};


    pub(super) fn setup_test_graph() -> GraphEngineV2 {
        let mut engine = GraphEngineV2::create_ephemeral();

        // Add test nodes
        engine.add_nodes(vec![
            NodeRecord {
                id: 1,
                node_type: Some("queue:publish".to_string()),
                name: Some("orders-pub".to_string()),
                file: Some("api.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
            NodeRecord {
                id: 2,
                node_type: Some("queue:consume".to_string()),
                name: Some("orders-con".to_string()),
                file: Some("worker.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
            NodeRecord {
                id: 3,
                node_type: Some("queue:publish".to_string()),
                name: Some("orphan-pub".to_string()),
                file: Some("orphan.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
            NodeRecord {
                id: 4,
                node_type: Some("FUNCTION".to_string()),
                name: Some("processOrder".to_string()),
                file: Some("worker.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
        ]);

        // Add edges: 1 -> 4 -> 2 (path exists)
        // Node 3 has no outgoing edges (orphan)
        engine.add_edges(vec![
            EdgeRecord {
                src: 1,
                dst: 4,
                edge_type: Some("CALLS".to_string()),
                version: "main".into(),
                metadata: None,
                deleted: false,
            },
            EdgeRecord {
                src: 4,
                dst: 2,
                edge_type: Some("CALLS".to_string()),
                version: "main".into(),
                metadata: None,
                deleted: false,
            },
        ], false);

        engine
    }

    #[test]
    fn test_bindings_empty() {
        let bindings = Bindings::new();
        assert!(bindings.is_empty());
        assert_eq!(bindings.get("X"), None);
    }

    #[test]
    fn test_bindings_set_get() {
        let mut bindings = Bindings::new();
        bindings.set("X", Value::Id(123));
        assert_eq!(bindings.get("X"), Some(&Value::Id(123)));
    }

    #[test]
    fn test_bindings_extend() {
        let mut b1 = Bindings::new();
        b1.set("X", Value::Id(1));

        let mut b2 = Bindings::new();
        b2.set("Y", Value::Id(2));

        let merged = b1.extend(&b2);
        assert!(merged.is_some());
        let merged = merged.unwrap();
        assert_eq!(merged.get("X"), Some(&Value::Id(1)));
        assert_eq!(merged.get("Y"), Some(&Value::Id(2)));
    }

    #[test]
    fn test_bindings_conflict() {
        let mut b1 = Bindings::new();
        b1.set("X", Value::Id(1));

        let mut b2 = Bindings::new();
        b2.set("X", Value::Id(2)); // conflict!

        let merged = b1.extend(&b2);
        assert!(merged.is_none());
    }

    #[test]
    fn test_eval_node_by_type() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // node(X, "queue:publish")
        let query = Atom::new("node", vec![
            Term::var("X"),
            Term::constant("queue:publish"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 2); // nodes 1 and 3
    }

    #[test]
    fn test_type_alias_returns_same_results_as_node() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // node(X, "queue:publish") and type(X, "queue:publish") should return identical results
        let node_query = Atom::new("node", vec![
            Term::var("X"),
            Term::constant("queue:publish"),
        ]);
        let type_query = Atom::new("type", vec![
            Term::var("X"),
            Term::constant("queue:publish"),
        ]);

        let node_results = evaluator.query_atom(&node_query).unwrap();
        let type_results = evaluator.query_atom(&type_query).unwrap();

        assert_eq!(node_results.len(), type_results.len());
        assert_eq!(node_results.len(), 2);

        let mut node_ids: Vec<u128> = node_results.iter()
            .filter_map(|b| b.get("X").and_then(|v| v.as_id()))
            .collect();
        node_ids.sort();

        let mut type_ids: Vec<u128> = type_results.iter()
            .filter_map(|b| b.get("X").and_then(|v| v.as_id()))
            .collect();
        type_ids.sort();

        assert_eq!(node_ids, type_ids);
    }

    #[test]
    fn test_type_alias_by_id() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // type(1, Type) should work the same as node(1, Type)
        let query = Atom::new("type", vec![
            Term::constant("1"),
            Term::var("Type"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("Type"), Some(&Value::Str("queue:publish".to_string())));
    }

    #[test]
    fn test_eval_node_by_id() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // node(1, Type) - find type of node 1
        let query = Atom::new("node", vec![
            Term::constant("1"),
            Term::var("Type"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("Type"), Some(&Value::Str("queue:publish".to_string())));
    }

    #[test]
    fn test_eval_edge() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // edge(1, X, "CALLS")
        let query = Atom::new("edge", vec![
            Term::constant("1"),
            Term::var("X"),
            Term::constant("CALLS"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Id(4)));
    }

    #[test]
    fn test_eval_path_exists() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // path(1, 2) - should exist (1 -> 4 -> 2)
        let query = Atom::new("path", vec![
            Term::constant("1"),
            Term::constant("2"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1); // path exists
    }

    #[test]
    fn test_eval_path_not_exists() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // path(3, 2) - orphan has no path to consumer
        let query = Atom::new("path", vec![
            Term::constant("3"),
            Term::constant("2"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 0); // no path
    }

    /// A->B->A two-node cycle plus an isolated node C, for self-reachability tests.
    fn setup_cycle_graph() -> GraphEngineV2 {
        let mut engine = GraphEngineV2::create_ephemeral();
        let mk = |id: u128, name: &str| NodeRecord {
            id,
            node_type: Some("FUNCTION".to_string()),
            name: Some(name.to_string()),
            file: Some("c.js".to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".into(),
            exported: false,
            replaces: None,
            deleted: false,
            metadata: None,
            semantic_id: None,
        };
        engine.add_nodes(vec![mk(100, "a"), mk(101, "b"), mk(102, "c_isolated")]);
        engine.add_edges(
            vec![
                EdgeRecord { src: 100, dst: 101, edge_type: Some("CALLS".into()), version: "main".into(), metadata: None, deleted: false },
                EdgeRecord { src: 101, dst: 100, edge_type: Some("CALLS".into()), version: "main".into(), metadata: None, deleted: false },
            ],
            false,
        );
        engine
    }

    // ── path() self-reachability (irreflexive: a node reaches itself only via a
    //    genuine cycle, never via the trivial zero-length self path) ──
    //
    // Regression: `path(src, dst)` seeded BFS from `src` itself, and `bfs` returns
    // the seed in its result set. The (Const, Const) arm did `reachable.contains(dst)`
    // without excluding that trivial self-presence, so `path(A, A)` was TRUE for
    // EVERY node — even an isolated node with no edges — contradicting the (Var) and
    // (Wildcard) arms which both exclude self. Fixed by seeding BFS from src's
    // neighbours (≥1 hop), so self counts only when a real edge path returns to src.

    #[test]
    fn test_eval_path_self_isolated_is_false() {
        // Node 3 in setup_test_graph has NO outgoing edges → no path to itself.
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);
        let query = Atom::new("path", vec![Term::constant("3"), Term::constant("3")]);
        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 0, "isolated node must NOT have a path to itself");
    }

    #[test]
    fn test_eval_path_self_acyclic_is_false() {
        // Node 1 reaches 4 and 2 but nothing loops back to 1 → no self path.
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);
        let query = Atom::new("path", vec![Term::constant("1"), Term::constant("1")]);
        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 0, "acyclic node must NOT have a path to itself");
    }

    #[test]
    fn test_eval_path_self_cycle_is_true() {
        // 100 -> 101 -> 100 is a genuine cycle → path(100, 100) holds.
        let engine = setup_cycle_graph();
        let evaluator = Evaluator::new(&engine);
        let query = Atom::new("path", vec![Term::constant("100"), Term::constant("100")]);
        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1, "node on a cycle MUST have a path to itself");
    }

    #[test]
    fn test_eval_path_var_includes_cyclic_self() {
        // Enumerating reachable nodes from a cyclic node must include the node
        // itself (it is genuinely reachable via the cycle), alongside its peer.
        let engine = setup_cycle_graph();
        let evaluator = Evaluator::new(&engine);
        let query = Atom::new("path", vec![Term::constant("100"), Term::var("X")]);
        let mut ids: Vec<u128> = evaluator
            .query_atom(&query)
            .unwrap()
            .iter()
            .filter_map(|b| b.get("X").and_then(|v| v.as_id()))
            .collect();
        ids.sort();
        assert_eq!(ids, vec![100, 101], "cyclic enumeration must include self (100) and peer (101)");
    }

    #[test]
    fn test_eval_path_var_acyclic_excludes_self() {
        // Regression guard: for an acyclic source, enumeration is unchanged and
        // never includes the source itself.
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);
        let query = Atom::new("path", vec![Term::constant("1"), Term::var("X")]);
        let mut ids: Vec<u128> = evaluator
            .query_atom(&query)
            .unwrap()
            .iter()
            .filter_map(|b| b.get("X").and_then(|v| v.as_id()))
            .collect();
        ids.sort();
        assert_eq!(ids, vec![2, 4], "acyclic enumeration unchanged: reaches 4 and 2, not self");
    }

    #[test]
    fn test_eval_rule_simple() {
        let engine = setup_test_graph();
        let mut evaluator = Evaluator::new(&engine);

        // publisher(X) :- node(X, "queue:publish").
        let rule = parse_rule("publisher(X) :- node(X, \"queue:publish\").").unwrap();
        evaluator.add_rule(rule);

        let query = parse_atom("publisher(X)").unwrap();
        let results = evaluator.query(&query).unwrap();

        assert_eq!(results.len(), 2); // two publishers
    }

    #[test]
    fn test_eval_rule_with_negation() {
        let engine = setup_test_graph();
        let mut evaluator = Evaluator::new(&engine);

        // orphan(X) :- node(X, "queue:publish"), \+ path(X, _).
        // Node 3 is orphan (no path to anywhere useful)
        let rule = parse_rule("orphan(X) :- node(X, \"queue:publish\"), \\+ path(X, _).").unwrap();
        evaluator.add_rule(rule);

        let query = parse_atom("orphan(X)").unwrap();
        let results = evaluator.query(&query).unwrap();

        assert_eq!(results.len(), 1); // only node 3
        assert_eq!(results[0].get("X"), Some(&Value::Id(3)));
    }

    #[test]
    fn test_eval_incoming() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // incoming(4, X, "CALLS") - who calls node 4?
        let query = Atom::new("incoming", vec![
            Term::constant("4"),
            Term::var("X"),
            Term::constant("CALLS"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Id(1))); // node 1 calls node 4
    }

    #[test]
    fn test_eval_incoming_no_edges() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // incoming(1, X, "CALLS") - who calls node 1? Nobody
        let query = Atom::new("incoming", vec![
            Term::constant("1"),
            Term::var("X"),
            Term::constant("CALLS"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 0);
    }

    // ====================================================================
    // Wildcard tests — Term::Wildcard in edge/incoming/node predicates
    // ====================================================================

    #[test]
    fn test_eval_edge_wildcard_src() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // edge(_, Y, "CALLS") — wildcard src, should return all CALLS edges with Y bound to dst
        let query = Atom::new("edge", vec![
            Term::wildcard(),
            Term::var("Y"),
            Term::constant("CALLS"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 2); // 1->4 and 4->2
        let mut dsts: Vec<u128> = results.iter()
            .filter_map(|b| b.get("Y").and_then(|v| v.as_id()))
            .collect();
        dsts.sort();
        assert_eq!(dsts, vec![2, 4]);
    }

    #[test]
    fn test_eval_edge_wildcard_src_and_dst() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // edge(_, _, "CALLS") — wildcard both src and dst, should return count of all CALLS edges
        let query = Atom::new("edge", vec![
            Term::wildcard(),
            Term::wildcard(),
            Term::constant("CALLS"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 2); // two CALLS edges in graph
    }

    #[test]
    fn test_eval_incoming_wildcard_dst() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // incoming(_, X, "CALLS") — wildcard dst, should return all CALLS edges with X bound to src
        let query = Atom::new("incoming", vec![
            Term::wildcard(),
            Term::var("X"),
            Term::constant("CALLS"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 2); // 1->4 and 4->2
        let mut srcs: Vec<u128> = results.iter()
            .filter_map(|b| b.get("X").and_then(|v| v.as_id()))
            .collect();
        srcs.sort();
        assert_eq!(srcs, vec![1, 4]);
    }

    #[test]
    fn test_eval_incoming_untyped_var_dst_enumerates_all_edges() {
        // incoming(D, S) — unbound dst AND no edge-type constant — must enumerate
        // every edge (binding D=dst, S=src), mirroring edge(S, D) and incoming's
        // own Wildcard-dst arm. Returning empty here silently drops every row of
        // an untyped incoming enumeration (false negatives).
        let engine = setup_test_graph(); // edges: 1->4, 4->2 (CALLS)
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("incoming", vec![Term::var("D"), Term::var("S")]);
        let mut pairs: Vec<(u128, u128)> = evaluator
            .query_atom(&query)
            .unwrap()
            .iter()
            .filter_map(|b| Some((b.get("D")?.as_id()?, b.get("S")?.as_id()?)))
            .collect();
        pairs.sort();
        // (dst, src): edge 1->4 => (4,1); edge 4->2 => (2,4)
        assert_eq!(pairs, vec![(2, 4), (4, 1)]);

        // Symmetry: incoming(D, S) must yield the same (dst,src) set as edge(S, D).
        let edge_query = Atom::new("edge", vec![Term::var("S"), Term::var("D")]);
        let mut edge_pairs: Vec<(u128, u128)> = evaluator
            .query_atom(&edge_query)
            .unwrap()
            .iter()
            .filter_map(|b| Some((b.get("D")?.as_id()?, b.get("S")?.as_id()?)))
            .collect();
        edge_pairs.sort();
        assert_eq!(pairs, edge_pairs, "incoming(D,S) must mirror edge(S,D)");
    }

    #[test]
    fn test_eval_edge_wildcard_negation() {
        // The original diagnostic query: violation(X) :- node(X, "FUNCTION"), \+ edge(_, X, "CONTAINS").
        // Setup: graph with FUNCTION nodes, some with incoming CONTAINS, some without
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            NodeRecord {
                id: 100,
                node_type: Some("MODULE".to_string()),
                name: Some("mod".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            },
            NodeRecord {
                id: 101,
                node_type: Some("FUNCTION".to_string()),
                name: Some("declared".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            },
            NodeRecord {
                id: 102,
                node_type: Some("FUNCTION".to_string()),
                name: Some("arrow".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            },
        ]);

        // Only node 101 has CONTAINS edge from module
        engine.add_edges(vec![
            EdgeRecord {
                src: 100,
                dst: 101,
                edge_type: Some("CONTAINS".to_string()),
                version: "main".into(),
                metadata: None,
                deleted: false,
            },
        ], false);

        let mut evaluator = Evaluator::new(&engine);

        let rule = parse_rule(
            r#"violation(X) :- node(X, "FUNCTION"), \+ edge(_, X, "CONTAINS")."#
        ).unwrap();
        evaluator.add_rule(rule);

        let query = parse_atom("violation(X)").unwrap();
        let results = evaluator.query(&query).unwrap();

        // Only node 102 (arrow) should violate — it has no incoming CONTAINS
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Id(102)));
    }

    #[test]
    fn test_eval_node_wildcard_type() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // node("1", _) — check if node 1 exists (wildcard type)
        let query = Atom::new("node", vec![
            Term::constant("1"),
            Term::wildcard(),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_eval_node_wildcard_id() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // node(_, "FUNCTION") — count FUNCTION nodes (wildcard id)
        let query = Atom::new("node", vec![
            Term::wildcard(),
            Term::constant("FUNCTION"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1); // only node 4 is FUNCTION
    }

    #[test]
    fn test_guarantee_all_variables_assigned() {
        // Setup: Create a graph with VARIABLE nodes, some with ASSIGNED_FROM, some without
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            NodeRecord {
                id: 10,
                node_type: Some("VARIABLE".to_string()),
                name: Some("x".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
            NodeRecord {
                id: 11,
                node_type: Some("VARIABLE".to_string()),
                name: Some("y".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
            NodeRecord {
                id: 20,
                node_type: Some("LITERAL".to_string()),
                name: Some("42".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
        ]);

        // Only x (10) has ASSIGNED_FROM, y (11) does not
        engine.add_edges(vec![
            EdgeRecord {
                src: 20,
                dst: 10,
                edge_type: Some("ASSIGNED_FROM".to_string()),
                version: "main".into(),
                metadata: None,
                deleted: false,
            },
        ], false);

        let mut evaluator = Evaluator::new(&engine);

        // Guarantee: violation(X) :- node(X, "VARIABLE"), \+ incoming(X, _, "ASSIGNED_FROM").
        let rule = parse_rule(
            "violation(X) :- node(X, \"VARIABLE\"), \\+ incoming(X, _, \"ASSIGNED_FROM\")."
        ).unwrap();
        evaluator.add_rule(rule);

        let query = parse_atom("violation(X)").unwrap();
        let results = evaluator.query(&query).unwrap();

        // Only y (11) violates the guarantee
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Id(11)));
    }

    #[test]
    fn test_eval_attr_builtin() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // attr(1, "name", X) - get name of node 1
        let query = Atom::new("attr", vec![
            Term::constant("1"),
            Term::constant("name"),
            Term::var("X"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Str("orders-pub".to_string())));
    }

    #[test]
    fn test_eval_attr_file() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // attr(1, "file", X) - get file of node 1
        let query = Atom::new("attr", vec![
            Term::constant("1"),
            Term::constant("file"),
            Term::var("X"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Str("api.js".to_string())));
    }

    #[test]
    fn test_eval_attr_type() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // attr(1, "type", X) - get type of node 1
        let query = Atom::new("attr", vec![
            Term::constant("1"),
            Term::constant("type"),
            Term::var("X"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Str("queue:publish".to_string())));
    }

    #[test]
    fn test_eval_attr_constant_match() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // attr(1, "name", "orders-pub") - check if name matches
        let query = Atom::new("attr", vec![
            Term::constant("1"),
            Term::constant("name"),
            Term::constant("orders-pub"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1); // Match
    }

    #[test]
    fn test_eval_attr_constant_no_match() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // attr(1, "name", "wrong-name") - check if name matches (it shouldn't)
        let query = Atom::new("attr", vec![
            Term::constant("1"),
            Term::constant("name"),
            Term::constant("wrong-name"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 0); // No match
    }

    #[test]
    fn test_eval_attr_metadata() {
        // Create a graph with metadata
        let mut engine = GraphEngineV2::create_ephemeral();

        // Add a CALL node with "object" and "method" in metadata
        engine.add_nodes(vec![
            NodeRecord {
                id: 100,
                node_type: Some("CALL".to_string()),
                name: Some("arr.map".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: Some(r#"{"object":"arr","method":"map"}"#.to_string()),
                semantic_id: None,
            },
        ]);

        let evaluator = Evaluator::new(&engine);

        // attr(100, "object", X) - get object from metadata
        let query = Atom::new("attr", vec![
            Term::constant("100"),
            Term::constant("object"),
            Term::var("X"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Str("arr".to_string())));

        // attr(100, "method", X) - get method from metadata
        let query2 = Atom::new("attr", vec![
            Term::constant("100"),
            Term::constant("method"),
            Term::var("X"),
        ]);

        let results2 = evaluator.query_atom(&query2).unwrap();
        assert_eq!(results2.len(), 1);
        assert_eq!(results2[0].get("X"), Some(&Value::Str("map".to_string())));
    }

    #[test]
    fn test_eval_attr_missing() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // attr(1, "nonexistent", X) - attribute doesn't exist
        let query = Atom::new("attr", vec![
            Term::constant("1"),
            Term::constant("nonexistent"),
            Term::var("X"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 0); // No results for missing attr
    }

    #[test]
    fn test_eval_attr_nested_path() {
        // Test nested path resolution in attr() predicate
        // attr(N, "config.port", V) should extract metadata["config"]["port"]
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            NodeRecord {
                id: 200,
                node_type: Some("DATABASE".to_string()),
                name: Some("postgres".to_string()),
                file: Some("config.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: Some(r#"{"config": {"host": "localhost", "port": 5432}}"#.to_string()),
                semantic_id: None,
            },
        ]);

        let evaluator = Evaluator::new(&engine);

        // Query nested path: attr(200, "config.host", X)
        let query = Atom::new("attr", vec![
            Term::constant("200"),
            Term::constant("config.host"),
            Term::var("X"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Str("localhost".to_string())));
    }

    #[test]
    fn test_eval_attr_nested_number() {
        // Test nested number extraction - numbers should be converted to strings
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            NodeRecord {
                id: 300,
                node_type: Some("SERVICE".to_string()),
                name: Some("redis".to_string()),
                file: Some("services.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: Some(r#"{"connection": {"timeout": 3000, "retries": 5}}"#.to_string()),
                semantic_id: None,
            },
        ]);

        let evaluator = Evaluator::new(&engine);

        // Query nested number: attr(300, "connection.timeout", X)
        let query = Atom::new("attr", vec![
            Term::constant("300"),
            Term::constant("connection.timeout"),
            Term::var("X"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Str("3000".to_string())));
    }

    #[test]
    fn test_eval_attr_literal_key_with_dots() {
        // Backward compatibility: literal keys containing dots should take precedence
        // over nested path resolution
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            NodeRecord {
                id: 400,
                node_type: Some("CONFIG".to_string()),
                name: Some("settings".to_string()),
                file: Some("config.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                // Both "app.name" as literal key AND "app": {"name": "..."} nested
                metadata: Some(r#"{"app.name": "literal-value", "app": {"name": "nested-value"}}"#.to_string()),
                semantic_id: None,
            },
        ]);

        let evaluator = Evaluator::new(&engine);

        // Query "app.name" - should match literal key, not nested path
        let query = Atom::new("attr", vec![
            Term::constant("400"),
            Term::constant("app.name"),
            Term::var("X"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
        // Literal key takes precedence
        assert_eq!(results[0].get("X"), Some(&Value::Str("literal-value".to_string())));
    }

    #[test]
    fn test_eval_attr_nested_path_not_found() {
        // Missing nested path should return empty results
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            NodeRecord {
                id: 500,
                node_type: Some("DATABASE".to_string()),
                name: Some("mysql".to_string()),
                file: Some("config.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: Some(r#"{"config": {"host": "localhost"}}"#.to_string()),
                semantic_id: None,
            },
        ]);

        let evaluator = Evaluator::new(&engine);

        // Query non-existent nested path: attr(500, "config.port", X)
        let query = Atom::new("attr", vec![
            Term::constant("500"),
            Term::constant("config.port"),
            Term::var("X"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 0); // Path not found
    }

    #[test]
    fn test_guarantee_call_without_target() {
        // Test: Find CALL nodes without "object" that don't have CALLS edge
        // This represents internal function calls that don't resolve
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            // CALL_SITE (internal function call) - has CALLS edge
            NodeRecord {
                id: 1,
                node_type: Some("CALL".to_string()),
                name: Some("foo".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None, // No "object" = CALL_SITE
                semantic_id: None,
            },
            // CALL_SITE without CALLS edge - violation!
            NodeRecord {
                id: 2,
                node_type: Some("CALL".to_string()),
                name: Some("bar".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None, // No "object" = CALL_SITE
                semantic_id: None,
            },
            // METHOD_CALL (external method call) - no CALLS edge needed
            NodeRecord {
                id: 3,
                node_type: Some("CALL".to_string()),
                name: Some("arr.map".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: Some(r#"{"object":"arr","method":"map"}"#.to_string()),
                semantic_id: None,
            },
            // Target function
            NodeRecord {
                id: 10,
                node_type: Some("FUNCTION".to_string()),
                name: Some("foo".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
        ]);

        // Only CALL 1 has CALLS edge
        engine.add_edges(vec![
            EdgeRecord {
                src: 1,
                dst: 10,
                edge_type: Some("CALLS".to_string()),
                version: "main".into(),
                metadata: None,
                deleted: false,
            },
        ], false);

        let mut evaluator = Evaluator::new(&engine);

        // Guarantee: CALL_SITE (no "object" attr) must have CALLS edge
        // violation(X) :- node(X, "CALL"), \+ attr(X, "object", _), \+ edge(X, _, "CALLS").
        let rule = parse_rule(
            r#"violation(X) :- node(X, "CALL"), \+ attr(X, "object", _), \+ edge(X, _, "CALLS")."#
        ).unwrap();
        evaluator.add_rule(rule);

        let query = parse_atom("violation(X)").unwrap();
        let results = evaluator.query(&query).unwrap();

        // Only node 2 should violate (CALL_SITE without CALLS)
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Id(2)));
    }

    #[test]
    fn test_eval_neq_success() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // neq("foo", "bar") - should succeed (not equal)
        let query = Atom::new("neq", vec![
            Term::constant("foo"),
            Term::constant("bar"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_eval_neq_failure() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // neq("foo", "foo") - should fail (equal)
        let query = Atom::new("neq", vec![
            Term::constant("foo"),
            Term::constant("foo"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn test_eval_starts_with_success() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // starts_with("<anonymous>", "<") - should succeed
        let query = Atom::new("starts_with", vec![
            Term::constant("<anonymous>"),
            Term::constant("<"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_eval_starts_with_failure() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // starts_with("myFunc", "<") - should fail
        let query = Atom::new("starts_with", vec![
            Term::constant("myFunc"),
            Term::constant("<"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn test_eval_not_starts_with_success() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // not_starts_with("myFunc", "<") - should succeed
        let query = Atom::new("not_starts_with", vec![
            Term::constant("myFunc"),
            Term::constant("<"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_eval_not_starts_with_failure() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // not_starts_with("<anonymous>", "<") - should fail
        let query = Atom::new("not_starts_with", vec![
            Term::constant("<anonymous>"),
            Term::constant("<"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn test_eval_string_contains_success() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("string_contains", vec![
            Term::constant("packages/core/src/plugins/analysis.ts"),
            Term::constant("plugins"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_eval_string_contains_failure() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("string_contains", vec![
            Term::constant("packages/core/src/index.ts"),
            Term::constant("plugins"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn test_eval_neq_in_rule() {
        // Test neq in a rule context
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            NodeRecord {
                id: 1,
                node_type: Some("FUNCTION".to_string()),
                name: Some("myFunc".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
            NodeRecord {
                id: 2,
                node_type: Some("FUNCTION".to_string()),
                name: Some("constructor".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
            NodeRecord {
                id: 3,
                node_type: Some("FUNCTION".to_string()),
                name: Some("<anonymous>".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
        ]);

        let mut evaluator = Evaluator::new(&engine);

        // Find functions that are NOT constructors AND don't start with <
        // violation(X) :- node(X, "FUNCTION"), attr(X, "name", N), neq(N, "constructor"), not_starts_with(N, "<").
        let rule = parse_rule(
            r#"violation(X) :- node(X, "FUNCTION"), attr(X, "name", N), neq(N, "constructor"), not_starts_with(N, "<")."#
        ).unwrap();
        evaluator.add_rule(rule);

        let query = parse_atom("violation(X)").unwrap();
        let results = evaluator.query(&query).unwrap();

        // Only node 1 (myFunc) should match
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Id(1)));
    }

    #[test]
    fn test_eval_edge_variable_source() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // edge(X, Y, "CALLS") - find all CALLS edges
        let query = Atom::new("edge", vec![
            Term::var("X"),
            Term::var("Y"),
            Term::constant("CALLS"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        // Graph has 2 CALLS edges: 1->4 and 4->2
        assert_eq!(results.len(), 2);

        // Check that we got both edges
        let edges: Vec<(u128, u128)> = results.iter()
            .filter_map(|b| {
                match (b.get("X"), b.get("Y")) {
                    (Some(Value::Id(x)), Some(Value::Id(y))) => Some((*x, *y)),
                    _ => None,
                }
            })
            .collect();
        assert!(edges.contains(&(1, 4)));
        assert!(edges.contains(&(4, 2)));
    }

    #[test]
    fn test_eval_edge_variable_source_constant_dest() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // edge(X, 4, T) - find edges TO node 4
        let query = Atom::new("edge", vec![
            Term::var("X"),
            Term::constant("4"),
            Term::var("T"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        // Only edge 1->4 points to node 4
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Id(1)));
        assert_eq!(results[0].get("T"), Some(&Value::Str("CALLS".to_string())));
    }

    #[test]
    fn test_eval_edge_all_variables() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // edge(X, Y, T) - enumerate all edges
        let query = Atom::new("edge", vec![
            Term::var("X"),
            Term::var("Y"),
            Term::var("T"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        // Graph has 2 edges total
        assert_eq!(results.len(), 2);

        // All results should have X, Y, and T bound
        for result in &results {
            assert!(matches!(result.get("X"), Some(Value::Id(_))));
            assert!(matches!(result.get("Y"), Some(Value::Id(_))));
            assert!(matches!(result.get("T"), Some(Value::Str(_))));
        }
    }

    #[test]
    fn test_eval_query_single_atom() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // Single atom query
        let literals = parse_query("node(X, \"queue:publish\")").unwrap();
        let results = evaluator.eval_query(&literals).unwrap();

        // Should find nodes 1 and 3
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn test_eval_query_conjunction() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // Conjunction: find CALLS edges and bind source/dest
        let literals = parse_query("edge(X, Y, \"CALLS\"), node(Y, T)").unwrap();
        let results = evaluator.eval_query(&literals).unwrap();

        // Should find 2 edges, each with bound X, Y, and T
        assert_eq!(results.len(), 2);
        for result in &results {
            assert!(result.get("X").is_some());
            assert!(result.get("Y").is_some());
            assert!(result.get("T").is_some());
        }
    }

    #[test]
    fn test_eval_query_attr_value_binding() {
        // Setup graph with metadata
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            NodeRecord {
                id: 100,
                node_type: Some("http:request".to_string()),
                name: Some("GET /api/users".to_string()),
                file: Some("routes.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: Some(r#"{"url": "/api/users", "method": "GET"}"#.to_string()),
                semantic_id: None,
            },
            NodeRecord {
                id: 101,
                node_type: Some("http:request".to_string()),
                name: Some("POST /api/orders".to_string()),
                file: Some("routes.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: Some(r#"{"url": "/api/orders", "method": "POST"}"#.to_string()),
                semantic_id: None,
            },
        ]);

        let evaluator = Evaluator::new(&engine);

        // Query: node(X, "http:request"), attr(X, "url", U)
        // Should return both X (node ID) and U (url attribute value)
        let literals = parse_query("node(X, \"http:request\"), attr(X, \"url\", U)").unwrap();
        let results = evaluator.eval_query(&literals).unwrap();

        // Should find both http:request nodes
        assert_eq!(results.len(), 2);

        // Each result should have both X and U bound
        for result in &results {
            assert!(result.get("X").is_some(), "X should be bound");
            assert!(result.get("U").is_some(), "U should be bound to URL value");
        }

        // Verify actual URL values are returned
        let urls: Vec<String> = results.iter()
            .filter_map(|r| r.get("U"))
            .map(|v| v.as_str())
            .collect();
        assert!(urls.contains(&"/api/users".to_string()));
        assert!(urls.contains(&"/api/orders".to_string()));
    }

    #[test]
    fn test_eval_query_attr_with_filter() {
        // Setup graph with metadata
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            NodeRecord {
                id: 200,
                node_type: Some("http:request".to_string()),
                name: Some("GET request".to_string()),
                file: Some("routes.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: Some(r#"{"method": "GET"}"#.to_string()),
                semantic_id: None,
            },
            NodeRecord {
                id: 201,
                node_type: Some("http:request".to_string()),
                name: Some("POST request".to_string()),
                file: Some("routes.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: Some(r#"{"method": "POST"}"#.to_string()),
                semantic_id: None,
            },
        ]);

        let evaluator = Evaluator::new(&engine);

        // Query: filter by specific attribute value
        let literals = parse_query("node(X, \"http:request\"), attr(X, \"method\", \"GET\")").unwrap();
        let results = evaluator.eval_query(&literals).unwrap();

        // Should find only the GET request
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Id(200)));
    }

    #[test]
    fn test_eval_query_with_negation() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // Find publishers without any outgoing path
        // Node 3 is orphan (no edges)
        let literals = parse_query("node(X, \"queue:publish\"), \\+ path(X, _)").unwrap();
        let results = evaluator.eval_query(&literals).unwrap();

        // Should find node 3 (orphan publisher)
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Id(3)));
    }

    // ============================================================================
    // attr_edge() Predicate Tests (REG-315)
    // ============================================================================

    #[test]
    fn test_eval_attr_edge_basic() {
        // Test basic edge metadata extraction
        // attr_edge(Src, Dst, EdgeType, AttrName, Value)
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            NodeRecord {
                id: 1,
                node_type: Some("LOOP".to_string()),
                name: Some("for_loop".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
            NodeRecord {
                id: 2,
                node_type: Some("VARIABLE".to_string()),
                name: Some("items".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
        ]);

        // Add edge with metadata
        engine.add_edges(vec![
            EdgeRecord {
                src: 1,
                dst: 2,
                edge_type: Some("ITERATES_OVER".to_string()),
                version: "main".into(),
                metadata: Some(r#"{"scale": "nodes", "reason": "array_iteration"}"#.to_string()),
                deleted: false,
            },
        ], false);

        let evaluator = Evaluator::new(&engine);

        // attr_edge(1, 2, "ITERATES_OVER", "scale", X)
        let query = Atom::new("attr_edge", vec![
            Term::constant("1"),
            Term::constant("2"),
            Term::constant("ITERATES_OVER"),
            Term::constant("scale"),
            Term::var("X"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Str("nodes".to_string())));
    }

    #[test]
    fn test_eval_attr_edge_nested_path() {
        // Test nested path in edge metadata (e.g., "cardinality.scale")
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            NodeRecord {
                id: 10,
                node_type: Some("LOOP".to_string()),
                name: Some("while_loop".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
            NodeRecord {
                id: 20,
                node_type: Some("VARIABLE".to_string()),
                name: Some("data".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
        ]);

        engine.add_edges(vec![
            EdgeRecord {
                src: 10,
                dst: 20,
                edge_type: Some("ITERATES_OVER".to_string()),
                version: "main".into(),
                metadata: Some(r#"{"cardinality": {"scale": "unbounded", "reason": "recursive"}}"#.to_string()),
                deleted: false,
            },
        ], false);

        let evaluator = Evaluator::new(&engine);

        // attr_edge(10, 20, "ITERATES_OVER", "cardinality.scale", X)
        let query = Atom::new("attr_edge", vec![
            Term::constant("10"),
            Term::constant("20"),
            Term::constant("ITERATES_OVER"),
            Term::constant("cardinality.scale"),
            Term::var("X"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Str("unbounded".to_string())));
    }

    #[test]
    fn test_eval_attr_edge_constant_match() {
        // Test matching against a constant value
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            NodeRecord {
                id: 100,
                node_type: Some("LOOP".to_string()),
                name: Some("loop1".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
            NodeRecord {
                id: 200,
                node_type: Some("VARIABLE".to_string()),
                name: Some("arr".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
        ]);

        engine.add_edges(vec![
            EdgeRecord {
                src: 100,
                dst: 200,
                edge_type: Some("ITERATES_OVER".to_string()),
                version: "main".into(),
                metadata: Some(r#"{"scale": "nodes"}"#.to_string()),
                deleted: false,
            },
        ], false);

        let evaluator = Evaluator::new(&engine);

        // Match: attr_edge(100, 200, "ITERATES_OVER", "scale", "nodes")
        let query_match = Atom::new("attr_edge", vec![
            Term::constant("100"),
            Term::constant("200"),
            Term::constant("ITERATES_OVER"),
            Term::constant("scale"),
            Term::constant("nodes"),
        ]);

        let results = evaluator.query_atom(&query_match).unwrap();
        assert_eq!(results.len(), 1); // Match succeeds

        // No match: attr_edge(100, 200, "ITERATES_OVER", "scale", "constant")
        let query_no_match = Atom::new("attr_edge", vec![
            Term::constant("100"),
            Term::constant("200"),
            Term::constant("ITERATES_OVER"),
            Term::constant("scale"),
            Term::constant("constant"),
        ]);

        let results = evaluator.query_atom(&query_no_match).unwrap();
        assert_eq!(results.len(), 0); // Match fails
    }

    #[test]
    fn test_eval_attr_edge_no_metadata() {
        // Edge without metadata should return empty
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            NodeRecord {
                id: 1,
                node_type: Some("FUNCTION".to_string()),
                name: Some("caller".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
            NodeRecord {
                id: 2,
                node_type: Some("FUNCTION".to_string()),
                name: Some("callee".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
        ]);

        // Edge without metadata
        engine.add_edges(vec![
            EdgeRecord {
                src: 1,
                dst: 2,
                edge_type: Some("CALLS".to_string()),
                version: "main".into(),
                metadata: None, // No metadata
                deleted: false,
            },
        ], false);

        let evaluator = Evaluator::new(&engine);

        // attr_edge(1, 2, "CALLS", "anyattr", X)
        let query = Atom::new("attr_edge", vec![
            Term::constant("1"),
            Term::constant("2"),
            Term::constant("CALLS"),
            Term::constant("anyattr"),
            Term::var("X"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 0); // No metadata = no results
    }

    #[test]
    fn test_eval_attr_edge_missing_attr() {
        // Missing attribute in edge metadata should return empty
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            NodeRecord {
                id: 1,
                node_type: Some("LOOP".to_string()),
                name: Some("loop".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
            NodeRecord {
                id: 2,
                node_type: Some("VARIABLE".to_string()),
                name: Some("var".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
        ]);

        engine.add_edges(vec![
            EdgeRecord {
                src: 1,
                dst: 2,
                edge_type: Some("ITERATES_OVER".to_string()),
                version: "main".into(),
                metadata: Some(r#"{"scale": "nodes"}"#.to_string()),
                deleted: false,
            },
        ], false);

        let evaluator = Evaluator::new(&engine);

        // attr_edge(1, 2, "ITERATES_OVER", "nonexistent", X)
        let query = Atom::new("attr_edge", vec![
            Term::constant("1"),
            Term::constant("2"),
            Term::constant("ITERATES_OVER"),
            Term::constant("nonexistent"),
            Term::var("X"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 0); // Attribute doesn't exist
    }

    #[test]
    fn test_eval_attr_edge_edge_not_found() {
        // Non-existent edge should return empty
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            NodeRecord {
                id: 1,
                node_type: Some("FUNCTION".to_string()),
                name: Some("func".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
            NodeRecord {
                id: 2,
                node_type: Some("FUNCTION".to_string()),
                name: Some("func2".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
        ]);

        // No edges added

        let evaluator = Evaluator::new(&engine);

        // attr_edge(1, 2, "CALLS", "anyattr", X) - edge doesn't exist
        let query = Atom::new("attr_edge", vec![
            Term::constant("1"),
            Term::constant("2"),
            Term::constant("CALLS"),
            Term::constant("anyattr"),
            Term::var("X"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 0); // Edge doesn't exist
    }

    // ============================================================================
    // EvaluatorExplain Tests (REG-503)
    // ============================================================================

    #[test]
    fn test_explain_eval_query_produces_steps() {
        use crate::datalog::eval_explain::EvaluatorExplain;

        let engine = setup_test_graph();
        let mut evaluator = EvaluatorExplain::new(&engine, true);

        let literals = parse_query("node(X, \"queue:publish\")").unwrap();
        let result = evaluator.eval_query(&literals).unwrap();

        assert!(!result.explain_steps.is_empty(), "explain_steps should be non-empty when explain=true");
        assert_eq!(result.explain_steps[0].step, 1);
    }

    #[test]
    fn test_explain_eval_query_no_explain_empty_steps() {
        use crate::datalog::eval_explain::EvaluatorExplain;

        let engine = setup_test_graph();
        let mut evaluator = EvaluatorExplain::new(&engine, false);

        let literals = parse_query("node(X, \"queue:publish\")").unwrap();
        let result = evaluator.eval_query(&literals).unwrap();

        assert!(result.explain_steps.is_empty(), "explain_steps should be empty when explain=false");
        assert_eq!(result.bindings.len(), 2, "should still produce correct bindings");
    }

    #[test]
    fn test_explain_query_produces_steps() {
        use crate::datalog::eval_explain::EvaluatorExplain;

        let engine = setup_test_graph();
        let mut evaluator = EvaluatorExplain::new(&engine, true);

        let atom = parse_atom("node(X, \"queue:publish\")").unwrap();
        let result = evaluator.query(&atom);

        assert!(!result.explain_steps.is_empty(), "explain_steps should be non-empty for query() with explain=true");
    }

    #[test]
    fn test_explain_bindings_match_plain_evaluator() {
        use crate::datalog::eval_explain::EvaluatorExplain;

        let engine = setup_test_graph();

        // Run with plain Evaluator
        let evaluator = Evaluator::new(&engine);
        let literals = parse_query("node(X, \"queue:publish\")").unwrap();
        let plain_bindings = evaluator.eval_query(&literals).unwrap();

        // Run with EvaluatorExplain
        let mut explain_eval = EvaluatorExplain::new(&engine, true);
        let literals2 = parse_query("node(X, \"queue:publish\")").unwrap();
        let explain_result = explain_eval.eval_query(&literals2).unwrap();

        // Both should produce the same number of results
        assert_eq!(plain_bindings.len(), explain_result.bindings.len(),
            "plain evaluator and explain evaluator should produce same number of results");

        // Collect binding values as sorted sets for comparison
        let mut plain_values: Vec<String> = plain_bindings.iter()
            .filter_map(|b| b.get("X").map(|v| v.as_str()))
            .collect();
        plain_values.sort();

        let mut explain_values: Vec<String> = explain_result.bindings.iter()
            .filter_map(|b| b.get("X").map(|s| s.clone()))
            .collect();
        explain_values.sort();

        assert_eq!(plain_values, explain_values,
            "binding values should match between plain and explain evaluators");
    }

    /// The explain evaluator has its OWN copy of `eval_path`; pin its
    /// self-reachability semantics to the same fix as the plain evaluator so the
    /// duplicated implementations cannot drift (isolated/acyclic self = false,
    /// cyclic self = true).
    #[test]
    fn test_explain_path_self_reachability_matches_plain() {
        use crate::datalog::eval_explain::EvaluatorExplain;

        // Isolated node 3 (no edges): path(3, 3) must be empty.
        let engine = setup_test_graph();
        let mut explain_eval = EvaluatorExplain::new(&engine, true);
        let isolated = explain_eval
            .eval_query(&parse_query("path(\"3\", \"3\")").unwrap())
            .unwrap();
        assert_eq!(isolated.bindings.len(), 0, "explain: isolated node has no self path");

        // Cyclic node 100 (100->101->100): path(100, 100) must hold.
        let cycle = setup_cycle_graph();
        let mut explain_cycle = EvaluatorExplain::new(&cycle, true);
        let cyclic = explain_cycle
            .eval_query(&parse_query("path(\"100\", \"100\")").unwrap())
            .unwrap();
        assert_eq!(cyclic.bindings.len(), 1, "explain: cyclic node reaches itself");
    }

    /// REG-503 parity — wildcard arms.
    ///
    /// The plain `Evaluator` has dedicated match arms for every `Term::Wildcard`
    /// combination in `node` / `edge` / `incoming`. The explain `EvaluatorExplain`
    /// historically fell through those to `_ => vec![]`, so any atom containing a
    /// bare `_` returned 0 bindings under `--explain` while plain returned N.
    /// These tests pin the explain↔plain parity invariant for the wildcard arms.
    ///
    /// Each case asserts the explain evaluator's bindings (count, and for bound
    /// vars the value set) equal the plain evaluator's on the shared test graph
    /// (ids 1,3 = `queue:publish`, id 2 = `queue:consume`, id 4 = `FUNCTION`;
    /// edges 1→4 and 4→2, both `CALLS`).
    fn assert_explain_parity(query: &str, var: Option<&str>) {
        use crate::datalog::eval_explain::EvaluatorExplain;

        let engine = setup_test_graph();

        let evaluator = Evaluator::new(&engine);
        let plain = evaluator
            .eval_query(&parse_query(query).unwrap())
            .unwrap();

        let mut explain_eval = EvaluatorExplain::new(&engine, true);
        let explain = explain_eval
            .eval_query(&parse_query(query).unwrap())
            .unwrap();

        assert_eq!(
            plain.len(),
            explain.bindings.len(),
            "explain evaluator must produce the same number of bindings as plain for `{query}` (parity)"
        );

        if let Some(v) = var {
            let mut plain_vals: Vec<String> =
                plain.iter().filter_map(|b| b.get(v).map(|x| x.as_str())).collect();
            plain_vals.sort();

            let mut explain_vals: Vec<String> =
                explain.bindings.iter().filter_map(|b| b.get(v).cloned()).collect();
            explain_vals.sort();

            assert_eq!(
                plain_vals, explain_vals,
                "explain evaluator must bind `{v}` to the same values as plain for `{query}` (parity)"
            );
        }
    }

    #[test]
    fn test_explain_node_wildcard_id_matches_plain() {
        // node(_, "type") — (Wildcard, Const): plain finds 2 publish nodes.
        assert_explain_parity("node(_, \"queue:publish\")", None);
    }

    #[test]
    fn test_explain_node_wildcard_type_matches_plain() {
        // node(X, _) — (Var, Wildcard): plain enumerates all 4 nodes, binds id.
        assert_explain_parity("node(X, _)", Some("X"));
    }

    #[test]
    fn test_explain_node_wildcard_id_var_type_matches_plain() {
        // node(_, T) — (Wildcard, Var): plain enumerates all 4 nodes, binds type.
        assert_explain_parity("node(_, T)", Some("T"));
    }

    #[test]
    fn test_explain_node_both_wildcard_matches_plain() {
        // node(_, _) — (Wildcard, Wildcard): plain enumerates all 4 nodes.
        assert_explain_parity("node(_, _)", None);
    }

    #[test]
    fn test_explain_node_const_wildcard_type_matches_plain() {
        // node("1", _) — (Const, Wildcard): plain checks node 1 exists.
        assert_explain_parity("node(\"1\", _)", None);
    }

    #[test]
    fn test_explain_edge_wildcard_src_matches_plain() {
        // edge(_, X, "CALLS") — Wildcard src: plain enumerates 2 CALLS edges, binds dst.
        assert_explain_parity("edge(_, X, \"CALLS\")", Some("X"));
    }

    #[test]
    fn test_explain_incoming_wildcard_dst_matches_plain() {
        // incoming(_, X, "CALLS") — Wildcard dst: plain enumerates 2 CALLS edges, binds src.
        assert_explain_parity("incoming(_, X, \"CALLS\")", Some("X"));
    }

    #[test]
    fn test_explain_incoming_untyped_var_dst_matches_plain() {
        // incoming(D, S) — Var dst, NO edge-type constant: the explain evaluator
        // has its own copy of eval_incoming, so pin the untyped enumeration to
        // the plain evaluator. Parity alone is insufficient here (both returned 0
        // before the fix → 0 == 0 would pass), so assert the non-empty count too.
        use crate::datalog::eval_explain::EvaluatorExplain;

        let engine = setup_test_graph(); // edges: 1->4, 4->2
        let mut explain_eval = EvaluatorExplain::new(&engine, true);
        let result = explain_eval
            .eval_query(&parse_query("incoming(D, S)").unwrap())
            .unwrap();
        assert_eq!(
            result.bindings.len(),
            2,
            "explain: untyped incoming(D,S) must enumerate all edges"
        );

        assert_explain_parity("incoming(D, S)", Some("S"));
    }

    #[test]
    fn test_explain_stats_populated() {
        use crate::datalog::eval_explain::EvaluatorExplain;

        let engine = setup_test_graph();
        let mut evaluator = EvaluatorExplain::new(&engine, true);

        let literals = parse_query("node(X, \"queue:publish\")").unwrap();
        let result = evaluator.eval_query(&literals).unwrap();

        assert!(result.stats.nodes_visited > 0,
            "stats.nodes_visited should be > 0 after querying nodes");
        assert!(result.stats.find_by_type_calls > 0,
            "stats.find_by_type_calls should be > 0 after node query by type");
        assert_eq!(result.stats.total_results, 2,
            "stats.total_results should match number of bindings");
    }

    // REG-315 / REG-503 regression: the explain evaluator must support the
    // attr_edge() builtin exactly like the plain evaluator. Before the fix,
    // EvaluatorExplain omitted attr_edge from its builtin dispatch, so under
    // `--explain` the atom fell through to derived-predicate lookup (no such
    // rule) and silently returned zero bindings — making `--explain` change
    // the answer for any query/guarantee that uses attr_edge.
    #[test]
    fn test_explain_attr_edge_matches_plain_evaluator() {
        use crate::datalog::eval_explain::EvaluatorExplain;

        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            NodeRecord {
                id: 1,
                node_type: Some("LOOP".to_string()),
                name: Some("for_loop".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            },
            NodeRecord {
                id: 2,
                node_type: Some("VARIABLE".to_string()),
                name: Some("items".to_string()),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            },
        ]);

        engine.add_edges(vec![
            EdgeRecord {
                src: 1,
                dst: 2,
                edge_type: Some("ITERATES_OVER".to_string()),
                version: "main".into(),
                metadata: Some(r#"{"scale": "nodes", "reason": "array_iteration"}"#.to_string()),
                deleted: false,
            },
        ], false);

        // attr_edge(1, 2, "ITERATES_OVER", "scale", X)
        let query = Atom::new("attr_edge", vec![
            Term::constant("1"),
            Term::constant("2"),
            Term::constant("ITERATES_OVER"),
            Term::constant("scale"),
            Term::var("X"),
        ]);

        // Plain evaluator (ground truth)
        let plain = Evaluator::new(&engine);
        let plain_results = plain.query_atom(&query).unwrap();
        assert_eq!(plain_results.len(), 1, "plain evaluator should bind X once");
        assert_eq!(plain_results[0].get("X"), Some(&Value::Str("nodes".to_string())));

        // Explain evaluator must produce the SAME binding
        let mut explain_eval = EvaluatorExplain::new(&engine, true);
        let explain_result = explain_eval.query(&query);
        assert_eq!(
            explain_result.bindings.len(),
            plain_results.len(),
            "explain evaluator must produce the same attr_edge bindings as the plain evaluator"
        );
        assert_eq!(
            explain_result.bindings[0].get("X").map(|s| s.as_str()),
            Some("nodes"),
            "explain evaluator must bind X to the edge metadata value"
        );
    }

    #[test]
    fn test_eval_attr_edge_in_rule() {
        // Test attr_edge() used in a Datalog rule context
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            NodeRecord {
                id: 1,
                node_type: Some("LOOP".to_string()),
                name: Some("loop1".to_string()),
                file: Some("api.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
            NodeRecord {
                id: 2,
                node_type: Some("LOOP".to_string()),
                name: Some("loop2".to_string()),
                file: Some("worker.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
            NodeRecord {
                id: 10,
                node_type: Some("VARIABLE".to_string()),
                name: Some("users".to_string()),
                file: Some("api.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
            NodeRecord {
                id: 20,
                node_type: Some("VARIABLE".to_string()),
                name: Some("items".to_string()),
                file: Some("worker.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
            semantic_id: None,
            },
        ]);

        engine.add_edges(vec![
            // Loop 1 iterates over a large collection (nodes scale)
            EdgeRecord {
                src: 1,
                dst: 10,
                edge_type: Some("ITERATES_OVER".to_string()),
                version: "main".into(),
                metadata: Some(r#"{"scale": "nodes"}"#.to_string()),
                deleted: false,
            },
            // Loop 2 iterates over a constant-size collection
            EdgeRecord {
                src: 2,
                dst: 20,
                edge_type: Some("ITERATES_OVER".to_string()),
                version: "main".into(),
                metadata: Some(r#"{"scale": "constant"}"#.to_string()),
                deleted: false,
            },
        ], false);

        let mut evaluator = Evaluator::new(&engine);

        // Rule: Find loops that iterate over large collections
        // large_iteration(Loop, Var, File) :-
        //     node(Loop, "LOOP"),
        //     edge(Loop, Var, "ITERATES_OVER"),
        //     attr_edge(Loop, Var, "ITERATES_OVER", "scale", "nodes"),
        //     attr(Loop, "file", File).
        let rule = parse_rule(
            r#"large_iteration(Loop, Var, File) :- node(Loop, "LOOP"), edge(Loop, Var, "ITERATES_OVER"), attr_edge(Loop, Var, "ITERATES_OVER", "scale", "nodes"), attr(Loop, "file", File)."#
        ).unwrap();
        evaluator.add_rule(rule);

        let query = parse_atom("large_iteration(Loop, Var, File)").unwrap();
        let results = evaluator.query(&query).unwrap();

        // Only loop 1 should match (scale = "nodes")
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("Loop"), Some(&Value::Id(1)));
        assert_eq!(results[0].get("Var"), Some(&Value::Id(10)));
        assert_eq!(results[0].get("File"), Some(&Value::Str("api.js".to_string())));
    }

    // ============================================================================
    // Query Reordering Tests (REG-504)
    // ============================================================================

    // --- Tests 0a-0d: reorder_literals unit tests (no graph needed) ---

    mod reorder_tests {
        use super::*;
        use crate::datalog::utils::reorder_literals;

        #[test]
        fn test_reorder_empty_input() {
            // 0a: empty input returns empty output
            let result = reorder_literals(&[]);
            assert_eq!(result.unwrap(), vec![]);
        }

        #[test]
        fn test_reorder_already_correct_order() {
            // 0b: [node(X, "CALL"), attr(X, "name", V)] is already correct — preserved
            let lit_node = Literal::positive(Atom::new("node", vec![
                Term::var("X"),
                Term::constant("CALL"),
            ]));
            let lit_attr = Literal::positive(Atom::new("attr", vec![
                Term::var("X"),
                Term::constant("name"),
                Term::var("V"),
            ]));

            let input = vec![lit_node.clone(), lit_attr.clone()];
            let result = reorder_literals(&input).unwrap();

            assert_eq!(result.len(), 2);
            assert_eq!(result[0], lit_node);
            assert_eq!(result[1], lit_attr);
        }

        #[test]
        fn test_reorder_wrong_order_fixed() {
            // 0c: [attr(X, "name", V), node(X, "CALL")] reordered to [node first, attr second]
            let lit_node = Literal::positive(Atom::new("node", vec![
                Term::var("X"),
                Term::constant("CALL"),
            ]));
            let lit_attr = Literal::positive(Atom::new("attr", vec![
                Term::var("X"),
                Term::constant("name"),
                Term::var("V"),
            ]));

            let input = vec![lit_attr.clone(), lit_node.clone()];
            let result = reorder_literals(&input).unwrap();

            assert_eq!(result.len(), 2);
            // node must come first because attr requires X to be bound
            assert_eq!(result[0], lit_node);
            assert_eq!(result[1], lit_attr);
        }

        #[test]
        fn test_reorder_circular_dependency_returns_err() {
            // 0d: [attr(X, "n", Y), attr(Y, "n", X)] — both require bound id, neither provides seed
            let lit1 = Literal::positive(Atom::new("attr", vec![
                Term::var("X"),
                Term::constant("n"),
                Term::var("Y"),
            ]));
            let lit2 = Literal::positive(Atom::new("attr", vec![
                Term::var("Y"),
                Term::constant("n"),
                Term::var("X"),
            ]));

            let input = vec![lit1, lit2];
            let result = reorder_literals(&input);

            assert!(result.is_err(), "circular dependency should return Err");
            let err_msg = result.unwrap_err();
            assert!(
                err_msg.contains("circular"),
                "error message should contain 'circular', got: {err_msg}"
            );
        }
    }

    // --- Tests 1-8: Integration tests via evaluator ---

    /// Helper: set up a graph with CALL nodes, attributes, and edges for reorder tests
    fn setup_reorder_test_graph() -> GraphEngineV2 {
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            // CALL node: handleRequest
            NodeRecord {
                id: 1,
                node_type: Some("CALL".to_string()),
                name: Some("handleRequest".to_string()),
                file: Some("api.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            },
            // CALL node: handleOrder
            NodeRecord {
                id: 2,
                node_type: Some("CALL".to_string()),
                name: Some("handleOrder".to_string()),
                file: Some("order.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            },
            // FUNCTION node: target of CALL 1
            NodeRecord {
                id: 3,
                node_type: Some("FUNCTION".to_string()),
                name: Some("processRequest".to_string()),
                file: Some("handler.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            },
            // queue:publish node (for negation/incoming tests)
            NodeRecord {
                id: 4,
                node_type: Some("queue:publish".to_string()),
                name: Some("events-pub".to_string()),
                file: Some("events.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            },
            // Another CALL node: doWork (does NOT start with "handle")
            NodeRecord {
                id: 5,
                node_type: Some("CALL".to_string()),
                name: Some("doWork".to_string()),
                file: Some("worker.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            },
        ]);

        // Edges: 1 calls 3, 3 calls 4 (creating a path 1->3->4)
        engine.add_edges(vec![
            EdgeRecord {
                src: 1,
                dst: 3,
                edge_type: Some("calls".to_string()),
                version: "main".into(),
                metadata: None,
                deleted: false,
            },
            EdgeRecord {
                src: 3,
                dst: 4,
                edge_type: Some("calls".to_string()),
                version: "main".into(),
                metadata: None,
                deleted: false,
            },
        ], false);

        engine
    }

    #[test]
    fn test_reorder_attr_before_node_gives_same_results() {
        // Test 1: attr before node (wrong order) gives same results as correct order
        let engine = setup_reorder_test_graph();
        let evaluator = Evaluator::new(&engine);

        let wrong_order = parse_query(r#"attr(X, "name", N), node(X, "CALL")"#).unwrap();
        let correct_order = parse_query(r#"node(X, "CALL"), attr(X, "name", N)"#).unwrap();

        let results_wrong = evaluator.eval_query(&wrong_order).unwrap();
        let results_correct = evaluator.eval_query(&correct_order).unwrap();

        assert_eq!(
            results_wrong.len(), results_correct.len(),
            "wrong order and correct order should produce same number of results"
        );
        assert!(
            !results_correct.is_empty(),
            "results should be non-empty (graph has CALL nodes)"
        );

        // Collect and sort values for deterministic comparison
        let mut wrong_vals: Vec<String> = results_wrong.iter()
            .filter_map(|b| b.get("N").map(|v| v.as_str()))
            .collect();
        wrong_vals.sort();

        let mut correct_vals: Vec<String> = results_correct.iter()
            .filter_map(|b| b.get("N").map(|v| v.as_str()))
            .collect();
        correct_vals.sort();

        assert_eq!(wrong_vals, correct_vals, "bound values should match regardless of order");
    }

    #[test]
    fn test_reorder_negation_before_positive_gives_same_results() {
        // Test 2: negation before positive (wrong order) gives same results
        let engine = setup_reorder_test_graph();
        let evaluator = Evaluator::new(&engine);

        let wrong_order = parse_query(r#"\+ path(X, _), node(X, "queue:publish")"#).unwrap();
        let correct_order = parse_query(r#"node(X, "queue:publish"), \+ path(X, _)"#).unwrap();

        let results_wrong = evaluator.eval_query(&wrong_order).unwrap();
        let results_correct = evaluator.eval_query(&correct_order).unwrap();

        assert_eq!(
            results_wrong.len(), results_correct.len(),
            "negation-first and positive-first should produce same results"
        );
    }

    #[test]
    fn test_reorder_already_correct_order_still_works() {
        // Test 3: already correct order returns expected results
        let engine = setup_reorder_test_graph();
        let evaluator = Evaluator::new(&engine);

        let literals = parse_query(r#"node(X, "CALL"), attr(X, "name", N)"#).unwrap();
        let results = evaluator.eval_query(&literals).unwrap();

        // Graph has 3 CALL nodes (ids 1, 2, 5)
        assert_eq!(results.len(), 3, "should find all 3 CALL nodes");

        let mut names: Vec<String> = results.iter()
            .filter_map(|b| b.get("N").map(|v| v.as_str()))
            .collect();
        names.sort();

        assert_eq!(names, vec!["doWork", "handleOrder", "handleRequest"]);
    }

    #[test]
    fn test_reorder_circular_dependency_returns_err() {
        // Test 4: circular dependency via eval_query returns Err
        let engine = setup_reorder_test_graph();
        let evaluator = Evaluator::new(&engine);

        // Construct a pathological query: attr(X, "k", Y), attr(Y, "k", X)
        // Both need bound first arg, neither provides a seed
        let circular = vec![
            Literal::positive(Atom::new("attr", vec![
                Term::var("X"),
                Term::constant("k"),
                Term::var("Y"),
            ])),
            Literal::positive(Atom::new("attr", vec![
                Term::var("Y"),
                Term::constant("k"),
                Term::var("X"),
            ])),
        ];

        let result = evaluator.eval_query(&circular);
        assert!(result.is_err(), "circular dependency should return Err from eval_query");
        let err_msg = result.unwrap_err();
        assert!(
            err_msg.contains("circular"),
            "error message should contain 'circular', got: {err_msg}"
        );
    }

    #[test]
    fn test_reorder_multi_variable_chain() {
        // Test 5: node -> attr -> edge -> attr chain reordered from wrong order
        let engine = setup_reorder_test_graph();
        let evaluator = Evaluator::new(&engine);

        // Wrong order: attr of Dst first, then edge, then attr of X, then node
        let wrong_order = parse_query(
            r#"attr(Dst, "name", L), edge(X, Dst, "calls"), attr(X, "name", N), node(X, "CALL")"#
        ).unwrap();
        // Correct order: node first, then attr(X), then edge, then attr(Dst)
        let correct_order = parse_query(
            r#"node(X, "CALL"), attr(X, "name", N), edge(X, Dst, "calls"), attr(Dst, "name", L)"#
        ).unwrap();

        let results_wrong = evaluator.eval_query(&wrong_order).unwrap();
        let results_correct = evaluator.eval_query(&correct_order).unwrap();

        assert_eq!(
            results_wrong.len(), results_correct.len(),
            "multi-variable chain: wrong and correct order should produce same number of results"
        );
        assert!(
            !results_correct.is_empty(),
            "should find at least one match (node 1 calls node 3)"
        );

        // Verify the bound values match
        let mut wrong_labels: Vec<String> = results_wrong.iter()
            .filter_map(|b| b.get("L").map(|v| v.as_str()))
            .collect();
        wrong_labels.sort();

        let mut correct_labels: Vec<String> = results_correct.iter()
            .filter_map(|b| b.get("L").map(|v| v.as_str()))
            .collect();
        correct_labels.sort();

        assert_eq!(wrong_labels, correct_labels, "bound labels should match");
    }

    #[test]
    fn test_reorder_constraint_predicates_after_bindings() {
        // Test 6: neq before node bindings (wrong order) gives same results
        let engine = setup_reorder_test_graph();
        let evaluator = Evaluator::new(&engine);

        let wrong_order = parse_query(
            r#"neq(X, Y), node(X, "CALL"), node(Y, "CALL")"#
        ).unwrap();
        let correct_order = parse_query(
            r#"node(X, "CALL"), node(Y, "CALL"), neq(X, Y)"#
        ).unwrap();

        let results_wrong = evaluator.eval_query(&wrong_order).unwrap();
        let results_correct = evaluator.eval_query(&correct_order).unwrap();

        assert_eq!(
            results_wrong.len(), results_correct.len(),
            "neq before/after node bindings should produce same results"
        );
        // 3 CALL nodes: 3*2=6 ordered pairs where X != Y
        assert_eq!(results_correct.len(), 6, "3 CALL nodes, 6 ordered pairs");
    }

    #[test]
    fn test_reorder_rule_body() {
        // Test 7: rule body with wrong order (attr and starts_with before node) still works
        let engine = setup_reorder_test_graph();
        let mut evaluator = Evaluator::new(&engine);

        // Rule body has attr and starts_with before node — needs reordering
        let rule = parse_rule(
            r#"caller(X) :- attr(X, "name", N), node(X, "CALL"), starts_with(N, "handle")."#
        ).unwrap();
        evaluator.add_rule(rule);

        let query = parse_atom("caller(X)").unwrap();
        let results = evaluator.query(&query).unwrap();

        // Should find nodes 1 (handleRequest) and 2 (handleOrder)
        assert_eq!(results.len(), 2, "should find 2 CALL nodes starting with 'handle'");

        let mut ids: Vec<u128> = results.iter()
            .filter_map(|b| b.get("X").and_then(|v| v.as_id()))
            .collect();
        ids.sort();

        assert_eq!(ids, vec![1, 2]);
    }

    #[test]
    fn test_reorder_incoming_with_unbound_dst() {
        // Test 8: incoming with unbound dst before node that provides dst
        let engine = setup_reorder_test_graph();
        let evaluator = Evaluator::new(&engine);

        // Wrong order: incoming before node (X is unbound when incoming is evaluated)
        let wrong_order = parse_query(
            r#"incoming(X, Src, "calls"), node(X, "FUNCTION")"#
        ).unwrap();
        // Correct order: node first, then incoming
        let correct_order = parse_query(
            r#"node(X, "FUNCTION"), incoming(X, Src, "calls")"#
        ).unwrap();

        let results_wrong = evaluator.eval_query(&wrong_order).unwrap();
        let results_correct = evaluator.eval_query(&correct_order).unwrap();

        assert_eq!(
            results_wrong.len(), results_correct.len(),
            "incoming with unbound dst: wrong and correct order should produce same results"
        );
        // Node 3 is FUNCTION and has incoming edge from node 1
        assert!(
            !results_correct.is_empty(),
            "should find at least one match"
        );
    }

    // ============================================================================
    // Slow Query Warnings Tests (REG-506)
    // ============================================================================

    #[test]
    fn test_warning_node_full_scan() {
        use crate::datalog::eval_explain::EvaluatorExplain;

        let engine = setup_test_graph();
        let mut evaluator = EvaluatorExplain::new(&engine, true);

        // node(X, Y) — both variables unbound → full node scan warning
        let literals = parse_query("node(X, Y)").unwrap();
        let result = evaluator.eval_query(&literals).unwrap();

        assert!(result.warnings.contains(&"Full node scan: consider binding type".to_string()),
            "should warn about full node scan when both args are variables");
    }

    #[test]
    fn test_no_warning_node_bound_type() {
        use crate::datalog::eval_explain::EvaluatorExplain;

        let engine = setup_test_graph();
        let mut evaluator = EvaluatorExplain::new(&engine, true);

        // node(X, "FUNCTION") — type is bound → no warning
        let literals = parse_query("node(X, \"FUNCTION\")").unwrap();
        let result = evaluator.eval_query(&literals).unwrap();

        assert!(result.warnings.is_empty(),
            "should not warn when type is bound: {:?}", result.warnings);
    }

    #[test]
    fn test_warning_edge_full_scan() {
        use crate::datalog::eval_explain::EvaluatorExplain;

        let engine = setup_test_graph();
        let mut evaluator = EvaluatorExplain::new(&engine, true);

        // edge(X, Y, T) — source unbound → full edge scan warning
        let literals = parse_query("edge(X, Y, T)").unwrap();
        let result = evaluator.eval_query(&literals).unwrap();

        assert!(result.warnings.contains(&"Full edge scan: consider binding source node".to_string()),
            "should warn about full edge scan when source is unbound");
    }

    #[test]
    fn test_no_warning_edge_bound_source() {
        use crate::datalog::eval_explain::EvaluatorExplain;

        let engine = setup_test_graph();
        let mut evaluator = EvaluatorExplain::new(&engine, true);

        // edge("1", Y, T) — source is bound → no warning
        let literals = parse_query("edge(\"1\", Y, T)").unwrap();
        let result = evaluator.eval_query(&literals).unwrap();

        assert!(result.warnings.is_empty(),
            "should not warn when source is bound: {:?}", result.warnings);
    }

    #[test]
    fn test_warnings_without_explain_mode() {
        use crate::datalog::eval_explain::EvaluatorExplain;

        let engine = setup_test_graph();
        let mut evaluator = EvaluatorExplain::new(&engine, false);

        // Warnings should still be collected even without explain mode
        let literals = parse_query("node(X, Y)").unwrap();
        let result = evaluator.eval_query(&literals).unwrap();

        assert!(result.warnings.contains(&"Full node scan: consider binding type".to_string()),
            "should collect warnings even when explain_mode=false");
        assert!(result.explain_steps.is_empty(),
            "explain_steps should be empty when explain_mode=false");
    }

    #[test]
    fn test_warnings_empty_for_efficient_query() {
        use crate::datalog::eval_explain::EvaluatorExplain;

        let engine = setup_test_graph();
        let mut evaluator = EvaluatorExplain::new(&engine, true);

        // Efficient query: bound type + bound source
        let literals = parse_query("node(X, \"FUNCTION\"), edge(X, Y, \"CALLS\")").unwrap();
        let result = evaluator.eval_query(&literals).unwrap();

        assert!(result.warnings.is_empty(),
            "efficient query should not produce warnings: {:?}", result.warnings);
    }

    #[test]
    fn test_warnings_deduplicated_in_multi_literal_query() {
        use crate::datalog::eval_explain::EvaluatorExplain;

        let engine = setup_test_graph();
        let mut evaluator = EvaluatorExplain::new(&engine, true);

        // Multi-literal query where node(X, Y) triggers per-binding evaluation
        // of node(Z, W) — both arms hit (Var, Var), but warning should appear once
        let literals = parse_query("node(X, Y), node(Z, W)").unwrap();
        let result = evaluator.eval_query(&literals).unwrap();

        let node_warnings: Vec<_> = result.warnings.iter()
            .filter(|w| w.contains("Full node scan"))
            .collect();
        assert_eq!(node_warnings.len(), 1,
            "duplicate full-scan warnings should be deduplicated: {:?}", result.warnings);
    }

    #[test]
    fn test_warnings_cleared_between_queries() {
        use crate::datalog::eval_explain::EvaluatorExplain;

        let engine = setup_test_graph();
        let mut evaluator = EvaluatorExplain::new(&engine, true);

        // First query: full scan → warning
        let literals1 = parse_query("node(X, Y)").unwrap();
        let result1 = evaluator.eval_query(&literals1).unwrap();
        assert!(!result1.warnings.is_empty(), "first query should have warnings");

        // Second query: efficient → no warning
        let literals2 = parse_query("node(X, \"FUNCTION\")").unwrap();
        let result2 = evaluator.eval_query(&literals2).unwrap();
        assert!(result2.warnings.is_empty(),
            "second query should not carry over warnings from first: {:?}", result2.warnings);
    }

    // ============================================================================
    // parent_function() Predicate Tests (REG-544)
    // ============================================================================

    mod parent_function_tests {
        use super::*;

        /// Build a graph that exercises all parent_function traversal cases:
        ///
        /// MODULE(id=1)
        ///   -[CONTAINS]-> FUNCTION(id=10, name="myFunc")
        ///     -[HAS_SCOPE]-> SCOPE(id=20)
        ///       -[CONTAINS]-> CALL(id=30, method="doSomething")
        ///       -[CONTAINS]-> SCOPE(id=21)       // nested if-block
        ///         -[CONTAINS]-> CALL(id=31)      // nested call
        ///       -[DECLARES]-> VARIABLE(id=40)
        ///     -[HAS_PARAMETER]-> PARAMETER(id=50, name="x")
        ///   -[CONTAINS]-> CALL(id=60)            // module-level call, NO parent function
        ///
        /// CLASS(id=2)
        ///   -[CONTAINS]-> FUNCTION(id=11, name="myMethod")
        ///     -[HAS_SCOPE]-> SCOPE(id=22)
        ///       -[CONTAINS]-> CALL(id=32)
        fn setup_parent_function_graph() -> GraphEngineV2 {
            let mut engine = GraphEngineV2::create_ephemeral();

            engine.add_nodes(vec![
                // MODULE node
                NodeRecord {
                    id: 1,
                    node_type: Some("MODULE".to_string()),
                    name: Some("index.js".to_string()),
                    file: Some("index.js".to_string()),
                    file_id: 0,
                    name_offset: 0,
                    version: "main".into(),
                    exported: false,
                    replaces: None,
                    deleted: false,
                    metadata: None,
                    semantic_id: None,
                },
                // CLASS node
                NodeRecord {
                    id: 2,
                    node_type: Some("CLASS".to_string()),
                    name: Some("MyClass".to_string()),
                    file: Some("index.js".to_string()),
                    file_id: 0,
                    name_offset: 0,
                    version: "main".into(),
                    exported: false,
                    replaces: None,
                    deleted: false,
                    metadata: None,
                    semantic_id: None,
                },
                // FUNCTION node (top-level function)
                NodeRecord {
                    id: 10,
                    node_type: Some("FUNCTION".to_string()),
                    name: Some("myFunc".to_string()),
                    file: Some("index.js".to_string()),
                    file_id: 0,
                    name_offset: 0,
                    version: "main".into(),
                    exported: false,
                    replaces: None,
                    deleted: false,
                    metadata: None,
                    semantic_id: None,
                },
                // FUNCTION node (class method — stored as FUNCTION per ClassVisitor.ts:358)
                NodeRecord {
                    id: 11,
                    node_type: Some("FUNCTION".to_string()),
                    name: Some("myMethod".to_string()),
                    file: Some("index.js".to_string()),
                    file_id: 0,
                    name_offset: 0,
                    version: "main".into(),
                    exported: false,
                    replaces: None,
                    deleted: false,
                    metadata: None,
                    semantic_id: None,
                },
                // SCOPE node (function body of myFunc)
                NodeRecord {
                    id: 20,
                    node_type: Some("SCOPE".to_string()),
                    name: None,
                    file: Some("index.js".to_string()),
                    file_id: 0,
                    name_offset: 0,
                    version: "main".into(),
                    exported: false,
                    replaces: None,
                    deleted: false,
                    metadata: None,
                    semantic_id: None,
                },
                // SCOPE node (nested if-block inside myFunc)
                NodeRecord {
                    id: 21,
                    node_type: Some("SCOPE".to_string()),
                    name: None,
                    file: Some("index.js".to_string()),
                    file_id: 0,
                    name_offset: 0,
                    version: "main".into(),
                    exported: false,
                    replaces: None,
                    deleted: false,
                    metadata: None,
                    semantic_id: None,
                },
                // SCOPE node (function body of myMethod)
                NodeRecord {
                    id: 22,
                    node_type: Some("SCOPE".to_string()),
                    name: None,
                    file: Some("index.js".to_string()),
                    file_id: 0,
                    name_offset: 0,
                    version: "main".into(),
                    exported: false,
                    replaces: None,
                    deleted: false,
                    metadata: None,
                    semantic_id: None,
                },
                // CALL node (direct call in myFunc body)
                NodeRecord {
                    id: 30,
                    node_type: Some("CALL".to_string()),
                    name: Some("doSomething".to_string()),
                    file: Some("index.js".to_string()),
                    file_id: 0,
                    name_offset: 0,
                    version: "main".into(),
                    exported: false,
                    replaces: None,
                    deleted: false,
                    metadata: Some(r#"{"method":"doSomething"}"#.to_string()),
                    semantic_id: None,
                },
                // CALL node (nested call inside if-block in myFunc)
                NodeRecord {
                    id: 31,
                    node_type: Some("CALL".to_string()),
                    name: Some("nestedCall".to_string()),
                    file: Some("index.js".to_string()),
                    file_id: 0,
                    name_offset: 0,
                    version: "main".into(),
                    exported: false,
                    replaces: None,
                    deleted: false,
                    metadata: None,
                    semantic_id: None,
                },
                // CALL node (call inside class method myMethod)
                NodeRecord {
                    id: 32,
                    node_type: Some("CALL".to_string()),
                    name: Some("classCall".to_string()),
                    file: Some("index.js".to_string()),
                    file_id: 0,
                    name_offset: 0,
                    version: "main".into(),
                    exported: false,
                    replaces: None,
                    deleted: false,
                    metadata: None,
                    semantic_id: None,
                },
                // VARIABLE node (declared in myFunc body via DECLARES)
                NodeRecord {
                    id: 40,
                    node_type: Some("VARIABLE".to_string()),
                    name: Some("localVar".to_string()),
                    file: Some("index.js".to_string()),
                    file_id: 0,
                    name_offset: 0,
                    version: "main".into(),
                    exported: false,
                    replaces: None,
                    deleted: false,
                    metadata: None,
                    semantic_id: None,
                },
                // PARAMETER node (parameter of myFunc)
                NodeRecord {
                    id: 50,
                    node_type: Some("PARAMETER".to_string()),
                    name: Some("x".to_string()),
                    file: Some("index.js".to_string()),
                    file_id: 0,
                    name_offset: 0,
                    version: "main".into(),
                    exported: false,
                    replaces: None,
                    deleted: false,
                    metadata: None,
                    semantic_id: None,
                },
                // CALL node (module-level call, no parent function)
                NodeRecord {
                    id: 60,
                    node_type: Some("CALL".to_string()),
                    name: Some("moduleLevelCall".to_string()),
                    file: Some("index.js".to_string()),
                    file_id: 0,
                    name_offset: 0,
                    version: "main".into(),
                    exported: false,
                    replaces: None,
                    deleted: false,
                    metadata: None,
                    semantic_id: None,
                },
            ]);

            engine.add_edges(vec![
                // MODULE(1) -[CONTAINS]-> FUNCTION(10)
                EdgeRecord {
                    src: 1,
                    dst: 10,
                    edge_type: Some("CONTAINS".to_string()),
                    version: "main".into(),
                    metadata: None,
                    deleted: false,
                },
                // MODULE(1) -[CONTAINS]-> CALL(60)  (module-level call)
                EdgeRecord {
                    src: 1,
                    dst: 60,
                    edge_type: Some("CONTAINS".to_string()),
                    version: "main".into(),
                    metadata: None,
                    deleted: false,
                },
                // FUNCTION(10) -[HAS_SCOPE]-> SCOPE(20)
                EdgeRecord {
                    src: 10,
                    dst: 20,
                    edge_type: Some("HAS_SCOPE".to_string()),
                    version: "main".into(),
                    metadata: None,
                    deleted: false,
                },
                // FUNCTION(10) -[HAS_PARAMETER]-> PARAMETER(50)
                EdgeRecord {
                    src: 10,
                    dst: 50,
                    edge_type: Some("HAS_PARAMETER".to_string()),
                    version: "main".into(),
                    metadata: None,
                    deleted: false,
                },
                // SCOPE(20) -[CONTAINS]-> CALL(30)
                EdgeRecord {
                    src: 20,
                    dst: 30,
                    edge_type: Some("CONTAINS".to_string()),
                    version: "main".into(),
                    metadata: None,
                    deleted: false,
                },
                // SCOPE(20) -[CONTAINS]-> SCOPE(21) (nested if-block)
                EdgeRecord {
                    src: 20,
                    dst: 21,
                    edge_type: Some("CONTAINS".to_string()),
                    version: "main".into(),
                    metadata: None,
                    deleted: false,
                },
                // SCOPE(20) -[DECLARES]-> VARIABLE(40)
                EdgeRecord {
                    src: 20,
                    dst: 40,
                    edge_type: Some("DECLARES".to_string()),
                    version: "main".into(),
                    metadata: None,
                    deleted: false,
                },
                // SCOPE(21) -[CONTAINS]-> CALL(31) (nested call)
                EdgeRecord {
                    src: 21,
                    dst: 31,
                    edge_type: Some("CONTAINS".to_string()),
                    version: "main".into(),
                    metadata: None,
                    deleted: false,
                },
                // CLASS(2) -[CONTAINS]-> FUNCTION(11) (class method)
                EdgeRecord {
                    src: 2,
                    dst: 11,
                    edge_type: Some("CONTAINS".to_string()),
                    version: "main".into(),
                    metadata: None,
                    deleted: false,
                },
                // FUNCTION(11) -[HAS_SCOPE]-> SCOPE(22) (method body)
                EdgeRecord {
                    src: 11,
                    dst: 22,
                    edge_type: Some("HAS_SCOPE".to_string()),
                    version: "main".into(),
                    metadata: None,
                    deleted: false,
                },
                // SCOPE(22) -[CONTAINS]-> CALL(32) (call inside class method)
                EdgeRecord {
                    src: 22,
                    dst: 32,
                    edge_type: Some("CONTAINS".to_string()),
                    version: "main".into(),
                    metadata: None,
                    deleted: false,
                },
            ], false);

            engine
        }

        // Test 1: CALL(30) directly inside function body SCOPE(20) → returns FUNCTION(10)
        // BFS path: CALL(30) <-[CONTAINS]- SCOPE(20) <-[HAS_SCOPE]- FUNCTION(10) → match
        #[test]
        fn test_parent_function_direct_call() {
            let engine = setup_parent_function_graph();
            let evaluator = Evaluator::new(&engine);

            let query = Atom::new("parent_function", vec![
                Term::constant("30"),
                Term::var("F"),
            ]);

            let results = evaluator.query_atom(&query).unwrap();
            assert_eq!(results.len(), 1, "should find exactly one parent function");
            assert_eq!(results[0].get("F"), Some(&Value::Id(10)),
                "parent function of CALL(30) should be FUNCTION(10)");
        }

        // Test 2: CALL(31) inside nested SCOPE(21) inside SCOPE(20) inside FUNCTION(10)
        // BFS path: CALL(31) <-[CONTAINS]- SCOPE(21) <-[CONTAINS]- SCOPE(20)
        //           <-[HAS_SCOPE]- FUNCTION(10) → match
        #[test]
        fn test_parent_function_nested_scope() {
            let engine = setup_parent_function_graph();
            let evaluator = Evaluator::new(&engine);

            let query = Atom::new("parent_function", vec![
                Term::constant("31"),
                Term::var("F"),
            ]);

            let results = evaluator.query_atom(&query).unwrap();
            assert_eq!(results.len(), 1, "should find exactly one parent function");
            assert_eq!(results[0].get("F"), Some(&Value::Id(10)),
                "parent function of nested CALL(31) should still be FUNCTION(10)");
        }

        // Test 3: CALL(60) at module level → returns empty
        // BFS path: CALL(60) <-[CONTAINS]- MODULE(1) → MODULE is STOP_TYPE → empty
        #[test]
        fn test_parent_function_module_level_returns_empty() {
            let engine = setup_parent_function_graph();
            let evaluator = Evaluator::new(&engine);

            let query = Atom::new("parent_function", vec![
                Term::constant("60"),
                Term::var("F"),
            ]);

            let results = evaluator.query_atom(&query).unwrap();
            assert_eq!(results.len(), 0,
                "module-level CALL(60) should have no parent function");
        }

        // Test 4: VARIABLE(40) inside SCOPE(20) connected via DECLARES → returns FUNCTION(10)
        // BFS path: VARIABLE(40) <-[DECLARES]- SCOPE(20) <-[HAS_SCOPE]- FUNCTION(10) → match
        // Verifies Gap 1 fix (DECLARES in traversal set)
        #[test]
        fn test_parent_function_variable_node() {
            let engine = setup_parent_function_graph();
            let evaluator = Evaluator::new(&engine);

            let query = Atom::new("parent_function", vec![
                Term::constant("40"),
                Term::var("F"),
            ]);

            let results = evaluator.query_atom(&query).unwrap();
            assert_eq!(results.len(), 1, "should find exactly one parent function for VARIABLE");
            assert_eq!(results[0].get("F"), Some(&Value::Id(10)),
                "parent function of VARIABLE(40) should be FUNCTION(10) via DECLARES edge");
        }

        // Test 5: PARAMETER(50) connected via FUNCTION(10) -[HAS_PARAMETER]-> PARAMETER(50)
        // Pre-check: input node type = PARAMETER → look up incoming HAS_PARAMETER
        // get_incoming_edges(50, ["HAS_PARAMETER"]) → edge.src = FUNCTION(10) → match
        // Verifies Gap 2 fix (PARAMETER special case)
        #[test]
        fn test_parent_function_parameter_node() {
            let engine = setup_parent_function_graph();
            let evaluator = Evaluator::new(&engine);

            let query = Atom::new("parent_function", vec![
                Term::constant("50"),
                Term::var("F"),
            ]);

            let results = evaluator.query_atom(&query).unwrap();
            assert_eq!(results.len(), 1, "should find exactly one parent function for PARAMETER");
            assert_eq!(results[0].get("F"), Some(&Value::Id(10)),
                "parent function of PARAMETER(50) should be FUNCTION(10) via HAS_PARAMETER edge");
        }

        // Test 6: CALL(32) inside class method (stored as FUNCTION, not METHOD) → FUNCTION(11)
        // BFS path: CALL(32) <-[CONTAINS]- SCOPE(22) <-[HAS_SCOPE]- FUNCTION(11) → match
        // Verifies Gap 4: class methods are stored as FUNCTION type
        #[test]
        fn test_parent_function_class_method_call() {
            let engine = setup_parent_function_graph();
            let evaluator = Evaluator::new(&engine);

            let query = Atom::new("parent_function", vec![
                Term::constant("32"),
                Term::var("F"),
            ]);

            let results = evaluator.query_atom(&query).unwrap();
            assert_eq!(results.len(), 1, "should find exactly one parent function for class method call");
            assert_eq!(results[0].get("F"), Some(&Value::Id(11)),
                "parent function of CALL(32) should be class method FUNCTION(11)");
        }

        // Test 7: parent_function(30, "10") with constant FunctionId that matches → one empty Bindings
        #[test]
        fn test_parent_function_constant_fn_id_match() {
            let engine = setup_parent_function_graph();
            let evaluator = Evaluator::new(&engine);

            let query = Atom::new("parent_function", vec![
                Term::constant("30"),
                Term::constant("10"),
            ]);

            let results = evaluator.query_atom(&query).unwrap();
            assert_eq!(results.len(), 1,
                "parent_function(30, \"10\") should match (FUNCTION 10 is the parent)");
            assert!(results[0].is_empty(),
                "constant-constant match should return empty bindings (no variables to bind)");
        }

        // Test 8: parent_function(30, "999") with constant FunctionId that does NOT match → empty
        #[test]
        fn test_parent_function_constant_fn_id_no_match() {
            let engine = setup_parent_function_graph();
            let evaluator = Evaluator::new(&engine);

            let query = Atom::new("parent_function", vec![
                Term::constant("30"),
                Term::constant("999"),
            ]);

            let results = evaluator.query_atom(&query).unwrap();
            assert_eq!(results.len(), 0,
                "parent_function(30, \"999\") should return empty (999 is not the parent)");
        }

        // Test 9: parent_function(30, _) with wildcard FunctionId → one empty Bindings
        #[test]
        fn test_parent_function_wildcard() {
            let engine = setup_parent_function_graph();
            let evaluator = Evaluator::new(&engine);

            let query = Atom::new("parent_function", vec![
                Term::constant("30"),
                Term::wildcard(),
            ]);

            let results = evaluator.query_atom(&query).unwrap();
            assert_eq!(results.len(), 1,
                "parent_function(30, _) should succeed with one empty Bindings");
            assert!(results[0].is_empty(),
                "wildcard match should return empty bindings");
        }

        // Test 10: parent_function("99999", F) with nonexistent NodeId → empty
        #[test]
        fn test_parent_function_nonexistent_node() {
            let engine = setup_parent_function_graph();
            let evaluator = Evaluator::new(&engine);

            let query = Atom::new("parent_function", vec![
                Term::constant("99999"),
                Term::var("F"),
            ]);

            let results = evaluator.query_atom(&query).unwrap();
            assert_eq!(results.len(), 0,
                "nonexistent node 99999 should return empty results");
        }

        // Test 11: Full Datalog rule using parent_function
        // Rule: answer(Name) :- node(C, "CALL"), parent_function(C, F), attr(F, "name", Name).
        // Expected: should return function names for all CALL nodes that have a parent function
        // CALL(30) → FUNCTION(10, "myFunc"), CALL(31) → FUNCTION(10, "myFunc"),
        // CALL(32) → FUNCTION(11, "myMethod"), CALL(60) → no parent (module-level)
        #[test]
        fn test_parent_function_in_datalog_rule() {
            let engine = setup_parent_function_graph();
            let mut evaluator = Evaluator::new(&engine);

            let rule = parse_rule(
                "answer(Name) :- node(C, \"CALL\"), parent_function(C, F), attr(F, \"name\", Name)."
            ).unwrap();
            evaluator.add_rule(rule);

            let query = parse_atom("answer(Name)").unwrap();
            let results = evaluator.query(&query).unwrap();

            // CALL(30) → myFunc, CALL(31) → myFunc, CALL(32) → myMethod
            // CALL(60) is module-level → no result
            assert_eq!(results.len(), 3,
                "should find 3 CALL nodes with parent functions, got {}", results.len());

            let mut names: Vec<String> = results.iter()
                .filter_map(|b| b.get("Name").map(|v| v.as_str()))
                .collect();
            names.sort();

            assert_eq!(names, vec!["myFunc", "myFunc", "myMethod"],
                "expected [myFunc, myFunc, myMethod], got {:?}", names);
        }

        // Test 12: Same as test 1 but using EvaluatorExplain to verify eval_explain.rs mirror
        // Verifies Gap 3: eval_explain.rs has the parent_function dispatch
        #[test]
        fn test_parent_function_explain_evaluator() {
            use crate::datalog::eval_explain::EvaluatorExplain;

            let engine = setup_parent_function_graph();
            // EvaluatorExplain methods use &mut self (not &self)
            let mut evaluator = EvaluatorExplain::new(&engine, true);

            // Use eval_query with a conjunction that includes parent_function
            let literals = parse_query("parent_function(\"30\", F)").unwrap();
            let result = evaluator.eval_query(&literals).unwrap();

            assert_eq!(result.bindings.len(), 1,
                "EvaluatorExplain should find exactly one parent function for CALL(30)");
            assert_eq!(result.bindings[0].get("F"), Some(&"10".to_string()),
                "EvaluatorExplain: parent function of CALL(30) should be FUNCTION(10)");

            // Verify explain steps were recorded (confirms the predicate ran through
            // eval_atom dispatch, not silently fell through to eval_derived)
            assert!(!result.explain_steps.is_empty(),
                "explain steps should be non-empty, confirming parent_function dispatch works");
        }
    }

    /// Verify that derived predicate evaluation pushes down bound query args.
    ///
    /// Rule: `has_edge(X) :- edge(X, _, T), neq(T, "CONTAINS").`
    /// When calling `has_edge("1")`, the P0 optimization binds X="1" BEFORE
    /// evaluating the body. This turns `edge(X, _, T)` into `edge("1", _, T)`
    /// which uses `get_outgoing_edges` (O(1) bloom) instead of
    /// `get_all_edges` (full scan).
    ///
    /// We verify via EvaluatorExplain stats: `outgoing_edge_calls > 0` and
    /// `all_edges_calls == 0`.
    #[test]
    fn test_derived_predicate_pushdown_uses_outgoing_not_all_edges() {
        use crate::datalog::eval_explain::EvaluatorExplain;

        let engine = setup_test_graph();

        // has_edge(X) :- edge(X, _, T), neq(T, "CONTAINS").
        let rule = parse_rule(
            r#"has_edge(X) :- edge(X, _, T), neq(T, "CONTAINS")."#,
        ).unwrap();

        let mut evaluator = EvaluatorExplain::new(&engine, false);
        evaluator.add_rule(rule);

        // Query with bound X: has_edge("1")
        let atom = parse_atom(r#"has_edge("1")"#).unwrap();
        let result = evaluator.query(&atom);

        // Node 1 has edges: 1->4 CALLS, 1->5 CONTAINS
        // After neq(T, "CONTAINS") filter, only CALLS edge remains
        assert!(
            result.bindings.len() >= 1,
            "expected at least 1 result for has_edge(\"1\"), got {}",
            result.bindings.len()
        );

        // Critical assertion: binding push-down means we used get_outgoing_edges,
        // NOT get_all_edges (the expensive full scan)
        assert!(
            result.stats.outgoing_edge_calls > 0,
            "expected outgoing_edge_calls > 0 (push-down should bind src before edge lookup)"
        );
        assert_eq!(
            result.stats.all_edges_calls, 0,
            "expected all_edges_calls == 0 (push-down should prevent full edge scan)"
        );
    }
}

// ============================================================================
// Phase 7: Reverse attr lookup tests
// ============================================================================

mod attr_reverse_lookup_tests {
    use super::*;
    use crate::graph::{GraphEngineV2, GraphStore};
    use crate::storage::{NodeRecord, EdgeRecord};
    use crate::datalog::eval::Evaluator;


    fn setup_reverse_lookup_graph() -> GraphEngineV2 {
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            NodeRecord {
                id: 1,
                node_type: Some("queue:publish".to_string()),
                name: Some("orders-pub".to_string()),
                file: Some("api.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: Some(r#"{"channel":"orders"}"#.to_string()),
                semantic_id: None,
            },
            NodeRecord {
                id: 2,
                node_type: Some("queue:consume".to_string()),
                name: Some("orders-con".to_string()),
                file: Some("worker.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: Some(r#"{"channel":"orders"}"#.to_string()),
                semantic_id: None,
            },
            NodeRecord {
                id: 3,
                node_type: Some("queue:publish".to_string()),
                name: Some("orphan-pub".to_string()),
                file: Some("orphan.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            },
            NodeRecord {
                id: 4,
                node_type: Some("FUNCTION".to_string()),
                name: Some("processOrder".to_string()),
                file: Some("worker.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            },
        ]);

        engine.add_edges(vec![
            EdgeRecord {
                src: 1,
                dst: 4,
                edge_type: Some("CALLS".to_string()),
                version: "main".into(),
                metadata: None,
                deleted: false,
            },
            EdgeRecord {
                src: 4,
                dst: 2,
                edge_type: Some("CALLS".to_string()),
                version: "main".into(),
                metadata: None,
                deleted: false,
            },
        ], false);

        engine
    }

    // attr(X, "name", "orders-pub") with unbound X returns node 1
    #[test]
    fn test_eval_attr_reverse_lookup_name() {
        let engine = setup_reverse_lookup_graph();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("attr", vec![
            Term::var("X"),
            Term::constant("name"),
            Term::constant("orders-pub"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Id(1)));
    }

    // attr(X, "file", "worker.js") returns nodes 2, 4
    #[test]
    fn test_eval_attr_reverse_lookup_file() {
        let engine = setup_reverse_lookup_graph();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("attr", vec![
            Term::var("X"),
            Term::constant("file"),
            Term::constant("worker.js"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        let mut ids: Vec<u128> = results.iter()
            .filter_map(|b| b.get("X").and_then(|v| v.as_id()))
            .collect();
        ids.sort();
        assert_eq!(ids, vec![2, 4]);
    }

    // attr(X, "type", "queue:publish") returns nodes 1, 3
    #[test]
    fn test_eval_attr_reverse_lookup_type() {
        let engine = setup_reverse_lookup_graph();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("attr", vec![
            Term::var("X"),
            Term::constant("type"),
            Term::constant("queue:publish"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        let mut ids: Vec<u128> = results.iter()
            .filter_map(|b| b.get("X").and_then(|v| v.as_id()))
            .collect();
        ids.sort();
        assert_eq!(ids, vec![1, 3]);
    }

    // attr(X, "channel", "orders") with metadata filter
    #[test]
    fn test_eval_attr_reverse_lookup_metadata() {
        let engine = setup_reverse_lookup_graph();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("attr", vec![
            Term::var("X"),
            Term::constant("channel"),
            Term::constant("orders"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        let mut ids: Vec<u128> = results.iter()
            .filter_map(|b| b.get("X").and_then(|v| v.as_id()))
            .collect();
        ids.sort();
        assert_eq!(ids, vec![1, 2]);
    }

    // Returns empty when no node matches
    #[test]
    fn test_eval_attr_reverse_lookup_no_match() {
        let engine = setup_reverse_lookup_graph();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("attr", vec![
            Term::var("X"),
            Term::constant("name"),
            Term::constant("nonexistent"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        assert!(results.is_empty());
    }

    // Reorder places attr(X, "name", "foo") before incoming(X, Y, "CALLS")
    // Before the fix, both would fail to place (circular dep). After the fix,
    // attr reverse provides X, enabling incoming to be placed.
    #[test]
    fn test_reorder_incoming_always_placeable_like_edge() {
        use crate::datalog::utils::reorder_literals;

        // `incoming` is the reverse of `edge` and, like `edge`, is always
        // placeable (full scan if dst is unbound) — it self-seeds and provides
        // its free vars. So the reorderer does NOT need to hoist a seed provider
        // ahead of it: the greedy sort keeps the author's order, placing
        // `incoming` first. (Previously `incoming` was wrongly treated as
        // requiring a bound dst, which forced `attr` ahead of it and rejected
        // standalone `incoming(D, S)` enumerations as circular dependencies.)
        let literals = vec![
            Literal::positive(Atom::new("incoming", vec![
                Term::var("X"),
                Term::var("Y"),
                Term::constant("CALLS"),
            ])),
            Literal::positive(Atom::new("attr", vec![
                Term::var("X"),
                Term::constant("name"),
                Term::constant("processOrder"),
            ])),
        ];

        let ordered = reorder_literals(&literals).unwrap();
        assert_eq!(ordered[0].atom().predicate(), "incoming",
            "incoming is always placeable (self-seeds) and stays first");
        assert_eq!(ordered[1].atom().predicate(), "attr");

        // End-to-end: the conjunction is valid and order-independent — it binds
        // X=dst (processOrder=node 4) and Y=src (node 1) for the CALLS edge 1->4.
        let engine = setup_reverse_lookup_graph();
        let evaluator = Evaluator::new(&engine);
        let results = evaluator
            .eval_query(&parse_query(
                r#"incoming(X, Y, "CALLS"), attr(X, "name", "processOrder")"#,
            ).unwrap())
            .unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Id(4)));
        assert_eq!(results[0].get("Y"), Some(&Value::Id(1)));
    }

    // End-to-end: attr(X, "name", "orders-pub"), edge(X, Y, "CALLS") works
    #[test]
    fn test_eval_query_attr_reverse_in_conjunction() {
        let engine = setup_reverse_lookup_graph();
        let evaluator = Evaluator::new(&engine);

        let literals = parse_query(
            r#"attr(X, "name", "orders-pub"), edge(X, Y, "CALLS")"#
        ).unwrap();

        let results = evaluator.eval_query(&literals).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Id(1)));
        assert_eq!(results[0].get("Y"), Some(&Value::Id(4)));
    }

    // End-to-end with EvaluatorExplain to verify the mirror
    #[test]
    fn test_eval_attr_reverse_lookup_explain() {
        use crate::datalog::eval_explain::EvaluatorExplain;

        let engine = setup_reverse_lookup_graph();
        let mut evaluator = EvaluatorExplain::new(&engine, true);

        let literals = parse_query(
            r#"attr(X, "name", "orders-pub"), edge(X, Y, "CALLS")"#
        ).unwrap();

        let result = evaluator.eval_query(&literals).unwrap();
        assert_eq!(result.bindings.len(), 1);
        assert_eq!(result.bindings[0].get("X"), Some(&"1".to_string()));
        assert_eq!(result.bindings[0].get("Y"), Some(&"4".to_string()));
        assert!(!result.explain_steps.is_empty());
    }
}

// ============================================================================
// RFD-48: attr() predicate — first-class fields (exported, version, semantic_id, id)
// ============================================================================

mod attr_first_class_field_tests {
    use super::*;
    use crate::graph::{GraphEngineV2, GraphStore};
    use crate::storage::NodeRecord;
    use crate::datalog::eval::Evaluator;
    use crate::datalog::eval_explain::EvaluatorExplain;

    fn setup_attr_field_graph() -> GraphEngineV2 {
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            NodeRecord {
                id: 10,
                node_type: Some("FUNCTION".to_string()),
                name: Some("exportedFn".to_string()),
                file: Some("lib.js".to_string()),
                file_id: 0, name_offset: 0,
                version: "main".into(),
                exported: true, replaces: None, deleted: false,
                metadata: Some(r#"{"source":"./utils"}"#.to_string()),
                semantic_id: Some("lib.js->FUNCTION->exportedFn".to_string()),
            },
            NodeRecord {
                id: 20,
                node_type: Some("IMPORT".to_string()),
                name: Some("React".to_string()),
                file: Some("app.js".to_string()),
                file_id: 0, name_offset: 0,
                version: "main".into(),
                exported: false, replaces: None, deleted: false,
                metadata: Some(r#"{"source":"react"}"#.to_string()),
                semantic_id: Some("app.js->IMPORT->React".to_string()),
            },
        ]);

        engine
    }

    // Forward lookup: attr(id, "exported", X) returns "true"/"false"
    #[test]
    fn test_eval_attr_exported_forward() {
        let engine = setup_attr_field_graph();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("attr", vec![
            Term::constant("10"),
            Term::constant("exported"),
            Term::var("X"),
        ]);
        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Str("true".to_string())));

        // Non-exported node
        let query2 = Atom::new("attr", vec![
            Term::constant("20"),
            Term::constant("exported"),
            Term::var("X"),
        ]);
        let results2 = evaluator.query_atom(&query2).unwrap();
        assert_eq!(results2.len(), 1);
        assert_eq!(results2[0].get("X"), Some(&Value::Str("false".to_string())));
    }

    // Forward lookup: attr(id, "version", X)
    #[test]
    fn test_eval_attr_version_forward() {
        let engine = setup_attr_field_graph();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("attr", vec![
            Term::constant("10"),
            Term::constant("version"),
            Term::var("X"),
        ]);
        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Str("main".to_string())));
    }

    // Forward lookup: attr(id, "semantic_id", X)
    #[test]
    fn test_eval_attr_semantic_id_forward() {
        let engine = setup_attr_field_graph();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("attr", vec![
            Term::constant("10"),
            Term::constant("semantic_id"),
            Term::var("X"),
        ]);
        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Str("lib.js->FUNCTION->exportedFn".to_string())));
    }

    // Forward lookup: attr(id, "id", X)
    #[test]
    fn test_eval_attr_id_forward() {
        let engine = setup_attr_field_graph();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("attr", vec![
            Term::constant("10"),
            Term::constant("id"),
            Term::var("X"),
        ]);
        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Str("10".to_string())));
    }

    // Forward lookup: attr(X, "source", S) for IMPORT node with source in metadata
    #[test]
    fn test_eval_attr_source_from_metadata() {
        let engine = setup_attr_field_graph();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("attr", vec![
            Term::constant("20"),
            Term::constant("source"),
            Term::var("S"),
        ]);
        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("S"), Some(&Value::Str("react".to_string())));
    }

    // Full rule: violation(S) :- node(X, "IMPORT"), attr(X, "source", S).
    #[test]
    fn test_eval_rule_import_source() {
        let engine = setup_attr_field_graph();
        let evaluator = Evaluator::new(&engine);

        let literals = parse_query(
            r#"node(X, "IMPORT"), attr(X, "source", S)"#
        ).unwrap();

        let results = evaluator.eval_query(&literals).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("S"), Some(&Value::Str("react".to_string())));
    }

    // Reverse lookup: attr(X, "exported", "true") finds exported nodes
    #[test]
    fn test_eval_attr_reverse_exported() {
        let engine = setup_attr_field_graph();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("attr", vec![
            Term::var("X"),
            Term::constant("exported"),
            Term::constant("true"),
        ]);
        let results = evaluator.query_atom(&query).unwrap();
        let ids: Vec<u128> = results.iter()
            .filter_map(|b| b.get("X").and_then(|v| v.as_id()))
            .collect();
        assert!(ids.contains(&10), "Expected exported node 10 in results: {:?}", ids);
        assert!(!ids.contains(&20), "Node 20 is not exported, should not be in results");
    }

    // EvaluatorExplain mirror — verify same behavior
    #[test]
    fn test_eval_attr_exported_explain() {
        let engine = setup_attr_field_graph();
        let mut evaluator = EvaluatorExplain::new(&engine, false);

        let literals = parse_query(
            r#"node(X, "FUNCTION"), attr(X, "exported", "true")"#
        ).unwrap();

        let result = evaluator.eval_query(&literals).unwrap();
        assert_eq!(result.bindings.len(), 1);
        assert_eq!(result.bindings[0].get("X"), Some(&"10".to_string()));
    }

    // ------------------------------------------------------------------
    // Reverse lookup for first-class fields version / semantic_id / id.
    //
    // RFD-48 added FORWARD `attr(id, F, V)` support for these (tested
    // above), but the REVERSE path `attr(X, F, V)` routed every non-
    // name/file/type/exported field through `metadata_filters`, which
    // only matches the node's metadata JSON. semantic_id / id / version
    // are first-class columns (NOT in metadata JSON), so reverse lookup
    // silently returned nothing — asymmetric with forward, a silent
    // wrong answer for the most fundamental "find the node with this
    // semantic_id" query. These tests pin the restored symmetry.
    // ------------------------------------------------------------------

    // Reverse lookup: attr(X, "semantic_id", "...") finds the node by its
    // canonical identifier. Must mirror the forward test above.
    #[test]
    fn test_eval_attr_reverse_semantic_id() {
        let engine = setup_attr_field_graph();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("attr", vec![
            Term::var("X"),
            Term::constant("semantic_id"),
            Term::constant("lib.js->FUNCTION->exportedFn"),
        ]);
        let results = evaluator.query_atom(&query).unwrap();
        let ids: Vec<u128> = results.iter()
            .filter_map(|b| b.get("X").and_then(|v| v.as_id()))
            .collect();
        assert_eq!(ids, vec![10], "reverse semantic_id must return node 10");
    }

    // Reverse lookup with a semantic_id that no node has → empty.
    #[test]
    fn test_eval_attr_reverse_semantic_id_no_match() {
        let engine = setup_attr_field_graph();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("attr", vec![
            Term::var("X"),
            Term::constant("semantic_id"),
            Term::constant("does.js->NONE->missing"),
        ]);
        let results = evaluator.query_atom(&query).unwrap();
        assert!(results.is_empty(), "unknown semantic_id must yield no rows");
    }

    // Forward/reverse symmetry: the value forward returns for node 10's
    // semantic_id, fed back into the reverse lookup, must return node 10.
    #[test]
    fn test_eval_attr_semantic_id_forward_reverse_symmetry() {
        let engine = setup_attr_field_graph();
        let evaluator = Evaluator::new(&engine);

        // Forward: get node 10's semantic_id value.
        let fwd = evaluator.query_atom(&Atom::new("attr", vec![
            Term::constant("10"),
            Term::constant("semantic_id"),
            Term::var("V"),
        ])).unwrap();
        let value = match fwd[0].get("V").unwrap() {
            Value::Str(s) => s.clone(),
            other => panic!("expected Str, got {:?}", other),
        };

        // Reverse: that value must resolve back to exactly node 10.
        let rev = evaluator.query_atom(&Atom::new("attr", vec![
            Term::var("X"),
            Term::constant("semantic_id"),
            Term::constant(&value),
        ])).unwrap();
        let ids: Vec<u128> = rev.iter()
            .filter_map(|b| b.get("X").and_then(|v| v.as_id()))
            .collect();
        assert_eq!(ids, vec![10], "forward semantic_id value must reverse to node 10");
    }

    // Reverse lookup: attr(X, "id", "20") binds X to that node (O(1) by id).
    #[test]
    fn test_eval_attr_reverse_id() {
        let engine = setup_attr_field_graph();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("attr", vec![
            Term::var("X"),
            Term::constant("id"),
            Term::constant("20"),
        ]);
        let results = evaluator.query_atom(&query).unwrap();
        let ids: Vec<u128> = results.iter()
            .filter_map(|b| b.get("X").and_then(|v| v.as_id()))
            .collect();
        assert_eq!(ids, vec![20], "reverse id must return exactly node 20");
    }

    // Reverse lookup: attr(X, "id", "<nonexistent>") → empty (node absent).
    #[test]
    fn test_eval_attr_reverse_id_no_match() {
        let engine = setup_attr_field_graph();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("attr", vec![
            Term::var("X"),
            Term::constant("id"),
            Term::constant("99999"),
        ]);
        let results = evaluator.query_atom(&query).unwrap();
        assert!(results.is_empty(), "unknown id must yield no rows");
    }

    // Reverse lookup: attr(X, "version", "main") returns every node at
    // that version (both fixture nodes are version "main").
    #[test]
    fn test_eval_attr_reverse_version() {
        let engine = setup_attr_field_graph();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("attr", vec![
            Term::var("X"),
            Term::constant("version"),
            Term::constant("main"),
        ]);
        let results = evaluator.query_atom(&query).unwrap();
        let mut ids: Vec<u128> = results.iter()
            .filter_map(|b| b.get("X").and_then(|v| v.as_id()))
            .collect();
        ids.sort();
        assert_eq!(ids, vec![10, 20], "reverse version must return both nodes");
    }

    // The pipelined GENERATOR path (eval_generator_chunked) is a SEPARATE copy
    // of the reverse-attr lookup. A conjunction whose only valid seed is a
    // reverse semantic_id lookup routes through it. `neq` is a filter (needs X
    // already bound), so the reorderer must place the reverse `attr` first as
    // the generator — exercising the generator-path copy, not eval_attr.
    #[test]
    fn test_eval_attr_reverse_semantic_id_as_generator() {
        let engine = setup_attr_field_graph();
        let evaluator = Evaluator::new(&engine);

        let literals = parse_query(
            r#"attr(X, "semantic_id", "lib.js->FUNCTION->exportedFn"), neq(X, "0")"#
        ).unwrap();

        let results = evaluator.eval_query(&literals).unwrap();
        let ids: Vec<u128> = results.iter()
            .filter_map(|b| b.get("X").and_then(|v| v.as_id()))
            .collect();
        assert_eq!(ids, vec![10], "reverse semantic_id must seed the pipelined generator path");
    }

    // EvaluatorExplain mirror for reverse semantic_id — both evaluators
    // must agree (the explain twin shares the same attr logic).
    #[test]
    fn test_eval_attr_reverse_semantic_id_explain() {
        let engine = setup_attr_field_graph();
        let mut evaluator = EvaluatorExplain::new(&engine, false);

        let literals = parse_query(
            r#"attr(X, "semantic_id", "app.js->IMPORT->React")"#
        ).unwrap();

        let result = evaluator.eval_query(&literals).unwrap();
        assert_eq!(result.bindings.len(), 1);
        assert_eq!(result.bindings[0].get("X"), Some(&"20".to_string()));
    }
}

// ============================================================================
// Phase 8: Edge-type index tests (RFD-44)
// ============================================================================

mod edge_type_index_tests {
    use super::*;
    use crate::graph::{GraphEngineV2, GraphStore};
    use crate::storage::{NodeRecord, EdgeRecord};
    use crate::datalog::eval::Evaluator;
    use crate::datalog::eval_explain::EvaluatorExplain;

    fn setup_edge_type_graph() -> GraphEngineV2 {
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            NodeRecord {
                id: 1,
                node_type: Some("FUNCTION".to_string()),
                name: Some("caller".to_string()),
                file: Some("a.js".to_string()),
                file_id: 0, name_offset: 0,
                version: "main".into(),
                exported: false, replaces: None, deleted: false,
                metadata: None, semantic_id: None,
            },
            NodeRecord {
                id: 2,
                node_type: Some("FUNCTION".to_string()),
                name: Some("callee".to_string()),
                file: Some("b.js".to_string()),
                file_id: 0, name_offset: 0,
                version: "main".into(),
                exported: false, replaces: None, deleted: false,
                metadata: None, semantic_id: None,
            },
            NodeRecord {
                id: 3,
                node_type: Some("MODULE".to_string()),
                name: Some("mod_a".to_string()),
                file: Some("a.js".to_string()),
                file_id: 0, name_offset: 0,
                version: "main".into(),
                exported: false, replaces: None, deleted: false,
                metadata: None, semantic_id: None,
            },
        ]);

        engine.add_edges(vec![
            EdgeRecord {
                src: 1, dst: 2,
                edge_type: Some("CALLS".to_string()),
                version: "main".into(), metadata: None, deleted: false,
            },
            EdgeRecord {
                src: 3, dst: 1,
                edge_type: Some("CONTAINS".to_string()),
                version: "main".into(), metadata: None, deleted: false,
            },
        ], false);

        engine
    }

    #[test]
    fn test_edge_unbound_src_const_type_uses_edges_by_type() {
        let engine = setup_edge_type_graph();
        let mut evaluator = EvaluatorExplain::new(&engine, false);

        // edge(X, Y, "CALLS") — src unbound, type constant → should use index
        let literals = parse_query(r#"edge(X, Y, "CALLS")"#).unwrap();
        let result = evaluator.eval_query(&literals).unwrap();

        assert_eq!(result.bindings.len(), 1);
        assert_eq!(result.bindings[0].get("X"), Some(&"1".to_string()));
        assert_eq!(result.bindings[0].get("Y"), Some(&"2".to_string()));

        assert!(
            result.stats.edges_by_type_calls > 0,
            "expected edges_by_type_calls > 0, got {}",
            result.stats.edges_by_type_calls
        );
        assert_eq!(
            result.stats.all_edges_calls, 0,
            "expected all_edges_calls == 0 (index should avoid full scan)"
        );
    }

    #[test]
    fn test_incoming_unbound_dst_const_type() {
        let engine = setup_edge_type_graph();
        let evaluator = Evaluator::new(&engine);

        // incoming(X, Y, "CALLS") — dst unbound, type constant → should return results
        let query = Atom::new("incoming", vec![
            Term::var("X"),
            Term::var("Y"),
            Term::constant("CALLS"),
        ]);

        let results = evaluator.query_atom(&query).unwrap();
        // Edge 1->2 CALLS: incoming to node 2, from node 1
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Id(2))); // dst
        assert_eq!(results[0].get("Y"), Some(&Value::Id(1))); // src
    }

    #[test]
    fn test_incoming_unbound_dst_var_type_enumerates_all_edges() {
        let engine = setup_edge_type_graph(); // edges: 1->2 CALLS, 3->1 CONTAINS
        let evaluator = Evaluator::new(&engine);

        // incoming(X, Y, T) — dst, src and type all unbound. With no edge-type
        // constant the edge-type index (RFD-44) cannot apply, so this falls back
        // to a full scan and enumerates EVERY edge, binding X=dst, Y=src, T=type.
        // This is the reverse of edge(Y, X, T) and must agree with it; it used to
        // silently return empty (a false-negative for an untyped enumeration).
        let query = Atom::new("incoming", vec![
            Term::var("X"),
            Term::var("Y"),
            Term::var("T"),
        ]);

        let mut triples: Vec<(u128, u128, String)> = evaluator
            .query_atom(&query)
            .unwrap()
            .iter()
            .filter_map(|b| {
                Some((b.get("X")?.as_id()?, b.get("Y")?.as_id()?, b.get("T")?.as_str()))
            })
            .collect();
        triples.sort();
        // (dst, src, type): CALLS 1->2 => (2,1,CALLS); CONTAINS 3->1 => (1,3,CONTAINS)
        assert_eq!(
            triples,
            vec![
                (1, 3, "CONTAINS".to_string()),
                (2, 1, "CALLS".to_string()),
            ]
        );

        // Must mirror edge(Y, X, T) (the same edges, src/dst swapped in binding).
        let edge_query = Atom::new("edge", vec![
            Term::var("Y"),
            Term::var("X"),
            Term::var("T"),
        ]);
        let mut edge_triples: Vec<(u128, u128, String)> = evaluator
            .query_atom(&edge_query)
            .unwrap()
            .iter()
            .filter_map(|b| {
                Some((b.get("X")?.as_id()?, b.get("Y")?.as_id()?, b.get("T")?.as_str()))
            })
            .collect();
        edge_triples.sort();
        assert_eq!(triples, edge_triples, "incoming(X,Y,T) must mirror edge(Y,X,T)");
    }
}

// ============================================================================
// Hash Join Tests
// ============================================================================

mod hash_join_tests {
    use super::*;
    use crate::graph::{GraphEngineV2, GraphStore};
    use crate::storage::{NodeRecord, EdgeRecord};
    use crate::datalog::eval::HASH_JOIN_THRESHOLD;
    use std::collections::HashSet;

    /// Build a graph with many FUNCTION nodes and CALLS edges to trigger hash join.
    /// Creates `n` FUNCTION nodes (ids 1..=n) and CALL nodes (ids n+1..=2n),
    /// with each FUNCTION having a CALLS edge to one CALL node.
    fn setup_hash_join_graph(n: usize) -> GraphEngineV2 {
        let mut engine = GraphEngineV2::create_ephemeral();

        let mut nodes = Vec::with_capacity(2 * n);
        for i in 1..=n {
            nodes.push(NodeRecord {
                id: i as u128,
                node_type: Some("FUNCTION".to_string()),
                name: Some(format!("fn_{}", i)),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            });
            nodes.push(NodeRecord {
                id: (n + i) as u128,
                node_type: Some("CALL".to_string()),
                name: Some(format!("call_{}", i)),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            });
        }
        engine.add_nodes(nodes);

        let edges: Vec<EdgeRecord> = (1..=n).map(|i| EdgeRecord {
            src: i as u128,
            dst: (n + i) as u128,
            edge_type: Some("CALLS".to_string()),
            version: "main".into(),
            metadata: None,
            deleted: false,
        }).collect();
        engine.add_edges(edges, false);

        engine
    }

    #[test]
    fn test_hash_join_same_results_as_nested_loop() {
        // Use enough nodes to trigger hash join (> HASH_JOIN_THRESHOLD)
        let n = HASH_JOIN_THRESHOLD + 10;
        let engine = setup_hash_join_graph(n);

        // Query: node(F, "FUNCTION"), edge(F, C, "CALLS")
        // This should trigger hash join for the edge literal
        let evaluator = Evaluator::new(&engine);
        let literals = parse_query(
            "node(F, \"FUNCTION\"), edge(F, C, \"CALLS\")"
        ).unwrap();
        let hash_join_results = evaluator.eval_query(&literals).unwrap();

        // Verify against manual nested-loop: for each function, get outgoing CALLS
        let mut nested_results: HashSet<(u128, u128)> = HashSet::new();
        let functions = engine.find_by_type("FUNCTION");
        for fn_id in &functions {
            let edges = engine.get_outgoing_edges(*fn_id, Some(&["CALLS"]));
            for e in edges {
                nested_results.insert((*fn_id, e.dst));
            }
        }

        let hash_results: HashSet<(u128, u128)> = hash_join_results.iter()
            .filter_map(|b| {
                let f = b.get("F")?.as_id()?;
                let c = b.get("C")?.as_id()?;
                Some((f, c))
            })
            .collect();

        assert_eq!(hash_results.len(), nested_results.len(),
            "hash join and nested-loop should produce same count");
        assert_eq!(hash_results, nested_results,
            "hash join and nested-loop should produce same results");
    }

    #[test]
    fn test_hash_join_not_activated_below_threshold() {
        // Use fewer nodes than threshold — hash join should NOT activate
        let n = HASH_JOIN_THRESHOLD - 1;
        let engine = setup_hash_join_graph(n);

        let evaluator = Evaluator::new(&engine);
        let literals = parse_query(
            "node(F, \"FUNCTION\"), edge(F, C, \"CALLS\")"
        ).unwrap();
        let results = evaluator.eval_query(&literals).unwrap();

        // Should still produce correct results via nested-loop
        assert_eq!(results.len(), n, "should find {} edges via nested-loop", n);
    }

    #[test]
    fn test_hash_join_not_activated_variable_edge_type() {
        let n = HASH_JOIN_THRESHOLD + 10;
        let engine = setup_hash_join_graph(n);

        let evaluator = Evaluator::new(&engine);
        // Variable edge type T — hash join should NOT activate
        let literals = parse_query(
            "node(F, \"FUNCTION\"), edge(F, C, T)"
        ).unwrap();
        let results = evaluator.eval_query(&literals).unwrap();

        // Should still produce results (nested-loop via get_all_edges)
        assert!(results.len() >= n, "should find at least {} edges", n);
    }

    #[test]
    fn test_hash_join_not_activated_constant_src() {
        let n = HASH_JOIN_THRESHOLD + 10;
        let engine = setup_hash_join_graph(n);

        let evaluator = Evaluator::new(&engine);
        // Constant src — already optimal, hash join should NOT activate
        let literals = parse_query(
            "edge(\"1\", C, \"CALLS\")"
        ).unwrap();
        let results = evaluator.eval_query(&literals).unwrap();

        // Node 1 has exactly 1 CALLS edge
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_incoming_hash_join_correctness() {
        let n = HASH_JOIN_THRESHOLD + 10;
        let engine = setup_hash_join_graph(n);

        // Query: node(C, "CALL"), incoming(C, F, "CALLS")
        let evaluator = Evaluator::new(&engine);
        let literals = parse_query(
            "node(C, \"CALL\"), incoming(C, F, \"CALLS\")"
        ).unwrap();
        let hash_join_results = evaluator.eval_query(&literals).unwrap();

        // Each CALL node should have exactly one incoming CALLS edge from its FUNCTION
        assert_eq!(hash_join_results.len(), n,
            "each CALL should have one incoming CALLS edge");

        // Verify specific mapping
        for b in &hash_join_results {
            let c = b.get("C").unwrap().as_id().unwrap();
            let f = b.get("F").unwrap().as_id().unwrap();
            // In our graph: function i → call n+i, so call_id - n = function_id
            assert_eq!(c - n as u128, f, "CALL {} should come from FUNCTION {}", c, f);
        }
    }

    /// Mirror of `test_hash_join_shared_var_across_two_edges` but for the
    /// `incoming/3` flavour of the same bug: the non-key term must honor
    /// already-bound variables instead of rebinding them.
    #[test]
    fn test_incoming_hash_join_shared_var() {
        let mut engine = GraphEngineV2::create_ephemeral();
        let n = HASH_JOIN_THRESHOLD + 10;

        let mut nodes = Vec::with_capacity(3 * n);
        for i in 1..=n {
            nodes.push(NodeRecord {
                id: i as u128,
                node_type: Some("A".to_string()),
                name: Some(format!("a_{}", i)),
                file: Some("t.ex".to_string()),
                file_id: 0, name_offset: 0, version: "main".into(),
                exported: false, replaces: None, deleted: false,
                metadata: None, semantic_id: None,
            });
            nodes.push(NodeRecord {
                id: (n + i) as u128,
                node_type: Some("B".to_string()),
                name: Some(format!("b_{}", i)),
                file: Some("t.ex".to_string()),
                file_id: 0, name_offset: 0, version: "main".into(),
                exported: false, replaces: None, deleted: false,
                metadata: None, semantic_id: None,
            });
            nodes.push(NodeRecord {
                id: (2 * n + i) as u128,
                node_type: Some("A".to_string()),
                name: Some(format!("other_a_{}", i)),
                file: Some("t.ex".to_string()),
                file_id: 0, name_offset: 0, version: "main".into(),
                exported: false, replaces: None, deleted: false,
                metadata: None, semantic_id: None,
            });
        }
        engine.add_nodes(nodes);

        // F: a_i -> b_i
        let fw: Vec<EdgeRecord> = (1..=n).map(|i| EdgeRecord {
            src: i as u128,
            dst: (n + i) as u128,
            edge_type: Some("F".to_string()),
            version: "main".into(), metadata: None, deleted: false,
        }).collect();
        engine.add_edges(fw, false);
        // G: b_i -> other_a_i, plus one true round-trip b_1 -> a_1
        let mut bk: Vec<EdgeRecord> = (1..=n).map(|i| EdgeRecord {
            src: (n + i) as u128,
            dst: (2 * n + i) as u128,
            edge_type: Some("G".to_string()),
            version: "main".into(), metadata: None, deleted: false,
        }).collect();
        bk.push(EdgeRecord {
            src: (n + 1) as u128,
            dst: 1u128,
            edge_type: Some("G".to_string()),
            version: "main".into(), metadata: None, deleted: false,
        });
        engine.add_edges(bk, false);

        let evaluator = Evaluator::new(&engine);
        // Anchor A via node/1 so the planner can place `incoming` with at
        // least one bound var; then `incoming(A, B, "G")` binds B while
        // `incoming(B, A, "F")` re-binds through the hash-join path — the
        // exact case the shared-var fix must honour.
        let literals = parse_query(
            "node(A, \"A\"), incoming(A, B, \"G\"), incoming(B, A, \"F\")"
        ).unwrap();
        let results = evaluator.eval_query(&literals).unwrap();
        assert_eq!(results.len(), 1, "only one true round-trip exists");
        let b = &results[0];
        assert_eq!(b.get("A").unwrap().as_id().unwrap(), 1);
        assert_eq!(b.get("B").unwrap().as_id().unwrap(), (n + 1) as u128);
    }

    /// REG-503 explain↔plain parity for the shared-variable hash-join fix.
    ///
    /// The plain `Evaluator` honours an already-bound variable on the non-key
    /// end of a self-join `edge(M, C, T1), edge(C, M, T2)` (see
    /// `test_hash_join_shared_var_across_two_edges`). The explain evaluator
    /// (`EvaluatorExplain`) drives the SAME `eval_edge_hash_join` shape and
    /// MUST produce identical bindings under `--explain`. Without the bound-var
    /// guard ported into the explain path, the second edge atom rebinds `M` to
    /// every `SENDS_MESSAGE` dst, yielding ~n spurious rows — so `--explain`
    /// silently changes the answer, violating the parity invariant.
    #[test]
    fn test_explain_edge_hash_join_shared_var_matches_plain() {
        use crate::datalog::eval_explain::EvaluatorExplain;
        let mut engine = GraphEngineV2::create_ephemeral();
        let n = HASH_JOIN_THRESHOLD + 10;

        let mut nodes = Vec::with_capacity(3 * n);
        for i in 1..=n {
            nodes.push(NodeRecord {
                id: i as u128,
                node_type: Some("MESSAGE_TYPE".to_string()),
                name: Some(format!("msg_{}", i)),
                file: Some("t.ex".to_string()),
                file_id: 0, name_offset: 0, version: "main".into(),
                exported: false, replaces: None, deleted: false,
                metadata: None, semantic_id: None,
            });
            nodes.push(NodeRecord {
                id: (n + i) as u128,
                node_type: Some("CALL".to_string()),
                name: Some(format!("call_{}", i)),
                file: Some("t.ex".to_string()),
                file_id: 0, name_offset: 0, version: "main".into(),
                exported: false, replaces: None, deleted: false,
                metadata: None, semantic_id: None,
            });
            nodes.push(NodeRecord {
                id: (2 * n + i) as u128,
                node_type: Some("MESSAGE_TYPE".to_string()),
                name: Some(format!("other_msg_{}", i)),
                file: Some("t.ex".to_string()),
                file_id: 0, name_offset: 0, version: "main".into(),
                exported: false, replaces: None, deleted: false,
                metadata: None, semantic_id: None,
            });
        }
        engine.add_nodes(nodes);

        let contains: Vec<EdgeRecord> = (1..=n).map(|i| EdgeRecord {
            src: i as u128,
            dst: (n + i) as u128,
            edge_type: Some("CONTAINS".to_string()),
            version: "main".into(), metadata: None, deleted: false,
        }).collect();
        engine.add_edges(contains, false);

        let mut sends: Vec<EdgeRecord> = (1..=n).map(|i| EdgeRecord {
            src: (n + i) as u128,
            dst: (2 * n + i) as u128,
            edge_type: Some("SENDS_MESSAGE".to_string()),
            version: "main".into(), metadata: None, deleted: false,
        }).collect();
        sends.push(EdgeRecord {
            src: (n + 1) as u128,
            dst: 1_u128,
            edge_type: Some("SENDS_MESSAGE".to_string()),
            version: "main".into(), metadata: None, deleted: false,
        });
        engine.add_edges(sends, false);

        let query = "edge(M, C, \"CONTAINS\"), edge(C, M, \"SENDS_MESSAGE\")";

        // Plain evaluator: ground truth (exactly one self-loop).
        let plain = Evaluator::new(&engine);
        let plain_results = plain.eval_query(&parse_query(query).unwrap()).unwrap();
        assert_eq!(plain_results.len(), 1, "plain evaluator baseline: one self-loop");

        // Explain evaluator MUST match.
        let mut explain = EvaluatorExplain::new(&engine, true);
        let explain_result = explain.eval_query(&parse_query(query).unwrap()).unwrap();
        assert_eq!(
            explain_result.bindings.len(), plain_results.len(),
            "explain evaluator must honour already-bound vars in edge hash-join \
             (parity with plain evaluator) — got spurious rows under --explain"
        );
        let b = &explain_result.bindings[0];
        assert_eq!(b.get("M").map(String::as_str), Some("1"));
        assert_eq!(b.get("C").map(String::as_str), Some((n + 1).to_string().as_str()));
    }

    /// REG-503 explain↔plain parity for the `incoming/3` flavour of the
    /// shared-variable hash-join fix. Mirror of
    /// `test_incoming_hash_join_shared_var` through `EvaluatorExplain`.
    #[test]
    fn test_explain_incoming_hash_join_shared_var_matches_plain() {
        use crate::datalog::eval_explain::EvaluatorExplain;
        let mut engine = GraphEngineV2::create_ephemeral();
        let n = HASH_JOIN_THRESHOLD + 10;

        let mut nodes = Vec::with_capacity(3 * n);
        for i in 1..=n {
            nodes.push(NodeRecord {
                id: i as u128,
                node_type: Some("A".to_string()),
                name: Some(format!("a_{}", i)),
                file: Some("t.ex".to_string()),
                file_id: 0, name_offset: 0, version: "main".into(),
                exported: false, replaces: None, deleted: false,
                metadata: None, semantic_id: None,
            });
            nodes.push(NodeRecord {
                id: (n + i) as u128,
                node_type: Some("B".to_string()),
                name: Some(format!("b_{}", i)),
                file: Some("t.ex".to_string()),
                file_id: 0, name_offset: 0, version: "main".into(),
                exported: false, replaces: None, deleted: false,
                metadata: None, semantic_id: None,
            });
            nodes.push(NodeRecord {
                id: (2 * n + i) as u128,
                node_type: Some("A".to_string()),
                name: Some(format!("other_a_{}", i)),
                file: Some("t.ex".to_string()),
                file_id: 0, name_offset: 0, version: "main".into(),
                exported: false, replaces: None, deleted: false,
                metadata: None, semantic_id: None,
            });
        }
        engine.add_nodes(nodes);

        let fw: Vec<EdgeRecord> = (1..=n).map(|i| EdgeRecord {
            src: i as u128,
            dst: (n + i) as u128,
            edge_type: Some("F".to_string()),
            version: "main".into(), metadata: None, deleted: false,
        }).collect();
        engine.add_edges(fw, false);
        let mut bk: Vec<EdgeRecord> = (1..=n).map(|i| EdgeRecord {
            src: (n + i) as u128,
            dst: (2 * n + i) as u128,
            edge_type: Some("G".to_string()),
            version: "main".into(), metadata: None, deleted: false,
        }).collect();
        bk.push(EdgeRecord {
            src: (n + 1) as u128,
            dst: 1u128,
            edge_type: Some("G".to_string()),
            version: "main".into(), metadata: None, deleted: false,
        });
        engine.add_edges(bk, false);

        let query = "node(A, \"A\"), incoming(A, B, \"G\"), incoming(B, A, \"F\")";

        let plain = Evaluator::new(&engine);
        let plain_results = plain.eval_query(&parse_query(query).unwrap()).unwrap();
        assert_eq!(plain_results.len(), 1, "plain evaluator baseline: one round-trip");

        let mut explain = EvaluatorExplain::new(&engine, true);
        let explain_result = explain.eval_query(&parse_query(query).unwrap()).unwrap();
        assert_eq!(
            explain_result.bindings.len(), plain_results.len(),
            "explain evaluator must honour already-bound vars in incoming hash-join \
             (parity with plain evaluator) — got spurious rows under --explain"
        );
        let b = &explain_result.bindings[0];
        assert_eq!(b.get("A").map(String::as_str), Some("1"));
        assert_eq!(b.get("B").map(String::as_str), Some((n + 1).to_string().as_str()));
    }

    /// Regression: when a variable appears in *both* edge atoms on opposite
    /// sides (self-join pattern `edge(A, B, T1), edge(B, A, T2)`), the hash-
    /// join path must verify the variable still unifies — not rebind it to
    /// any hash-joined value. Without the check, any pair satisfying first
    /// edge AND some second edge anywhere in the graph bleeds through as a
    /// false match. Hit in practice when adding MESSAGE_TYPE → CONTAINS →
    /// CALL edges on Ichi and querying for handler self-loops.
    #[test]
    fn test_hash_join_shared_var_across_two_edges() {
        let mut engine = GraphEngineV2::create_ephemeral();

        // Build > HASH_JOIN_THRESHOLD entities so both edge atoms trip the
        // hash-join path. We create three layers of nodes:
        //  - MESSAGE_TYPE nodes msg_i (ids 1..=n)
        //  - CALL nodes call_i      (ids n+1..=2n)
        //  - "other" MESSAGE_TYPE   (ids 2n+1..=3n) to be the SENDS_MESSAGE
        //    target of each call, so SENDS_MESSAGE has edges, but almost
        //    none of them land back at the CONTAINing msg.
        //
        // Correct answer: exactly one pair — msg_1 contains call_1 and
        // call_1 additionally SENDS_MESSAGE back to msg_1.
        let n = HASH_JOIN_THRESHOLD + 10;

        let mut nodes = Vec::with_capacity(3 * n);
        for i in 1..=n {
            nodes.push(NodeRecord {
                id: i as u128,
                node_type: Some("MESSAGE_TYPE".to_string()),
                name: Some(format!("msg_{}", i)),
                file: Some("t.ex".to_string()),
                file_id: 0, name_offset: 0, version: "main".into(),
                exported: false, replaces: None, deleted: false,
                metadata: None, semantic_id: None,
            });
            nodes.push(NodeRecord {
                id: (n + i) as u128,
                node_type: Some("CALL".to_string()),
                name: Some(format!("call_{}", i)),
                file: Some("t.ex".to_string()),
                file_id: 0, name_offset: 0, version: "main".into(),
                exported: false, replaces: None, deleted: false,
                metadata: None, semantic_id: None,
            });
            nodes.push(NodeRecord {
                id: (2 * n + i) as u128,
                node_type: Some("MESSAGE_TYPE".to_string()),
                name: Some(format!("other_msg_{}", i)),
                file: Some("t.ex".to_string()),
                file_id: 0, name_offset: 0, version: "main".into(),
                exported: false, replaces: None, deleted: false,
                metadata: None, semantic_id: None,
            });
        }
        engine.add_nodes(nodes);

        // CONTAINS: msg_i -> call_i (n edges)
        let contains: Vec<EdgeRecord> = (1..=n).map(|i| EdgeRecord {
            src: i as u128,
            dst: (n + i) as u128,
            edge_type: Some("CONTAINS".to_string()),
            version: "main".into(), metadata: None, deleted: false,
        }).collect();
        engine.add_edges(contains, false);

        // SENDS_MESSAGE: call_i -> other_msg_i for every i,
        // PLUS one real self-loop call_1 -> msg_1.
        let mut sends: Vec<EdgeRecord> = (1..=n).map(|i| EdgeRecord {
            src: (n + i) as u128,
            dst: (2 * n + i) as u128,
            edge_type: Some("SENDS_MESSAGE".to_string()),
            version: "main".into(), metadata: None, deleted: false,
        }).collect();
        sends.push(EdgeRecord {
            src: (n + 1) as u128,
            dst: 1_u128,
            edge_type: Some("SENDS_MESSAGE".to_string()),
            version: "main".into(), metadata: None, deleted: false,
        });
        engine.add_edges(sends, false);

        let evaluator = Evaluator::new(&engine);
        // Self-loop rule: `edge(M, C, CONTAINS), edge(C, M, SENDS_MESSAGE)`
        let literals = parse_query(
            "edge(M, C, \"CONTAINS\"), edge(C, M, \"SENDS_MESSAGE\")"
        ).unwrap();
        let results = evaluator.eval_query(&literals).unwrap();

        // Correct: only (msg_1, call_1). Before the fix, the second edge
        // atom rebinds M to every SENDS_MESSAGE dst, yielding ~n spurious
        // rows where M is an other_msg_i that the CONTAIN'ing msg_i never
        // points to.
        assert_eq!(
            results.len(), 1,
            "hash-join must honor already-bound variables in both edge atoms"
        );
        let b = &results[0];
        assert_eq!(b.get("M").unwrap().as_id().unwrap(), 1);
        assert_eq!(b.get("C").unwrap().as_id().unwrap(), (n + 1) as u128);
    }

    #[test]
    fn test_hash_join_negation_correctness() {
        // Negation with hash join: \+ edge(F, _, "CALLS") uses existence set
        let n = HASH_JOIN_THRESHOLD + 10;
        let mut engine = setup_hash_join_graph(n);

        // Add some FUNCTION nodes WITHOUT CALLS edges (orphans)
        let mut orphan_nodes = Vec::new();
        for i in (2 * n + 1)..=(2 * n + 5) {
            orphan_nodes.push(NodeRecord {
                id: i as u128,
                node_type: Some("FUNCTION".to_string()),
                name: Some(format!("orphan_fn_{}", i)),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            });
        }
        engine.add_nodes(orphan_nodes);

        let mut evaluator = Evaluator::new(&engine);
        let rule = parse_rule(
            "no_calls(F) :- node(F, \"FUNCTION\"), \\+ edge(F, _, \"CALLS\")."
        ).unwrap();
        evaluator.add_rule(rule);

        let goal = parse_atom("no_calls(F)").unwrap();
        let results = evaluator.query(&goal).unwrap();

        // Only the 5 orphan functions should match
        assert_eq!(results.len(), 5, "only orphan functions should have no CALLS edges");
    }

    #[test]
    fn test_hash_join_negation_dst_position() {
        // Negation with dst-position variable: \+ edge(_, X, "CONTAINS")
        // This is the guarantee pattern that was timing out (RFD-49)
        let n = HASH_JOIN_THRESHOLD + 10;
        let mut engine = setup_hash_join_graph(n);

        // Add CONTAINS edges: module → some FUNCTION nodes (but not all)
        let module_id = (3 * n + 1) as u128;
        engine.add_nodes(vec![NodeRecord {
            id: module_id,
            node_type: Some("MODULE".to_string()),
            name: Some("mod".to_string()),
            file: Some("test.js".to_string()),
            file_id: 0,
            name_offset: 0,
            version: "main".into(),
            exported: false,
            replaces: None,
            deleted: false,
            metadata: None,
            semantic_id: None,
        }]);

        // Add CONTAINS edges to first n-5 FUNCTION nodes (leave 5 orphans)
        let orphan_count = 5;
        let contained_count = n - orphan_count;
        let mut edges = Vec::new();
        for i in 1..=contained_count {
            edges.push(EdgeRecord {
                src: module_id,
                dst: i as u128, // FUNCTION node IDs from setup_hash_join_graph
                edge_type: Some("CONTAINS".to_string()),
                version: "main".into(),
                metadata: None,
                deleted: false,
            });
        }
        engine.add_edges(edges, false);

        let mut evaluator = Evaluator::new(&engine);
        let rule = parse_rule(
            r#"orphan(X) :- node(X, "FUNCTION"), \+ edge(_, X, "CONTAINS")."#
        ).unwrap();
        evaluator.add_rule(rule);

        let goal = parse_atom("orphan(X)").unwrap();
        let results = evaluator.query(&goal).unwrap();

        // Only the last 5 FUNCTION nodes should be orphans
        assert_eq!(results.len(), orphan_count,
            "only FUNCTION nodes without incoming CONTAINS should match");
    }

    #[test]
    fn test_hash_join_3literal_with_attr() {
        // Full 3-literal join: node(F, "FUNCTION"), edge(F, C, "CALLS"), attr(C, "name", Name)
        let n = HASH_JOIN_THRESHOLD + 10;
        let engine = setup_hash_join_graph(n);

        let evaluator = Evaluator::new(&engine);
        let literals = parse_query(
            "node(F, \"FUNCTION\"), edge(F, C, \"CALLS\"), attr(C, \"name\", Name)"
        ).unwrap();
        let results = evaluator.eval_query(&literals).unwrap();

        assert_eq!(results.len(), n, "should find name for each CALL via join");
        for b in &results {
            let name = b.get("Name").unwrap().as_str();
            assert!(name.starts_with("call_"), "name should start with call_, got: {}", name);
        }
    }

    #[test]
    fn test_hash_join_2hop_pattern() {
        // 2-hop: node(F, "FUNCTION"), edge(F, C, "CALLS"), edge(C, Q, "QUERIES_DB")
        let n = HASH_JOIN_THRESHOLD + 10;
        let mut engine = setup_hash_join_graph(n);

        // Add some DB_QUERY nodes and QUERIES_DB edges from some CALL nodes
        let db_count = 5;
        let mut db_nodes = Vec::new();
        let mut db_edges = Vec::new();
        for i in 0..db_count {
            let db_id = (3 * n + i + 1) as u128;
            let call_id = (n + i + 1) as u128; // connect to first db_count call nodes
            db_nodes.push(NodeRecord {
                id: db_id,
                node_type: Some("DATABASE_QUERY".to_string()),
                name: Some(format!("query_{}", i)),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            });
            db_edges.push(EdgeRecord {
                src: call_id,
                dst: db_id,
                edge_type: Some("QUERIES_DB".to_string()),
                version: "main".into(),
                metadata: None,
                deleted: false,
            });
        }
        engine.add_nodes(db_nodes);
        engine.add_edges(db_edges, false);

        let mut evaluator = Evaluator::new(&engine);
        let program = parse_program(
            "db_caller(F, Q) :- node(F, \"FUNCTION\"), edge(F, C, \"CALLS\"), edge(C, Q, \"QUERIES_DB\")."
        ).unwrap();
        evaluator.load_rules(program.rules().to_vec());

        let goal = parse_atom("db_caller(F, Q)").unwrap();
        let results = evaluator.query(&goal).unwrap();

        assert_eq!(results.len(), db_count,
            "should find {} functions calling DB queries", db_count);
    }

    // ------------------------------------------------------------------------
    // Negation hash join: a constant (or bound-var) NON-KEY endpoint must be
    // honored.
    //
    // `eval_negation_hash_join` keys its existence set on a single endpoint
    // (`key_pos`). For `\+ edge(X, "d", "T")` the constant dst "d" was silently
    // dropped once the binding count crossed HASH_JOIN_THRESHOLD, collapsing the
    // literal into `\+ edge(X, _, "T")` ("X has NO outgoing T edge") — a
    // threshold-dependent silent wrong answer. These tests pin the correct
    // per-edge semantics across all three evaluation loops (process_literals,
    // eval_rule_body_with, and the explain twin), in both edge directions.
    // ------------------------------------------------------------------------

    #[test]
    fn test_hash_join_negation_const_dst_via_eval_query() {
        // In setup_hash_join_graph, FUNCTION i calls CALL node (n+i). Targeting
        // the CALL node of function 1 means ONLY function 1 calls it, so
        // `\+ edge(X, "<n+1>", "CALLS")` must match every function EXCEPT 1.
        let n = HASH_JOIN_THRESHOLD + 10;
        let engine = setup_hash_join_graph(n);
        let target = (n + 1) as u128;

        let evaluator = Evaluator::new(&engine);
        let literals = parse_query(&format!(
            "node(X, \"FUNCTION\"), \\+ edge(X, \"{}\", \"CALLS\")",
            target
        )).unwrap();
        let results = evaluator.eval_query(&literals).unwrap();

        let ids: HashSet<u128> = results.iter()
            .filter_map(|b| b.get("X").and_then(|v| v.as_id()))
            .collect();

        assert_eq!(ids.len(), n - 1,
            "negation with a const dst must exclude ONLY the caller of that dst");
        assert!(!ids.contains(&1), "fn 1 calls the target dst -> excluded");
        assert!(ids.contains(&2), "fn 2 does not call the target dst -> included");
    }

    #[test]
    fn test_hash_join_negation_const_dst_via_rule() {
        // Same property through a derived rule (eval_rule_body_with path).
        let n = HASH_JOIN_THRESHOLD + 10;
        let engine = setup_hash_join_graph(n);
        let target = (n + 1) as u128;

        let mut evaluator = Evaluator::new(&engine);
        let rule = parse_rule(&format!(
            "no_call_to(X) :- node(X, \"FUNCTION\"), \\+ edge(X, \"{}\", \"CALLS\").",
            target
        )).unwrap();
        evaluator.add_rule(rule);

        let goal = parse_atom("no_call_to(X)").unwrap();
        let results = evaluator.query(&goal).unwrap();

        let ids: HashSet<u128> = results.iter()
            .filter_map(|b| b.get("X").and_then(|v| v.as_id()))
            .collect();
        assert_eq!(ids.len(), n - 1,
            "derived-rule negation with a const dst must honor the dst");
        assert!(!ids.contains(&1), "fn 1 calls the target dst -> excluded");
    }

    #[test]
    fn test_hash_join_negation_const_src_incoming() {
        // incoming sibling: `\+ incoming(C, "1", "CALLS")` = "no CALLS edge from
        // node 1 into C". Only CALL node (n+1) has node 1 as its caller, so every
        // other CALL node must match.
        let n = HASH_JOIN_THRESHOLD + 10;
        let engine = setup_hash_join_graph(n);

        let evaluator = Evaluator::new(&engine);
        let literals = parse_query(
            "node(C, \"CALL\"), \\+ incoming(C, \"1\", \"CALLS\")"
        ).unwrap();
        let results = evaluator.eval_query(&literals).unwrap();

        let ids: HashSet<u128> = results.iter()
            .filter_map(|b| b.get("C").and_then(|v| v.as_id()))
            .collect();
        assert_eq!(ids.len(), n - 1,
            "only the CALL node called by node 1 must be excluded");
        assert!(!ids.contains(&((n + 1) as u128)), "CALL n+1 is called by node 1 -> excluded");
        assert!(ids.contains(&((n + 2) as u128)), "CALL n+2 is called by node 2 -> included");
    }

    #[test]
    fn test_hash_join_negation_const_dst_explain_parity() {
        // The explain twin must agree with the standard evaluator.
        let n = HASH_JOIN_THRESHOLD + 10;
        let engine = setup_hash_join_graph(n);
        let target = (n + 1) as u128;

        let mut explain = EvaluatorExplain::new(&engine, false);
        let literals = parse_query(&format!(
            "node(X, \"FUNCTION\"), \\+ edge(X, \"{}\", \"CALLS\")",
            target
        )).unwrap();
        let result = explain.eval_query(&literals).unwrap();

        let ids: HashSet<u128> = result.bindings.iter()
            .filter_map(|b| b.get("X").and_then(|s| s.parse::<u128>().ok()))
            .collect();
        assert_eq!(ids.len(), n - 1, "explain twin must honor the const dst too");
        assert!(!ids.contains(&1), "fn 1 calls the target dst -> excluded");
    }

    #[test]
    fn test_hash_join_negation_wildcard_still_fast_path() {
        // Regression guard: the wildcard non-key endpoint is the ONLY sound
        // fast-path case and must keep working — `\+ edge(X, _, "CALLS")`.
        let n = HASH_JOIN_THRESHOLD + 10;
        let mut engine = setup_hash_join_graph(n);
        let mut orphans = Vec::new();
        for i in (2 * n + 1)..=(2 * n + 5) {
            orphans.push(NodeRecord {
                id: i as u128,
                node_type: Some("FUNCTION".to_string()),
                name: Some(format!("orphan_{}", i)),
                file: Some("test.js".to_string()),
                file_id: 0,
                name_offset: 0,
                version: "main".into(),
                exported: false,
                replaces: None,
                deleted: false,
                metadata: None,
                semantic_id: None,
            });
        }
        engine.add_nodes(orphans);

        let evaluator = Evaluator::new(&engine);
        let literals = parse_query(
            "node(X, \"FUNCTION\"), \\+ edge(X, _, \"CALLS\")"
        ).unwrap();
        let results = evaluator.eval_query(&literals).unwrap();
        assert_eq!(results.len(), 5, "only the 5 orphan functions have no CALLS edge");
    }
}

// ============================================================================
// Evaluation Limits Tests (RFD-45)
// ============================================================================

mod eval_limits_tests {
    use super::*;
    use super::eval_tests::setup_test_graph;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;
    use std::time::{Duration, Instant};

    #[test]
    fn test_deadline_timeout() {
        let engine = setup_test_graph();
        // 1ns deadline — already expired
        let limits = EvalLimits {
            deadline: Some(Instant::now() - Duration::from_secs(1)),
            max_intermediate_results: usize::MAX,
            max_recursion_depth: usize::MAX,
            cancelled: None,
        };
        let evaluator = Evaluator::with_limits(&engine, limits);

        let query = parse_atom("node(X, \"queue:publish\")").unwrap();
        let result = evaluator.query(&query);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("timeout"), "should contain 'timeout'");
    }

    #[test]
    fn test_intermediate_result_limit() {
        let engine = setup_test_graph();
        // Set a very low limit — even 1 result exceeds it
        let limits = EvalLimits {
            deadline: None,
            max_intermediate_results: 0,
            max_recursion_depth: usize::MAX,
            cancelled: None,
        };
        let evaluator = Evaluator::with_limits(&engine, limits);

        // This query produces results, and eval_query starts with 1 binding (Bindings::new())
        // which triggers the limit check at current.len()=1 > max=0
        let literals = parse_query("node(X, \"queue:publish\")").unwrap();
        let result = evaluator.eval_query(&literals);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("intermediate result limit"));
    }

    #[test]
    fn test_recursion_depth_limit() {
        let engine = setup_test_graph();
        // Set depth limit to 0 — any derived predicate evaluation triggers it
        let limits = EvalLimits {
            deadline: None,
            max_intermediate_results: usize::MAX,
            max_recursion_depth: 0,
            cancelled: None,
        };
        let mut evaluator = Evaluator::with_limits(&engine, limits);

        // Define a derived rule
        let rule = parse_rule("orphan(X) :- node(X, \"queue:publish\").").unwrap();
        evaluator.add_rule(rule);

        let query = parse_atom("orphan(X)").unwrap();
        let result = evaluator.query(&query);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("recursion depth"));
    }

    #[test]
    fn test_cancellation_flag() {
        let engine = setup_test_graph();
        let flag = Arc::new(AtomicBool::new(true)); // Already cancelled
        let limits = EvalLimits {
            deadline: None,
            max_intermediate_results: usize::MAX,
            max_recursion_depth: usize::MAX,
            cancelled: Some(flag),
        };
        let evaluator = Evaluator::with_limits(&engine, limits);

        let query = parse_atom("node(X, \"queue:publish\")").unwrap();
        let result = evaluator.query(&query);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("cancelled"));
    }

    #[test]
    fn test_default_limits_dont_break_normal_queries() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine); // Uses default limits (30s, 100k, 64 depth)

        // Basic queries should work fine
        let query = parse_atom("node(X, \"queue:publish\")").unwrap();
        let results = evaluator.query(&query).unwrap();
        assert_eq!(results.len(), 2);

        // eval_query should also work
        let literals = parse_query("node(X, \"queue:publish\"), attr(X, \"name\", N)").unwrap();
        let results = evaluator.eval_query(&literals).unwrap();
        assert!(!results.is_empty());
    }

    #[test]
    fn test_no_limits() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::with_limits(&engine, EvalLimits::none());

        let query = parse_atom("node(X, \"queue:publish\")").unwrap();
        let results = evaluator.query(&query).unwrap();
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn test_explain_evaluator_deadline_timeout() {
        let engine = setup_test_graph();
        let limits = EvalLimits {
            deadline: Some(Instant::now() - Duration::from_secs(1)),
            max_intermediate_results: usize::MAX,
            max_recursion_depth: usize::MAX,
            cancelled: None,
        };
        let mut evaluator = EvaluatorExplain::with_limits(&engine, true, limits);

        let literals = parse_query("node(X, \"queue:publish\")").unwrap();
        let result = evaluator.eval_query(&literals);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("timeout"));
    }

    #[test]
    fn test_explain_evaluator_cancellation() {
        let engine = setup_test_graph();
        let flag = Arc::new(AtomicBool::new(true));
        let limits = EvalLimits {
            deadline: None,
            max_intermediate_results: usize::MAX,
            max_recursion_depth: usize::MAX,
            cancelled: Some(flag),
        };
        let mut evaluator = EvaluatorExplain::with_limits(&engine, false, limits);

        let literals = parse_query("node(X, \"queue:publish\")").unwrap();
        let result = evaluator.eval_query(&literals);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("cancelled"));
    }
}

// ============================================================================
// RFD-52: Numeric Comparison Operators (gt, lt, gte, lte)
// ============================================================================

mod numeric_cmp_tests {
    use super::*;
    use crate::graph::{GraphEngineV2, GraphStore};
    use crate::storage::NodeRecord;
    use crate::datalog::eval::{Evaluator, Value};
    use crate::datalog::utils::reorder_literals;

    #[test]
    fn test_eval_gt_integer_success() {
        let engine = GraphEngineV2::create_ephemeral();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("gt", vec![
            Term::constant("1500"),
            Term::constant("1000"),
        ]);
        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_eval_gt_integer_failure() {
        let engine = GraphEngineV2::create_ephemeral();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("gt", vec![
            Term::constant("500"),
            Term::constant("1000"),
        ]);
        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn test_eval_lt_success() {
        let engine = GraphEngineV2::create_ephemeral();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("lt", vec![
            Term::constant("500"),
            Term::constant("1000"),
        ]);
        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_eval_lt_failure() {
        let engine = GraphEngineV2::create_ephemeral();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("lt", vec![
            Term::constant("1500"),
            Term::constant("1000"),
        ]);
        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn test_eval_gte_equal() {
        let engine = GraphEngineV2::create_ephemeral();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("gte", vec![
            Term::constant("1000"),
            Term::constant("1000"),
        ]);
        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_eval_lte_equal() {
        let engine = GraphEngineV2::create_ephemeral();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("lte", vec![
            Term::constant("1000"),
            Term::constant("1000"),
        ]);
        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_eval_gt_float() {
        let engine = GraphEngineV2::create_ephemeral();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("gt", vec![
            Term::constant("1000.5"),
            Term::constant("1000"),
        ]);
        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_eval_gt_negative() {
        let engine = GraphEngineV2::create_ephemeral();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("gt", vec![
            Term::constant("5"),
            Term::constant("-10"),
        ]);
        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn test_eval_gt_non_numeric() {
        let engine = GraphEngineV2::create_ephemeral();
        let evaluator = Evaluator::new(&engine);

        let query = Atom::new("gt", vec![
            Term::constant("abc"),
            Term::constant("100"),
        ]);
        let results = evaluator.query_atom(&query).unwrap();
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn test_eval_gt_in_rule() {
        let mut engine = GraphEngineV2::create_ephemeral();

        engine.add_nodes(vec![
            NodeRecord {
                id: 1,
                node_type: Some("METRIC".to_string()),
                name: Some("response_time".to_string()),
                file: Some("api.js".to_string()),
                file_id: 0, name_offset: 0,
                version: "main".into(),
                exported: false, replaces: None, deleted: false,
                metadata: Some(r#"{"value":"1500"}"#.to_string()),
                semantic_id: None,
            },
            NodeRecord {
                id: 2,
                node_type: Some("METRIC".to_string()),
                name: Some("fast_call".to_string()),
                file: Some("api.js".to_string()),
                file_id: 0, name_offset: 0,
                version: "main".into(),
                exported: false, replaces: None, deleted: false,
                metadata: Some(r#"{"value":"500"}"#.to_string()),
                semantic_id: None,
            },
            NodeRecord {
                id: 3,
                node_type: Some("METRIC".to_string()),
                name: Some("exact_threshold".to_string()),
                file: Some("api.js".to_string()),
                file_id: 0, name_offset: 0,
                version: "main".into(),
                exported: false, replaces: None, deleted: false,
                metadata: Some(r#"{"value":"1000"}"#.to_string()),
                semantic_id: None,
            },
        ]);

        let mut evaluator = Evaluator::new(&engine);

        let rule = parse_rule(
            r#"violation(X) :- node(X, "METRIC"), attr(X, "value", V), gt(V, "1000")."#
        ).unwrap();
        evaluator.add_rule(rule);

        let query = parse_atom("violation(X)").unwrap();
        let results = evaluator.query(&query).unwrap();

        // Only node 1 (value=1500) should violate; node 2 (500) and node 3 (1000) should not
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Id(1)));
    }

    #[test]
    fn test_reorder_numeric_cmp() {
        // gt before node bindings should be reordered: node first, then attr, then gt
        let lit_node = Literal::positive(Atom::new("node", vec![
            Term::var("X"),
            Term::constant("METRIC"),
        ]));
        let lit_attr = Literal::positive(Atom::new("attr", vec![
            Term::var("X"),
            Term::constant("value"),
            Term::var("V"),
        ]));
        let lit_gt = Literal::positive(Atom::new("gt", vec![
            Term::var("V"),
            Term::constant("1000"),
        ]));

        // Wrong order: gt first
        let input = vec![lit_gt.clone(), lit_attr.clone(), lit_node.clone()];
        let result = reorder_literals(&input).unwrap();

        // node must come first (provides X), attr second (needs X, provides V), gt last (needs V)
        assert_eq!(result[0].atom().predicate(), "node");
        assert_eq!(result[1].atom().predicate(), "attr");
        assert_eq!(result[2].atom().predicate(), "gt");
    }
}


// ============================================================================
// attr() reverse lookup — nested metadata dotted paths (forward/reverse symmetry)
//
// The forward path `attr(id, "a.b", V)` resolves nested dotted metadata paths
// via `get_metadata_value` (metadata["a"]["b"]). The reverse path
// `attr(X, "a.b", "v")` routed dotted keys through `metadata_filters`, which
// only matches FLAT keys (`parsed.get("a.b")`), so it silently returned nothing
// while the forward dual resolved it — a silent forward/reverse asymmetry of
// the same class as the semantic_id/version/id reverse gap (RFD-48). These
// tests pin the restored symmetry; flat-key reverse is unchanged.
// ============================================================================

mod attr_reverse_nested_metadata_tests {
    use super::*;
    use crate::graph::{GraphEngineV2, GraphStore};
    use crate::storage::NodeRecord;
    use crate::datalog::eval::Evaluator;
    use crate::datalog::eval_explain::EvaluatorExplain;

    fn setup_nested_metadata_graph() -> GraphEngineV2 {
        let mut engine = GraphEngineV2::create_ephemeral();
        engine.add_nodes(vec![
            NodeRecord {
                id: 1,
                node_type: Some("SERVICE".to_string()),
                name: Some("db".to_string()),
                file: Some("db.js".to_string()),
                file_id: 0, name_offset: 0,
                version: "main".into(),
                exported: false, replaces: None, deleted: false,
                metadata: Some(r#"{"config":{"port":"5432"},"tier":"data"}"#.to_string()),
                semantic_id: None,
            },
            NodeRecord {
                id: 2,
                node_type: Some("SERVICE".to_string()),
                name: Some("cache".to_string()),
                file: Some("cache.js".to_string()),
                file_id: 0, name_offset: 0,
                version: "main".into(),
                exported: false, replaces: None, deleted: false,
                metadata: Some(r#"{"config":{"port":"6379"},"tier":"data"}"#.to_string()),
                semantic_id: None,
            },
        ]);
        engine
    }

    // Reverse: attr(X, "config.port", "5432") must find node 1, mirroring the
    // forward attr(1, "config.port", V) = "5432".
    #[test]
    fn test_eval_attr_reverse_nested_metadata() {
        let engine = setup_nested_metadata_graph();
        let ev = Evaluator::new(&engine);

        let results = ev.query_atom(&Atom::new("attr", vec![
            Term::var("X"),
            Term::constant("config.port"),
            Term::constant("5432"),
        ])).unwrap();

        let ids: Vec<u128> = results.iter()
            .filter_map(|b| b.get("X").and_then(|v| v.as_id()))
            .collect();
        assert_eq!(ids, vec![1], "reverse nested config.port=5432 must return node 1");
    }

    // Forward/reverse symmetry over a nested dotted path: the value forward
    // returns for node 2's config.port, fed back to reverse, returns node 2.
    #[test]
    fn test_eval_attr_nested_forward_reverse_symmetry() {
        let engine = setup_nested_metadata_graph();
        let ev = Evaluator::new(&engine);

        let fwd = ev.query_atom(&Atom::new("attr", vec![
            Term::constant("2"),
            Term::constant("config.port"),
            Term::var("V"),
        ])).unwrap();
        assert_eq!(fwd.len(), 1);
        let value = match fwd[0].get("V").unwrap() {
            Value::Str(s) => s.clone(),
            other => panic!("expected Str, got {:?}", other),
        };
        assert_eq!(value, "6379");

        let rev = ev.query_atom(&Atom::new("attr", vec![
            Term::var("X"),
            Term::constant("config.port"),
            Term::constant(&value),
        ])).unwrap();
        let ids: Vec<u128> = rev.iter()
            .filter_map(|b| b.get("X").and_then(|v| v.as_id()))
            .collect();
        assert_eq!(ids, vec![2], "forward nested value must reverse to node 2");
    }

    // A nested path value that no node has → empty.
    #[test]
    fn test_eval_attr_reverse_nested_no_match() {
        let engine = setup_nested_metadata_graph();
        let ev = Evaluator::new(&engine);
        let results = ev.query_atom(&Atom::new("attr", vec![
            Term::var("X"),
            Term::constant("config.port"),
            Term::constant("9999"),
        ])).unwrap();
        assert!(results.is_empty(), "unknown nested value must yield no rows");
    }

    // Regression: flat metadata key reverse lookup is unchanged.
    #[test]
    fn test_eval_attr_reverse_flat_metadata_still_works() {
        let engine = setup_nested_metadata_graph();
        let ev = Evaluator::new(&engine);
        let results = ev.query_atom(&Atom::new("attr", vec![
            Term::var("X"),
            Term::constant("tier"),
            Term::constant("data"),
        ])).unwrap();
        let mut ids: Vec<u128> = results.iter()
            .filter_map(|b| b.get("X").and_then(|v| v.as_id()))
            .collect();
        ids.sort();
        assert_eq!(ids, vec![1, 2], "flat metadata reverse must still match both nodes");
    }

    // EvaluatorExplain twin must agree with Evaluator on the reverse nested lookup.
    #[test]
    fn test_eval_attr_reverse_nested_explain() {
        let engine = setup_nested_metadata_graph();
        let mut ev = EvaluatorExplain::new(&engine, false);
        let result = ev.eval_query(&parse_query(
            r#"attr(X, "config.port", "5432")"#
        ).unwrap()).unwrap();
        assert_eq!(result.bindings.len(), 1);
        assert_eq!(result.bindings[0].get("X"), Some(&"1".to_string()));
    }

    // The pipelined generator path (eval_generator_chunked) has its OWN copy of
    // the reverse-attr routing. A conjunction whose only valid seed is the
    // reverse nested attr lookup routes through it (neq is a filter that needs X
    // already bound, so the reorderer places the reverse attr first as the
    // generator) — exercising the generator-path copy, not eval_attr.
    #[test]
    fn test_eval_attr_reverse_nested_as_generator() {
        let engine = setup_nested_metadata_graph();
        let ev = Evaluator::new(&engine);
        let results = ev.eval_query(&parse_query(
            r#"attr(X, "config.port", "6379"), neq(X, "0")"#
        ).unwrap()).unwrap();
        let ids: Vec<u128> = results.iter()
            .filter_map(|b| b.get("X").and_then(|v| v.as_id()))
            .collect();
        assert_eq!(ids, vec![2], "reverse nested attr must seed the pipelined generator path");
    }
}
