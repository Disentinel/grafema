//! Pull-based Volcano executor for Cypher queries.
//!
//! Each operator implements the `Operator` trait with a single `next()` method
//! that returns one record at a time. Operators form a tree: source operators
//! (NodeScan) produce records, pipe operators (Filter, Project, Expand, Limit)
//! transform them, and blocking operators (Sort, HashAggregate) accumulate
//! all input before yielding output.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use crate::cypher::aggregate::AggAcc;
use crate::cypher::ast::*;
use crate::cypher::values::{CypherValue, Record};
use crate::cypher::CypherError;
use crate::datalog::EvalLimits;
use crate::graph::GraphStore;
use crate::storage::{AttrQuery, EdgeRecord};

// ─── Operator trait ─────────────────────────────────────────────────────────

/// Pull-based operator interface (Volcano model).
/// Each call to `next()` produces one record or signals end-of-stream.
pub trait Operator {
    fn next(&mut self) -> Result<Option<Record>, CypherError>;
}

// ─── LimitState ─────────────────────────────────────────────────────────────

/// Deadline / cancellation / intermediate-result bookkeeping shared by operators.
pub(crate) struct LimitState {
    deadline: Option<Instant>,
    cancelled: Option<Arc<AtomicBool>>,
    max_intermediate: usize,
    intermediate_count: usize,
}

impl LimitState {
    pub fn from_limits(limits: &EvalLimits) -> Self {
        LimitState {
            deadline: limits.deadline,
            cancelled: limits.cancelled.clone(),
            max_intermediate: limits.max_intermediate_results,
            intermediate_count: 0,
        }
    }

    pub fn check(&self) -> Result<(), CypherError> {
        if let Some(deadline) = self.deadline {
            if Instant::now() > deadline {
                return Err(CypherError::Timeout);
            }
        }
        if let Some(ref flag) = self.cancelled {
            if flag.load(Ordering::Relaxed) {
                return Err(CypherError::Cancelled);
            }
        }
        Ok(())
    }

    /// Track an intermediate result and check the cap.
    pub fn track_intermediate(&mut self) -> Result<(), CypherError> {
        self.intermediate_count += 1;
        if self.intermediate_count > self.max_intermediate {
            return Err(CypherError::Execution(format!(
                "Intermediate result limit exceeded ({})",
                self.max_intermediate,
            )));
        }
        Ok(())
    }
}

// ─── NodeScan ───────────────────────────────────────────────────────────────

/// Chunk size for `find_by_attr_chunked` streaming.
const NODE_SCAN_CHUNK_SIZE: usize = 512;

/// Source operator: scans nodes matching a label (node type) and optional
/// inline property filters from the MATCH pattern.
///
/// Uses `find_by_attr_chunked()` for true streaming: loads one chunk of IDs
/// at a time, so that downstream `Limit` can stop the pipeline after k results
/// without materialising the full scan (O(k) not O(N)).
pub struct NodeScan<'a> {
    engine: &'a dyn GraphStore,
    variable: Option<String>,
    labels: Vec<String>,
    properties: Vec<(String, Expr)>,
    /// All remaining IDs collected from chunked scan.
    /// Populated lazily: on first `next()` call we run the chunked scan
    /// and collect ALL chunks into this buffer. True pull-through-callback
    /// streaming is impossible because `find_by_attr_chunked` is synchronous
    /// with a `FnMut` callback, so we can't suspend mid-callback. Instead
    /// we use the chunked API with an early-exit sentinel: if we've already
    /// collected enough to hit `max_intermediate_results`, we stop the scan.
    buffer: Vec<u128>,
    buffer_pos: usize,
    done: bool,
    limits: LimitState,
}

impl<'a> NodeScan<'a> {
    pub fn new(
        engine: &'a dyn GraphStore,
        variable: Option<String>,
        labels: Vec<String>,
        properties: Vec<(String, Expr)>,
        limits: &EvalLimits,
    ) -> Self {
        NodeScan {
            engine,
            variable,
            labels,
            properties,
            buffer: Vec::new(),
            buffer_pos: 0,
            done: false,
            limits: LimitState::from_limits(limits),
        }
    }

    /// Build an AttrQuery from labels and inline properties.
    fn build_query(&self) -> AttrQuery {
        let mut query = AttrQuery::new();
        if !self.labels.is_empty() {
            query = query.node_type(&self.labels[0]);
        }
        // Push down name filter to AttrQuery for index acceleration.
        for (key, expr) in &self.properties {
            if key == "name" {
                if let Expr::Literal(CypherLiteral::Str(s)) = expr {
                    query = query.name(s);
                }
            }
        }
        query
    }

    /// Check if a node matches ALL inline property filters.
    fn matches_properties(&self, value: &CypherValue) -> bool {
        for (key, expr) in &self.properties {
            let prop_val = value.property(key);
            let expected = eval_literal_expr(expr);
            if prop_val != expected {
                return false;
            }
        }
        true
    }

