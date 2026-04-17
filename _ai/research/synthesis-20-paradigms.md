# Синтез 20 парадигм: архитектура автономного агента Ичи

*Исследовательский документ. Апрель 2026.*

Этот документ — синтез двадцати архитектурных предложений для runtime автономного AI-агента (Ичи), каждое из которых спроектировано через призму отдельной парадигмы программирования. Цель — не пересказать каждое предложение, а столкнуть их друг с другом, найти общие решения, фундаментальные противоречия и уникальные находки, а затем предложить одну синтезированную архитектуру.

---

## 1. Группировка по проблемам

### 1.1 Быстрый цикл обратной связи (Fast Feedback Loop)

**Проблема:** минимальная задержка от «агент предложил действие» до «результат валидирован» (или «человек ответил»).

| Подход | Парадигмы | Механизм | Tradeoff |
|--------|-----------|----------|----------|
| **Event-driven / FSEvents без поллинга** | Erlang, Go, Unix, Kubernetes, Nginx, Excel, Dataflow, Cellular Automata | `fswatch`/`inotify`/`kqueue` на `.kami/inbox/` и `.kami/questions/answered/` — OS уведомляет процесс при изменении файла | Зависимость от ОС-специфичных API (FSEvents на macOS, inotify на Linux). Файловая система как шина сообщений — не самый быстрый транспорт, но достаточный для latency ~200ms |
| **select!/race combinator** | Rust, Go, Haskell | `tokio::select!`, Go `select {}`, STM — несколько каналов одновременно, пробуждение по первому готовому | Требует async runtime. Даёт максимальную гранулярность — можно гонять Claude API call, budget check и human interrupt одновременно |
| **Короткий feedback wire внутри pipeline** | Dataflow/FPGA | Результат executor'а возвращается напрямую в planner, минуя priority arbiter. Цикл plan→execute→result→plan быстрее, чем полный observe→orient→decide→act | Требует явного разделения «внутреннего» и «внешнего» цикла. Увеличивает сложность маршрутизации |
| **REPL как нервная система** | Lisp, Smalltalk | Предложение — это S-expression / Command object, валидация — `eval` в sandbox / execute в staging namespace. Нет сериализации, нет subprocess | Привязка к конкретному runtime (Pharo image, Common Lisp image). Максимально быстрый feedback — микросекунды для локальных операций |
| **Чистая функция планирования** | Haskell | `Event -> AgentState -> (AgentState, [Effect])` — планирование pure, выполнение interpreted. Планирование занимает микросекунды | Требует discipline разделения pure/effectful кода. В Python-реализации эта граница будет конвенцией, не enforced компилятором |
| **Транзакции как атомарный цикл** | SQL | `BEGIN → execute → COMMIT/ROLLBACK`. SELECT дешёвый (микросекунды), состояние всегда консистентно | SQLite как единственное хранилище — нетрадиционно для daemon. Но идея транзакционного цикла ценна |
| **Формулы с зависимостями** | Excel/Reactive | Граф зависимостей между «ячейками» — изменение input cascades автоматически. Dirty-tracking вместо поллинга | Нужно строить и поддерживать dependency graph. Дополнительная инфраструктура, но элегантная модель |

**Вывод:** Почти все парадигмы сходятся на FSEvents + event-driven цикле как базе. Различия — в том, что происходит *после* получения сигнала. Lisp/Smalltalk дают самый быстрый внутренний цикл (eval в том же процессе), но привязаны к экзотическим runtime. Haskell/Rust дают формальные гарантии через типы, но требуют соответствующего языка. Для Python-реализации оптимальный компромисс: **FSEvents + asyncio event loop + разделение на pure planning и effectful execution** (идея Haskell, реализация — convention).

### 1.2 Проактивность

**Проблема:** агент должен действовать без внешнего стимула — обнаруживать drift, запускать рефлексию, инициировать улучшения.

