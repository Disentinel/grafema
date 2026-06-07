//! Rule-based query planner: converts Cypher AST to an operator tree.
//!
//! The planner is a simple bottom-up builder — no cost optimizer.
//! It walks the parsed CypherQuery and chains operators:
//!
//! 1. First NodePattern → `NodeScan`
//! 2. Each (RelPattern, NodePattern) segment → `Expand` or `VarLengthExpand`
//! 3. WHERE → `Filter`
//! 4. Without aggregates: `Sort` → `Project` → `Limit`
//!    With aggregates: `HashAggregate` → `Sort` → `Limit`

use crate::cypher::aggregate::is_aggregate_function;
use crate::cypher::ast::*;
use crate::cypher::executor::*;
use crate::cypher::CypherError;
use crate::datalog::EvalLimits;
use crate::graph::GraphStore;

/// Build an operator tree from a parsed Cypher query.
pub fn plan<'a>(
    query: &CypherQuery,
    engine: &'a dyn GraphStore,
    limits: &'a EvalLimits,
) -> Result<Box<dyn Operator + 'a>, CypherError> {
    let pattern = &query.match_clause.pattern;

    // The start node's effective variable name. For an anonymous start node
    // (`MATCH ()-[:CALLS]->(g)`) we synthesize `__anon_0` — the same name the
    // segment loop below uses for unnamed nodes (`__anon_{i+1}`). This name is
    // used for BOTH the `NodeScan` binding and `prev_var` so they always agree.
    let start_var = pattern
        .start
        .variable
        .clone()
        .unwrap_or_else(|| "__anon_0".to_string());

    // 1. Start with NodeScan for the first node pattern.
    //
    // The scan must always bind the start node under `start_var`, even when the
    // pattern node is anonymous: a downstream `Expand` resolves its source node
    // by looking up `start_var` in the record. If `NodeScan` produced an unbound
    // record (as it did when the start node had no explicit variable), `Expand`
    // failed with "variable '__anon_0' is not a node". Binding here mirrors how
    // anonymous DESTINATION nodes are already bound by `Expand`.
    let mut op: Box<dyn Operator + 'a> = Box::new(NodeScan::new(
        engine,
        Some(start_var.clone()),
        pattern.start.labels.clone(),
        pattern.start.properties.clone(),
        limits,
    ));

    // Track the "current" variable name so Expand knows which record field
    // holds the source node. Start with the first node pattern's variable.
    let mut prev_var = start_var;

    // 2. Chain Expand/VarLengthExpand for each segment.
    for (i, (rel, node)) in pattern.segments.iter().enumerate() {
        let dst_var = node
            .variable
            .clone()
            .unwrap_or_else(|| format!("__anon_{}", i + 1));

        if let Some((min, max)) = rel.length {
            op = Box::new(VarLengthExpand::new(
                op,
                engine,
                prev_var.clone(),
                Some(dst_var.clone()),
                rel.rel_types.clone(),
                rel.direction,
                min,
                max,
                limits,
            ));
        } else {
            op = Box::new(Expand::new(
                op,
                engine,
                prev_var.clone(),
                Some(dst_var.clone()),
                rel.variable.clone(),
                rel.rel_types.clone(),
                rel.direction,
                limits,
            ));
        }

        // If the destination node has labels, add a Filter for node type.
        if !node.labels.is_empty() {
            let filter_expr = Expr::BinaryOp(
                Box::new(Expr::Property(dst_var.clone(), "type".to_string())),
                BinOp::Eq,
                Box::new(Expr::Literal(CypherLiteral::Str(
                    node.labels[0].clone(),
                ))),
            );
            op = Box::new(Filter::new(op, filter_expr));
        }

        // If the destination node has inline properties, add filters for each.
        for (key, value) in &node.properties {
            let filter_expr = Expr::BinaryOp(
                Box::new(Expr::Property(dst_var.clone(), key.clone())),
                BinOp::Eq,
                Box::new(value.clone()),
            );
            op = Box::new(Filter::new(op, filter_expr));
        }

        prev_var = dst_var;
    }

    // 3. WHERE → Filter
    if let Some(ref where_expr) = query.where_clause {
        op = Box::new(Filter::new(op, where_expr.clone()));
    }

    // 4-7. RETURN / ORDER BY / LIMIT
    //
    // Operator ordering depends on whether aggregation is present:
    //
    // Without aggregates: Sort → Project → Limit
    //   Sort must run before Project because it evaluates expressions
    //   (e.g., n.name) against the full record which still has node objects.
    //   After Project, records only have projected string values.
    //
    // With aggregates: HashAggregate → Sort → Limit
    //   HashAggregate already produces named columns, so Sort works on those.
    //   No separate Project is needed after HashAggregate.

    // Reject unsupported (non-aggregate) scalar functions in every clause whose
    // expressions the engine evaluates. The executor implements only the aggregate
    // functions (COUNT/SUM/AVG/MIN/MAX); any other function name (e.g. `toUpper`,
    // `toLower`, `type`, `length`) is NOT implemented and `eval_expr` evaluates it
    // to NULL. Left unguarded that produces silent wrong answers:
    //   - RETURN toUpper(n.name)            → mislabeled as an aggregate / NULL column
    //   - WHERE  toUpper(n.name) = 'X'      → `NULL = 'X'` = NULL → every row dropped
    //                                         (an empty result that looks like "no match")
    //   - ORDER BY toUpper(n.name)          → every sort key NULL → silent no-op sort
    // So each such clause must fail loudly here. Scalar-function support is a
    // separate feature; until it exists, an unsupported call is an error, not a
    // confidently-wrong result.
    for item in &query.return_clause.items {
        reject_unsupported_functions(&item.expr, "RETURN")?;
    }
    if let Some(ref where_expr) = query.where_clause {
        reject_unsupported_functions(where_expr, "WHERE")?;
    }
    if let Some(ref order_by) = query.order_by {
        for (expr, _) in order_by {
            reject_unsupported_functions(expr, "ORDER BY")?;
        }
    }
    // Inline pattern property values are evaluated too — the start node's via
    // `NodeScan::matches_properties` (`eval_literal_expr`) and each segment node's
    // via a synthesized `Filter` (`eval_expr`). A function call there is the same
    // silent-NULL trap (e.g. `MATCH (n {name: toUpper('x')})` would match only
    // NULL-named nodes), so validate those values as well.
    for (_, val) in &pattern.start.properties {
        reject_unsupported_functions(val, "node pattern properties")?;
    }
    for (_, node) in &pattern.segments {
        for (_, val) in &node.properties {
            reject_unsupported_functions(val, "node pattern properties")?;
        }
    }

    let has_aggregates = query
        .return_clause
        .items
        .iter()
        .any(|item| match &item.expr {
            Expr::FunctionCall(name, _) => is_aggregate_function(name),
            _ => false,
        });

    if has_aggregates {
        let (group_keys, aggregates) = split_return_items(&query.return_clause);
        op = Box::new(HashAggregate::new(op, group_keys, aggregates, limits));

        // Sort after aggregate (operates on named columns).
        if let Some(ref order_by) = query.order_by {
            op = Box::new(Sort::new(op, order_by.clone(), limits));
        }
    } else {
        // Sort before Project (operates on full node records).
        if let Some(ref order_by) = query.order_by {
            op = Box::new(Sort::new(op, order_by.clone(), limits));
        }

        op = Box::new(Project::new(op, query.return_clause.items.clone()));
    }

    // Limit is always last.
    if let Some(limit) = query.limit {
        op = Box::new(Limit::new(op, limit));
    }

    Ok(op)
}

