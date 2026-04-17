
============================================================
## ERLANG_OTP (4120 chars)
============================================================

## Ichi Runtime — Erlang/OTP Architecture

**Supervision Tree as the Skeleton.** The entire system is one OTP application with a root supervisor `kami_sup` using `one_for_one` — child crashes are isolated by default. The tree has four arms: `clock_sup` (scheduling), `io_sup` (inbox watcher + Telegram poller/sender, `rest_for_one` — if the poller dies, the sender restarts too since ordering matters), `claude_sup` (`one_for_all` — budget_server and session_pool are tightly coupled; if the budget crashes, you want the session pool dead too so it stops making unbilled calls), and `effort_sup` (`simple_one_for_one` — a dynamic factory spawning one `gen_server` per active effort/project). Underneath sits `health_sup` with a `watchdog` gen_server that calls `erlang:monitor/2` on every sibling and grandchild at startup. The tree encodes your fault tolerance *semantically*, not procedurally.

**Let It Crash for Fast Recovery.** `inbox_processor` is a plain gen_server that pattern-matches on message format. Malformed message → no match → process crashes → supervisor restarts in milliseconds → next message is picked up. There's no `try/catch` wrapping the handler — the crash *is* the error handling. Budget state lives in DETS (on-disk ETS), not the gen_server's state tuple, so it survives the server crashing and restarting with no data loss. Each `effort_worker` writes its current plan and session context to a project-local file on every `handle_cast({update_state, ...})` — on restart it calls `init/1`, reads the file, and continues from the last checkpoint. State recovery is structural, not bolted on.

**Proactivity via `send_after` + Priority Queues.** `kami_clock` is a gen_server with an internal `gb_sets`-backed priority queue of `{unix_timestamp, action}` entries. In `handle_info(timeout, State)` it fires the next due action — wakeup, reflection trigger, stale-effort nudge — and reschedules with `erlang:send_after(NextMs, self(), timeout)`. This gives millisecond scheduling without a cron daemon. When the clock detects idle (queue empty, no active efforts, inbox silent for N minutes), it sends `{tick, idle}` to a randomly chosen effort_worker or spawns a reflection session. The agent never blocks waiting for external commands; it runs on internal clock messages.

**Budget as a Token Bucket gen_statem.** `budget_server` is a `gen_statem` with states `{normal, throttled, exhausted}`. Every API caller — no matter which effort worker — calls `budget_server:acquire(EstimatedTokens)` *synchronously*; the calling process simply blocks. In `normal` state, the server decrements its token count and replies immediately — fast path, zero overhead. In `throttled` (rate-limit hit), incoming `acquire` calls are queued in the state data as `{From, Tokens}` pairs; when `retry_after` timer fires via `send_after`, the state machine transitions back to `normal` and flushes the queue in order. In `exhausted` (daily budget 50% consumed), the server replies `{error, budget_exhausted}` and logs to `enox-measurements.jsonl`. Callers pattern-match on that and park themselves rather than spinning.

**Safety via the Approval Gate Process.** Irreversible actions (git push, file delete, API calls to external services) are never called directly. Any process that wants to perform one spawns a temporary `approval_gate` gen_server, passing the action as a term. The gate sends the action description to Telegram, registers itself with a `{action_id, pid}` entry in a named ETS table, and enters a `waiting_approval` state with a 30-minute timeout via `send_after`. When the human replies, the Telegram poller looks up the action_id in ETS, sends `{approved, action_id}` or `{rejected, action_id}` to the gate's pid directly — no polling. On timeout, the gate process crashes intentionally (`exit(timeout)`); its supervisor does *not* restart it (`temporary` child spec), so the action is silently discarded and logged. An entire class of safety bugs becomes structurally impossible: you can't accidentally execute an unapproved action because the only process holding the action reference has died.


============================================================
## RUST_OWNERSHIP (3662 chars)
============================================================

**Ownership as the process topology.** Each subsystem owns its state exclusively — there is no shared mutable god-object. The `Supervisor` is the root owner: it holds a `Vec<JoinHandle<Result<!, FatalError>>>` of child tasks and is the only thing that can restart them. The `SessionExecutor` takes ownership of a `TaskContext` (inbox item + budget slice + session token) when it fires — the original queue slot is consumed, so double-execution is structurally impossible. State transitions go through a single-writer `IchiState` enum: `Sleeping | Waking | Active(SessionContext) | Cooling { until: Instant }`. The `&mut IchiState` token is passed exactly one place at a time. No two subsystems can be "in charge" simultaneously — the type system enforces it.

**Result<T,E> as the nervous system.** Every boundary returns a typed error, never panics. The API layer distinguishes `ApiError::RateLimit(RetryAfter)` from `ApiError::AuthExpired` from `ApiError::Timeout` — the supervisor pattern-matches on variants and takes different recovery paths: exponential backoff, token refresh, or immediate Telegram alert respectively. The `?` operator propagates errors up the call stack; the supervisor is the terminal handler — analogous to `main()` being the last place `unwrap()` is acceptable. Silent failures are illegal: any `Err` that isn't explicitly handled at the supervisor causes a structured shutdown with a logged postmortem, never a silent drop.

**Lifetimes as resource scopes — the budget and session model.** A `BudgetGuard<'session>` is issued at wake-time, holding a reserved token slice. It implements `Drop`: when the session ends (normally or via panic unwind), the guard writes the actual spend to `usage.jsonl` before releasing. The Claude API client holds a `ConnectionLease` with a lifetime tied to the auth token's expiry — the compiler refuses to use it past that point. This means budget accounting and connection cleanup are *guaranteed by construction*, not by "remembering to call cleanup." The session's `Lifetime` bounds all borrows of `.kami/state.md` — no subprocess can hold a stale reference to state that was already flushed to disk.

**`tokio::select!` as the fast feedback loop.** The executor runs a racing combinator: `select! { result = claude_api_call() => ..., _ = budget_monitor.limit_reached() => Err(BudgetExhausted), _ = human_interrupt_rx.recv() => Err(HumanAbort), _ = timeout(MAX_TURNS_DEADLINE) => Err(TurnsExceeded) }`. No polling, no sleep loops — pure event-driven wakeup. Telegram responses arrive on an `mpsc` channel; the executor can `recv()` them mid-session without blocking the main loop. The feedback cycle is: propose action → write to `.kami/questions/` → Telegram bot detects inotify event → delivers to human → response arrives on channel → executor continues. End-to-end latency is bounded by network RTT, not by any polling interval.

**`unsafe` boundaries are the external world.** Telegram payloads, Claude API responses, and file contents are the `unsafe` blocks — unverified foreign data. They get parsed at the boundary into owned, validated types (`InboxMessage`, `ApiResponse`, `SessionState`) immediately. Everything inside the boundary is safe Rust: algebraic types, no nulls, exhaustive matches. The Telegram bridge is the only place raw JSON is touched; past that point, the rest of the system operates on `Message { from: UserId, body: MessageBody, timestamp: Utc }` — a type that cannot represent malformed input. This is the zero-cost abstraction principle applied to security: the validation overhead is paid once at ingress, and the compiler proves it cannot be bypassed downstream.


============================================================
## GO_GOROUTINES (3834 chars)
============================================================

**Core: one Runtime, typed channels, no shared state.**

The `Runtime` struct holds a root `context.Context` (cancelled on SIGTERM/SIGINT) and owns a single buffered `chan Event` — the system's nervous system. Every goroutine is started under a `supervise()` wrapper: if it returns an error and the root context is still alive, it logs and restarts after a backoff. No panics propagate up, no goroutine is ever "fire and forget" without a supervisor. The supervisor itself is the only `go func()` called directly from `main`. This gives Erlang-style crash isolation with zero framework overhead — just a `for { err := fn(ctx); if ctx.Err() != nil { return }; sleep(backoff) }` loop.

**Triggers → EventBus → Decision loop — the proactivity engine.**

Three goroutines feed `chan Event`: a cron ticker (8:00 EEST wake, periodic reflection intervals), an `fsnotify` watcher on `.kami/inbox/` and `.kami/questions/answered/` (new file = immediate event, sub-second latency), and a Telegram poller (long-poll with 30s timeout, turns incoming messages into events). The decision loop is a single goroutine with a `select` on the event channel and a `time.Ticker` for heartbeat. It calls Claude API via a request-reply channel pattern: `req := Request{Prompt: ..., ReplyCh: make(chan Response, 1)}; claudeCh <- req; resp := <-req.ReplyCh`. The Claude client goroutine owns rate-limit state — no mutexes, just one goroutine reading from `claudeCh` and tracking token bucket state internally.

**Safety gate as a typed discriminated union.**

Every `Action` carries a `Kind` field: `Reversible | RequiresApproval | Autonomous`. Reversible actions (write file, append log, git add/commit) go straight to the Executor goroutine. `RequiresApproval` actions get a UUID, are stored in `map[string]PendingAction` owned by the SafetyGate goroutine, and trigger a Telegram message with approve/reject buttons. Telegram callback query events route back through `chan ApprovalResult` — the SafetyGate's `select` wakes immediately, finds the pending action by ID, and either executes or discards it. Approvals time out after 30 minutes via `time.AfterFunc` sending a timeout result on the same channel. No approval is ever silently dropped.

**Self-monitoring as a first-class goroutine, not an afterthought.**

A `MetricsCollector` goroutine receives `Metric{Name, Value, At}` on `chan Metric` from every other goroutine (Claude calls log token counts, executor logs action durations, Telegram logs message counts). It periodically flushes to `.kami/budget/usage.jsonl` via `os.OpenFile` with `O_APPEND`. A `HealthProbe` goroutine runs every 60s: writes a `.kami/heartbeat.json` with current goroutine count, budget consumed, and last-event timestamp. If budget crosses 80% of the daily limit, it emits a `BudgetWarningEvent` into the main event channel — the decision loop handles this by switching to a `ConservativeMode` flag that skips autonomous reflections and requires explicit triggers. The decision loop knows its own state at all times because that state is just local variables inside the goroutine, not distributed across services.

