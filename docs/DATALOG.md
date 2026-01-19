# ReginaFlowDB Datalog Extension

Расширение ReginaFlowDB для интерпретации Datalog-подобных запросов.

## Мотивация

Гарантии в GDD выражаются как графовые утверждения:
```
"Для каждого queue:publish существует путь до queue:consume с тем же именем очереди"
```

Это естественно выражается в Datalog:
```prolog
violation(P) :-
    node(P, "queue:publish", Queue),
    \+ reachable(P, C),
    node(C, "queue:consume", Queue).
```

## Архитектура

```
┌─────────────────────────────────────────┐
│           Datalog Query                 │
│  violation(X) :- publish(X), \+path(X,Y)│
└─────────────────┬───────────────────────┘
                  │ parse
                  ▼
┌─────────────────────────────────────────┐
│           Rule AST                      │
│  { head: "violation", body: [...] }     │
└─────────────────┬───────────────────────┘
                  │ compile
                  ▼
┌─────────────────────────────────────────┐
│        Execution Plan                   │
│  1. Scan(queue:publish)                 │
│  2. AntiJoin(path, queue:consume)       │
└─────────────────┬───────────────────────┘
                  │ execute
                  ▼
┌─────────────────────────────────────────┐
│        ReginaFlowDB Engine              │
│  find_by_type(), bfs(), get_edges()     │
└─────────────────────────────────────────┘
```

## Синтаксис

### Базовые предикаты (встроенные)

```prolog
% Nodes
node(Id, Type).                    % нода с типом
node(Id, Type, Attr, Value).       % нода с атрибутом

% Edges
edge(Src, Dst, EdgeType).          % ребро
edge(Src, Dst).                    % любое ребро

% Paths (встроенный, не рекурсивный)
path(Src, Dst).                    % существует путь
path(Src, Dst, [E1, E2]).          % путь через типы рёбер
path(Src, Dst, MaxDepth).          % с ограничением глубины
```

### Пользовательские правила

```prolog
% Определение правила
publisher(X, Queue) :- node(X, "queue:publish"), attr(X, "queue", Queue).
consumer(X, Queue) :- node(X, "queue:consume"), attr(X, "queue", Queue).

% Гарантия: каждый publisher имеет consumer
violation(P, Queue) :-
    publisher(P, Queue),
    \+ (consumer(C, Queue), path(P, C)).
```

### Операторы

| Оператор | Синтаксис | Описание |
|----------|-----------|----------|
| Conjunction | `A, B` | A и B |
| Negation | `\+ A` | не A (stratified) |
| Inequality | `neq(X, Y)` | X не равно Y |
| Prefix check | `starts_with(X, P)` | X начинается с P |
| Prefix negation | `not_starts_with(X, P)` | X не начинается с P |

### String Predicates

```prolog
% Inequality - passes if X != Y
neq(Name, "constructor").         % filter out constructors

% Prefix matching
starts_with(Name, "<").           % matches "<anonymous>", "<computed>"
not_starts_with(Name, "<").       % excludes anonymous functions
```

Example: Find named functions (not anonymous, not constructors):
```prolog
violation(X) :-
    node(X, "FUNCTION"),
    attr(X, "name", N),
    neq(N, "constructor"),
    not_starts_with(N, "<").
```

## Реализация (Rust)

### Фаза 1: Core Types

```rust
// src/datalog/mod.rs

/// Терм в Datalog
#[derive(Clone, Debug)]
pub enum Term {
    Var(String),           // X, Y, Queue
    Const(String),         // "queue:publish", "orders"
    Wildcard,              // _
}

/// Атом (предикат с аргументами)
#[derive(Clone, Debug)]
pub struct Atom {
    pub predicate: String,  // node, edge, path, violation
    pub args: Vec<Term>,
}

/// Литерал (атом или его отрицание)
#[derive(Clone, Debug)]
pub enum Literal {
    Positive(Atom),
    Negative(Atom),  // \+ atom
}

/// Правило
#[derive(Clone, Debug)]
pub struct Rule {
    pub head: Atom,
    pub body: Vec<Literal>,
}

/// Программа
#[derive(Clone, Debug)]
pub struct Program {
    pub rules: Vec<Rule>,
}
```