    /// Populate `self.buffer` via chunked scan, respecting intermediate limits.
    fn load_ids(&mut self) {
        let query = self.build_query();
        let max = self.limits.max_intermediate;
        let mut buf = Vec::new();
        self.engine.find_by_attr_chunked(
            &query,
            NODE_SCAN_CHUNK_SIZE,
            &mut |chunk: &[u128]| {
                buf.extend_from_slice(chunk);
                // Stop scanning if we hit the intermediate cap.
                buf.len() < max
            },
        );
        self.buffer = buf;
    }
}

impl<'a> Operator for NodeScan<'a> {
    fn next(&mut self) -> Result<Option<Record>, CypherError> {
        if self.done {
            return Ok(None);
        }

        // Lazy initialisation: load matching IDs via chunked scan.
        if self.buffer.is_empty() && self.buffer_pos == 0 {
            self.limits.check()?;
            self.load_ids();
        }

        loop {
            if self.buffer_pos >= self.buffer.len() {
                self.done = true;
                return Ok(None);
            }

            let id = self.buffer[self.buffer_pos];
            self.buffer_pos += 1;

            // Periodic deadline check (every 1024 nodes).
            if self.buffer_pos % 1024 == 0 {
                self.limits.check()?;
            }

            if let Some(node_rec) = self.engine.get_node(id) {
                let cv = node_record_to_value(&node_rec);

                // Check inline property filters not pushed down to AttrQuery.
                if !self.matches_properties(&cv) {
                    continue;
                }

                self.limits.track_intermediate()?;

                let mut record = Record::new();
                if let Some(ref var) = self.variable {
                    record.insert(var.clone(), cv);
                }
                return Ok(Some(record));
            }
            // Node deleted between find and get — skip.
        }
    }
}

// ─── Expand ─────────────────────────────────────────────────────────────────

/// Pipe operator: for each input record, follows edges of specified types
/// from a source node to target nodes.
pub struct Expand<'a> {
    input: Box<dyn Operator + 'a>,
    engine: &'a dyn GraphStore,
    src_var: String,
    dst_var: Option<String>,
    rel_var: Option<String>,
    rel_types: Vec<String>,
    direction: Direction,
    current_input: Option<Record>,
    edge_buffer: Vec<EdgeRecord>,
    edge_pos: usize,
    limits: LimitState,
}

impl<'a> Expand<'a> {
    pub fn new(
        input: Box<dyn Operator + 'a>,
        engine: &'a dyn GraphStore,
        src_var: String,
        dst_var: Option<String>,
        rel_var: Option<String>,
        rel_types: Vec<String>,
        direction: Direction,
        limits: &EvalLimits,
    ) -> Self {
        Expand {
            input,
            engine,
            src_var,
            dst_var,
            rel_var,
            rel_types,
            direction,
            current_input: None,
            edge_buffer: Vec::new(),
            edge_pos: 0,
            limits: LimitState::from_limits(limits),
        }
    }

    /// Fetch edges for a given node ID according to direction and type filter.
    fn fetch_edges(&self, node_id: u128) -> Vec<EdgeRecord> {
        let type_filter: Option<Vec<&str>> = if self.rel_types.is_empty() {
            None
        } else {
            Some(self.rel_types.iter().map(|s| s.as_str()).collect())
        };
        let filter_ref = type_filter.as_deref();

        match self.direction {
            Direction::Outgoing => self.engine.get_outgoing_edges(node_id, filter_ref),
            Direction::Incoming => self.engine.get_incoming_edges(node_id, filter_ref),
            Direction::Both => {
                let mut edges = self.engine.get_outgoing_edges(node_id, filter_ref);
                edges.extend(self.engine.get_incoming_edges(node_id, filter_ref));
                edges
            }
        }
    }

    /// For a given edge, determine the "other" node ID (the one that is NOT the source).
    fn target_id(&self, edge: &EdgeRecord, src_node_id: u128) -> u128 {
        if edge.src == src_node_id {
            edge.dst
        } else {
            edge.src
        }
    }
}

