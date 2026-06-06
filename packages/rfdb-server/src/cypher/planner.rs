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

    // Reject non-aggregate functions in RETURN. The executor implements only
    // aggregate functions (COUNT/SUM/AVG/MIN/MAX); a scalar function such as
    // toUpper(...) must fail loudly here rather than be silently routed through
    // HashAggregate (which would mislabel it as an aggregate) or projected to
    // NULL. Scalar-function support is a separate feature.
    for item in &query.return_clause.items {
        if let Expr::FunctionCall(name, _) = &item.expr {
            if !is_aggregate_function(name) {
                return Err(CypherError::Plan(format!(
                    "Unsupported function '{}' in RETURN (supported: COUNT, SUM, AVG, MIN, MAX)",
                    name
                )));
            }
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

        // Rewrite ORDER BY to reference the columns HashAggregate produces.
        // Post-aggregation the original node bindings are gone and aggregate
        // calls are not re-evaluated, so Sort must reference the produced
        // column names. Done BEFORE the groups/aggregates are moved into the
        // operator below.
        let order_by = query
            .order_by
            .as_ref()
            .map(|ob| rewrite_order_by_for_aggregates(ob, &group_keys, &aggregates));

        op = Box::new(HashAggregate::new(op, group_keys, aggregates, limits));

        // Sort after aggregate (operates on the produced named columns).
        if let Some(order_by) = order_by {
            op = Box::new(Sort::new(op, order_by, limits));
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

/// The column name `HashAggregate` produces for a group-key RETURN item.
///
/// MUST stay identical to the key `HashAggregate::materialize` inserts for the
/// same item (`alias` else `format_return_expr(expr)`), so that an `ORDER BY`
/// expression rewritten to `Variable(name)` resolves to the right column.
fn group_key_name(item: &ReturnItem) -> String {
    item.alias
        .clone()
        .unwrap_or_else(|| format_return_expr(&item.expr))
}

/// Rewrite the `ORDER BY` expressions of an aggregate query so they reference
/// the columns the `HashAggregate` operator emits.
///
/// In an aggregate query the `Sort` operator runs *after* `HashAggregate`,
/// whose output records carry only the produced columns: one per group key
/// (keyed by [`group_key_name`]) and one per aggregate (keyed by its alias).
/// The original `ORDER BY` AST instead holds the raw pattern expressions:
///
/// - `ORDER BY n.file` is a `Property("n", "file")`, but `n` no longer exists
///   in the post-aggregation record (only the string column `"n.file"` does),
///   so `eval_expr` would yield `NULL` and the rows would not sort.
/// - `ORDER BY COUNT(*)` is a `FunctionCall`, which `eval_expr` returns `NULL`
///   for (aggregates are not re-evaluated post-aggregation), again no sort.
///
/// This rewrite maps any `ORDER BY` term that matches a RETURN item — by
/// structural equality for group keys, by function name + argument for
/// aggregates — to a `Variable` referencing that item's produced column, so
/// `Sort` reads the already-computed value. Terms that match nothing (e.g. an
/// alias already referenced directly, or an expression not in RETURN) are left
/// unchanged.
fn rewrite_order_by_for_aggregates(
    order_by: &[(Expr, SortDir)],
    group_keys: &[ReturnItem],
    aggregates: &[AggregateItem],
) -> Vec<(Expr, SortDir)> {
    order_by
        .iter()
        .map(|(expr, dir)| (rewrite_order_expr(expr, group_keys, aggregates), *dir))
        .collect()
}

/// Recursively rewrite a single `ORDER BY` expression. See
/// [`rewrite_order_by_for_aggregates`] for the rationale.
fn rewrite_order_expr(
    expr: &Expr,
    group_keys: &[ReturnItem],
    aggregates: &[AggregateItem],
) -> Expr {
    // An aggregate call that also appears in RETURN -> its produced column.
    if let Expr::FunctionCall(name, args) = expr {
        if is_aggregate_function(name) {
            let func = name.to_uppercase();
            let arg = args.first().cloned().unwrap_or(Expr::Star);
            if let Some(agg) = aggregates
                .iter()
                .find(|a| a.function == func && a.arg == arg)
            {
                return Expr::Variable(agg.alias.clone());
            }
        }
    }

    // A group-key expression that appears in RETURN -> its produced column.
    if let Some(gk) = group_keys.iter().find(|g| g.expr == *expr) {
        return Expr::Variable(group_key_name(gk));
    }

    // Recurse into compound expressions so combinations resolve too.
    match expr {
        Expr::BinaryOp(l, op, r) => Expr::BinaryOp(
            Box::new(rewrite_order_expr(l, group_keys, aggregates)),
            *op,
            Box::new(rewrite_order_expr(r, group_keys, aggregates)),
        ),
        Expr::And(l, r) => Expr::And(
            Box::new(rewrite_order_expr(l, group_keys, aggregates)),
            Box::new(rewrite_order_expr(r, group_keys, aggregates)),
        ),
        Expr::Or(l, r) => Expr::Or(
            Box::new(rewrite_order_expr(l, group_keys, aggregates)),
            Box::new(rewrite_order_expr(r, group_keys, aggregates)),
        ),
        Expr::Not(inner) => {
            Expr::Not(Box::new(rewrite_order_expr(inner, group_keys, aggregates)))
        }
        other => other.clone(),
    }
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
