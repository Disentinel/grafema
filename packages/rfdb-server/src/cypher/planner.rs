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

    // 1. Start with NodeScan for the first node pattern.
    let mut op: Box<dyn Operator + 'a> = Box::new(NodeScan::new(
        engine,
        pattern.start.variable.clone(),
        pattern.start.labels.clone(),
        pattern.start.properties.clone(),
        limits,
    ));

    // Track the "current" variable name so Expand knows which record field
    // holds the source node. Start with the first node pattern's variable.
    let mut prev_var = pattern
        .start
        .variable
        .clone()
        .unwrap_or_else(|| "__anon_0".to_string());

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

    let has_aggregates = query
        .return_clause
        .items
        .iter()
        .any(|item| matches!(item.expr, Expr::FunctionCall(_, _)));

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