| Подход | Парадигмы | Механизм | Tradeoff |
|--------|-----------|----------|----------|
| **Таймеры / cron внутри процесса** | Erlang (`send_after`), Go (Ticker), Nginx (periodic), Haskell (priority queue) | Внутренний планировщик с priority queue. Idle detection → trigger reflection | Простота. Но таймеры — это pull-модель с фиксированным интервалом, не реактивность |
| **Drift detection / reconciliation** | Terraform, Kubernetes | Сравнение desired vs actual state → минимальный patch. Drift IS the signal | Мощная модель. Требует формализации «desired state» — что именно «должно быть» |
| **CHR / constraint rules** | Prolog | Правила срабатывают автоматически при появлении matching constraints. Проактивность на *отсутствии*: «давно не было рефлексии → создай задачу» | Декларативно красиво, но CHR — экзотика. Идею можно реализовать как правила в Python |
| **Reactive formulas** | Excel | Ячейки пересчитываются при изменении зависимостей. Volatile cells (heartbeat, NOW()) пересчитываются каждый tick | Элегантно для мониторинга. Для инициации действий нужен macro layer |
| **Асимметричный покой (asymmetric quiescence)** | Cellular Automata | Клетки активны по умолчанию, переходят в покой только когда output queue пуст. DriftCell, ReflectionCell — автономно генерируют задачи | Отсутствие центрального dispatcher'а. Проактивность *emerge* из правил, а не программируется |
| **Punctuators / self-wake** | Kafka | Wall-clock punctuators каждые 15 мин проверяют materialized state. Idle + queue depth > 0 → self-wake intention | Похоже на внутренний cron, но встроено в streaming topology |
| **useEffect с dependency arrays** | React | Декларативные реакции на изменения state slices. Mount effect запускает watchers, idle detection — effect на отсутствие activity | Модель «реакция на изменение состояния» — одна из самых чистых формулировок |

**Вывод:** Два принципиально разных подхода: **(A) таймеры + idle detection** (Erlang, Go, Kafka — push из scheduler) и **(B) drift reconciliation** (Terraform, K8s — pull из desired state). Оба нужны. Таймеры ловят «давно ничего не происходило», drift detection ловит «состояние отклонилось от желаемого». React/Excel предлагают элегантный синтез: **декларативные реакции на изменения конкретных слайсов состояния**.

### 1.3 Надёжность и самовосстановление

| Подход | Парадигмы | Механизм | Tradeoff |
|--------|-----------|----------|----------|
| **Supervision tree / let it crash** | Erlang, Actor Model | Дерево супервизоров с разными стратегиями перезапуска (`one_for_one`, `rest_for_one`, `all_for_one`). Crash = нормальный механизм восстановления | Золотой стандарт. Сложно реализовать полноценно в Python, но принцип ценен |
| **Ownership + Drop as cleanup** | Rust | `BudgetGuard<'session>` — `Drop` гарантирует запись usage. Lifetimes привязывают ресурсы к scope | Compile-time гарантии невозможны в Python. Но pattern `__enter__`/`__exit__` (context managers) — прямой аналог |
| **Condition system / resumable exceptions** | Lisp, Smalltalk | Стек не разматывается — handler может resume с точки ошибки. Rate limit → wait → retry с сохранённым контекстом | Уникально мощно. В Python приблизительный аналог — retry decorators, но без сохранения call stack |
| **Backtracking** | Prolog | Failure = try next clause. Три клаузы `execute/1` — это supervisor tree в миниатюре | Красиво концептуально. В Python — цепочка fallback handlers |
| **WARM / COLD restart** | Forth | `WARM` — очистить стеки, сохранить словарь. `COLD` — полный перезапуск из bootstrap | Два уровня recovery. Применимо: soft restart (сохранить state, перезапустить loop) vs hard restart |
| **Транзакции + ROLLBACK** | SQL | Fail mid-action → ROLLBACK → state не изменился. ACID гарантии | Для файловой системы нет настоящих транзакций, но паттерн «write tmp → atomic rename» (Unix) близок |
| **Error Boundaries** | React | Каждый компонент обёрнут в boundary. Timeout на suspension. Escalation при неуспехе | Hierarchical error handling с bounded suspension time — полезный паттерн |
| **Двухуровневый watchdog** | Dataflow, Unix, Cellular Automata | Уровень 1: внутренний watchdog (block-level / cell-level). Уровень 2: внешний процесс (cron / launchd) | Необходимый minimum: watched process cannot watch itself |

**Вывод:** Три слоя надёжности, которые не заменяют друг друга:
1. **Внутренний**: structured error handling (Result types, try/except с разными путями для rate limit vs auth error vs timeout)
2. **Архитектурный**: supervision / restart strategy (soft restart с сохранением state vs hard restart)
3. **Внешний**: независимый watchdog (launchd / cron), который не может быть убит тем же failure mode

### 1.4 Самомониторинг

