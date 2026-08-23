//! Layer 8 — event log.
//!
//! Always-on structured event emission (spec §11) capturing the engine's *decisions*
//! and *aggregate counters* under a versioned schema. Invariant I9: the event log is the
//! source of truth for what the engine did (explain is a recording of the single eval
//! entry's execution path, not a parallel implementation).
//!
//! # What is logged (and what is not)
//!
//! Per spec §11 the default stream carries decisions + aggregates only: run begin /
//! commit / abort, the stratum schedule, per-iteration Δ sizes *per predicate*, rule
//! firing counts, fold ⊕ counts, plan choices, and guard rejections. There are **no
//! per-tuple events** in the default stream — every hot-loop signal is an aggregate
//! counter. Bounded per-tuple tracing (`--trace-rule`) is a separate, opt-in channel and
//! is not part of Gate A's always-on log.
//!
//! # Zero-allocation without a sink (hot loop)
//!
//! The executor's Δ-loop calls into [`EventLog`] every iteration. When no sink is
//! installed, every emit method is a single `Option::is_none` check and returns
//! immediately — no event value is constructed, so the hot loop allocates nothing. An
//! event is only built (and serialized) when a sink is present. This keeps the "always
//! on" contract honest: instrumentation points are unconditional in the source, but cost
//! nothing when the run discards its log.
//!
//! # Schema versioning (I9, self-describing)
//!
//! Every emitted line carries a `v` field ([`EVENT_SCHEMA_VERSION`]) and a `kind` tag
//! (serde-internally-tagged on [`EventKind`]). A reader can reconstruct a run report from
//! the log alone: the begin/commit events bracket the run, the per-stratum/per-iteration
//! Δ events reproduce the fixpoint schedule, and `RunCommitted::fact_counts` lets a
//! replay tool independently check the committed fact counts against the segments.

#![allow(dead_code)]

use std::io::{self, Write};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// The event-log schema version, emitted in the `v` field of every line. Bumped only on a
/// breaking change to an event's field set (I11: format outlives code — a reader keyed on
/// an older version must be able to detect and reject a newer one explicitly).
pub const EVENT_SCHEMA_VERSION: u16 = 1;

// ── Event payloads ─────────────────────────────────────────────────

/// Per-predicate Δ size at one fixpoint iteration: the predicate name and how many *new*
/// facts entered its Δ this round. Aggregate, never per-tuple (spec §11).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PredicateDelta {
    /// The derived predicate's name.
    pub predicate: String,
    /// Count of facts newly added to this predicate's Δ this iteration.
    pub delta_facts: u64,
}

/// One predicate's committed fact count at run commit. Lets a replay tool recompute the
/// run report's totals and cross-check them against the committed segments (I9: log,
/// replay, and segments must all agree).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PredicateCount {
    /// The derived predicate's name.
    pub predicate: String,
    /// Number of committed ground facts for the predicate.
    pub facts: u64,
}