impl<'a> Operator for Expand<'a> {
    fn next(&mut self) -> Result<Option<Record>, CypherError> {
        loop {
            // Yield buffered edges.
            if let Some(ref input_rec) = self.current_input {
                while self.edge_pos < self.edge_buffer.len() {
                    let edge = &self.edge_buffer[self.edge_pos];
                    self.edge_pos += 1;

                    // Skip deleted edges.
                    if edge.deleted {
                        continue;
                    }

                    let src_node_id = input_rec
                        .get(&self.src_var)
                        .and_then(|v| v.as_node_id())
                        .unwrap_or(0);
                    let target_id = self.target_id(edge, src_node_id);

                    // Repeated-variable constraint: if `dst_var` is already
                    // bound (the pattern reuses this node variable, e.g.
                    // `(a)-[:R]->(a)` or `(m)-[:R1]->(c)-[:R2]->(m)`), the
                    // discovered target must equal the existing binding —
                    // Cypher requires the same variable to denote the same
                    // node. Overwriting it would fabricate rows for
                    // non-existent self-loops/cycles, so skip on mismatch.
                    if let Some(ref dv) = self.dst_var {
                        if let Some(existing) = input_rec.get(dv).and_then(|v| v.as_node_id()) {
                            if existing != target_id {
                                continue;
                            }
                        }
                    }

                    if let Some(target_rec) = self.engine.get_node(target_id) {
                        self.limits.track_intermediate()?;
                        let mut out = input_rec.clone();
                        if let Some(ref dv) = self.dst_var {
                            out.insert(dv.clone(), node_record_to_value(&target_rec));
                        }
                        if let Some(ref rv) = self.rel_var {
                            out.insert(rv.clone(), edge_record_to_value(edge));
                        }
                        return Ok(Some(out));
                    }
                    // Target node missing (deleted) — skip.
                }
                // Buffer exhausted — fall through to pull next input.
            }

            // Pull next input record.
            match self.input.next()? {
                Some(rec) => {
                    self.limits.check()?;
                    let node_id = rec
                        .get(&self.src_var)
                        .and_then(|v| v.as_node_id())
                        .ok_or_else(|| {
                            CypherError::Execution(format!(
                                "variable '{}' is not a node",
                                self.src_var
                            ))
                        })?;
                    self.edge_buffer = self.fetch_edges(node_id);
                    self.edge_pos = 0;
                    self.current_input = Some(rec);
                }
                None => return Ok(None),
            }
        }
    }
}

// ─── VarLengthExpand ────────────────────────────────────────────────────────

/// Pipe operator: BFS traversal with variable-length path `*min..max`.
pub struct VarLengthExpand<'a> {
    input: Box<dyn Operator + 'a>,
    engine: &'a dyn GraphStore,
    src_var: String,
    dst_var: Option<String>,
    rel_types: Vec<String>,
    direction: Direction,
    min_depth: u32,
    max_depth: u32,
    current_input: Option<Record>,
    results: Vec<u128>,
    result_pos: usize,
    limits: LimitState,
}

impl<'a> VarLengthExpand<'a> {
    pub fn new(
        input: Box<dyn Operator + 'a>,
        engine: &'a dyn GraphStore,
        src_var: String,
        dst_var: Option<String>,
        rel_types: Vec<String>,
        direction: Direction,
        min_depth: u32,
        max_depth: u32,
        limits: &EvalLimits,
    ) -> Self {
        VarLengthExpand {
            input,
            engine,
            src_var,
            dst_var,
            rel_types,
            direction,
            min_depth,
            max_depth,
            current_input: None,
            results: Vec::new(),
            result_pos: 0,
            limits: LimitState::from_limits(limits),
        }
    }

    /// BFS from `start_id`, collecting node IDs at depths `[min_depth, max_depth]`.
    fn bfs(&self, start_id: u128) -> Vec<u128> {
        let mut visited = HashSet::new();
        let mut queue: VecDeque<(u128, u32)> = VecDeque::new();
        let mut result = Vec::new();

        visited.insert(start_id);
        queue.push_back((start_id, 0));

        let type_filter: Option<Vec<&str>> = if self.rel_types.is_empty() {
            None
        } else {
            Some(self.rel_types.iter().map(|s| s.as_str()).collect())
        };

        while let Some((node_id, depth)) = queue.pop_front() {
            if depth >= self.min_depth && depth > 0 {
                result.push(node_id);
            }
            if depth >= self.max_depth {
                continue;
            }

            let filter_ref = type_filter.as_deref();
            let edges = match self.direction {
                Direction::Outgoing => self.engine.get_outgoing_edges(node_id, filter_ref),
                Direction::Incoming => self.engine.get_incoming_edges(node_id, filter_ref),
                Direction::Both => {
                    let mut e = self.engine.get_outgoing_edges(node_id, filter_ref);
                    e.extend(self.engine.get_incoming_edges(node_id, filter_ref));
                    e
                }
            };

            for edge in &edges {
                if edge.deleted {
                    continue;
                }
                let next_id = if edge.src == node_id {
                    edge.dst
                } else {
                    edge.src
                };
                if visited.insert(next_id) {
                    queue.push_back((next_id, depth + 1));
                }
            }
        }
        result
    }
}