| Подход | Парадигмы | Механизм |
|--------|-----------|----------|
| **Dedicated metrics goroutine/actor** | Go, Actor Model, Kafka | Отдельный процесс собирает метрики по каналу/шине, пишет heartbeat и usage |
| **Pub/sub event bus для heartbeat'ов** | Actor Model, Kafka | Каждый актор/процессор публикует `Heartbeat(id, ts, queueDepth)` на metrics bus |
| **Live object inspection** | Smalltalk, Lisp | Состояние навигируемо в runtime через Inspector/REPL. Мониторинг = запрос к живому объекту |
| **Views / derived state** | SQL, Excel | Health = `SELECT`/формула, вычисляется on demand, никогда не stale |
| **Stack trace IS the diagnostic** | Forth (`.S` idiom) | Non-destructive inspection вплетена в main loop |
| **Git plumbing** | Git | `git rev-list --count`, `git fsck` — состояние = запросы к repository |
| **Consumer lag monitoring** | Kafka | Рост lag на топике = executor stuck. Watchdog = consumer |

**Вывод:** Мониторинг должен быть **derived, не duplicated** — вычисляться из того же state, который использует runtime, а не из отдельной копии. SQL/Excel формулируют это чище всех: health — это VIEW, а не отдельная таблица. Реализация: единый state store + функции-запросы к нему.

### 1.5 Безопасность (Safety Gate)

| Подход | Парадигмы | Механизм | Tradeoff |
|--------|-----------|----------|----------|
| **Approval gate как отдельный процесс/актор** | Erlang, Actor Model, Go | Временный процесс/горутина, владеющий pending action. Timeout → процесс умирает → action discarded | Crash = safety. Элегантно. Но tight coupling между gate и execution |
| **Newtype / phantom type** | Haskell, Rust | `Approved IrreversibleAction` — конструктор доступен только approval subsystem. `executeIrreversible` не существует без `Approved` обёртки | Compile-time enforcement. В Python невозможно строго, но convention + runtime check применимы |
| **Constraint / trigger** | SQL, Prolog | `RAISE(ABORT)` если `approved_by IS NULL`. CWA: если approval не в KB, значит не approved | Schema-level enforcement. Не обходится багом в application code |
| **Stack contract** | Forth | `( ... TRUE -- )` — irreversible word требует explicit TRUE на стеке. Без него — THROW | Минималистично. TRUE = approval token |
| **BLOCKED cell state** | Cellular Automata | Локальное правило WorkerCell: `requires_approval AND NOT EXISTS answered/<id>` → skip. Физически невозможно execute | Нет центрального gate. Safety — свойство каждой клетки |
| **Command objects + undo stack** | Smalltalk | Каждое действие — Command с `#isReversible`, `#execute`, `#undo`. Irreversible → ApprovalRequest → semaphore wait | OOP-классика. Undo stack для reversible — бонус |
| **Plan before apply** | Terraform | Structured plan с reversibility tagging отправляется человеку. Reversible = auto-apply, irreversible = block | Самая прозрачная модель для человека: видно ВЕСЬ план, не по одному action |
| **Protected master + pre-commit hook** | Git | Классификация staged changes по reversibility. Irreversible → require signed approval commit | Использует инфраструктуру Git. Привязано к commit workflow |

**Вывод:** Все сходятся на одном паттерне: **классификация действия (reversible/irreversible) → gate → timeout**. Различия — в enforcement mechanism. Самые сильные гарантии дают type system (Haskell/Rust) и schema constraints (SQL). Для Python-реализации оптимальный вариант: **Command objects с явным `is_reversible` + approval gate процесс с timeout + двойная проверка (и в gate, и в executor)**.

Уникален подход Terraform: показать человеку **весь план целиком**, а не по одному действию. Это уменьшает количество interruptions и даёт контекст.

---

## 2. Фундаментальные противоречия

### 2.1 Центральный dispatcher vs распределённые правила

**Центральный:** Erlang (orchestrator gen_server), Go (decision loop goroutine), Actor Model (OrchestratorActor), Nginx (event_worker), Kafka (SignalRouter), React (root reducer), Haskell (event router — pure function).

**Распределённый:** Cellular Automata (каждая клетка решает сама), Prolog (CHR rules fire independently).

**Почему противоречие:** Центральный dispatcher знает глобальное состояние и может принимать оптимальные решения (приоритизация, load shedding). Распределённые правила не имеют глобального view — каждая клетка видит только соседей. Но центральный dispatcher — единая точка отказа и bottleneck. Если он завис, вся система стоит. В CA/Prolog отказ одной клетки не блокирует остальные.