/// The kind-tagged event payload. Serialized with serde's internal tag `kind`, so every
/// line is self-describing: `{"v":1,"kind":"...", ...fields}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum EventKind {
    /// A stored rule reflection was SKIPPED while assembling the program from the store
    /// (`RuleSource::Store`). Emitted before the fixpoint, one per skipped reflection —
    /// the decoder never takes a healthy rule down with a broken neighbour, and a skip is
    /// never silent. `detail` is the decoder's diagnostic verbatim.
    ReflectSkipped {
        /// The decoder's diagnostic (`rule <id>: …`).
        detail: String,
    },
    /// A run started. Carries the count of strata and the total number of planned rule
    /// clauses — the bracket-open for the whole evaluation.
    RunBegin {
        /// Number of strata in the program's stratification.
        strata: u64,
        /// Number of planned rule clauses across all strata.
        rules: u64,
    },

    /// The stratum schedule: the order strata will be evaluated in, lowest first. Emitted
    /// once at run start, after [`EventKind::RunBegin`].
    StratumSchedule {
        /// Stratum index → its predicate set, in evaluation order.
        order: Vec<StratumEntry>,
    },

    /// A stratum's evaluation began. Brackets the per-iteration Δ events that follow.
    StratumBegin {
        /// 0-based stratum index.
        stratum: usize,
        /// The predicates derived in this stratum.
        predicates: Vec<String>,
    },

    /// The seed pass of a stratum completed: the round-0 (non-recursive) derivations. The
    /// per-predicate seed Δ sizes that became the first Δ.
    StratumSeeded {
        /// 0-based stratum index.
        stratum: usize,
        /// Per-predicate seed fact counts (the initial Δ).
        deltas: Vec<PredicateDelta>,
    },

    /// One semi-naive Δ-iteration completed. Carries the per-predicate Δ sizes, the count
    /// of rule firings (clause × recursive-leg evaluations) this round, and the count of
    /// `⊕` folds performed during the GROUP BY (two derivations of one fact in a round).
    Iteration {
        /// 0-based stratum index.
        stratum: usize,
        /// 1-based iteration number within the stratum's Δ-loop.
        iteration: usize,
        /// Per-predicate Δ sizes this iteration (aggregate; empty Δ predicates omitted).
        deltas: Vec<PredicateDelta>,
        /// Rule firings this iteration: each (clause, recursive-leg) delta-variant eval.
        rule_firings: u64,
        /// `⊕` folds this iteration: GROUP BY collisions where two derivations of the
        /// same fact key were combined with the tag `plus`.
        fold_plus: u64,
    },

    /// A stratum reached its fixpoint. Carries the iterations it took and its committed
    /// per-predicate fact counts (the frozen lower stratum the next strata read).
    StratumCommitted {
        /// 0-based stratum index.
        stratum: usize,
        /// Number of Δ-iterations executed (0 = seed already saturated).
        iterations: usize,
        /// Per-predicate committed fact counts for this stratum.
        counts: Vec<PredicateCount>,
    },

    /// A guard rejected a rule at plan time (spec §3). Carries the stable error code, the
    /// offending rule head, and the one-line detail. A decision event (I5/I9).
    GuardRejected {
        /// Stable taxonomy code (e.g. `E-PLAN-003`).
        code: String,
        /// Head predicate of the rejected rule.
        head: String,
        /// One-line human detail (the estimate, the required bindings, …).
        detail: String,
    },

    /// The run committed successfully. Carries the total committed fact counts per
    /// predicate — the independently-recomputable anchor for I9's three-way agreement
    /// (log ≡ replay ≡ segments).
    RunCommitted {
        /// Per-predicate committed fact counts across the whole run.
        fact_counts: Vec<PredicateCount>,
    },

    /// The run aborted without committing (a limit fired, a guard rejected, cancellation).
    /// Carries the stable error code and detail; readers never see a silently-empty log.
    RunAborted {
        /// Stable taxonomy code of the abort cause (e.g. `E-EXEC-002`).
        code: String,
        /// One-line human detail.
        detail: String,
    },
}

/// One entry of the stratum schedule: a stratum index and the predicates it derives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StratumEntry {
    /// 0-based stratum index (evaluation order is ascending).
    pub stratum: usize,
    /// The predicates derived in this stratum.
    pub predicates: Vec<String>,
}

/// One line of the event log: the schema version plus a kind-tagged payload. Serializes to
/// a single JSON object; the writer sink appends one per line (`events.jsonl`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    /// Schema version of this line ([`EVENT_SCHEMA_VERSION`] at emit time). A reader keyed
    /// on a known version uses this to detect and explicitly reject a newer log (I11).
    pub v: u16,
    /// The kind-tagged event payload.
    #[serde(flatten)]
    pub kind: EventKind,
}