**Concurrency budget: 8 goroutines total, all named.**

`main` → `supervisor` → {`cronTrigger`, `fsWatcher`, `telegramPoller`, `decisionLoop`, `claudeClient`, `executor`, `safetyGate`, `metricsCollector`}. Each goroutine's name is logged on start/stop. When `decisionLoop` is blocked waiting for Claude, `fsWatcher` and `telegramPoller` keep filling the buffered event channel — nothing stalls. When Claude hits a rate limit, `claudeClient` blocks on its own internal ticker and back-pressures `decisionLoop` naturally via the unbuffered request channel. The whole system fits in `~800 lines` of stdlib Go with `fsnotify` and a Telegram HTTP client as the only dependencies — readable, debuggable, no magic.


============================================================
## REACT_HOOKS (4423 chars)
============================================================

## Ichi Runtime as a React Application

**The Component Tree and Single Source of Truth**

The daemon is the root `App` component. Its state is managed via `useReducer`: `{ queue: Task[], running: Effect[], budget: Budget, inbox: Message[], health: Health }`. Nothing mutates this state directly — every change is a dispatched action (`TASK_ENQUEUED`, `BUDGET_CONSUMED`, `INBOX_ARRIVED`, `EFFECT_CRASHED`). On every state transition, the reducer serializes to `.kami/state.md` — this is React's hydration in reverse: future sessions call `ReactDOM.hydrateRoot()` by reading that file. Child components (`TaskRunner`, `BudgetMonitor`, `TelegramBridge`, `HealthCheck`, `Reconciler`) receive state slices as props and emit actions upward. Unidirectional flow means every state transition is auditable: `git diff .kami/state.md` is the change log.

**`useEffect` as the Proactivity Engine**

Every autonomous behavior is a `useEffect` with a dependency array — *reactions to state, not imperative commands*. `useEffect([inbox], processInbox)` fires on new messages. `useEffect([queue], runNextTask)` fires when a task enters. `useEffect([], startWatchers)` runs once on mount: registers `fswatch` on `.kami/inbox/`, starts the cron scheduler, opens Telegram long-polling. When Vadim sends a message, it doesn't call a handler directly — it updates `inbox`, which triggers the effect. Effects that spawn Claude subprocess sessions return cleanup functions that `SIGTERM` the child if the component unmounts (budget exceeded, task cancelled) — no ghost processes. This is the difference between event-driven spaghetti and declarative reactivity.

**Virtual DOM Diffing as the Proactivity Loop**

The agent maintains two trees: `desiredState` (what *should* be true — derived from wiki, efforts index, Enox knowledge graph) and `observedState` (what *is* true — git status, file mtimes, last activity timestamps). Every cycle the `Reconciler` component diffs them, exactly like React comparing vDOM to real DOM, and emits the minimal patch set as dispatched actions. If `desired.efforts["grafema"].status === "active"` but `observed.efforts["grafema"].lastTouch > 48h`, the diff produces `TASK_ENQUEUED: wake-up-check`. The reconciler is `useMemo`-guarded — it only re-diffs when its inputs change, not on every heartbeat tick. Priority lanes (React Concurrent Mode) determine execution order: `urgent` lane (Vadim messages, rate-limit responses) > `normal` lane (queue tasks) > `idle` lane (reflections, Enox writes, health snapshots). `startTransition` wraps idle work — it yields to urgent renders.

**Error Boundaries and Graceful Degradation**

Every `TaskRunner` instance is wrapped in an `<ErrorBoundary>`. Claude API `429` → boundary catches it, the component enters `<Suspense fallback="degraded">`, all non-urgent effects pause, a Telegram notification fires. API failure → boundary logs to `.kami/log/`, queues retry with exponential backoff, remounts after TTL. The root boundary (daemon process itself) is the last resort: if any child crashes unrecoverably, it unmounts it, writes a post-mortem, and remounts after 60s — guaranteed uptime without manual restart. Each boundary knows its *suspension budget*: how long it can stay suspended before escalating. This isn't a try/catch wrapper bolted on — it's structural: the component *cannot render* without its boundary, so resilience is opt-out impossible.

**Context Providers as the Safety Layer**

Three `Context` providers wrap the entire tree. `BudgetContext` exposes `{ remaining, consume(tokens) }` — every Claude call goes through this hook; silent overspend is structurally impossible. `SafetyContext` exposes `requireApproval(action: IrreversibleAction)`: it creates a `.kami/questions/` file, dispatches `COMPONENT_SUSPENDED`, and the calling effect simply *waits* — no polling, no timeout, just a suspended Promise that resolves when Vadim's answer lands in inbox and triggers `QUESTION_ANSWERED`. `TelegramContext` is the escalation outlet, consumed at the point of need rather than threaded through props. The safety layer isn't a wrapper around the agent — it's woven into the component model itself, the same way React's rules of hooks make certain patterns structurally unrepresentable. You can't call `requireApproval` conditionally, you can't skip `BudgetContext` — the architecture enforces the constraints, not the discipline of the implementer.


============================================================
## KUBERNETES (4123 chars)
============================================================

## Ichi Runtime Architecture: The Operator Pattern

**Control Plane: The Operator**

`kami_daemon.py` is the Operator — a custom controller that owns the lifecycle of `KamiSession` custom resources. It runs a reconciliation loop with two cadences: a *fast path* every 5s (liveness check + inbox drain) and a *slow path* every 60s (full state reconciliation). The reconciler compares desired state (`.kami/state.md` + `queue/` depth + `budget/usage.jsonl`) against actual state (heartbeat timestamp + process table + `active-daemon` lock file). If desired = "session running, effort in progress" and actual = "no process", the operator schedules a new Pod. This is exactly `ReplicaSet` enforcement: `spec.replicas: 1` while work exists, `0` when idle. The single-instance guard in the daemon *is* this invariant — the lock file is the Pod UID.

**Pods: Ephemeral Sessions**

Each `claude --dangerously-skip-permissions --max-turns 15` invocation is a Pod. Pods are stateless at the process level — all state lives in etcd (`.kami/`). Three health probes run against each Pod: *liveness* = `heartbeat.json` timestamp freshness (>2min stale → pod is zombie → SIGTERM + restart); *readiness* = `budget-check.sh` exit code (rate-limited → pod not ready → operator stops dispatching work to it, queues instead); *startup* = did the session write its init log within 30s of launch. When a Pod crashes mid-task (rate limit, API error), the operator detects via liveness failure, appends a `[ПРЕРВАНО]` marker to the session log, and reschedules — the task wasn't lost, it's still in `queue/`. The `--max-turns 15` limit is a `terminationGracePeriodSeconds` equivalent: bounded, predictable, no infinite loops.

**Services: Stable Endpoints Over Ephemeral Pods**

Three services front the pod layer. `inbox/` is a ClusterIP Service — an internal message bus. Producers (Telegram bot, cron wake, web UI, other agents) write to it regardless of which pod is running; the active pod drains it. `questions/` is a NodePort exposed externally: when Ichi writes a question file, the Telegram bot (the Ingress controller) detects it via inotify-equivalent watch and forwards to Vadim; the human response flows back in through inbox/, closing the loop. Telegram itself is the LoadBalancer — it provides a stable external address that survives internal pod churn. This decoupling is the point: Vadim never talks to a specific session, he talks to the Service.

**CRDs: The Domain Model**

Three custom resources define the desired world. `KamiEffort` (entries in `efforts/INDEX.md`) are StatefulSets — long-lived work streams with stable identity that survive session restarts; each Effort has a PLAN.md (its `spec`) and tracks actual progress against it. `KamiQuestion` (files in `questions/`) are PodDisruptionBudgets — they block irreversible actions until the human approves; the operator will not execute the gated action while `status: open`. `KamiBudgetPolicy` (derived from `budget/usage.jsonl`) is a ResourceQuota — the operator enforces it before scheduling: if daily token spend > 50% of 5h limit, new pods get `Pending` status until quota resets. The quota check is synchronous in the reconciler, not a post-hoc audit.

**Fast Feedback Loop: The Informer Pattern**

The critical insight for sub-30s proposal→validation latency: don't poll, watch. The daemon uses `FSEvents` (macOS) or inotify to watch `inbox/` and `questions/answered/` for filesystem events — new file creation triggers immediate fast-path reconciliation without waiting for the 5s tick. When Ichi proposes a change and writes a question, the Telegram bot delivers it within seconds; Vadim's response writes to `inbox/`; FSEvents fires; the operator wakes the session (or starts one if idle) immediately. This is the Kubernetes informer/watch API vs list-polling: event-driven reconciliation collapses the feedback loop from minutes to seconds. Combined with the liveness probe catching crashes fast and the operator auto-restarting, the system converges to desired state as fast as human response time allows — which is the actual bottleneck, not the machinery.


============================================================
## UNIX_PHILOSOPHY (3966 chars)
============================================================

## Ichi Runtime Architecture

**Process topology and supervision.** The single supervisory truth is a `launchd` plist with `KeepAlive = true` — macOS restarts `kami-daemon` unconditionally if it crashes, exits, or is killed. The daemon writes its PID to `.kami/runtime/daemon.pid` on startup and `touch`es `.kami/runtime/heartbeat` every 30 seconds; a separate cron job (`*/5 * * * *`) runs `kami-health`: if `heartbeat` is >90 seconds old, something is wrong — it sends a Telegram alert and optionally force-kills+relaunches. This is the watchdog pattern: the watched process cannot watch itself, so a second independent process watches it. The daemon holds no logic beyond dispatch — it is a process manager, not an agent.