**Что теряешь:** выбирая центральный — теряешь resilience к отказу coordinator'а. Выбирая распределённый — теряешь возможность глобальной оптимизации (нельзя сказать «пропусти рефлексию, потому что бюджет на 80%» — budget cell и reflection cell не координируются напрямую).

**Решение для синтеза:** центральный event loop + distributed health monitoring. Coordinator делает routing, но watchdog и health monitor работают независимо и могут перезапустить coordinator.

### 2.2 Persistent image vs crash-and-recover

**Persistent image:** Lisp (живой образ, никогда не перезапускается), Smalltalk (Pharo image save/resume).

**Crash-and-recover:** Erlang (let it crash), Rust (Drop + restart), Kubernetes (ephemeral Pods), Forth (WARM/COLD), Unix (launchd KeepAlive).

**Почему противоречие:** Persistent image исключает фазу startup — состояние всегда в памяти, feedback loop начинается мгновенно. Но: corrupted image = corrupted всё. Нет способа частично перезапустить подсистему. Если memory leak накопился за неделю — единственный выход полная перезагрузка, которая теряет всё in-memory состояние.

Crash-and-recover предполагает, что state externalized (файлы, DB). Каждый перезапуск чистый. Но: cold start penalty, потеря in-flight контекста, необходимость checkpoint'ить всё важное.

**Что теряешь:** выбирая image — теряешь возможность частичного restart и чистоту состояния. Выбирая crash-and-recover — теряешь мгновенный feedback при resume и in-memory continuations.

**Решение для синтеза:** crash-and-recover с minimal cold start. State externalized в файлы (`.kami/`), но hot state (текущий контекст сессии) checkpoint'ится часто. Это то, что уже делает текущая реализация.

### 2.3 Append-only log vs mutable state

**Append-only:** Kafka (event log IS state), Git (commits never deleted, reflog as safety net).

**Mutable:** SQL (UPDATE rows), Erlang (gen_server state), Cellular Automata (file presence = state, files deleted/overwritten).

**Почему противоречие:** Append-only даёт полную аудитируемость и replay capability. Можно восстановить любое прошлое состояние. Но: storage растёт линейно, compaction нужен, «текущее состояние» — это scan всего лога. Mutable state компактен и быстро читаем, но теряет историю и уязвим к corrupted writes.

**Решение для синтеза:** гибридная модель, которая УЖЕ реализована в `.kami/`: append-only логи (`log/`, `budget/usage.jsonl`) для аудита + mutable state (`state.md`, `heartbeat.json`) для текущего view. Kafka-модель подсказывает: `state.md` — это compacted projection append-only лога, а не primary source of truth.

### 2.4 Pure planning vs imperative execution

**Pure:** Haskell (`Event -> AgentState -> (AgentState, [Effect])`), Prolog (proof search produces goals), React (reducer — pure function, effects interpreted separately).

**Imperative:** Unix (fork + exec), Erlang (gen_server callbacks mutate state), Go (goroutine bodies).

**Почему противоречие:** Pure planning testable в изоляции — можно написать QuickCheck-тесты для всех комбинаций событий. Но: в Python чистота — convention, не enforcement. Императивный код проще писать и отлаживать пошагово.

**Решение для синтеза:** выделить decision function как отдельный модуль, который принимает state snapshot и возвращает list of effects. Тестировать его отдельно. Но не пытаться делать его «чистым» в Haskell-смысле — Python всё равно не enforces.

### 2.5 Typed safety vs dynamic safety

**Typed:** Haskell (`Approved IrreversibleAction`), Rust (`BudgetGuard<'session'>`).

**Dynamic:** Prolog (CWA), SQL (constraints), Forth (stack contracts), Python runtime checks.

**Почему это не столько противоречие, сколько выбор языка:** для Python-реализации typed safety невозможен. Но *идеи* переносимы: runtime assertions, Protocol/ABC для command types, dataclass validation.

---

## 3. Уникальные находки по парадигмам

### 3.1 Condition System (Lisp)

**Концепция:** При ошибке стек НЕ разматывается. Handler на архитектурном уровне выбирает restart strategy, и выполнение продолжается с точки ошибки. Rate limit → handler ждёт retry_after → resume с того же места. Ответ человека в Telegram — это буквально `(invoke-restart :proceed)`.

**Почему уникально:** Ни одна другая парадигма не предлагает сохранение полного execution context при ошибке. Erlang перезапускает процесс с нуля. Rust возвращает `Err`. Go проверяет `if err != nil`. Все они теряют контекст. Condition system — единственная, где «подождать и продолжить с того же места» — родной паттерн.