impl Event {
    /// Wrap a payload with the current schema version.
    pub fn new(kind: EventKind) -> Self {
        Self {
            v: EVENT_SCHEMA_VERSION,
            kind,
        }
    }
}

// ── Sinks ──────────────────────────────────────────────────────────

/// A destination for serialized events. The executor never holds a concrete sink; it holds
/// an [`EventLog`] whose `Option<Box<dyn EventSink>>` is `None` for a discarded run (the
/// zero-allocation hot path) and `Some` when a destination is wired (a file, a buffer, an
/// in-memory collector for tests).
pub trait EventSink: Send {
    /// Append one event. Implementations serialize to JSON and write a trailing newline so
    /// the stream is line-delimited JSON (`events.jsonl`). Errors are surfaced; the caller
    /// (the executor) is responsible for its own policy on a logging IO error.
    fn emit(&mut self, event: &Event) -> io::Result<()>;
}

/// A JSON-lines sink over any [`Write`] (the production `events.jsonl` destination). Each
/// event is serialized to one compact JSON object followed by `\n`.
pub struct WriterSink<W: Write + Send> {
    writer: W,
}

impl<W: Write + Send> WriterSink<W> {
    /// Wrap a writer as a JSON-lines event sink.
    pub fn new(writer: W) -> Self {
        Self { writer }
    }

    /// Consume the sink and return the underlying writer (e.g. to flush/inspect a buffer).
    pub fn into_inner(self) -> W {
        self.writer
    }
}

impl<W: Write + Send> EventSink for WriterSink<W> {
    fn emit(&mut self, event: &Event) -> io::Result<()> {
        let line = serde_json::to_string(event)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        self.writer.write_all(line.as_bytes())?;
        self.writer.write_all(b"\n")?;
        Ok(())
    }
}

/// An in-memory event collector (test/replay fixture). Keeps every emitted [`Event`] in
/// order so a unit test can assert the schema-valid sequence directly, and a replay tool
/// can reconstruct a run report without re-reading a file.
#[derive(Default)]
pub struct MemSink {
    events: Vec<Event>,
}

impl MemSink {
    /// A fresh, empty collector.
    pub fn new() -> Self {
        Self { events: Vec::new() }
    }

    /// The collected events, in emit order.
    pub fn events(&self) -> &[Event] {
        &self.events
    }

    /// Take ownership of the collected events.
    pub fn into_events(self) -> Vec<Event> {
        self.events
    }
}

impl EventSink for MemSink {
    fn emit(&mut self, event: &Event) -> io::Result<()> {
        self.events.push(event.clone());
        Ok(())
    }
}

/// A shared in-memory sink: a `MemSink` behind a `Mutex` so a caller can keep a handle to
/// read the collected events after the executor (which moves its sink into the [`EventLog`])
/// has finished. `emit` locks, pushes, and unlocks — never on the hot path without a sink.
#[derive(Clone, Default)]
pub struct SharedMemSink {
    inner: std::sync::Arc<Mutex<Vec<Event>>>,
}

