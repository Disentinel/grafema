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
        // Sort before Project (operates on full node records). ORDER BY may
        // reference a RETURN alias (e.g. `RETURN n.name AS nm ORDER BY nm`),
        // but alias columns are not materialised until Project runs afterwards.
        // Rewrite alias references to the underlying RETURN expression so Sort
        // can evaluate them against the full pattern record.
        if let Some(ref order_by) = query.order_by {
            let order_by = rewrite_order_by_aliases(order_by, &query.return_clause);
            op = Box::new(Sort::new(op, order_by, limits));
        }

        op = Box::new(Project::new(op, query.return_clause.items.clone()));
    }

    // Limit is always last.
    if let Some(limit) = query.limit {
        op = Box::new(Limit::new(op, limit));
    }

    Ok(op)
}

/// Expand a `RETURN *` wildcard into one explicit return item per variable bound
/// by the MATCH pattern, in pattern-declaration order.
///
/// `RETURN *` is a core Cypher idiom — "give me every variable in scope". The
/// parser produces it as a top-level [`Expr::Star`] return item (distinct from
/// `count(*)`, where the `Star` is nested inside a [`Expr::FunctionCall`]'s
/// arguments and is therefore left untouched here). Without expansion the
/// executor's `eval_expr` evaluates a bare `Expr::Star` to `NULL`, so the query
/// silently returns a single column literally named `*` holding `NULL` instead
/// of the bound nodes/relationships — an on-thesis silent-wrong-answer.
///
/// This MUST run before both the planner and the column-name derivation in
/// `execute`, so that the operator tree and the result header agree on the
/// expanded set of columns.
///
/// Behaviour:
/// - The wildcard expands to the pattern's **named** variables only — the start
///   node, then for each segment its relationship variable (if named) followed
///   by its destination node variable (if named) — preserving declaration order
///   and de-duplicating. Anonymous pattern elements (`()`, `-[:T]->`) contribute
///   nothing, mirroring Cypher (they are not in scope).
/// - `RETURN *` with **no** named variable in the pattern is an error (nothing to
///   project), rather than a confidently-empty/NULL result.
/// - `RETURN * AS x` is rejected: aliasing the wildcard is not valid Cypher.
/// - Non-wildcard return items (including `count(*)`) are passed through
///   unchanged, so `RETURN *, count(x)` expands the `*` and keeps the aggregate.
pub fn expand_return_star(query: &mut CypherQuery) -> Result<(), CypherError> {
    // Fast path: nothing to do unless a top-level `*` return item is present.
    let has_star = query
        .return_clause
        .items
        .iter()
        .any(|item| matches!(item.expr, Expr::Star));
    if !has_star {
        return Ok(());
    }

    // Collect named variables in pattern-declaration order, de-duplicated.
    let pattern = &query.match_clause.pattern;
    let mut named: Vec<String> = Vec::new();
    let mut push_unique = |v: &Option<String>, named: &mut Vec<String>| {
        if let Some(name) = v {
            if !named.iter().any(|n| n == name) {
                named.push(name.clone());
            }
        }
    };
    push_unique(&pattern.start.variable, &mut named);
    for (rel, node) in &pattern.segments {
        push_unique(&rel.variable, &mut named);
        push_unique(&node.variable, &mut named);
    }

    let mut expanded: Vec<ReturnItem> = Vec::with_capacity(query.return_clause.items.len());
    for item in &query.return_clause.items {
        if matches!(item.expr, Expr::Star) {
            if item.alias.is_some() {
                return Err(CypherError::Plan(
                    "RETURN * cannot be aliased (`RETURN * AS ...` is invalid)".to_string(),
                ));
            }
            if named.is_empty() {
                return Err(CypherError::Plan(
                    "RETURN * requires at least one named variable in the MATCH pattern".to_string(),
                ));
            }
            for var in &named {
                expanded.push(ReturnItem {
                    expr: Expr::Variable(var.clone()),
                    // Alias to the variable name so the column header is `n`, not
                    // the formatted expression — matching `RETURN n`.
                    alias: Some(var.clone()),
                });
            }
        } else {
            expanded.push(item.clone());
        }
    }

    query.return_clause.items = expanded;
    Ok(())
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

/// Rewrite ORDER BY terms that reference a RETURN alias to the underlying
/// RETURN expression, for the non-aggregate query path.
///
/// Here the `Sort` operator runs *before* `Project`, so it sees the raw pattern
/// bindings (e.g. node `n`) but none of the RETURN-clause aliases, which
/// `Project` materialises afterwards. An `ORDER BY <alias>` term is parsed as
/// `Variable(alias)`; without this rewrite `eval_expr` looks up an absent
/// variable, yields `NULL` for every row, and the result silently falls back to
/// scan order (the ORDER BY no-ops). Mapping each such `Variable(alias)` back to
/// the aliased expression lets `Sort` evaluate it against the full record.
///
/// Terms that match no alias — a raw property, or a variable that is a real
/// pattern binding — are left unchanged.
fn rewrite_order_by_aliases(
    order_by: &[(Expr, SortDir)],
    ret: &ReturnClause,
) -> Vec<(Expr, SortDir)> {
    order_by
        .iter()
        .map(|(expr, dir)| (rewrite_alias_expr(expr, ret), *dir))
        .collect()
}

/// Recursively replace a `Variable(alias)` reference with the expression the
/// matching aliased RETURN item projects. See [`rewrite_order_by_aliases`].
///
/// The substituted expression is returned as-is (not re-rewritten): RETURN
/// expressions are pattern-scoped and cannot reference other aliases, so a
/// single substitution suffices and self-aliases (`RETURN n AS n`) cannot loop.
fn rewrite_alias_expr(expr: &Expr, ret: &ReturnClause) -> Expr {
    if let Expr::Variable(name) = expr {
        if let Some(item) = ret
            .items
            .iter()
            .find(|it| it.alias.as_deref() == Some(name.as_str()))
        {
            return item.expr.clone();
        }
    }

    match expr {
        Expr::BinaryOp(l, op, r) => Expr::BinaryOp(
            Box::new(rewrite_alias_expr(l, ret)),
            *op,
            Box::new(rewrite_alias_expr(r, ret)),
        ),
        Expr::And(l, r) => Expr::And(
            Box::new(rewrite_alias_expr(l, ret)),
            Box::new(rewrite_alias_expr(r, ret)),
        ),
        Expr::Or(l, r) => Expr::Or(
            Box::new(rewrite_alias_expr(l, ret)),
            Box::new(rewrite_alias_expr(r, ret)),
        ),
        Expr::Not(inner) => Expr::Not(Box::new(rewrite_alias_expr(inner, ret))),
        other => other.clone(),
    }
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