### Фаза 2: Parser

```rust
// src/datalog/parser.rs

pub fn parse_program(input: &str) -> Result<Program, ParseError>;
pub fn parse_rule(input: &str) -> Result<Rule, ParseError>;
pub fn parse_query(input: &str) -> Result<Atom, ParseError>;

// Примеры:
// parse_rule("violation(X) :- node(X, \"queue:publish\"), \\+ path(X, _).")
// parse_query("violation(X)")
```

Можно использовать `nom` или `pest` для парсинга.

### Фаза 3: Evaluator

```rust
// src/datalog/eval.rs

pub struct Evaluator<'a> {
    db: &'a GraphEngine,
    rules: HashMap<String, Vec<Rule>>,
}

impl<'a> Evaluator<'a> {
    /// Выполнить запрос, вернуть все bindings
    pub fn query(&self, goal: &Atom) -> Vec<Bindings> {
        match goal.predicate.as_str() {
            "node" => self.eval_node(goal),
            "edge" => self.eval_edge(goal),
            "path" => self.eval_path(goal),
            _ => self.eval_derived(goal),
        }
    }

    /// Встроенный предикат node(Id, Type)
    fn eval_node(&self, atom: &Atom) -> Vec<Bindings> {
        // Использует db.find_by_type()
    }

    /// Встроенный предикат path(Src, Dst)
    fn eval_path(&self, atom: &Atom) -> Vec<Bindings> {
        // Использует db.bfs()
    }

    /// Вычисление пользовательских правил (semi-naive)
    fn eval_derived(&self, atom: &Atom) -> Vec<Bindings> {
        // Fixed-point iteration
    }
}
```

### Фаза 4: Semi-Naive Evaluation

```rust
// src/datalog/seminaive.rs

/// Semi-naive evaluation для рекурсивных правил
pub fn evaluate_rules(
    db: &GraphEngine,
    rules: &[Rule],
    goal: &str,
) -> HashSet<Tuple> {
    let mut result: HashSet<Tuple> = HashSet::new();
    let mut delta: HashSet<Tuple> = HashSet::new();

    // Initial facts
    delta = derive_initial(db, rules, goal);
    result.extend(delta.clone());

    // Fixed-point
    while !delta.is_empty() {
        let new_delta = derive_new(db, rules, &result, &delta);
        delta = new_delta.difference(&result).cloned().collect();
        result.extend(delta.clone());
    }

    result
}
```

## API (NAPI)

```rust
// src/ffi/napi_bindings.rs

#[napi]
impl JsGraphEngine {
    /// Выполнить Datalog запрос
    #[napi]
    pub fn datalog_query(&self, query: String) -> napi::Result<Vec<JsBindings>> {
        let atom = parse_query(&query)?;
        let evaluator = Evaluator::new(&self.engine);
        let results = evaluator.query(&atom);
        Ok(results.into_iter().map(|b| b.into()).collect())
    }

    /// Загрузить правила
    #[napi]
    pub fn datalog_load_rules(&mut self, rules: String) -> napi::Result<()> {
        let program = parse_program(&rules)?;
        self.rules = program.rules;
        Ok(())
    }

    /// Проверить гарантию (возвращает violations)
    #[napi]
    pub fn check_guarantee(&self, guarantee_id: String) -> napi::Result<Vec<JsViolation>> {
        // Загружает правило из guarantee node
        // Выполняет query
        // Возвращает violations
    }
}
```

## JavaScript API

```javascript
// Загрузка правил
await graph.datalogLoadRules(`
    publisher(X, Queue) :- node(X, "queue:publish"), attr(X, "queue", Queue).
    consumer(X, Queue) :- node(X, "queue:consume"), attr(X, "queue", Queue).

    violation(P, Queue) :-
        publisher(P, Queue),
        \\+ (consumer(C, Queue), path(P, C)).