impl<'a> Operator for VarLengthExpand<'a> {
    fn next(&mut self) -> Result<Option<Record>, CypherError> {
        loop {
            // Yield buffered BFS results.
            if let Some(ref input_rec) = self.current_input {
                while self.result_pos < self.results.len() {
                    let nid = self.results[self.result_pos];
                    self.result_pos += 1;

                    // Repeated-variable constraint (see Expand::next): if
                    // `dst_var` is already bound (e.g. `(a)-[:R*1..2]->(a)`),
                    // a reached node must equal the existing binding rather
                    // than overwrite it. Skip on mismatch to avoid fabricating
                    // rows that rebind the variable to a different node.
                    if let Some(ref dv) = self.dst_var {
                        if let Some(existing) = input_rec.get(dv).and_then(|v| v.as_node_id()) {
                            if existing != nid {
                                continue;
                            }
                        }
                    }

                    if let Some(node_rec) = self.engine.get_node(nid) {
                        self.limits.track_intermediate()?;
                        let mut out = input_rec.clone();
                        if let Some(ref dv) = self.dst_var {
                            out.insert(dv.clone(), node_record_to_value(&node_rec));
                        }
                        return Ok(Some(out));
                    }
                }
            }

            // Pull next input.
            match self.input.next()? {
                Some(rec) => {
                    self.limits.check()?;
                    let node_id = rec
                        .get(&self.src_var)
                        .and_then(|v| v.as_node_id())
                        .ok_or_else(|| {
                            CypherError::Execution(format!(
                                "variable '{}' is not a node",
                                self.src_var
                            ))
                        })?;
                    self.results = self.bfs(node_id);
                    self.result_pos = 0;
                    self.current_input = Some(rec);
                }
                None => return Ok(None),
            }
        }
    }
}

// ─── Filter ─────────────────────────────────────────────────────────────────

/// Pipe operator: evaluates a predicate expression against each record,
/// passes through only records where the predicate is truthy.
pub struct Filter<'a> {
    input: Box<dyn Operator + 'a>,
    predicate: Expr,
}

impl<'a> Filter<'a> {
    pub fn new(input: Box<dyn Operator + 'a>, predicate: Expr) -> Self {
        Filter { input, predicate }
    }
}

impl<'a> Operator for Filter<'a> {
    fn next(&mut self) -> Result<Option<Record>, CypherError> {
        loop {
            match self.input.next()? {
                Some(rec) => {
                    if eval_expr(&self.predicate, &rec).is_truthy() {
                        return Ok(Some(rec));
                    }
                }
                None => return Ok(None),
            }
        }
    }
}

// ─── Project ────────────────────────────────────────────────────────────────

/// Pipe operator: evaluates RETURN expressions and builds a new record
/// with only the requested columns.
pub struct Project<'a> {
    input: Box<dyn Operator + 'a>,
    items: Vec<ReturnItem>,
}

impl<'a> Project<'a> {
    pub fn new(input: Box<dyn Operator + 'a>, items: Vec<ReturnItem>) -> Self {
        Project { input, items }
    }
}

impl<'a> Operator for Project<'a> {
    fn next(&mut self) -> Result<Option<Record>, CypherError> {
        match self.input.next()? {
            Some(rec) => {
                let mut out = Record::new();
                for item in &self.items {
                    let val = eval_expr(&item.expr, &rec);
                    let key = item
                        .alias
                        .clone()
                        .unwrap_or_else(|| format_return_expr(&item.expr));
                    out.insert(key, val);
                }
                Ok(Some(out))
            }
            None => Ok(None),
        }
    }
}

// ─── Limit ──────────────────────────────────────────────────────────────────

/// Pipe operator: returns `None` after `remaining` records have been yielded.
pub struct Limit<'a> {
    input: Box<dyn Operator + 'a>,
    remaining: u64,
}

impl<'a> Limit<'a> {
    pub fn new(input: Box<dyn Operator + 'a>, limit: u64) -> Self {
        Limit {
            input,
            remaining: limit,
        }
    }
}

impl<'a> Operator for Limit<'a> {
    fn next(&mut self) -> Result<Option<Record>, CypherError> {
        if self.remaining == 0 {
            return Ok(None);
        }
        match self.input.next()? {
            Some(rec) => {
                self.remaining -= 1;
                Ok(Some(rec))
            }
            None => Ok(None),
        }
    }
}

// ─── Sort ───────────────────────────────────────────────────────────────────

/// BLOCKING operator: accumulates all input, sorts, then yields from the
/// sorted vector.
pub struct Sort<'a> {
    input: Box<dyn Operator + 'a>,
    order_by: Vec<(Expr, SortDir)>,
    buffer: Option<Vec<Record>>,
    pos: usize,
    limits: LimitState,
}

impl<'a> Sort<'a> {
    pub fn new(input: Box<dyn Operator + 'a>, order_by: Vec<(Expr, SortDir)>, limits: &EvalLimits) -> Self {
        Sort {
            input,
            order_by,
            buffer: None,
            pos: 0,
            limits: LimitState::from_limits(limits),
        }
    }

    /// Accumulate all input records, then sort.
    fn materialize(&mut self) -> Result<(), CypherError> {
        let mut rows = Vec::new();
        while let Some(rec) = self.input.next()? {
            rows.push(rec);
            if rows.len() > self.limits.max_intermediate {
                return Err(CypherError::Execution(format!(
                    "Sort intermediate result limit exceeded ({})",
                    self.limits.max_intermediate,
                )));
            }
        }

        let order_by = &self.order_by;
        rows.sort_by(|a, b| {
            for (expr, dir) in order_by {
                let va = eval_expr(expr, a);
                let vb = eval_expr(expr, b);
                let cmp = order_cmp(&va, &vb);
                let cmp = match dir {
                    SortDir::Asc => cmp,
                    SortDir::Desc => cmp.reverse(),
                };
                if cmp != std::cmp::Ordering::Equal {
                    return cmp;
                }
            }
            std::cmp::Ordering::Equal
        });

        self.buffer = Some(rows);
        Ok(())
    }
}