**Event bus via filesystem and FIFOs.** `fswatch -0 .kami/inbox/ .kami/questions/answered/ .kami/runtime/trigger` pipes a null-delimited stream of changed paths into the daemon's stdin. The daemon reads one path per iteration, classifies it (inbox message? answered question? manual trigger?), and dispatches to the appropriate worker. This is the Unix `select()`-over-files model applied at the process level: no polling, no timers — the OS wakes the daemon exactly when something changes. For sub-second internal signaling (e.g., budget-check result ready), a named FIFO `.kami/runtime/events.fifo` is used: writer does `echo "budget:ok"`, reader unblocks instantly. FSEvents + FIFOs together give a zero-polling event loop.

**Worker processes and feedback.** Each task spawns `kami-worker` — a thin wrapper that calls `claude --max-turns 15 --dangerously-skip-permissions` with the task on stdin and captures stdout line-by-line. Exit codes carry semantics: `0` = done, `1` = error, `2` = needs human approval (worker writes a `questions/` file before exiting). The daemon pipes worker stdout through `tee` to both the session log (`.kami/log/session-$(date +%s).jsonl`) and a live FIFO `.kami/runtime/live.log` — anyone can `tail -f .kami/runtime/live.log` to watch the agent think in real time. Worker wall-time is bounded by the daemon via `SIGALRM` → `SIGKILL` escalation; no worker runs forever. Budget is checked before each spawn: `kami-budget-check` reads `budget/usage.jsonl`, outputs `ok`/`warn`/`block` to stdout, daemon acts accordingly.

**State as atomic text files.** All mutable state lives in `.kami/runtime/` — plain text files: `status` (one word: `idle`/`working`/`blocked`/`rate-limited`), `budget` (two numbers: used/limit), `last-error` (last stderr line). Writes always go through `write(tmp) → mv -f tmp target` — atomic rename on the same filesystem guarantees no reader sees a half-written file. `.kami/state.md` follows the same pattern. Logs are append-only (`>>`, never truncated), rotated weekly by a cron script that `gzip`s the old file. This means the entire system state is inspectable with `cat`, `grep`, `jq` — no special tooling, no RPC, no database.

**Human-in-the-loop as a Unix pipe stage.** The Telegram bridge (`kami-tg`) is a separate long-lived process with one job: watch `.kami/questions/` for new `tg-sent: false` files, send them as Telegram messages, and write replies back to `.kami/inbox/` as new files. It communicates with the daemon only via the filesystem — no shared memory, no sockets. This makes it independently restartable and testable. When Vadim replies, `fswatch` fires on `inbox/`, daemon wakes in milliseconds, routes the reply to the relevant worker context. The round-trip from agent question to human answer processed is bounded by Vadim's response time plus ~200ms of filesystem event latency — not minutes, not polls. `SIGTERM` to any component triggers a graceful flush: daemon finishes the current dispatch loop iteration, worker checkpoints its partial output, tg-bot flushes its send queue. Irreversible actions (git push, file delete) require exit code `2` from the worker; nothing irreversible executes without a `questions/` file being created and answered.


============================================================
## ACTOR_MODEL (4504 chars)
============================================================

## Ichi Runtime: Actor Model Architecture

