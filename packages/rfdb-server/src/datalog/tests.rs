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
        let results = evaluator.eval_query(&literals);

        // Should find nodes 1 and 3
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn test_eval_query_conjunction() {
        let engine = setup_test_graph();
        let evaluator = Evaluator::new(&engine);

        // Conjunction: find CALLS edges and bind source/dest
        let literals = parse_query("edge(X, Y, \"CALLS\"), node(Y, T)").unwrap();
        let results = evaluator.eval_query(&literals);

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
        let results = evaluator.eval_query(&literals);

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
        let results = evaluator.eval_query(&literals);

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
        let results = evaluator.eval_query(&literals);

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
}