impl<'a> Operator for Sort<'a> {
    fn next(&mut self) -> Result<Option<Record>, CypherError> {
        if self.buffer.is_none() {
            self.materialize()?;
        }
        let buf = self.buffer.as_ref().unwrap();
        if self.pos < buf.len() {
            let rec = buf[self.pos].clone();
            self.pos += 1;
            Ok(Some(rec))
        } else {
            Ok(None)
        }
    }
}

// ─── HashAggregate ──────────────────────────────────────────────────────────

/// Description of a single aggregate expression (e.g., COUNT(m)).
pub struct AggregateItem {
    pub function: String,
    pub arg: Expr,
    pub alias: String,
}

/// Per-group state accumulated by `HashAggregate`: the group-key column
/// values (name + value pairs) plus one accumulator per aggregate expression.
type GroupState = (Vec<(String, CypherValue)>, Vec<AggAcc>);

/// BLOCKING operator: groups records by non-aggregate RETURN items,
/// computes aggregate functions, then yields result records.
pub struct HashAggregate<'a> {
    input: Box<dyn Operator + 'a>,
    group_keys: Vec<ReturnItem>,
    aggregates: Vec<AggregateItem>,
    result: Option<Vec<Record>>,
    pos: usize,
    limits: LimitState,
}

impl<'a> HashAggregate<'a> {
    pub fn new(
        input: Box<dyn Operator + 'a>,
        group_keys: Vec<ReturnItem>,
        aggregates: Vec<AggregateItem>,
        limits: &EvalLimits,
    ) -> Self {
        HashAggregate {
            input,
            group_keys,
            aggregates,
            result: None,
            pos: 0,
            limits: LimitState::from_limits(limits),
        }
    }

    /// Consume all input, group by keys, compute aggregates.
    fn materialize(&mut self) -> Result<(), CypherError> {
        // Build a template of fresh accumulators, one per aggregate. This
        // validates every function name up front (AggAcc::new errors on an
        // unsupported function) so we fail before consuming input instead of
        // silently returning a count. Each new group clones this template.
        let mut acc_template: Vec<AggAcc> = Vec::with_capacity(self.aggregates.len());
        for agg in &self.aggregates {
            acc_template.push(AggAcc::new(&agg.function)?);
        }

        // group_key_string -> (group_key_values, per-aggregate accumulators)
        let mut groups: HashMap<Vec<String>, GroupState> = HashMap::new();
        // Maintain insertion order for deterministic output.
        let mut order: Vec<Vec<String>> = Vec::new();

        let mut input_count: usize = 0;
        while let Some(rec) = self.input.next()? {
            input_count += 1;
            if input_count > self.limits.max_intermediate {
                return Err(CypherError::Execution(format!(
                    "Aggregate intermediate result limit exceeded ({})",
                    self.limits.max_intermediate,
                )));
            }
            // Compute group key.
            let mut key_strings = Vec::with_capacity(self.group_keys.len());
            let mut key_values = Vec::with_capacity(self.group_keys.len());
            for gk in &self.group_keys {
                let val = eval_expr(&gk.expr, &rec);
                let key_str = value_to_group_key(&val);
                let col_name = gk
                    .alias
                    .clone()
                    .unwrap_or_else(|| format_return_expr(&gk.expr));
                key_strings.push(key_str);
                key_values.push((col_name, val));
            }

            let entry = groups.entry(key_strings.clone());
            let accs = &mut entry
                .or_insert_with(|| {
                    order.push(key_strings.clone());
                    (key_values, acc_template.clone())
                })
                .1;

            // Fold this row into each aggregate accumulator.
            for (i, agg) in self.aggregates.iter().enumerate() {
                let is_star = matches!(agg.arg, Expr::Star);
                let value = if is_star {
                    CypherValue::Null
                } else {
                    eval_expr(&agg.arg, &rec)
                };
                accs[i].update(&value, is_star)?;
            }
        }

        // Build result records in insertion order.
        let mut result = Vec::with_capacity(order.len());

        // Edge case: pure aggregation with no group keys and no input rows.
        // Finalize the empty template so each function returns its identity
        // (COUNT/SUM -> 0, AVG/MIN/MAX -> NULL).
        if order.is_empty() && self.group_keys.is_empty() && !self.aggregates.is_empty() {
            let mut rec = Record::new();
            for (agg, acc) in self.aggregates.iter().zip(acc_template) {
                rec.insert(agg.alias.clone(), acc.finalize());
            }
            result.push(rec);
        } else {
            for key_strings in &order {
                let (key_values, accs) = groups.remove(key_strings).unwrap();
                let mut rec = Record::new();

                // Group key columns.
                for (col_name, val) in key_values {
                    rec.insert(col_name, val);
                }

                // Aggregate columns.
                for (agg, acc) in self.aggregates.iter().zip(accs) {
                    rec.insert(agg.alias.clone(), acc.finalize());
                }

                result.push(rec);
            }
        }

        self.result = Some(result);
        Ok(())
    }
}