**Supervision Tree as the Skeleton of Reliability.** The root supervisor owns three subtrees — `CoreSupervisor`, `IntelligenceSupervisor`, and `EffectorSupervisor` — each with its own restart strategy. Core uses `AllForOne` (if inbox or scheduler crashes, restart the whole coordination layer together — they share causal state). Intelligence and Effector use `OneForOne` (a failed code-execution child shouldn't take down the Telegram actor). Each leaf actor owns its own mutable state exclusively; no shared memory, no locks. The `WatchdogActor` sits outside the main tree, supervised directly by root, and its only job is to monitor heartbeat messages from other actors — if `OrchestratorActor` stops emitting pulses for 30 seconds, Watchdog sends a `Restart` message up the tree. This is the Erlang "let it crash" philosophy: don't defensively code around failure, design the supervision strategy instead.

**OODA Loop as a Message Circuit.** `SchedulerActor` fires `Tick(reason: WakeReason)` messages on cron (8:00 EEST) and on demand. `InboxActor` continuously polls `.kami/inbox/` and emits `InboxEvent(msg)` into the `OrchestratorActor`'s mailbox. The orchestrator is the core OODA loop — it consumes these messages, builds an `Intent`, and sends `Propose(action, reversible: bool)` to `SafetyGateActor`. The gate replies synchronously via the ask-pattern (request-reply) with `Approved | PendingHumanApproval(id)` within milliseconds for reversible actions. For reversible actions the gate immediately forwards to the appropriate effector (`FileSystemActor`, `CodeWorker`, `TelegramActor`); for irreversible it parks the message in its own mailbox and sends a Telegram notification via `TelegramActor`. When Vadim replies, `TelegramActor` emits `HumanApproval(id, approved)` back to the gate, which resumes the parked action. The feedback loop — propose → gate check → execute → result message back to orchestrator — completes in under 2 seconds for anything local.

**Back-Pressure at the Claude API Boundary.** `BudgetGuardActor` is the only actor allowed to talk to the Claude API. It maintains a token bucket (5h/weekly quota split 50/50) and exposes a `Request(prompt, priority)` → `Response | Throttled(retryAfter)` interface. All intelligence actors route through it — they never call the API directly. When the bucket is low, `BudgetGuardActor` applies back-pressure by making callers await, and emits `BudgetWarning` events onto the system event bus. A circuit breaker wraps the actual HTTP call: after 3 consecutive `429` responses it opens the circuit, stops attempting, and broadcasts `RateLimitCircuitOpen` — the orchestrator transitions to a degraded mode (queue tasks, skip non-critical wakeups) rather than hammering the API blindly.

**Self-Monitoring via Event Bus, Not Polling.** Every actor publishes structured `Heartbeat(actorId, ts, queueDepth, lastError?)` messages to a dedicated `MetricsBus` (pub/sub channel, not point-to-point). `HealthActor` subscribes to all heartbeats, maintains a rolling health map, and periodically writes `.kami/heartbeat.json` and appends to `budget/usage.jsonl`. Crucially, `HealthActor` also emits `SystemHealthReport` onto the bus — `OrchestratorActor` subscribes to these and can decide autonomously to shed load (e.g. skip background reflection if queue depth is high). `CostTrackerActor` separately subscribes to every `Response` from `BudgetGuardActor`, accumulates token counts, and fires `BudgetThresholdCrossed` when approaching limits — the orchestrator receives this and notches down its proactivity level rather than stopping cold.

**Safety as a First-Class Actor, Not an Afterthought.** `SafetyGateActor` classifies every `Propose` by three axes: reversibility (file edit vs branch delete), blast radius (local vs remote vs shared), and confidence (does the intent have a matching `questions/answered/` source?). It maintains an `ApprovalLedger` — a log of every pending and completed approval decision — written to disk via `FileSystemActor` before any irreversible action is dispatched. If `SafetyGateActor` itself crashes, its supervisor restarts it from the ledger, so no pending approval is silently lost. Dead letters (messages to crashed actors) are routed to a `DeadLetterActor` that logs them to `.kami/log/` and, if the dead letter was an effector result, re-emits it as a `LostResultWarning` onto the orchestrator's mailbox — silent failures are architecturally impossible.


============================================================
## HASKELL_TYPES (3978 chars)
============================================================

**Core: types make illegal states unrepresentable.**
Every action in Ichi's action space is an ADT where safety guarantees live in the type, not in runtime checks. `ReversibleAction` carries its own `IO () {- rollback -}`. `IrreversibleAction` can only be executed as `Approved IrreversibleAction` — a newtype constructible solely by the approval subsystem. There is no `executeIrreversible :: IrreversibleAction -> IO ()`; the function signature physically doesn't exist. The agent monad stack is `ReaderT Env (StateT AgentState (ExceptT AgentError IO))` with effects surfaced via tagless-final type classes: `HasTelegram`, `HasBudget`, `HasClaude`. A pure planning computation cannot call Telegram because the constraint is absent — capability leakage is a compile error. Budget tracking is `WriterT (Sum Cost)` wrapped around every Claude call; the accumulated cost is flushed and checked via a pure `BudgetState -> Either BudgetExceeded BudgetState` before each API call. If the limit is hit, `BudgetExceeded` propagates through `ExceptT`, gets caught at the session boundary, and transitions `AgentState` to `Dormant` — no silent failures because errors are values, not exceptions that escape silently.

**Concurrency: STM + structured concurrency via `ki`.**
The runtime holds an `AgentRuntime { inbox :: TQueue Event, state :: TVar AgentState, metrics :: TVar Metrics, pendingApproval :: TMVar (NonEmpty IrreversibleAction) }`. Four supervised threads write into `inbox` atomically: a Telegram poller, an `fsnotify` filesystem watcher, a cron ticker, and a budget monitor. The event router is a **pure function** `Event -> AgentState -> (AgentState, [Effect])` — it produces the new state and a list of `Effect` values (`SendTelegram Text | ExecuteAction ValidatedAction | RequestApproval IrreversibleAction | Sleep NominalDiffTime`) without touching IO. This pure core runs in microseconds. A separate interpreter executes the effect list sequentially. The fast feedback loop is structural: planning is pure, execution is interpreted — you can property-test the entire decision logic without a running agent.

**Self-healing: two-level supervisor tree.**
`withAsync` supervises three long-running processes — event loop, Telegram gateway, health monitor — each tagged with `RestartPolicy = AlwaysRestart | CooldownRestart NominalDiffTime | RestartIf (SomeException -> Bool)`. `AgentState` lives in a `TVar` *outside* supervised threads: a crashing event loop restarts and reads the last-known state from the TVar rather than starting cold. A `429` from Claude is not a crash — it's `Left RateLimitError` in the `ExceptT` layer, caught by a dedicated handler that writes `RateLimited { retryAfter }` into the state TVar and signals a `Sleep` effect. Graceful degradation is also typed: `AgentCapabilities = Set Capability` where `Capability = UseClaude | UseTelegram | WriteFilesystem`; the capability set narrows when subsystems degrade, and the router's pattern matches handle `AgentCapabilities` explicitly rather than failing at call sites.

**Proactivity: `MinPQueue Priority Opportunity` drained continuously.**
`Opportunity` is a sum type — `QueuedTask Task | ScheduledReflection UTCTime | InboxMessage MessageId | ProjectImprovement ProjectId`. The main loop has no `waitForEvent`; it drains the priority queue whenever `state = Active`. Cron ticks, answered questions, and filesystem changes all atomically `modifyTVar queue (insert newOpportunity)`. Ichi never waits — it processes the highest-priority opportunity available, then the next. The cron tick enqueues a `ScheduledReflection`; inbox messages enqueue at `Critical` priority and preempt it. The entire scheduling policy is a pure `AgentState -> OpportunityQueue -> Maybe (Opportunity, OpportunityQueue)` function, testable in isolation with `QuickCheck` generators for all opportunity combinations — including adversarial sequences like simultaneous rate limit + pending approval + high-priority task.


============================================================
## LISP_HOMOICONIC (4229 chars)
============================================================

## Ichi Runtime: Lisp-Paradigm Architecture

**The Image as Ground Truth.** The Ichi runtime is a persistent Lisp image that never restarts — it *resumes*. MacOS launchd mounts the image from disk; it contains not just bytecode but live closures, open connections, pending continuations, and the full agent worldview. There is no "crash-and-recover" because the image snapshots exact execution state — budget counters, Telegram session, open questions, in-flight reasoning all persist. The distinction between development and production dissolves: the image Ichi inhabits at 8am is the same one Vadim can attach to via REPL socket at noon. Self-healing is trivial: if the OS process is killed, the watchdog restores the image from the last checkpoint. No "startup initialization" — state is already there.

**The REPL as Nervous System.** Every stimulus — cron tick, Telegram message, inbox file, self-generated proposal — is reified as an S-expression and routed to a central evaluator running inside the image. The agent doesn't "call functions" — it constructs forms and evaluates them: `(process-inbox msg)`, `(schedule-reflection)`, and `(self-propose '(commit-findings "discovery"))` all flow through one pipe. Fast feedback becomes structural: a proposal is literally `(let ((result (eval proposed-form *sandbox*))) (validate result))`. Because code IS data, the agent can inspect the form before running it, transform it with macros (inject logging, wrap in budget-check, add reversibility guard), and evaluate the modified form — within the same REPL turn. No serialization round-trip, no subprocess, no seconds of latency.

**Condition System as Safety Architecture.** Every risky operation signals a condition rather than throwing. A Claude API rate-limit signals `(api-rate-limited :retry-after n)`; an irreversible filesystem op signals `(irreversible-action :description "delete branch X")`. Restart handlers are bound at architectural boundaries: the scheduler binds `:wait-and-retry`, the budget controller binds `:abort-session`, the human-approval loop binds `:ask-vadim`. The call stack doesn't unwind until a restart fires — the system stays alive, mid-operation. Vadim's Telegram reply IS the restart invocation: `(invoke-restart :proceed)` or `(invoke-restart :abort)`. Silent failures are structurally impossible: unhandled conditions surface to a top-level handler that logs, notifies, and installs a safe default restart. The entire safety model is the condition hierarchy, not scattered `if` guards.

**Dynamic Redefinition as Self-Improvement.** When Ichi proposes a better `analyze-effort` strategy, the proposal is a `defun` form stored as data in `.kami/proposals/`. Validation forks the current image state (cheap, copy-on-write), evaluates the new definition there, runs metrics. If they improve, `(eval improved-defun)` fires in the live image — no deployment, no restart. Old function replaced in-place; all live closures see new behavior on next call. This is REPL-driven development applied to self-modification: the agent's improvement cycle is identical to the workflow a Lisp developer uses to iterate on a running production server, except the developer and the server are the same entity. Accumulated improvements persist in the image across OS restarts — Ichi gets smarter without ever stopping.

**The Macro Layer as Policy.** Proactivity and safety are not runtime checks — they are read-time transformations. A macro `defaction` expands every agent action into: budget check, reversibility annotation, logging hook, and condition wrapper. `(defaction post-telegram ...)` looks like `defun` but structurally guarantees the safety envelope. New policies — add a cost cap, require daytime-only for destructive ops, rate-limit Telegram sends — are new macros applied to existing action definitions, not scattered guards. Ichi's behavior is meta-programmable at the macro level: Vadim adds one macro constraint and it applies retroactively to every `defaction`. The agent's architecture is self-describing in the same language as its behavior — there is no "config layer" separate from "logic layer." The codebase and the running system are one coherent, introspectable, modifiable object.


============================================================
## SQL_DECLARATIVE (3817 chars)
============================================================

## Ichi Runtime Architecture: SQL Paradigm

**Canonical State as Tables, Not Files**

The entire runtime lives in a single SQLite database — `ichi.db`. Not files, not logs, not heartbeats. Tables are the ontology: `tasks(id, payload, status, priority, created_at, started_at, completed_at)`, `actions(id, task_id, type, reversible, approved_by, outcome, rolled_back)`, `budget(period, tokens_used, cost_usd)`, `questions(id, body, sent_to_telegram, answered_at, answer)`. Every `.kami/` file currently used for state becomes a query. "What's the current budget?" is `SELECT sum(cost_usd) FROM budget WHERE period = strftime('%Y-%W', 'now')`. This is the single source of truth — no state drift between files.

**Views as Derived State (Never Stored)**

Everything observable is a `VIEW`, computed on demand, never stale: `CREATE VIEW pending_tasks AS SELECT * FROM tasks WHERE status = 'pending' ORDER BY priority DESC, created_at ASC`. `CREATE VIEW budget_health AS SELECT tokens_used * 1.0 / 50000 AS pct_used, CASE WHEN pct_used > 0.9 THEN 'critical' WHEN pct_used > 0.7 THEN 'warning' ELSE 'ok' END AS level FROM budget WHERE period = current_period`. `CREATE VIEW blocked_actions AS SELECT a.* FROM actions a WHERE a.reversible = 0 AND a.approved_by IS NULL`. The agent never computes health — it SELECTs it. Health is always current because it's derived, not cached.

**Constraints as Invariants (What Cannot Be True)**

Safety is enforced at the schema level, not in application code. `CHECK (status IN ('pending','running','done','failed','cancelled'))` makes illegal states unrepresentable. `CHECK (reversible = 0 OR rolled_back IN (0,1))` ensures non-reversible actions are never accidentally marked rollbackable. Most critically: a trigger `BEFORE INSERT ON actions WHEN NEW.reversible = 0` runs `SELECT RAISE(ABORT, 'irreversible action requires approval') WHERE NEW.approved_by IS NULL` — the database physically refuses to record an unapproved irreversible action. This cannot be bypassed by a bug in agent code. The constraint is the safety mechanism, not a conditional branch.

**Triggers as Reactive Behavior (The Proactivity Engine)**

`AFTER INSERT ON questions` → shell-out to send Telegram notification. `AFTER UPDATE ON tasks WHEN NEW.status = 'failed' AND OLD.retry_count < 3` → `INSERT INTO tasks SELECT ..., OLD.retry_count + 1 FROM tasks WHERE id = OLD.id` — automatic re-queue with backoff baked into the trigger. `AFTER UPDATE ON budget WHEN NEW.tokens_used > 0.85 * 50000` → INSERT a high-priority task `type='alert'`. The agent doesn't poll for conditions — state changes fire behavior. Proactivity is a trigger, not a loop. The watchdog for stuck tasks is `SELECT id FROM tasks WHERE status = 'running' AND started_at < datetime('now', '-10 minutes')` run periodically, updating status to `'stalled'` — which itself fires a trigger to re-queue.

**Transactions as the Feedback Loop**

Every agent action is a transaction: `BEGIN; UPDATE tasks SET status='running', started_at=NOW() WHERE id=?; INSERT INTO actions(task_id, type, payload) VALUES(...); COMMIT`. If the action fails mid-execution: `ROLLBACK` — the task remains `pending`, the action was never recorded, retry is automatic. The feedback loop is `SELECT * FROM pending_tasks LIMIT 1` every N seconds — but N can be 1 because SQLite reads are microsecond-fast and the view is computed, not materialized. Fast feedback is achieved not by a faster daemon but by making state queries cheap. The agent wakes, asks "what's next?", executes in a transaction, and either commits (success visible instantly to all readers, including Telegram webhook) or rolls back (as if it never happened). ACID guarantees mean Ichi can crash mid-action and resurrect with consistent state — no half-written `.kami/` files, no ambiguous heartbeats.


============================================================
## EXCEL_REACTIVE (5381 chars)
============================================================

## Ichi Runtime: The Spreadsheet Architecture

**The Workbook is the runtime.** The `.kami/` directory is a multi-sheet workbook. Each subdirectory is a sheet with a schema: `QUEUE` has columns `[task_id, priority, project, status, reversible, created_at]`; `BUDGET` has `[timestamp, tokens_in, tokens_out, cost_usd, session_id]`; `HEARTBEAT` has a single volatile cell — `last_seen`, equivalent to `=NOW()` — that the daemon overwrites every 30s. Named ranges give stable references across the workbook: `BUDGET.remaining` points to a computed cell regardless of where the raw log lives. When the file structure changes, you update the named range definition, not every formula that references it. The daemon is the **calculation engine** — it holds the dependency graph, knows which cells are dirty, and triggers recalculation in topological order. `inbox/` messages are **input cells**: write a value, mark dependent cells dirty, engine recalculates downstream.

**Reactive propagation replaces polling.** In Excel, `=SUM(BUDGET!B:B)` doesn't poll — it recalculates when column B changes. Here: `FSEvents` watches `.kami/` for inode changes. When `queue/task-xyz.md` appears (a new input cell), the engine marks `QUEUE.pending_count` dirty, which marks `SCHEDULER.next_action` dirty, which marks `SESSION.should_wake` dirty — recalculation cascades in microseconds. The daemon never sleeps in a loop asking "anything new?"; it waits on an `fd` from FSEvents, exactly like Excel waiting on a `WM_PAINT` event. Volatile cells — `heartbeat.json`, `budget/usage.jsonl` — recalculate on every engine tick regardless of dependencies, just like `RAND()` and `NOW()`. The watchdog is a **circular reference in iterative mode**: `health_ok = f(last_heartbeat)`, and if health drops, it writes to `inbox/` which triggers recalculation of `health_ok` again. Excel's max-iterations guard (default 100) maps to the `--max-turns 15` cap — convergence is guaranteed, runaway loops are structurally impossible.

**Conditional formatting is the monitoring layer.** Every threshold rule is a named formula: `ALERT.budget_low = BUDGET.remaining_fraction < 0.2`, `ALERT.stale_heartbeat = NOW() - HEARTBEAT.last_seen > 90s`, `ALERT.queue_overflow = QUEUE.pending_count > 20`. These aren't code — they're declarative predicates evaluated by the engine after every recalculation pass. When a predicate flips from FALSE to TRUE, the engine fires the associated **macro**: Telegram push for `budget_low`, auto-restart for `stale_heartbeat`, escalation DM for `queue_overflow`. Color coding maps directly: green cells are healthy, yellow cells are warnings the agent handles autonomously, red cells require Vadim's approval before the formula can write its output. **Data validation on the QUEUE table enforces safety**: a task row with `reversible = FALSE` cannot transition to `status = executing` without a corresponding row in `APPROVALS` — the formula `=IF(AND(reversible=FALSE, VLOOKUP(task_id, APPROVALS, 3, FALSE)<>"approved"), "BLOCKED", ...)` short-circuits to BLOCKED, not an error, not a crash.

**Pivot tables are the operational dashboard.** Raw `budget/usage.jsonl` is the source data range — append-only, structured, never mutated. The pivot aggregates: rows = `session_date`, columns = `project`, values = `SUM(cost_usd)`, `COUNT(sessions)`, `AVG(tokens_per_task)`. This pivot recalculates when new rows land in the source, giving Vadim a live P&L by project with no manual work. A second pivot over `enox-measurements.jsonl` shows `AVG(relevance)` by query type — the agent sees its own Enox ROI in real time and prunes low-value recall patterns. The `DASHBOARD` sheet pulls from both pivots with `INDEX-MATCH` (not VLOOKUP — stable against column reorders): `=INDEX(BUDGET_PIVOT, MATCH(TODAY(), dates_col, 0), MATCH("grafema", project_col, 0))`. When the agent writes its session summary, it's filling in cells; the dashboard updates automatically. **The fast feedback loop is a formula chain, not an RPC call** — propose an improvement (write to a cell), the chain evaluates in the same recalculation pass, the result appears in the adjacent cell before the next heartbeat tick.

**The macro layer is VBA for irreversible operations only.** Routine recalculations — sorting the queue, updating heartbeat, writing budget rows — happen in pure formula space: no side effects, fully reversible by deleting the row. Macros (`Workbook_BeforeClose` → sleep protocol, `Worksheet_Change` on QUEUE → Telegram notify, cron trigger → `wake.sh`) fire only when a cell transition *cannot* be expressed as a formula — because it touches the outside world. This mirrors Excel's design philosophy: formulas for computation, macros for I/O. The boundary is explicit and auditable. Every macro call logs a row to `AUDIT` sheet before executing: `[timestamp, macro_name, trigger_cell, old_value, new_value, outcome]`. If a macro panics, the audit row gets `outcome = FAILED` and the cell reverts to its pre-macro value — the workbook never lands in a half-written state. Self-healing is `=IFERROR(primary_formula, fallback_formula)` all the way down: if the daemon process dies, the heartbeat cell goes stale, the FSEvents watcher fires `ALERT.stale_heartbeat`, the macro restarts the daemon, the heartbeat resumes — no human intervention, no silent failure, the audit trail shows exactly what happened.


============================================================
## GIT_DISTRIBUTED (3793 chars)
============================================================

## Ichi Runtime Architecture — Git Paradigm

**`.kami/` as the object store.** Everything Ichi touches becomes a content-addressable commit in the same Git repo it lives in. State, proposals, questions, queue items — all are commits, not files. This means deduplication is free (same insight recorded twice has one SHA), integrity is guaranteed (you can't silently corrupt a commit), and the reflog is the ultimate safety net: every HEAD movement is recorded with a timestamp, so a crashed daemon can always reconstruct exactly where it was. Ichi never uses "rm" on `.kami/` artifacts — it soft-deletes by committing a removal, leaving the object reachable via reflog. Irreversibility lives only in explicit `git push` to remotes.

**Hooks as the event spine.** The feedback loop lives entirely in `.git/hooks/`. A `post-commit` hook fires within milliseconds of any state change and routes by file path: a new file under `questions/` triggers a Telegram push; a new file under `inbox/` wakes the daemon; a commit touching `budget/usage.jsonl` runs the rate-limit check. This is the opposite of polling — the filesystem IS the message bus, commits are messages, hooks are subscriptions. Vadim's Telegram reply hits a webhook, which writes a file, which gets auto-committed by the watchdog, which fires the hook, which wakes Ichi. Round-trip latency target: under 3 seconds. No separate message queue, no broker, no network hop beyond Telegram itself.

**Branches as experiment sandboxes.** When Ichi wants to try something non-trivial — a refactoring proposal, a new wiki structure, a hypothesis — it does `git worktree add .kami-exp experiment/slug` and works in the worktree. The main tree stays clean and stable; the experiment runs in parallel with its own working state. If the experiment produces a valid result (Vadim approves, or Ichi's own pre-merge hook validates safety), it merges via `--no-ff` (explicit consensus commit, never fast-forward — the merge commit is the approval record). If rejected: `git branch -D`, no trace on `master`. `git rerere` handles recurrent conflicts: when the same "blocked by rate limit while doing X" pattern appears, the recorded resolution fires automatically — this is what the `lessons/` directory formalizes.

**Plumbing over porcelain for self-monitoring.** Ichi's daemon uses Git plumbing commands directly — `git cat-file`, `git for-each-ref`, `git rev-list --count` — not high-level porcelain that can silently recover or print to stdout. This means budget tracking is `git log --since="1 hour ago" --format="%T" | wc -l` against `budget/usage.jsonl`'s commit history, not a separate counter that can drift. Health status = `git fsck --no-full` on `.kami/` every wake cycle. Queue depth = `git ls-tree HEAD queue/ | wc -l`. The watchdog process is itself a `post-commit` hook that checks the daemon PID file and spawns a restart if stale — the hook infrastructure never goes down as long as Git exists.

**Protected master as the human-approval gate.** `master` has a `pre-commit` hook that classifies every staged change as reversible or irreversible using a simple ruleset: writes to `wiki/`, `reflections/`, `log/` are auto-approved; writes to `questions/` trigger Telegram and block until answered; anything touching external state (pushing to a remote, spawning a subprocess with side effects) requires a signed approval commit in `questions/answered/` to be present in the tree. This is `git --protected-branch` semantics applied to safety, not just code review. Distributed backup is just `git remote add backup <location>` with a `post-commit` hook that pushes non-interactively — if the MacBook dies mid-session, the reflog clone on the remote has every object. No special disaster-recovery protocol needed: `git clone` is recovery.


============================================================
## NGINX_EVENTLOOP (3776 chars)
============================================================

## Ichi Runtime: Nginx-Paradigm Architecture

**Master process + worker pool.** `kami_daemon.py` runs as a master that forks exactly two long-lived worker coroutines — `event_worker` (the hot path) and `budget_worker` (the slow path). Master owns signals: `SIGUSR1` triggers config reload (re-reads `CLAUDE.md`, refreshes rate-limit settings) without dropping in-flight work, identical to `nginx -s reload`. Master writes `daemon.pid`, watches worker liveness via `asyncio.create_task`, and on any worker crash immediately re-forks with exponential backoff starting at 1s — the same `max_fails`/`fail_timeout` semantics nginx applies to upstream backends. This is the only loop allowed to `os.fork()`; workers never spawn children.

**Single-threaded event loop with non-blocking I/O.** `event_worker` runs one `asyncio` event loop driven by `kqueue`/`FSEvents` watching `.kami/inbox/`, `.kami/queue/`, and `.kami/questions/`. No thread pools, no blocking `sleep`. Every file-system event is a request that enters a filter chain: `[parse] → [priority] → [budget_check] → [dispatch] → [commit] → [log]`. Budget check is a synchronous gate — if the upstream (Claude API) is circuit-broken, the request is queued into a retry ring buffer with backoff, never dropped silently. This is `limit_req` + `proxy_next_upstream` in one: rate pressure is absorbed in-process without touching the caller. The fast feedback loop lives here: a proposed action that only writes files round-trips in <500ms because it never leaves the event loop.

**Upstream pool with health probes.** Claude API is treated as one upstream group with two slots — `interactive` (priority, reserved for human-initiated requests) and `autonomous` (background, lower priority). Each slot tracks `fail_count` and `last_success`. Before every `proxy_pass` (API call), `budget_worker` runs a synthetic health check: reads `budget/usage.jsonl`, computes tokens-used-today vs. 50% of daily limit, and sets the upstream state to `up/degraded/down`. When `down`, `event_worker` sees the circuit broken and writes a `questions/` file instead of calling the API — graceful degradation, not silent failure. When the upstream recovers (new day, rate window resets), the circuit closes automatically. `budget_worker` polls every 60s and writes `heartbeat.json` — the `/nginx_status` stub that the watchdog cron reads.

**Graceful reload and zero-downtime config.** When `CLAUDE.md` or a settings file changes (detected by the same FSEvents watch), master sends `SIGUSR1` to itself. It snapshots current in-flight task IDs into `.kami/context/thread.md`, then re-reads config and reloads the filter chain — without killing `event_worker`. In-flight tasks complete against the old config; new tasks pick up the new one. This is identical to nginx's old-worker drain: master tracks `active_tasks` counter, waits for it to reach zero, then fully evicts the old chain. `SIGTERM` triggers graceful shutdown: drain queue, flush logs, commit `state.md`, then exit — `SIGQUIT` semantics, not `SIGKILL`.

**Access log as source of truth, not afterthought.** Every request through the filter chain emits one structured line to `.kami/log/YYYY-MM-DD.jsonl` — timestamp, event type, budget consumed, latency, upstream state, outcome. This is the `access_log` format. `budget_worker` tails this log (not the API — the log is authoritative) to compute real-time spend. Enox is used as an `upstream cache` — before hitting Claude, `event_worker` does a `recall` query; a cache hit skips the expensive upstream call entirely, same as `proxy_cache_valid`. Each cache probe is measured in `enox-measurements.jsonl` (the cache hit/miss ratio log), which feeds back into deciding query strategy — iterative improvement without a human in the loop.


============================================================
## TERRAFORM_IAC (4298 chars)
============================================================

## Ichi Runtime: Terraform Paradigm

**State as Single Truth, Drift as the Engine**

The `.kami/state.md` becomes `terraform.tfstate` — a structured record of every *resource* Ichi manages: open questions, active efforts, tracked processes, scheduled jobs, pending Telegram messages. The daemon's entire job is a continuous `plan → apply → refresh` loop: read desired state (from `.kami/efforts/`, `.kami/queue/`), read actual state (filesystem, git, process table, API quota), compute the diff, execute the minimal set of mutations to close it. Drift is not an error — it's the signal. A new file in `inbox/` means desired state now includes "message processed"; the reconciler applies it. A crashed process means actual state diverged; the reconciler restarts it. Nothing is imperative — every action is a reconciliation step toward a declared target.

**Desired State Declarations, Not Scripts**

Efforts and tasks are declared as resource manifests, not runnable commands:
```hcl
resource "effort" "grafema_mcp" {
  status    = "active"
  next_step = "implement edge lifting for CALLS"
  budget    = "0.5h"
  
  precondition {
    condition     = budget.daily_remaining > 0.20
    error_message = "insufficient budget — defer to tomorrow"
  }
}
```
The runtime reads this declaration and determines *how* to advance it — what tools to call, what files to read, what commits to make. The human never writes instructions; they write *intent*. Changing `status = "paused"` in the manifest is the kill switch. No process signals, no SSH — just edit a file and the next reconciliation cycle notices the drift.

**Plan Before Apply, Always**

Before any action above a reversibility threshold, Ichi emits a structured plan to Telegram:
```
Plan: 3 actions pending
  + create questions/2026-04-10-grafema-edge-lifting.md  [reversible, auto]
  ~ update efforts/grafema/PLAN.md                       [reversible, auto]  
  ! push branch feature/edge-lifting to origin           [irreversible, needs approval]