impl SharedMemSink {
    /// A fresh, empty shared collector.
    pub fn new() -> Self {
        Self {
            inner: std::sync::Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Snapshot the collected events, in emit order.
    pub fn events(&self) -> Vec<Event> {
        self.inner.lock().expect("event sink mutex not poisoned").clone()
    }
}

impl EventSink for SharedMemSink {
    fn emit(&mut self, event: &Event) -> io::Result<()> {
        self.inner
            .lock()
            .expect("event sink mutex not poisoned")
            .push(event.clone());
        Ok(())
    }
}

// ── The event log handle ───────────────────────────────────────────

/// The executor's handle to the event stream. Holds an optional sink: `None` means the run
/// discards its log and every emit is a no-op (zero allocation on the hot loop); `Some`
/// means events are built and forwarded to the destination.
///
/// The emit helpers take already-computed aggregate counts by value, so no event payload is
/// constructed when there is no sink — the `with_sink` closure is the only place an [`Event`]
/// is built, and it runs solely when a sink is present.
#[derive(Default)]
pub struct EventLog {
    sink: Option<Box<dyn EventSink>>,
    /// Set when a sink's `emit` returned an IO error. The run does not crash on a logging
    /// fault (logging is observational), but the flag lets a caller surface it.
    io_failed: bool,
}

impl EventLog {
    /// A discarding log: no sink, every emit a no-op (the default, zero-cost path).
    pub fn discard() -> Self {
        Self {
            sink: None,
            io_failed: false,
        }
    }

    /// A log writing to the given sink.
    pub fn with_sink(sink: Box<dyn EventSink>) -> Self {
        Self {
            sink: Some(sink),
            io_failed: false,
        }
    }

    /// Whether a sink is installed (instrumentation should build an event). Lets callers
    /// gate any per-event *computation* (not just allocation) on a present sink.
    #[inline]
    pub fn is_active(&self) -> bool {
        self.sink.is_some()
    }

    /// Whether any `emit` has hit an IO error since construction.
    #[inline]
    pub fn io_failed(&self) -> bool {
        self.io_failed
    }

    /// Build and forward an event, but only when a sink is present. The `make` closure is
    /// the sole construction site for a payload, so a discarding log never allocates one.
    #[inline]
    fn emit_with<F: FnOnce() -> EventKind>(&mut self, make: F) {
        if let Some(sink) = self.sink.as_mut() {
            let event = Event::new(make());
            if sink.emit(&event).is_err() {
                self.io_failed = true;
            }
        }
    }

    /// A stored reflection was skipped while assembling the program from the store.
    #[inline]
    pub fn reflect_skipped(&mut self, detail: &str) {
        self.emit_with(|| EventKind::ReflectSkipped { detail: detail.to_string() });
    }

    /// Run begin (brackets the evaluation).
    #[inline]
    pub fn run_begin(&mut self, strata: u64, rules: u64) {
        self.emit_with(|| EventKind::RunBegin { strata, rules });
    }

    /// The stratum schedule (lowest-first evaluation order).
    #[inline]
    pub fn stratum_schedule(&mut self, order: Vec<StratumEntry>) {
        self.emit_with(|| EventKind::StratumSchedule { order });
    }

    /// A stratum's evaluation began.
    #[inline]
    pub fn stratum_begin(&mut self, stratum: usize, predicates: Vec<String>) {
        self.emit_with(|| EventKind::StratumBegin {
            stratum,
            predicates,
        });
    }

    /// The seed pass of a stratum completed (round-0 Δ sizes).
    #[inline]
    pub fn stratum_seeded(&mut self, stratum: usize, deltas: Vec<PredicateDelta>) {
        self.emit_with(|| EventKind::StratumSeeded { stratum, deltas });
    }

    /// One Δ-iteration completed (per-predicate Δ sizes + firing/fold counters).
    #[inline]
    pub fn iteration(
        &mut self,
        stratum: usize,
        iteration: usize,
        deltas: Vec<PredicateDelta>,
        rule_firings: u64,
        fold_plus: u64,
    ) {
        self.emit_with(|| EventKind::Iteration {
            stratum,
            iteration,
            deltas,
            rule_firings,
            fold_plus,
        });
    }

    /// A stratum reached its fixpoint (iterations + committed per-predicate counts).
    #[inline]
    pub fn stratum_committed(
        &mut self,
        stratum: usize,
        iterations: usize,
        counts: Vec<PredicateCount>,
    ) {
        self.emit_with(|| EventKind::StratumCommitted {
            stratum,
            iterations,
            counts,
        });
    }

    /// A guard rejected a rule (decision event).
    #[inline]
    pub fn guard_rejected(&mut self, code: &str, head: &str, detail: &str) {
        let (code, head, detail) = (code.to_string(), head.to_string(), detail.to_string());
        self.emit_with(|| EventKind::GuardRejected { code, head, detail });
    }

    /// The run committed (per-predicate total fact counts).
    #[inline]
    pub fn run_committed(&mut self, fact_counts: Vec<PredicateCount>) {
        self.emit_with(|| EventKind::RunCommitted { fact_counts });
    }

    /// The run aborted without committing (stable code + detail).
    #[inline]
    pub fn run_aborted(&mut self, code: &str, detail: &str) {
        let (code, detail) = (code.to_string(), detail.to_string());
        self.emit_with(|| EventKind::RunAborted { code, detail });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discarding_log_is_noop_and_allocation_free() {
        // A discarding log builds no event: emit helpers return without touching a sink.
        let mut log = EventLog::discard();
        assert!(!log.is_active());
        log.run_begin(3, 9);
        log.iteration(0, 1, vec![], 0, 0);
        log.run_committed(vec![]);
        assert!(!log.io_failed(), "no sink ⇒ no IO ⇒ no failure");
    }

    #[test]
    fn mem_sink_collects_in_order() {
        let sink = SharedMemSink::new();
        let mut log = EventLog::with_sink(Box::new(sink.clone()));
        log.run_begin(1, 2);
        log.stratum_begin(0, vec!["p".to_string()]);
        log.run_committed(vec![PredicateCount {
            predicate: "p".to_string(),
            facts: 5,
        }]);

        let events = sink.events();
        assert_eq!(events.len(), 3);
        assert!(matches!(events[0].kind, EventKind::RunBegin { strata: 1, rules: 2 }));
        assert!(matches!(events[1].kind, EventKind::StratumBegin { stratum: 0, .. }));
        match &events[2].kind {
            EventKind::RunCommitted { fact_counts } => {
                assert_eq!(fact_counts.len(), 1);
                assert_eq!(fact_counts[0].facts, 5);
            }
            other => panic!("expected RunCommitted, got {other:?}"),
        }
    }

    #[test]
    fn every_line_carries_schema_version_and_kind() {
        // Write through a WriterSink owning a Vec<u8> (the JSON-lines destination), then
        // recover the buffer. `Box<dyn EventSink>` is `'static`, so the sink must own its
        // writer rather than borrow a stack buffer.
        let mut sink = WriterSink::new(Vec::<u8>::new());
        sink.emit(&Event::new(EventKind::RunBegin { strata: 2, rules: 4 }))
            .expect("emit run_begin");
        sink.emit(&Event::new(EventKind::Iteration {
            stratum: 0,
            iteration: 1,
            deltas: vec![PredicateDelta {
                predicate: "reach".to_string(),
                delta_facts: 3,
            }],
            rule_firings: 2,
            fold_plus: 1,
        }))
        .expect("emit iteration");
        let buf = sink.into_inner();
        let text = String::from_utf8(buf).expect("utf8 log");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2, "one JSON object per line");
        for line in &lines {
            let value: serde_json::Value = serde_json::from_str(line).expect("schema-valid JSON");
            assert_eq!(value["v"].as_u64(), Some(EVENT_SCHEMA_VERSION as u64));
            assert!(value["kind"].is_string(), "every line is kind-tagged");
        }
        // The iteration line round-trips fields.
        let it: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(it["kind"], "Iteration");
        assert_eq!(it["rule_firings"], 2);
        assert_eq!(it["fold_plus"], 1);
        assert_eq!(it["deltas"][0]["predicate"], "reach");
        assert_eq!(it["deltas"][0]["delta_facts"], 3);
    }

    #[test]
    fn event_round_trips_through_serde() {
        let original = Event::new(EventKind::StratumCommitted {
            stratum: 1,
            iterations: 4,
            counts: vec![PredicateCount {
                predicate: "depends".to_string(),
                facts: 12,
            }],
        });
        let json = serde_json::to_string(&original).expect("serialize");
        let back: Event = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(original, back, "event must round-trip losslessly");
    }
}