impl<'a> Operator for HashAggregate<'a> {
    fn next(&mut self) -> Result<Option<Record>, CypherError> {
        if self.result.is_none() {
            self.materialize()?;
        }
        let buf = self.result.as_ref().unwrap();
        if self.pos < buf.len() {
            let rec = buf[self.pos].clone();
            self.pos += 1;
            Ok(Some(rec))
        } else {
            Ok(None)
        }
    }
}

// ─── eval_expr ──────────────────────────────────────────────────────────────

/// Evaluate an expression against a record, producing a CypherValue.
///
/// This is the core expression evaluator used by Filter, Project, Sort,
/// and HashAggregate operators.
pub fn eval_expr(expr: &Expr, record: &Record) -> CypherValue {
    match expr {
        Expr::Property(var, prop) => record
            .get(var)
            .map(|v| v.property(prop))
            .unwrap_or(CypherValue::Null),

        Expr::Literal(lit) => literal_to_value(lit),

        Expr::Variable(var) => record.get(var).cloned().unwrap_or(CypherValue::Null),

        Expr::BinaryOp(lhs, op, rhs) => {
            let l = eval_expr(lhs, record);
            let r = eval_expr(rhs, record);
            eval_binop(&l, *op, &r)
        }

        Expr::And(lhs, rhs) => {
            // Kleene three-valued AND. FALSE dominates (short-circuits even past a
            // NULL operand: `null AND false = false`); otherwise NULL is contagious
            // (`true AND null = null`, `null AND true = null`). Collapsing a NULL
            // operand to `Bool(false)` here would be wrong under `NOT`: it makes
            // `NOT (null AND true)` become `NOT false = true`, wrongly admitting a
            // row whose predicate is unknown. See `Expr::Not` below for the
            // complementary NULL-preserving rule. Non-NULL operands fall through
            // `kleene_truth` to `is_truthy()`, so their behaviour is unchanged.
            let l = kleene_truth(&eval_expr(lhs, record));
            if l == Some(false) {
                return CypherValue::Bool(false);
            }
            let r = kleene_truth(&eval_expr(rhs, record));
            kleene_value(match (l, r) {
                (_, Some(false)) => Some(false),
                (Some(true), Some(true)) => Some(true),
                _ => None,
            })
        }

        Expr::Or(lhs, rhs) => {
            // Kleene three-valued OR. TRUE dominates (`null OR true = true`);
            // otherwise NULL is contagious (`null OR false = null`, `false OR
            // null = null`). As with AND, collapsing a NULL operand to
            // `Bool(false)` would wrongly admit rows under `NOT`.
            let l = kleene_truth(&eval_expr(lhs, record));
            if l == Some(true) {
                return CypherValue::Bool(true);
            }
            let r = kleene_truth(&eval_expr(rhs, record));
            kleene_value(match (l, r) {
                (_, Some(true)) => Some(true),
                (Some(false), Some(false)) => Some(false),
                _ => None,
            })
        }

        Expr::Not(inner) => {
            // Three-valued logic: NOT NULL is NULL, not TRUE. Without this, a
            // predicate that evaluates to NULL (e.g. a string predicate against
            // an absent property) would be flipped to a definite TRUE and
            // wrongly admit the row in `WHERE NOT ...`.
            let v = eval_expr(inner, record);
            match v {
                CypherValue::Null => CypherValue::Null,
                _ => CypherValue::Bool(!v.is_truthy()),
            }
        }

        Expr::Contains(lhs, rhs) => {
            let l = eval_expr(lhs, record);
            let r = eval_expr(rhs, record);
            eval_string_predicate(l, r, |a, b| a.contains(b))
        }

        Expr::StartsWith(lhs, rhs) => {
            let l = eval_expr(lhs, record);
            let r = eval_expr(rhs, record);
            eval_string_predicate(l, r, |a, b| a.starts_with(b))
        }

        Expr::EndsWith(lhs, rhs) => {
            let l = eval_expr(lhs, record);
            let r = eval_expr(rhs, record);
            eval_string_predicate(l, r, |a, b| a.ends_with(b))
        }

        Expr::IsNull(inner) => {
            let v = eval_expr(inner, record);
            CypherValue::Bool(matches!(v, CypherValue::Null))
        }

        Expr::IsNotNull(inner) => {
            let v = eval_expr(inner, record);
            CypherValue::Bool(!matches!(v, CypherValue::Null))
        }

        Expr::FunctionCall(name, _args) => {
            // Aggregation functions are handled by HashAggregate.
            // Here we handle scalar function evaluation (pass-through for aggregates
            // since they will already have been resolved by the aggregate operator).
            match name.to_uppercase().as_str() {
                "COUNT" => {
                    // If we reach here outside of HashAggregate, return Null.
                    CypherValue::Null
                }
                _ => CypherValue::Null,
            }
        }

        Expr::Star => CypherValue::Null,
    }
}