Auto-applying 2/3. Reply "apply" to approve push.
```
This is `terraform plan` natively — not an ad-hoc "should I do this?" message, but a diff rendered against current state with explicit reversibility tagging. The feedback loop target (requirement #1) is: reversible actions apply in the same cycle (seconds), irreversible actions block on Telegram reply. The `apply` reply is a state mutation itself — it flips a `pending_approval` resource to `approved`, which the next reconciliation cycle picks up.

**Modules as Isolation Boundaries**

Each subsystem is a module with its own state slice, inputs, and outputs — no cross-module direct calls, only through declared interfaces:

- `module.telegram` — provider over bot API; exposes `inbox[]`, `outbox[]` as data sources and resources
- `module.budget` — tracks API spend against quota; exposes `daily_remaining`, `weekly_remaining` as outputs consumed by effort preconditions
- `module.projects` — each repo (`grafema`, `enox`) is a resource with `current_branch`, `dirty`, `last_commit` as attributes
- `module.memory` — Enox + wiki as *data sources* (read-only lookups, never mutated directly by reconciler)
- `module.clock` — cron triggers as resources; destroying a cron resource cancels it without touching scheduler config

The daemon process is the `terraform` binary — stateless executor that loads modules, acquires the lockfile (`.kami/active-daemon`), runs reconciliation, releases lock. Crash recovery is free: restart the process, it re-reads state, re-computes diff, continues. No in-memory state survives crashes and none needs to.

**Workspaces for Session Types**

Two workspaces share the same module tree with different variable bindings: `workspace=interactive` (human present, higher budget ceiling, destructive actions allowed, real-time Telegram feedback) and `workspace=autonomous` (cron-triggered, strict budget cap of 20% daily, no destructive actions, plan-only for anything touching external systems). The cron wake script is just `terraform apply -workspace=autonomous -var-file=autonomous.tfvars` — same reconciler, locked-down variable set. If the autonomous session detects it's approaching budget, it writes a `budget_warning` resource to state and the next interactive session sees it as drift to resolve.


============================================================
## KAFKA_STREAMING (4950 chars)
============================================================

## Ichi Runtime: Kafka-Paradigm Architecture

**Event backbone and topic topology.** The core is an append-only event log with six topics. `ichi.signals` (partitioned by source: `inbox`, `cron`, `git`, `telegram`, `api-response`) is the single entry point for all stimuli — a cron tick, an inbox message, a git push, a Telegram callback all land here as structured events. `ichi.intentions` holds proposed actions before execution; `ichi.approvals` holds Vadim's yes/no decisions; `ichi.actions` holds committed, authorized work items; `ichi.outcomes` holds execution results; and `ichi.telemetry` streams health and cost metrics. One compacted topic — `ichi.state` — is the materialized state store: key = state key (`budget.week`, `session.active`, `question.abc`), value = latest event. `.kami/state.md` is just a human-readable sink projection of this compacted log, regenerated on every write. No database. State IS the log.

**Processing topology and proactivity.** Three Kafka Streams topologies run as independent JVM-equivalent processes (in practice: Python threads with their own offset cursors). The `SignalRouter` reads `ichi.signals`, classifies each event, and `context.forward()`s it downstream — a git push on grafema emits an "analyze?" intention, a cron tick emits a "review queue" intention. This is the proactivity engine: punctuators fire on wall-clock schedule (every 15 min) and inspect the materialized state store — if `session.idle > 30min AND queue.depth > 0`, emit a self-wake intention. No polling, no sleep loops. The `IntentionEvaluator` topology applies the reversibility predicate to every intention: reversible → forward to `ichi.actions` (latency: <200ms); irreversible → forward to `ichi.approvals` with a 24h tombstone TTL. The `ActionExecutor` reads `ichi.actions` with exactly-once semantics — each action carries a UUID, the processor checks a local RocksDB state store before executing, commits offset only after confirmed outcome, writes result to `ichi.outcomes`. Chain-reaction proactivity: `ichi.outcomes` feeds back into `ichi.signals` (stream-stream join on task-id, 5-min window) — completed work can trigger new intentions within the same processing cycle.

**Exactly-once and self-healing.** The `ActionExecutor` uses Kafka's transactional producer API pattern: write to `ichi.outcomes` AND update `ichi.state` in a single atomic transaction, then commit the offset. If the process crashes mid-execution, on restart it replays from the last committed offset — the idempotency key prevents double-execution. Consumer group rebalancing handles process death: each topology has a consumer group (`signal-router-cg`, `executor-cg`), and if a thread dies, its partitions are reassigned within seconds. Dead-letter queue (`ichi.deadletter`) captures any event that fails three retries — the retry topology uses event header timestamps to implement exponential backoff via a scheduled re-injection into `ichi.signals`. The watchdog is itself a consumer: it monitors consumer lag on all topics via the Kafka admin API equivalent; lag growing on `ichi.actions` means the executor is stuck — it emits a `RESTART_EXECUTOR` event to `ichi.signals`.

**Fast feedback and budget monitoring.** The feedback loop closes via a stream-stream join: `ichi.intentions` ⋈ `ichi.outcomes` keyed by `task-id`, windowed over 5 minutes. The resulting `effectiveness-stream` feeds the `TelemetryAggregator`, which maintains two tumbling windows: 5-hour and 7-day cost sums (aggregating Claude API token costs from outcome events). This materializes into `ichi.state` under keys `budget.5h` and `budget.week` — the executor reads these before dispatching any Claude API call and hard-stops if either exceeds the 50% threshold. The Telegram sink is a consumer on `ichi.approvals` (sends to Vadim) and a producer to `ichi.signals` (injects callback responses) — round-trip for an approval decision is one Telegram message, which arrives as an event and unblocks the stalled intention within the same processing cycle. The `ichi.telemetry` topic streams per-event latency, API cost, and consumer lag — a simple tumbling-window aggregator over 1-minute windows gives Ichi a live dashboard of its own health without any external observability infrastructure.

**MacBook deployment note.** Full Kafka is heavy for a laptop; the idiomatic lightweight implementation is **Redpanda** (single binary, Kafka-compatible API, <50MB RAM) or — even simpler — implement the topic abstraction over append-only JSONL files with `inotifywait`/`fsevents` as the delivery mechanism. The paradigm is identical: immutable log, consumer offsets stored as files, compaction via keyed-overwrite. The *idioms* (exactly-once via idempotency keys, dead-letter, stream-stream joins via in-memory hash maps, punctuators via cron) translate directly. When Ichi graduates to a server, swap the file-based transport for real Redpanda with zero topology changes.


============================================================
## PROLOG_LOGIC (4071 chars)
============================================================

## Ichi Runtime Architecture: Logic Paradigm

**The Knowledge Base IS the Runtime.** In Prolog, there is no separation between program and data — the KB is both. Ichi's entire world model is asserted as facts: `state(agent, awake)`, `rate_limit(remaining, 4800)`, `pending(task(reflect, low))`, `approved(vadim, delete_branch(X)) :- asks(vadim, X)`. The main loop is literally a query: `?- repeat, once(agenda_step), fail.` where `agenda_step` succeeds by trying clauses in priority order — handle inbox, execute queue task, run reflection — backtracking through each until one fires. Computation *is* proof search. The daemon is Prolog's top-level running continuously, and "sleeping" is just a fact: `assert(state(agent, sleeping))` that makes `agenda_step` immediately fail (backtrack) to a `sleep(60)` clause.

**CHR as the Reactive/Proactive Layer.** Constraint Handling Rules are Prolog's native push model — rules fire *automatically* when matching constraints enter the store, with no polling. This gives maximum proactivity for free: `telegram_message(From, Text), parse(Text, intent(task, T)) ==> assert(pending(T)), ack(From).` When `rate_limit(remaining, N), N < 100` and `pending(_)` coexist in the store, the rule `budget_tight, task_pending ==> retract(pending(_)), defer_to_tomorrow` fires immediately. Cron wakeups, file system events, Telegram updates all become `assert(event(T, E))` — CHR rules react compositionally. You don't build an event dispatcher; the constraint store *is* the event bus, and rules are the subscribers. Proactivity emerges from rules that fire on *absence*: `\+ pending(_), time_since_last_reflection(H), H > 12 ==> assert(pending(reflect))`.

**Backtracking as Bulletproof Reliability.** In Prolog, failure is information, not catastrophe — the engine simply tries the next clause. `execute(Goal) :- catch(call(Goal), Err, (log(error, Goal, Err), fail)).` `execute(Goal) :- fallback(Goal, Alt), execute(Alt).` `execute(Goal) :- log(error, Goal, no_fallback), assert(pending(notify(vadim, Goal))).` This IS a supervisor tree in three clauses. Self-healing: if `api_call(X)` fails with a rate limit error, the catch clause asserts `state(rate_limited, until(T))`, which makes the CHR rule fire to pause all pending tasks and reschedule. No separate watchdog process needed — the Prolog interpreter's backtracking mechanism *is* the error recovery strategy, and `retract(state(rate_limited, _))` when T passes is just another CHR rule.

**Meta-Predicates as Self-Monitoring.** The monitoring system is queries over the same KB: `budget_ok :- aggregate_all(count, metric(turn, _, Today), N), N < 45, rate_limit(remaining, R), R > 200.` `system_health(H) :- findall(C-S, (component(C), state(C, S)), Pairs), maplist(ok_pair, Pairs), H = ok.` `?- system_health(H)` is the health check — it either proves `ok` or fails with the first failing component bound. Tabling (`:-table expensive_check/1`) memoizes costly file reads; when `assert(file_changed(F))` invalidates the table, the next query recomputes lazily. The budget log in `.kami/budget/usage.jsonl` is just a side-effectful write inside a rule that fires on every `metric/3` assertion — the KB tracks itself.

**Closed-World Safety.** Prolog's Closed World Assumption is the safety model: if approval is not in the KB, it is not approved. `safe_to_execute(Action) :- \+ irreversible(Action).` `safe_to_execute(Action) :- irreversible(Action), approved(vadim, Action).` `irreversible(delete_branch(_)). irreversible(force_push(_)).` `reversible(edit_file(_)). reversible(create_file(_)).` Vadim's approval is a dynamic fact — `assert(approved(vadim, delete_branch(feat_x)))` — that expires: `approved(vadim, A) :- approval_record(vadim, A, T), now(Now), Now - T < 3600.` No silent failures because any uncaught exception triggers `catch(_, E, (assert(pending(notify(vadim, E))), fail))` wrapping the top-level loop. The entire safety policy is five ground facts and two rules — inspectable, queryable, modifiable at runtime via `assert/retract` without restarting the daemon.


============================================================
## FORTH_STACK (3869 chars)
============================================================

## Ichi Runtime: Forth-Stack Architecture

**The Core: One Word, One Loop**

The entire runtime is `ICHI` — a single `BEGIN...AGAIN` word, Forth's way of saying "this never returns." Each iteration: `INBOX READ` fetches the top signal onto the data stack, `CLASSIFY` converts it to an execution token, `EXECUTE` dispatches. The stack *is* the message bus — no queues, no pub/sub, just `( signal -- response )` word signatures chained by composition: `READ CLASSIFY DISPATCH RESPOND LOG`. `CATCH` wraps the full loop body. Any unhandled `THROW` triggers `WARM` — soft restart that clears both stacks but *preserves the dictionary*. Learned behaviors survive crashes because they're compiled words, not heap state.

**Dictionary as Living State (The Feedback Loop)**

The agent's knowledge IS the dictionary. Fast feedback works like this: Ichi proposes improvement → defines a new word in a scratch vocabulary → executes it against sample stack items → milliseconds to validate → moves to main vocabulary by redefining. No deployment, no restart, no diff/review cycle. Revert = `FORGET CHECKPOINT` — Forth is append-only, so you can always forget back to a named marker. The dictionary checkpoints itself before any self-modification: `: IMPROVE CHECKPOINT ' OLD-WORD FORGET : NEW-WORD ... ; ;` — the old definition is shadowed but the checkpoint word survives. This is the Forth way: the interpreter *is* the CI/CD pipeline.

