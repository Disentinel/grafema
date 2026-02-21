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
    use crate::graph::{GraphEngine, GraphStore};
    use crate::storage::{NodeRecord, EdgeRecord};
    use tempfile::tempdir;

    fn setup_test_graph() -> GraphEngine {
        let dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(dir.path()).unwrap();

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

        let results = evaluator.eval_atom(&query);
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

        let node_results = evaluator.eval_atom(&node_query);
        let type_results = evaluator.eval_atom(&type_query);

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

        let results = evaluator.eval_atom(&query);
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

        let results = evaluator.eval_atom(&query);
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

        let results = evaluator.eval_atom(&query);
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

        let results = evaluator.eval_atom(&query);
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

        let results = evaluator.eval_atom(&query);
        assert_eq!(results.len(), 0); // no path
    }

    #[test]
    fn test_eval_rule_simple() {
        let engine = setup_test_graph();
        let mut evaluator = Evaluator::new(&engine);

        // publisher(X) :- node(X, "queue:publish").
        let rule = parse_rule("publisher(X) :- node(X, \"queue:publish\").").unwrap();
        evaluator.add_rule(rule);

        let query = parse_atom("publisher(X)").unwrap();
        let results = evaluator.query(&query);

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
        let results = evaluator.query(&query);

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

        let results = evaluator.eval_atom(&query);
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

        let results = evaluator.eval_atom(&query);
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn test_guarantee_all_variables_assigned() {
        // Setup: Create a graph with VARIABLE nodes, some with ASSIGNED_FROM, some without
        let dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(dir.path()).unwrap();

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
        let results = evaluator.query(&query);

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

        let results = evaluator.eval_atom(&query);
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

        let results = evaluator.eval_atom(&query);
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

        let results = evaluator.eval_atom(&query);
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

        let results = evaluator.eval_atom(&query);
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

        let results = evaluator.eval_atom(&query);
        assert_eq!(results.len(), 0); // No match
    }

    #[test]
    fn test_eval_attr_metadata() {
        // Create a graph with metadata
        let dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(dir.path()).unwrap();

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

        let results = evaluator.eval_atom(&query);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Str("arr".to_string())));

        // attr(100, "method", X) - get method from metadata
        let query2 = Atom::new("attr", vec![
            Term::constant("100"),
            Term::constant("method"),
            Term::var("X"),
        ]);

        let results2 = evaluator.eval_atom(&query2);
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

        let results = evaluator.eval_atom(&query);
        assert_eq!(results.len(), 0); // No results for missing attr
    }

    #[test]
    fn test_eval_attr_nested_path() {
        // Test nested path resolution in attr() predicate
        // attr(N, "config.port", V) should extract metadata["config"]["port"]
        let dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(dir.path()).unwrap();

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

        let results = evaluator.eval_atom(&query);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Str("localhost".to_string())));
    }

    #[test]
    fn test_eval_attr_nested_number() {
        // Test nested number extraction - numbers should be converted to strings
        let dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(dir.path()).unwrap();

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

        let results = evaluator.eval_atom(&query);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Str("3000".to_string())));
    }

    #[test]
    fn test_eval_attr_literal_key_with_dots() {
        // Backward compatibility: literal keys containing dots should take precedence
        // over nested path resolution
        let dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(dir.path()).unwrap();

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

        let results = evaluator.eval_atom(&query);
        assert_eq!(results.len(), 1);
        // Literal key takes precedence
        assert_eq!(results[0].get("X"), Some(&Value::Str("literal-value".to_string())));
    }

    #[test]
    fn test_eval_attr_nested_path_not_found() {
        // Missing nested path should return empty results
        let dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(dir.path()).unwrap();

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

        let results = evaluator.eval_atom(&query);
        assert_eq!(results.len(), 0); // Path not found
    }

    #[test]
    fn test_guarantee_call_without_target() {
        // Test: Find CALL nodes without "object" that don't have CALLS edge
        // This represents internal function calls that don't resolve
        let dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(dir.path()).unwrap();

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
        let results = evaluator.query(&query);

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

        let results = evaluator.eval_atom(&query);
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

        let results = evaluator.eval_atom(&query);
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

        let results = evaluator.eval_atom(&query);
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

        let results = evaluator.eval_atom(&query);
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

        let results = evaluator.eval_atom(&query);
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

        let results = evaluator.eval_atom(&query);
        assert_eq!(results.len(), 0);
    }

    #[test]
    fn test_eval_neq_in_rule() {
        // Test neq in a rule context
        let dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(dir.path()).unwrap();

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
        let results = evaluator.query(&query);

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

        let results = evaluator.eval_atom(&query);
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

        let results = evaluator.eval_atom(&query);
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

        let results = evaluator.eval_atom(&query);
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
        let dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(dir.path()).unwrap();

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
        let dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(dir.path()).unwrap();

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
        let dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(dir.path()).unwrap();

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

        let results = evaluator.eval_atom(&query);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Str("nodes".to_string())));
    }

    #[test]
    fn test_eval_attr_edge_nested_path() {
        // Test nested path in edge metadata (e.g., "cardinality.scale")
        let dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(dir.path()).unwrap();

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

        let results = evaluator.eval_atom(&query);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].get("X"), Some(&Value::Str("unbounded".to_string())));
    }

    #[test]
    fn test_eval_attr_edge_constant_match() {
        // Test matching against a constant value
        let dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(dir.path()).unwrap();

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

        let results = evaluator.eval_atom(&query_match);
        assert_eq!(results.len(), 1); // Match succeeds

        // No match: attr_edge(100, 200, "ITERATES_OVER", "scale", "constant")
        let query_no_match = Atom::new("attr_edge", vec![
            Term::constant("100"),
            Term::constant("200"),
            Term::constant("ITERATES_OVER"),
            Term::constant("scale"),
            Term::constant("constant"),
        ]);

        let results = evaluator.eval_atom(&query_no_match);
        assert_eq!(results.len(), 0); // Match fails
    }

    #[test]
    fn test_eval_attr_edge_no_metadata() {
        // Edge without metadata should return empty
        let dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(dir.path()).unwrap();

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

        let results = evaluator.eval_atom(&query);
        assert_eq!(results.len(), 0); // No metadata = no results
    }

    #[test]
    fn test_eval_attr_edge_missing_attr() {
        // Missing attribute in edge metadata should return empty
        let dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(dir.path()).unwrap();

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

        let results = evaluator.eval_atom(&query);
        assert_eq!(results.len(), 0); // Attribute doesn't exist
    }

    #[test]
    fn test_eval_attr_edge_edge_not_found() {
        // Non-existent edge should return empty
        let dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(dir.path()).unwrap();

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

        let results = evaluator.eval_atom(&query);
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

    #[test]
    fn test_eval_attr_edge_in_rule() {
        // Test attr_edge() used in a Datalog rule context
        let dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(dir.path()).unwrap();

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
        let results = evaluator.query(&query);

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
    fn setup_reorder_test_graph() -> GraphEngine {
        let dir = tempdir().unwrap();
        let mut engine = GraphEngine::create(dir.path()).unwrap();

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
        let results = evaluator.query(&query);

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
        fn setup_parent_function_graph() -> GraphEngine {
            let dir = tempdir().unwrap();
            let mut engine = GraphEngine::create(dir.path()).unwrap();

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

            let results = evaluator.eval_atom(&query);
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

            let results = evaluator.eval_atom(&query);
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

            let results = evaluator.eval_atom(&query);
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

            let results = evaluator.eval_atom(&query);
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

            let results = evaluator.eval_atom(&query);
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

            let results = evaluator.eval_atom(&query);
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

            let results = evaluator.eval_atom(&query);
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

            let results = evaluator.eval_atom(&query);
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

            let results = evaluator.eval_atom(&query);
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

            let results = evaluator.eval_atom(&query);
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
            let results = evaluator.query(&query);

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
}