// ─── Helper functions ───────────────────────────────────────────────────────

/// Ordering comparator for `ORDER BY`, applied in the *ascending* direction
/// (callers reverse it for `DESC`).
///
/// Implements Cypher/Neo4j ordering semantics for NULL: a null value is
/// considered **greater than** any non-null value, so it sorts LAST under
/// ascending order and FIRST under descending order (see the Neo4j Cypher
/// manual, "Ordering null"). This deliberately differs from
/// [`CypherValue::partial_cmp_values`], which treats null as the smallest
/// value — that comparator is shared with WHERE-clause comparisons
/// (`eval_binop`) and must not change. ORDER BY needs its own null rule, so
/// it lives here rather than in the shared value comparator.
///
/// Non-null, mutually-incomparable values (e.g. a Str vs an Int, or two
/// Node values) fall back to `Ordering::Equal`, preserving the prior
/// best-effort behaviour for heterogeneous columns.
fn order_cmp(a: &CypherValue, b: &CypherValue) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match (a, b) {
        (CypherValue::Null, CypherValue::Null) => Ordering::Equal,
        // null is greater than any non-null value -> sorts last ascending.
        (CypherValue::Null, _) => Ordering::Greater,
        (_, CypherValue::Null) => Ordering::Less,
        _ => a.partial_cmp_values(b).unwrap_or(Ordering::Equal),
    }
}

/// Evaluate a Cypher string predicate (CONTAINS / STARTS WITH / ENDS WITH)
/// over already-evaluated operands, applying three-valued logic.
///
/// Semantics (matching Neo4j):
/// - if EITHER operand is NULL, the result is NULL (so that `NOT pred` stays
///   NULL and the row is excluded, rather than being flipped to a definite
///   TRUE and wrongly admitted);
/// - if both operands are strings, return `Bool(test(a, b))`;
/// - any other (non-NULL, non-string) combination yields `Bool(false)`,
///   preserving the engine's prior behavior for type mismatches.
fn eval_string_predicate(
    lhs: CypherValue,
    rhs: CypherValue,
    test: impl Fn(&str, &str) -> bool,
) -> CypherValue {
    if matches!(lhs, CypherValue::Null) || matches!(rhs, CypherValue::Null) {
        return CypherValue::Null;
    }
    match (&lhs, &rhs) {
        (CypherValue::Str(a), CypherValue::Str(b)) => CypherValue::Bool(test(a, b)),
        _ => CypherValue::Bool(false),
    }
}

/// Convert a CypherLiteral to a CypherValue.
fn literal_to_value(lit: &CypherLiteral) -> CypherValue {
    match lit {
        CypherLiteral::Str(s) => CypherValue::Str(s.clone()),
        CypherLiteral::Int(i) => CypherValue::Int(*i),
        CypherLiteral::Float(f) => CypherValue::Float(*f),
        CypherLiteral::Bool(b) => CypherValue::Bool(*b),
        CypherLiteral::Null => CypherValue::Null,
    }
}

/// Evaluate a literal expression (used for inline property matching).
fn eval_literal_expr(expr: &Expr) -> CypherValue {
    match expr {
        Expr::Literal(lit) => literal_to_value(lit),
        _ => CypherValue::Null,
    }
}

/// Evaluate a binary comparison operator.
///
/// Follows Cypher three-valued logic: a comparison where either operand is NULL
/// evaluates to NULL (unknown), never to a definite boolean. This matters in a
/// `WHERE` clause — a NULL predicate is not truthy, so the row is excluded. Without
/// this guard the ordering operators delegated to `partial_cmp_values`, which orders
/// NULL as Less-than-everything (so `null < x` was `true`), and `Neq` returned `true`
/// for `null <> x` — both wrongly admitting rows whose compared property is absent.
fn eval_binop(l: &CypherValue, op: BinOp, r: &CypherValue) -> CypherValue {
    if matches!(l, CypherValue::Null) || matches!(r, CypherValue::Null) {
        return CypherValue::Null;
    }
    match op {
        BinOp::Eq => CypherValue::Bool(l == r),
        BinOp::Neq => CypherValue::Bool(l != r),
        // Ordering operators follow three-valued logic for INCOMPARABLE operands.
        // `partial_cmp_values` returns `None` when the two non-NULL operands cannot
        // be ordered against each other (e.g. String vs Int, Bool vs number, Node,
        // or a NaN float). Per Cypher/Neo4j this is UNKNOWN → NULL, not a definite
        // `false`: a previous `.unwrap_or(false)` here meant `NOT (Str < Int)`
        // flipped to a definite `true` and wrongly admitted the row in `WHERE`.
        // (NULL operands are already short-circuited to NULL at the top of this fn,
        // so they never reach `partial_cmp_values`; this guard covers only the
        // non-NULL-but-incomparable case — the sibling of #341/#348/#352.)
        BinOp::Lt | BinOp::Gt | BinOp::Lte | BinOp::Gte => match l.partial_cmp_values(r) {
            Some(ord) => CypherValue::Bool(match op {
                BinOp::Lt => ord == std::cmp::Ordering::Less,
                BinOp::Gt => ord == std::cmp::Ordering::Greater,
                BinOp::Lte => ord != std::cmp::Ordering::Greater,
                BinOp::Gte => ord != std::cmp::Ordering::Less,
                _ => unreachable!("outer arm restricts op to ordering comparisons"),
            }),
            None => CypherValue::Null,
        },
    }
}