**Four Cooperative Tasks, One CPU**

Four Forth tasks share execution via `PAUSE` (cooperative, no preemption, no locks needed — one task runs at a time): `DAEMON` runs the main ICHI loop; `WATCHER` calls kqueue/FSEvents at its `PAUSE` point, pushing file-change tokens onto the shared inbox; `TELEGRAM` long-polls, pushing message tokens; `CRON` sleeps via `MS` until the next scheduled epoch, then pushes `WAKE`. The inbox stack is the sole shared resource — each task produces tokens to it or consumes from it, never concurrently. Rate limiting is a budget word woven into `DAEMON`: if the daily token counter exceeds threshold, `BUDGET-EXCEEDED THROW` fires, caught by `CATCH`, which calls `SLEEP` before `WARM`. The agent doesn't poll for rate limits — it hits them, `CATCH`es them, backs off. That's the Forth way: throw on the exceptional path, normal path has no branches.

**Self-Monitoring: The `.S` Idiom**

In Forth, `.S` prints the stack without consuming it — the canonical non-destructive inspection word. Every monitoring word in Ichi follows this idiom: `BUDGET.`, `DEPTH.`, `HEALTH.` — all `( -- )`, no stack effect, pure side-output. They're woven into `DAEMON` every N iterations automatically. Output goes simultaneously to `.kami/heartbeat.json` and stdout. The external watchdog (a 10-line shell `WHILE` loop) reads heartbeat age — if stale, it executes `COLD`, the full dictionary reset. `WARM` = clear stacks, keep dictionary. `COLD` = ground zero, re-`INCLUDE` the bootstrap file. Two words, two recovery modes, total coverage.