**Как украсть:** В Python нет condition system, но есть `asyncio`. Coroutine, ожидающая approval, фактически «suspended с сохранённым контекстом» — `await approval_event.wait()` в async функции сохраняет весь local scope. Это ближайший аналог. Ключевой инсайт: **человеческий ответ — это не event, а resume signal для suspended coroutine**.

**Риски:** Coroutine может «зависнуть» навечно, если approval event никогда не придёт. Нужен timeout + cleanup.

### 3.2 Dynamic Redefinition / Dictionary as CI/CD (Lisp + Forth)

**Концепция:** Агент предлагает улучшенную функцию, форкирует image / создаёт checkpoint, eval'ит новую definition, проверяет метрики. Если лучше — заменяет в live runtime. Нет deployment, нет restart. Forth: `IMPROVE CHECKPOINT ' OLD-WORD FORGET : NEW-WORD ... ;`.

**Почему уникально:** Все остальные парадигмы предполагают статичный код, который меняется между deployments. Lisp и Forth — единственные, где runtime code modification — штатная операция, а не hack.

**Как украсть:** Python `importlib.reload()` + hot-patching модулей. Но это fragile. Более практичный вариант: **агент пишет новую версию конфигурации / промпта / стратегии в файл, daemon перезагружает при следующем цикле** — это уже есть (Nginx paradigm: `SIGUSR1` → reload config). Не live code modification, но тот же эффект.

**Риски:** Self-modification в production — рецепт для катастрофы без sandbox. Нужен fork/validate/merge workflow (что и предлагает Lisp с copy-on-write image fork).

### 3.3 Desired State Reconciliation с планом перед apply (Terraform)

**Концепция:** Не «выполни задачу», а «вот как мир должен выглядеть — вычисли diff и покажи план». Reversible actions auto-apply, irreversible — block с structured plan в Telegram. Workspaces: `interactive` (больше budget, destructive actions разрешены) vs `autonomous` (strict budget, plan-only для внешнего).

**Почему уникально:** Большинство парадигм моделируют агента как *исполнителя задач*. Terraform моделирует его как *reconciler состояния*. Это принципиально другая ментальная модель: агент не делает «шаги», он «закрывает drift». Результат: идемпотентность by design. Повторный запуск после crash'а не дублирует работу — diff уже пуст.

**Как украсть:** `desired_state.yaml` (или structured `PLAN.md`) vs `actual_state` (вычисленный из файловой системы, git, budget). Reconciler вычисляет diff. Plan отправляется в Telegram. Workspaces → переменные окружения для daemon (`WORKSPACE=autonomous` с пониженными лимитами).

**Риски:** Формализация «desired state» для творческих задач (рефлексия, exploration) неестественна. Подходит для операционных задач, не для всех.

### 3.4 Approval Gate as Temporal Process (Erlang)

**Концепция:** Approval gate — это *временный процесс* (`temporary` child spec), который живёт ровно столько, сколько нужно. Timeout → process crashes → action discarded. Процесс держит единственную ссылку на pending action. Когда процесс умирает, action физически недоступен для выполнения.

**Почему уникально:** В Go/Rust/Haskell approval — это state в map или channel. Если map corrupted или channel leaked — action может выполниться без approval. В Erlang процесс — *единственный владелец*. Его смерть — гарантированная отмена.

**Как украсть:** asyncio Task, который `await`-ит approval. При timeout — Task cancelled, action reference garbage collected. Но нужна дисциплина: action не должен быть сохранён нигде кроме Task'а.

### 3.5 Backpressure через hardware-like signals (Dataflow/FPGA)

**Концепция:** Budget exhausted → `executor_ready` signal deasserted → executor FIFO stalls → planner FIFO fills → planner stalls → arbiter stops draining task_wire. Backpressure *propagates upstream* без единой строки rate-limit кода. Budget register IS the throttle.

**Почему уникально:** Все программные парадигмы реализуют rate limiting как explicit check (`if budget < threshold: stop`). Dataflow делает его *emergent* из заполнения буферов. Нет проверки — есть физическая невозможность продвинуться.

**Как украсть:** asyncio.Queue с maxsize. Когда queue полна, `put()` блокирует. Upstream producer stalls. Downstream consumer — единственный, кто может разблокировать. Это и есть backpressure. Ключ: **использовать bounded queues между stage'ами pipeline, а не if-checks в каждом stage**.

### 3.6 Branches as Experiment Sandboxes (Git)

**Концепция:** Non-trivial предложение → `git worktree add` → работа в изолированном worktree → validate → merge `--no-ff` (merge commit = approval record) или `branch -D` (без следа). `git rerere` автоматически разрешает recurrent conflicts.

**Почему уникально:** Ни одна другая парадигма не предлагает *нативную изоляцию экспериментов* с нулевой стоимостью creation/deletion. Git worktrees — уже есть на машине, бесплатны, дают полную изоляцию.

**Как украсть:** Для рискованных операций (рефакторинг wiki, реорганизация knowledge base): создать worktree, выполнить, validate, merge/discard. Это уже частично реализовано в текущей системе (experiment branches), но не автоматизировано в daemon workflow.

**Риски:** Git worktrees на MacBook с SSD — дёшевы. Но merge conflicts при параллельной работе человека и агента — потенциальная проблема.

### 3.7 Streams + Stream-Stream Joins для effectiveness tracking (Kafka)

**Концепция:** `intentions ⋈ outcomes` keyed by task-id, windowed 5 min. Результат — effectiveness stream, который агрегируется в tumbling windows для budget monitoring. Feedback loop замкнут через join, не через polling.

**Почему уникально:** Kafka — единственная парадигма, которая моделирует *measurement effectiveness* как stream operation, а не как batch query. Это позволяет real-time корректировку поведения на основе собственной эффективности.

**Как украсть:** Append-only log intentions + outcomes (уже есть: `usage.jsonl`). Периодический join по task-id для вычисления latency и success rate. Если success rate падает — автоматическое снижение aggressiveness.

### 3.8 Closed World Assumption для Safety (Prolog)

**Концепция:** Если `approved(vadim, Action)` не доказуемо — action не approved. Точка. Approval — dynamic fact с TTL: `approved(vadim, A) :- approval_record(vadim, A, T), now(Now), Now - T < 3600`. Через час approval истекает.

**Почему уникально:** Все остальные проверяют `if approved`. Prolog проверяет отсутствие proof. Это инверсия: не «есть ли разрешение», а «можно ли доказать разрешение». Approval с TTL — элегантно и безопасно.

**Как украсть:** Approval record с timestamp. При проверке: `if approval exists AND age < TTL`. Просто, но Prolog подсказывает сделать TTL *явной частью модели*, а не hardcoded constant.

---

## 4. Синтез: лучшая архитектура

### Архитектурный скелет

```
┌─────────────────────────────────────────────────────┐
│                   kami_daemon.py                      │
│                  (Master Process)                     │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ FSEvents │  │  Cron    │  │  Telegram Poller  │  │
│  │ Watcher  │  │  Ticker  │  │  (long-poll)      │  │
│  └────┬─────┘  └────┬─────┘  └────────┬──────────┘  │
│       │              │                 │              │
│       └──────────────┼─────────────────┘              │
│                      ▼                                │
│            ┌─────────────────┐                        │
│            │  Event Queue    │  ← asyncio.Queue       │
│            │  (bounded)      │    (backpressure)      │
│            └────────┬────────┘                        │
│                     ▼                                 │
│            ┌─────────────────┐                        │
│            │  Reconciler     │  ← Terraform           │
│            │  (pure func)    │    desired vs actual    │
│            └────────┬────────┘                        │
│                     ▼                                 │
│            ┌─────────────────┐                        │
│            │  Safety Gate    │  ← Erlang/Actor        │
│            │  (async task)   │    temporal ownership   │
│            └────────┬────────┘                        │
│                     ▼                                 │
│            ┌─────────────────┐                        │
│            │  Executor       │  ← bounded queue       │
│            │  (Claude API)   │    backpressure from    │
│            └────────┬────────┘    BudgetRegister       │
│                     │                                 │
│                     ▼                                 │
│            ┌─────────────────┐                        │
│            │  Result →       │  ← Kafka/Dataflow      │
│            │  back to        │    short feedback wire  │
│            │  Reconciler     │                        │
│            └─────────────────┘                        │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │  Health Monitor (independent async task)      │    │
│  │  Derived state queries (SQL/Excel pattern)    │    │
│  └──────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
         ▲
         │ launchd KeepAlive + cron watchdog (Unix)
         │ Two-level: internal health + external heartbeat