/// Classify a Cypher value for Kleene (three-valued) boolean logic.
///
/// Returns `None` for NULL (the UNKNOWN truth value) and `Some(bool)` for any
/// definite value, reusing `is_truthy()` so non-NULL operands keep the engine's
/// existing loose truthiness (e.g. `Int(0)` → `Some(false)`). Used by the `AND`
/// and `OR` arms of `eval_expr` so a NULL operand propagates as NULL instead of
/// collapsing to a definite boolean (which is wrong under `NOT`).
fn kleene_truth(v: &CypherValue) -> Option<bool> {
    match v {
        CypherValue::Null => None,
        other => Some(other.is_truthy()),
    }
}

/// Reconstruct a Cypher value from a Kleene truth: `None` → NULL, `Some(b)` →
/// `Bool(b)`. Inverse of `kleene_truth` for the definite cases.
fn kleene_value(t: Option<bool>) -> CypherValue {
    match t {
        Some(b) => CypherValue::Bool(b),
        None => CypherValue::Null,
    }
}

/// Convert a NodeRecord into a CypherValue::Node.
fn node_record_to_value(rec: &crate::storage::NodeRecord) -> CypherValue {
    CypherValue::Node {
        id: rec.id,
        node_type: rec.node_type.clone().unwrap_or_default(),
        name: rec.name.clone().unwrap_or_default(),
        file: rec.file.clone().unwrap_or_default(),
        metadata: rec.metadata.clone(),
        semantic_id: rec.semantic_id.clone(),
        exported: rec.exported,
    }
}

/// Convert an EdgeRecord into a CypherValue (represented as a Node-like structure
/// with edge-specific fields stored in a map).
fn edge_record_to_value(edge: &EdgeRecord) -> CypherValue {
    // Represent a relationship as a map-like structure. For now, use
    // a Node variant with edge_type as the "name" and metadata forwarded.
    // This is a pragmatic choice — a dedicated Relationship variant can be
    // added later if needed.
    CypherValue::Node {
        id: 0, // Edges don't have a single ID; use 0 as sentinel.
        node_type: edge.edge_type.clone().unwrap_or_default(),
        name: edge.edge_type.clone().unwrap_or_default(),
        file: String::new(),
        metadata: edge.metadata.clone(),
        semantic_id: None,
        exported: false,
    }
}

/// Format a RETURN expression as a column name.
///
/// `pub(crate)` so the planner can reconstruct the exact group-key column names
/// produced by `HashAggregate` when rewriting `ORDER BY` expressions (an
/// aggregate query sorts over these produced columns, not the raw pattern).
pub(crate) fn format_return_expr(expr: &Expr) -> String {
    match expr {
        Expr::Property(var, prop) => format!("{}.{}", var, prop),
        Expr::Variable(v) => v.clone(),
        Expr::FunctionCall(name, _) => name.clone(),
        Expr::Star => "*".to_string(),
        _ => "?".to_string(),
    }
}

/// Convert a CypherValue into a `GROUP BY` bucket key for HashAggregate.
///
/// Two values must map to the SAME key iff they are equal under
/// `CypherValue`'s `PartialEq` (the relation `GROUP BY` groups on). The first
/// character is a per-type discriminant, so values of different types can never
/// collide even when they render to the same text — `Int(5)` (`"#5"`),
/// `Str("5")` (`"S5"`), `Bool(true)` (`"Btrue"`) and `Null` (`"N"`) are all
/// distinct buckets. `Int` and `Float` deliberately share the `#` numeric
/// namespace because `Int(5) == Float(5.0)` holds (`values.rs` PartialEq), so
/// `5` and `5.0` must group together — and they do, since `5.0_f64` renders to
/// `"5"`. Without the discriminant a bare `to_string()` silently merged
/// distinct-typed values (e.g. `Int(5)` with `Str("5")`) into one group.
fn value_to_group_key(val: &CypherValue) -> String {
    match val {
        CypherValue::Null => "N".to_string(),
        CypherValue::Bool(b) => format!("B{b}"),
        CypherValue::Int(i) => format!("#{i}"),
        CypherValue::Float(f) => format!("#{f}"),
        CypherValue::Str(s) => format!("S{s}"),
        CypherValue::Node { id, .. } => format!("@{id}"),
    }
}