**Safety via Stack Contract Enforcement**

In Forth, the stack comment *is* the contract: `( n -- n*2 )`. Irreversible words carry the signature `( ... TRUE -- )` — they require an explicit `TRUE` on the stack or they `THROW`. `DELETE-FILE` alone aborts. `TRUE DELETE-FILE` proceeds. Human approval maps directly: the word pushes a question token to Telegram outbox, then `R>` parks its continuation on the return stack. When Vadim replies, the `TELEGRAM` task pushes `TRUE` or `FALSE` onto the data stack and calls `EXECUTE` on the parked continuation. No callbacks, no promises, no async machinery — just the return stack doing what it always does. Silent failures are impossible because every word that can fail carries a `CATCH` wrapper at its call site; unhandled throws propagate up until `DAEMON`'s outer `CATCH` logs them with full stack dump. The stack trace IS the error report.


============================================================
## SMALLTALK_OBJECTS (4385 chars)
============================================================

## Ichi Runtime: Smalltalk Paradigm

**The Live Image as Foundation**

Ichi doesn't *run* — it *lives* in a persistent Pharo image. MacBook sleep/wake = image save/resume via `Smalltalk snapshot: true andQuit: false`. All objects maintain identity across sessions; no bootstrap, no cold start, no re-reading state files. `IchiCore default` always returns the live stateful singleton. This alone satisfies requirement #1: the feedback loop starts in milliseconds because the system never stopped. When Vadim wakes the laptop, Ichi's processes resume mid-thought, exactly where they were. The image IS the runtime.

**Process Mesh via Semaphores and SharedQueues**

Five concurrent Smalltalk Processes form the skeleton. `PulseProcess` is a `[true] whileTrue: [self tick. (Delay forSeconds: 3) wait]` heartbeat — it drives `InboxWatcher`, `BudgetLedger`, and `CommandQueue`. `TelegramPoller` feeds a `SharedQueue` of incoming messages, decoupled from processing. `APIDispatcher` owns a counting `Semaphore` initialized to the rate limit — every Claude call does `rateSemaphore wait` before dispatch and `rateSemaphore signal` after the window resets, making backpressure mechanical rather than coded. `WatchdogProcess` holds references to all critical processes and polls `aProcess isTerminated` every 10 seconds, restarting any that died. Processes share the live object graph directly — no serialization, no IPC, no JSON crossing thread boundaries. `aProcess suspend` / `aProcess resume` are first-class messages.

**Resumable Exceptions for Self-Healing**

Smalltalk's unique contribution to reliability: exceptions are resumable — the call stack is preserved and execution can continue from the exact failure point. When Claude API returns a rate limit: `[self callClaude: prompt] on: RateLimitError do: [:e | (Delay forSeconds: e retryAfter) wait. e retry]`. Not "restart the task from scratch" — resume the original activation. File write fails on full disk: handler frees temp space, resumes. Telegram disconnects: handler reconnects, resumes mid-message. The `WatchdogProcess` uses `Process class >> #fork:onError:` — if a monitored process crashes with unhandled exception, Watchdog receives the exception context, logs it (with full stack, live inspectable), and forks a fresh process from a stored `BlockClosure`. No information is lost because the dead process's context is still a live object until GC.