`);

// Запрос
const violations = await graph.datalogQuery('violation(X, Queue)');
// [{ X: "node123", Queue: "orders" }, ...]

// Или через Guarantee API
const result = await graph.checkGuarantee('guarantee:queue#orders');
// { satisfied: false, violations: [...] }
```

## Примеры гарантий

### 1. Queue Contract

```prolog
% Каждый publisher должен иметь consumer с тем же именем очереди
queue_violation(Pub, Queue) :-
    node(Pub, "queue:publish"),
    attr(Pub, "queue", Queue),
    \+ (
        node(Con, "queue:consume"),
        attr(Con, "queue", Queue),
        path(Pub, Con)
    ).
```

### 2. Auth Middleware

```prolog
% Каждый HTTP route должен быть достижим из auth middleware
unprotected_route(Route) :-
    node(Route, "http:route"),
    \+ (
        node(Auth, "express:middleware"),
        attr(Auth, "name", Name),
        Name = "*auth*",  % pattern match
        path(Auth, Route, [CALLS])
    ).
```

### 3. Permission Check

```prolog
% Каждый S3 write должен иметь IAM policy
missing_permission(Call, Bucket) :-
    node(Call, "aws:s3:putObject"),
    attr(Call, "bucket", Bucket),
    \+ (
        node(Policy, "iam:policy"),
        allows(Policy, "s3:PutObject", Bucket),
        path(Call, Policy, [ASSUMES_ROLE, HAS_POLICY])
    ).
```

## Что реализуем

### Фаза 1 (MVP) ✅ COMPLETE
- [x] Core types (Term, Atom, Rule) ✅
- [x] Parser (простой, без full Prolog syntax) ✅
- [x] Evaluator для встроенных предикатов ✅
- [x] Negation support (\+) ✅
- [x] NAPI bindings ✅

### Фаза 2
- [ ] Semi-naive evaluation
- [ ] Stratified negation
- [ ] Оптимизация join'ов (индексы)

### Фаза 3
- [ ] Caching результатов
- [ ] Инкрементальное обновление
- [ ] Profiling / explain

## Backlog (не для GDD)

Эти фичи не нужны для базовых гарантий:

| Фича | Причина отложить |
|------|------------------|
| Aggregation (`count`, `sum`) | Гарантии — existence, не counting |
| Lattices | Для abstract interpretation |
| Incremental (DDlog-style) | Оптимизация, не функционал |
| Parallel evaluation | Оптимизация |
| Magic sets | Оптимизация |
| Subsumption | Для dataflow analysis |

## Тестирование

```rust
#[test]
fn test_simple_query() {
    let db = setup_test_db();
    db.add_node("n1", "queue:publish", json!({"queue": "orders"}));
    db.add_node("n2", "queue:consume", json!({"queue": "orders"}));
    db.add_edge("n1", "n2", "CALLS");

    let results = db.datalog_query("node(X, \"queue:publish\")");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["X"], "n1");
}

#[test]
fn test_path_query() {
    let db = setup_test_db();
    // ... setup ...

    let results = db.datalog_query("path(\"n1\", \"n3\")");
    assert_eq!(results.len(), 1); // path exists
}

#[test]
fn test_negation() {
    let db = setup_test_db();
    db.add_node("n1", "queue:publish", json!({"queue": "orphan"}));
    // No consumer!

    db.datalog_load_rules("violation(X) :- node(X, \"queue:publish\"), \\+ path(X, _).");
    let violations = db.datalog_query("violation(X)");
    assert_eq!(violations.len(), 1);
}
```

## References

- [Datalog and Recursive Query Processing](https://www.nowpublishers.com/article/Details/DBS-017) — semi-naive evaluation
- [Souffle](https://souffle-lang.github.io/) — optimizations
- [Crepe](https://github.com/ekzhang/crepe) — simple Rust implementation