```

### Детали по компонентам

**1. Event Sources (из Go/Unix/Kubernetes)**
- FSEvents watcher на `.kami/inbox/`, `.kami/questions/answered/`, `.kami/queue/` — sub-second notification
- Cron ticker внутри процесса (из Erlang: `send_after` pattern, реализация: `asyncio.call_later`)
- Telegram long-poller — отдельная asyncio task

Все три источника пишут в единый `asyncio.Queue(maxsize=64)` — bounded queue из Dataflow paradigm обеспечивает backpressure.

**2. Reconciler (из Terraform/Kubernetes)**

Центральный цикл — не «обработай event», а **«вычисли drift и закрой его»**. При каждом пробуждении:
- `desired_state` = PLAN.md entries + queue tasks + open questions
- `actual_state` = file system scan + git status + budget check + heartbeat freshness
- `diff` = desired - actual → list of Actions

Это из Terraform, но enriched идеей React: reconciler перевычисляет diff только когда relevant inputs изменились (мемоизация).

Reconciler — **pure function** (из Haskell): `(events, current_state) -> (new_state, [Effect])`. Тестируем отдельно. В Python — convention, не enforcement, но модуль без side effects.

**3. Safety Gate (из Erlang + Terraform)**

Каждый Action в diff помечен: `reversible | requires_approval`. Из Terraform: весь план показывается человеку разом (не по одному action), с explicit reversibility tagging. Reversible actions auto-apply. Irreversible — блокируются.

Implementation из Erlang/Actor: approval gate — отдельная asyncio Task с timeout. Task владеет единственной ссылкой на pending action. Timeout → Task cancel → action garbage collected. Из Prolog: approval record с TTL — через час approval истекает.

**4. Executor + Budget (из Dataflow + Rust)**

Executor — asyncio task, потребляющий из bounded queue. Budget — register (из Dataflow), не if-check. Реализация: `BudgetGuard` context manager (из Rust: Drop semantics → `__exit__` в Python). Вход в executor без `async with BudgetGuard()` — невозможен (не compile-time guarantee, но convention enforced code review).

Из Dataflow: когда budget exhausted, executor task не берёт новые items из queue → queue fills → reconciler sees full queue → stops producing new actions. Backpressure, а не explicit check.

**5. Short Feedback Wire (из Dataflow + Kafka)**

Результат executor'а возвращается напрямую в reconciler, минуя event queue. Это «внутренний цикл»: plan → execute → result → re-plan, без ожидания нового tick'а. Из Kafka: stream-stream join intentions↔outcomes для effectiveness tracking.

**6. Health Monitor (из SQL/Excel + Unix)**

Отдельная asyncio task (не может быть убита основным loop'ом). Health — derived state (из SQL: VIEW, не TABLE). Функции `get_health()`, `get_budget_status()` — запросы к единому state store, не отдельные counters.

Двухуровневый watchdog (из Unix/Dataflow):
- Level 1: internal health task проверяет liveness executor'а и reconciler'а
- Level 2: external cron job проверяет `heartbeat.json` freshness, перезапускает daemon при stale

**7. State Persistence (из Unix + Git + Kafka)**

- Mutable state (`state.md`, `heartbeat.json`): atomic write through `write(tmp) → rename` (из Unix)
- Append-only logs (`log/`, `budget/usage.jsonl`): event sourcing (из Kafka). State.md — compacted projection
- Git commits: audit trail, disaster recovery (из Git). Но не primary state mechanism

**8. Proactivity (из Terraform + React + Prolog)**

Drift detection (Terraform): «effort active но нет activity за 48h» → reconciler генерирует wake-up task.
Reactive effects (React): `useEffect([inbox], processInbox)` → asyncio callback при изменении inbox.
Rules on absence (Prolog): «нет pending tasks и последняя рефлексия > 12h назад» → создать reflection task.

**9. Workspaces (из Terraform)**

`WORKSPACE=interactive`: higher budget ceiling, destructive actions allowed, real-time feedback.
`WORKSPACE=autonomous`: strict budget (20% daily), no destructive actions, plan-only для external.

Cron wake = `daemon.py --workspace=autonomous`. Интерактивная сессия = `daemon.py --workspace=interactive`.

### Что пришлось отбросить

- **Persistent image** (Lisp/Smalltalk): Python не поддерживает image-based persistence. Crash-and-recover с fast checkpoint — наш путь.
- **Compile-time safety** (Haskell/Rust): Python — dynamically typed. Runtime checks + conventions вместо type system.
- **Full supervision tree** (Erlang): asyncio tasks можно supervise, но без rich restart strategies (one_for_all, rest_for_one). Упрощённая версия: restart individual tasks, hard restart для correlated failures.
- **Distributed cells** (Cellular Automata): центральный event loop проще и надёжнее для single-process daemon. CA интересна для multi-agent, не для single agent.
- **Full event sourcing** (Kafka): overhead для laptop daemon. Гибридная модель (append-only logs + mutable state) — компромисс.

---

## 5. Несинтезируемое

### 5.1 Persistent Live Image (Lisp + Smalltalk)

Концепция «система никогда не перезапускается, состояние — в живых объектах» фундаментально несовместима с Python daemon. Python не имеет image-based persistence. `pickle` + `dill` — fragile hacks, не production solution. Более того, persistent image противоречит принципу «crash recovery через externalized state», который является фундаментом текущей архитектуры.

**Почему блестяще:** Zero cold start. In-memory continuations. REPL-driven development IS production. Мониторинг = навигация по живым объектам.

**Future research:** Если когда-либо Ичи мигрирует на Elixir/Erlang (есть distribution + hot code reload) или на GraalVM (polyglot с Smalltalk-like capabilities), persistent image становится возможным. Но это другой runtime, другой язык, другая архитектура.

### 5.2 Resumable Exceptions / Condition System (Lisp + Smalltalk)

Python exceptions unwind the stack. `asyncio.Task` suspension сохраняет coroutine frame, но это не настоящая condition system — нельзя повесить handler на произвольном уровне стека и resume с точки ошибки в вызванной функции.

**Почему блестяще:** Rate limit → handler ждёт → execution продолжается с того же места. Никакого retry-from-scratch. Человеческий ответ = `invoke-restart`.

**Future research:** Delimited continuations в Python (через generators/coroutines) могут приблизить к condition system. Библиотека `effect` (algebraic effects для Python) — экспериментальная, но направление правильное. Алгебраические эффекты — обобщение condition system.

### 5.3 Self-Modifying Code at Runtime (Lisp + Forth)

Агент, который `eval`-ит новые определения функций в свой running process — мощная идея, но опасная в production Python. `importlib.reload()` — fragile, не атомарный, ломает references. Hot-patching module attributes — recipe for Heisenbugs.

**Почему блестяще:** Improvement cycle без deployment. Agent literally gets smarter without stopping. Dictionary checkpoint + rollback (Forth) — встроенный version control для кода.

**Future research:** Safe self-modification через **configuration-as-code**: агент не меняет свой код, а генерирует/модифицирует конфигурационные файлы (промпты, стратегии, правила), которые daemon перезагружает при следующем цикле. Это уже частично реализовано (CLAUDE.md, PLAN.md). Расширение: structured strategy files, hot-reloadable.

### 5.4 CHR / Constraint Propagation (Prolog)

Правила, которые срабатывают автоматически при появлении matching constraints в store — фундаментально другая модель вычисления, чем императивный event loop. В Python нет constraint store и нет forward-chaining rule engine (без библиотек).

**Почему блестяще:** Проактивность на *отсутствии*: «нет pending tasks И давно не было рефлексии → создай задачу». Композиционность: правила комбинируются без explicit orchestration.

**Future research:** Rule engine как отдельный компонент daemon'а. Drools-style (Python: `durable_rules`, `business-rules`). Или: простой DSL в YAML, который daemon интерпретирует. Декларативные правила вместо императивных checks.

### 5.5 Full Dataflow Pipeline с Hardware-like Backpressure

Модель FPGA — registered stages, FIFO buffers, ready/valid signals — красива, но для single-process Python daemon это over-engineering. asyncio.Queue с maxsize даёт *часть* backpressure, но не полную pipeline с per-stage stalling.

**Почему блестяще:** Backpressure emergent, не programmed. Нет ни одной строки rate-limit кода — просто полные буферы. Двухуровневый watchdog (block-level + process-level). Short feedback wire как архитектурный примитив.

**Future research:** Если daemon станет multi-process (e.g., separate workers для разных проектов), dataflow pipeline с bounded channels между процессами (через `multiprocessing.Queue`) станет релевантным.

---

*Основной вывод: из двадцати парадигм примерно 70% идей конвергируют на одних и тех же решениях (event-driven loop, supervisor/watchdog, safety gate с timeout, externalized state). Оставшиеся 30% — это уникальные находки, которые либо переносимы в Python с adaptation (desired state reconciliation, backpressure через bounded queues, plan-before-apply, derived health state), либо требуют другого runtime (persistent image, condition system, self-modifying code, constraint propagation). Синтезированная архитектура берёт лучшее из первой группы и оставляет вторую для future research — не потому что она плоха, а потому что Python runtime не позволяет реализовать её без потери тех самых свойств, ради которых она ценна.*