**Inspector-First Observability**

Instead of log files, Ichi's state is *navigable live*. From Workspace: `IchiCore default inspect` opens a tree — current task, budget consumed, process list, last 10 errors as live exception contexts you can re-open in the debugger. `BudgetLedger current sessionCost` returns a live number. `CommandQueue default` is an inspectable, mutable queue: Vadim can inject tasks, cancel approvals, reprioritize — all from Workspace without restarting anything. This makes requirement #4 structural rather than bolted on: the system's live object graph IS the monitoring dashboard. Ichi additionally pushes narrative summaries to Telegram as formatted messages, but those are projections of live state, not the source of truth.

**Command Objects and the Approval Gate**

Every Ichi action is a `Command` object: subclasses include `FileWriteCommand`, `GitCommitCommand`, `CodeModifyCommand`, `GitPushCommand`. Each implements `#isReversible`, `#execute`, `#undo`. Before execution, `IchiCore` sends `cmd isReversible`: reversible commands execute immediately and are pushed to an undo stack (a simple `OrderedCollection` on `IchiCore`). Irreversible commands — `GitPushCommand`, `DeleteFileCommand` — are wrapped in `ApprovalRequest`, serialized to a Telegram inline-keyboard message, and the executing Process blocks on `approvalSemaphore wait`. When Vadim taps Approve (Telegram webhook → `IchiTelegramHandler` → `semaphore signal`), the process resumes with full original context intact. Timeout after 24h signals `semaphore signal` with a `Cancelled` token, and `#execute` returns without acting. Improvement proposals use the same path: Ichi always writes to a staging namespace first (reversible), validates the result autonomously, then if confident, creates an `ApplyImprovementCommand` requiring approval — making the fast-feedback loop (seconds) and the safety gate (human approval) orthogonal concerns on the same Command protocol.


============================================================
## DATAFLOW_FPGA (4881 chars)
============================================================

## Ichi Runtime — Dataflow Architecture

**Dataplane: tokens over typed wires, not function calls.** The system is a collection of independent hardware blocks, each firing when its input wire carries a valid token — never polling. Three input clock domains feed the mesh: `telegram_rx` (edge-triggered, ~seconds), `cron_tick` (1Hz), and `fs_watcher` (inotify events on `.kami/inbox/`, `.kami/questions/`). Each domain has its own FIFO buffer; FIFO depth is the "elasticity budget" absorbing bursts. A `priority_arbiter` block sits downstream of all three FIFOs — it selects one token per cycle with strict priority: `urgent > interactive > autonomous`. This arbiter is the single chokepoint that enforces fairness without any mutex or lock. Downstream of the arbiter, an `intent_classifier` (combinational — zero added latency) tags each token with its routing key and fans it out onto named wires: `{task_wire, answer_wire, reflection_wire, health_wire}`.

**Planning and execution pipeline: fill the pipe, minimize stall.** `task_wire` feeds a `task_planner` block — a multi-cycle registered block (~3-5 "cycles", i.e. seconds of LLM processing). Its output is a `plan_token` carrying structured steps. Immediately downstream is a combinational `reversibility_checker` — zero latency, pure logic — that classifies each step as `{safe, unsafe}`. Safe steps route directly to the `executor` FIFO; unsafe steps route to the `approval_gate` block, which holds the token in a TTL register (5 min default) and fires a `telegram_notify` side-effect wire. The `executor` block is the long-latency registered stage (10–120s per API call). Critically, `result_tokens` from the executor feed back into the *planner's* input FIFO — not to the arbiter's top level. This short feedback loop (planner → executor → result → planner) runs at full pipeline speed: propose an improvement, validate the result, propose the next step — all without bubbling back through the arbiter's priority queue. Requirement #1 is satisfied by making the feedback wire *shorter* than the observation wire.

**Backpressure is rate limiting.** The `api_budget_reg` block maintains a token-bucket register: refilled on a 5-minute timer, decremented on each executor firing. When the bucket empties, it deasserts the `executor_ready` signal — the executor's input FIFO stalls. Backpressure propagates upstream: the planner's output FIFO fills, the planner stalls, the arbiter stops draining `task_wire`. The cron and fs domains keep accepting tokens (their FIFOs absorb them) but no new work enters the planning stage. No sleep, no polling, no explicit rate-limit check anywhere in the codebase — the register *is* the throttle. When the budget refills, the ready signal reasserts and the pipeline drains in order. Rate-limit events are logged as `budget_exhausted` tokens on a dedicated `metrics_wire` — never silently dropped.

**Watchdog and health monitor: independent clock domain.** A `health_monitor` block runs on its own 1Hz clock, completely decoupled from the data pipeline. Each cycle it samples: executor liveness counter (incremented by executor on progress, cleared on stall), FIFO fill levels, budget register value, last heartbeat timestamp. It writes `heartbeat.json` unconditionally every cycle. If `executor_liveness` hasn't incremented in 120 cycles, the health monitor fires a `watchdog_reset` wire — the executor block clears its state, the in-flight token re-queues to the executor FIFO head, and a `stall_event` token flows to the metrics wire. No crashed process, no zombie — the executor FSM resets to `IDLE` state and the token is retried. A second watchdog at the daemon level monitors the Python process itself: if `heartbeat.json` is older than 90s, `wake.sh` relaunches the daemon. Two-level watchdog gives two-level self-healing: block-level and process-level.

**Approval gate and safety semantics.** The `approval_gate` is a registered FIFO with a `telegram_ack` input wire and a `timeout_reg`. Unsafe tokens arrive, a notification fires on `outbox_tx`, and the token waits. Three outcomes are wired: ACK arrives → token routes to `executor`; NACK arrives → token routes to `rejected_sink` (logged, never silently dropped); TTL expires → token routes to `timeout_sink` with a `partner_notify` side effect. No token is ever lost — every unsafe action either executes with explicit approval, is explicitly rejected, or times out visibly. The approval gate's FIFO depth is bounded (default: 3 pending approvals) — if full, new unsafe tokens are immediately routed to a `deferred_wire` that persists them to `.kami/queue/`, preventing memory growth and preserving them across daemon restarts. The filesystem is the clock-domain crossing between the in-memory dataplane and the persistent world: tokens that survive a restart are tokens that were written to disk before the process died.


============================================================
## CELLULAR_AUTOMATA (3868 chars)
============================================================

## Ichi Runtime: Cellular Automata Architecture

**The Grid is `.kami/`; state is file presence.**
Each subdirectory is a cell lattice — `inbox/`, `queue/`, `budget/`, `questions/`, `context/`. A cell's state is encoded in its files: their existence, modification timestamp, and frontmatter (`status: open|processing|done|error`). Cells never call each other's functions. They interact exclusively by reading and writing into adjacent lattices. This *is* the neighborhood. `kami_daemon.py` runs a fixed tick (30s) — that's a generation. Every generation, each cell evaluates its local rule: `next_state = f(my_files, neighbor_files)`. No central dispatcher. No event bus. The OS filesystem is the CA substrate, and file atomicity is the concurrency primitive.

**Local rules define each cell type.**
`InboxCell`: if new `.md` appears → parse intent → write task to `queue/` → mark processed. One generation, quiescent→active→quiescent. `BudgetCell`: each tick reads `budget/usage.jsonl`; if 7-day cost exceeds 50% of Max limit, writes `budget/throttle.signal` — this file is the inhibitory signal to `WorkerCell`'s neighborhood. `WorkerCell`: if task in `queue/` AND no throttle signal → spawn Claude subagent → write result to `context/` → delete task. It is the *only* cell that consumes API budget; budget awareness is purely local rule checking. `TelegramCell` is a boundary cell bridging external world to grid: inbound messages write to `inbox/`; outbound reads `questions/` for `tg-sent: false` and flips the frontmatter after delivery. `WatchdogCell`: if any cell's `last-heartbeat` timestamp is older than 3 generations → emit restart signal for that cell. Self-healing emerges from this single rule.

**Fast feedback is a phase transition, not a pipeline.**
Ichi proposes a change → writes to `questions/`. `TelegramCell` fires it to Vadim in the next generation (≤30s). Vadim replies → `TelegramCell` writes answer to `inbox/`. `RouterCell` routes to `queue/`. `WorkerCell` applies. End-to-end: 2–4 generations = 60–120 seconds. For urgency, `TelegramCell` uses FSEvents (macOS) to break synchrony *locally* — it fires immediately on new `questions/` files without waiting for tick. Global generation discipline is preserved; one cell gets a faster clock. The feedback loop isn't designed in — it *emerges* from the cell topology.

**Proactivity is asymmetric quiescence.**
Cells aren't "activated by commands" — they return to dormancy only when their output queue is empty. `DriftCell` reads `git log` for each project each generation; if no analysis in N days it emits a `queue/analyze-<project>.md` task autonomously. `ReflectionCell` activates after K consecutive generations of low `WorkerCell` activity (nights, weekends) and runs synthesis over recent logs. `MetaCell` counts active cells per generation and writes `heartbeat.json` — if the heartbeat goes stale across 3 generations, cron restarts the daemon. The system doesn't have a "proactivity module." It has cells with rules that only go quiet when there's genuinely nothing to do.

**Safety is boundary conditions, not permission checks.**
Irreversible actions are BLOCKED cells. A task with `requires-approval: true` sits in `queue/` in BLOCKED state. `WorkerCell`'s local rule has one branch: `IF task.requires_approval AND NOT EXISTS questions/answered/<id>.md → skip`. No amount of other-cell signaling can cause WorkerCell to proceed — the local rule physically cannot produce an ACTIVE state without the answered file. The block propagates: downstream tasks that depend on this one also evaluate to BLOCKED. Silent failures are structurally impossible: every cell must write a `last-seen` timestamp each generation. A crashed cell is indistinguishable from a stale cell. `WatchdogCell` treats them identically. Dead cells restart; the grid self-heals without knowing *why* a cell died.