/// Recursively reject any unsupported (non-aggregate) function call anywhere in
/// `expr`, returning a [`CypherError::Plan`] that names the offending function
/// and the `clause` it appears in.
///
/// The engine only implements the aggregate functions (COUNT/SUM/AVG/MIN/MAX);
/// every other function name evaluates to NULL in `eval_expr`, which silently
/// corrupts WHERE filters, ORDER BY keys, and RETURN columns. This walk catches
/// such calls before execution — including ones buried inside compound
/// predicates (e.g. `NOT (toLower(x) = 'y' AND ...)`) — so the query fails
/// loudly instead of returning a confidently-wrong empty/unsorted result.
///
/// Aggregate function calls are left intact: they are legitimate in RETURN (and
/// in ORDER BY of an aggregate query), and are routed through `HashAggregate`.
/// Their arguments are still walked, so a scalar function nested inside an
/// aggregate (e.g. `COUNT(toUpper(x))`) is also rejected.
fn reject_unsupported_functions(expr: &Expr, clause: &str) -> Result<(), CypherError> {
    match expr {
        Expr::FunctionCall(name, args) => {
            if !is_aggregate_function(name) {
                return Err(CypherError::Plan(format!(
                    "Unsupported function '{}' in {} (supported: COUNT, SUM, AVG, MIN, MAX); \
                     scalar functions are not implemented",
                    name, clause
                )));
            }
            for arg in args {
                reject_unsupported_functions(arg, clause)?;
            }
            Ok(())
        }
        Expr::BinaryOp(lhs, _, rhs)
        | Expr::And(lhs, rhs)
        | Expr::Or(lhs, rhs)
        | Expr::Contains(lhs, rhs)
        | Expr::StartsWith(lhs, rhs)
        | Expr::EndsWith(lhs, rhs) => {
            reject_unsupported_functions(lhs, clause)?;
            reject_unsupported_functions(rhs, clause)
        }
        Expr::Not(inner) | Expr::IsNull(inner) | Expr::IsNotNull(inner) => {
            reject_unsupported_functions(inner, clause)
        }
        Expr::Property(_, _) | Expr::Literal(_) | Expr::Variable(_) | Expr::Star => Ok(()),
    }
}

/// Split ReturnClause items into group keys (non-aggregate) and aggregate items.
fn split_return_items(ret: &ReturnClause) -> (Vec<ReturnItem>, Vec<AggregateItem>) {
    let mut group_keys = Vec::new();
    let mut aggregates = Vec::new();

    for item in &ret.items {
        match &item.expr {
            Expr::FunctionCall(name, args) => {
                let alias = item.alias.clone().unwrap_or_else(|| {
                    format!(
                        "{}({})",
                        name,
                        if args.is_empty() {
                            "*".to_string()
                        } else {
                            format_arg_expr(args.first().unwrap())
                        }
                    )
                });
                aggregates.push(AggregateItem {
                    function: name.to_uppercase(),
                    arg: args.first().cloned().unwrap_or(Expr::Star),
                    alias,
                });
            }
            _ => {
                group_keys.push(item.clone());
            }
        }
    }

    (group_keys, aggregates)
}

/// Format an expression for use in a generated alias.
fn format_arg_expr(expr: &Expr) -> String {
    match expr {
        Expr::Variable(v) => v.clone(),
        Expr::Property(var, prop) => format!("{}.{}", var, prop),
        Expr::Star => "*".to_string(),
        _ => "?".to_string(),
    }
}
