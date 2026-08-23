# Вычисление по запросу (demand mode) в RFDB — проект, угол «от вычислителя RFDB»

Статус: ПРОЕКТ (не реализовано). Ветка `rofl-v1`, HEAD `09dbe1cf` (`git log -1 --format=%cd` →
`Sun Aug 23 14:12:22 2026 +0000`). Мандат: `run-migration/OWNER-RULINGS.md`, делегирование
от 2026-08-22.

Все утверждения о поведении v0 получены **прогоном**, не чтением. Все утверждения о RFDB несут
`file:line` в текущем рабочем дереве либо вывод живого сервера
(`packages/rfdb-server/target/release/rfdb-server`, собран `Aug 23 14:13`, то есть из HEAD;
`hello` → `server 0.4.1 proto v3 feat multiDatabase,ephemeral,semanticIds,streaming,datalogDerive`).

Скрипты прогонов лежат в `/tmp`: `v0-demand-probe.ts`, `v0-safe-scan.ts`,
`v0-demand-per-scenario.ts`, `v0-demand-provenance.ts`, `v0-demand-provenance2.ts`,
`v0-sensors-why.ts`, `rfdb-demand-probe.ts`.

---

## 0. Главный вывод, который меняет постановку задачи

Метка `missing:demand-mode` в трансляторе — это **не одна** возможность движка, а **четыре разных
условия**, склеенных одной строкой. Транслятор ставит её в 18 из 25 красных кейсов
(`run-migration/R14-blocker-matrix.md:118-138`). Измерение показало:

**7 кейсов из 18 действительно требуют вычисления по запросу. 11 — не требуют его вообще.**

Прогон, который это установил, — `/tmp/v0-demand-per-scenario.ts`: он подменяет
`Evaluation.prototype.prepare` и записывает, какие отношения v0 **на самом деле** перевёл в
демандный режим в каждом из 30 сценариев первого уровня, а затем сводит это с
`/tmp/R14-percase.json`:

```
$ node --experimental-strip-types --no-warnings /tmp/v0-demand-per-scenario.ts
RED cases: 25
RED cases the translator marks missing:demand-mode AND v0 really runs in demand mode: 7
RED cases the translator marks missing:demand-mode while v0 uses NO demand mode at all: 11
```

Семь настоящих: `p1-functor-append` (`app`, `joined`), `p3-snapshot-roundtrip`, `p4-replay`,
`p4-sensors`, `p4-forged` (`close`, `corroborated`, `temp`), `p4-tm`, `p4-tm-diverge`
(`move`, `step`).

Одиннадцать ложных: `p1-arith`, `p2-stratum-order`, `p2-unstrat-reject`, `p3-runtime-rule`,
`p3-write-protected`, `p3-breach`, `p3-malformed-sibling`, `p4-counter`, `p4-boot-audits`,
`p4-budget-hole`, `boot-load`.

И ключевое для приоритетов: **`boot.rofl` не требует демандного режима ни в одной строке.**

```
$ node --experimental-strip-types --no-warnings /tmp/v0-safe-scan.ts
##### boot.rofl
  load ok=true diags=[]
  rules=21  UNSAFE=0  demandRels=[]
```

Все 21 правило ядра v0 классифицирует безопасными. Между тем `boot.rofl` загружают 15 из 25
красных кейсов, и именно он объявлен узким местом миграции. Значит, «сделать `boot.rofl`
переводимым» — это **не** задача демандного режима.

### Что на самом деле блокирует `boot.rofl` по этой линии

Фаза 9 транслятора (`packages/rofl-conformance/src/translate.ts:214-251`) выдаёт
`missing:demand-mode` по пяти разным `return fail(...)`. На `boot.rofl` срабатывают четыре
условия, и из них **три — ошибки транслятора**, а не пробелы движка:

| условие транслятора | строка `boot.rofl` | что показал живой RFDB |
|---|---|---|
| повторная переменная в голове | `7: sees(P, P) :- perspective(P).` | **работает**: `p(X, X) :- q(X).` → `{"X":"a"}, {"X":"b"}` |
| голова — не именованная переменная | `19: stratum(Rel, 0) :- edb(Rel).` | **работает**: `p(X, 0) :- q(X).` → `{"X":"a"}` |
| несвязанная переменная в голове | `20: stratum(Rel, N) :- dep_neg(Rel,Q), stratum(Q,M), N is M + 1.` | `N` связана выходной модой `is` (`engine.ts:149-151`); v0 сам считает правило безопасным |
| небезопасное отрицание | `31: leak[audit](A,B) :- flow(A,B), not sees(B,A), not bridge_decl(R,A,B).` | **настоящий отказ движка**, см. ниже |

Живой прогон, подтверждающий первые две строки (`/tmp/rfdb-demand-probe.ts`):

```
=== R1 repeated head var: p(X,X) :- q(X). ===
    -> {"X":"a"}
    -> {"X":"b"}
=== R3 head int const (boot.rofl:19 stratum(Rel,0)): p(X,0) :- q(X). ===
    -> {"X":"a"}
```

Причина трёх ложных срабатываний одна и та же: множество `posVars` в
`translate.ts:220-223` собирает **только** `b.lit.args`. Оно не видит ни перспективу
(`engine.ts:141` `bindAll(b.lit.persp)`), ни выходные моды встроенных предикатов
(`engine.ts:149-151`), ни того, что константа в голове основна по определению
(`engine.ts:158` `h.args.every(groundIn)` — на константе истинно тривиально).

Четвёртая строка — единственная настоящая. Форма `boot.rofl:31` дословно:

```
=== R8 boot.rofl:31 shape: leak(A,B) :- flow(A,B), \+ sees(B,A), \+ bridge_decl(R,A,B). ===
    !! ERROR: derive engine error [E-PLAN-002]:
       plan: E-PLAN-002 (leak): cannot order bound-first: no feasible binding for ["bridge_decl"]
=== R8b same with R replaced by a wildcard ===
    -> {"A":"x","B":"y"}
```

**Одна свободная именованная переменная в одном отрицаемом литерале — вот что блокирует ядро.**

---

## 1. Линия — это ДВА механизма, а не один

Дальше проект различает их строго, потому что у них разная цена, разный радиус и разная отдача.

**Механизм I — экзистенциальное отрицание.** Свободная именованная переменная внутри
отрицаемого литерала. В v0 это **не** демандный режим: `classify` (`engine.ts:130-160`) вообще
не смотрит на переменные отрицаемых литералов, поле `safe` они не трогают. Измерено:

```
=== D7 unsafe negation (r EMPTY): p(X) :- q(X), not r(Y). ===
    rules: ["r… p[main](?X)@now :- q[main](?X)@now, not r[main](?Y)@now safe=true hasNeg=true"]
    demandRels: []
    ? p(A)  -> rows=["A = a","A = b"]
=== D7b unsafe negation (r NON-empty): r(zzz). ===
    ? p(A)  -> rows=[]
```

Семантика — конечный отказ: «нет ни одного `Y`, для которого `r(Y)`».

**Механизм II — собственно вычисление по запросу.** Нисходящая раскрутка правила с
несвязанной переменной в голове в точке вызова. Нужен ровно трём семействам предикатов во всём
корпусе: `app/3`, `close/2`, `move/5`. Полный список небезопасных правил всего набора
(`/tmp/v0-demand-per-scenario.ts`):

```
app[main](cons(?H,?T),?Ys,cons(?H,?Zs))@now :- app[main](?T,?Ys,?Zs)@now
app[main](nil,?Ys,?Ys)@now                  :- ?Ys = ?Ys
close[main](?V1,?V2)@now                    :- ?D is -(?V1,?V2), ?D <= 2, ?D >= -2
move[main](l,cons(?H2,?L2),?W,?R,tape(?L2,?H2,cons(?W,?R)))@now :- ?H2 = ?H2
move[main](l,nil,?W,?R,tape(nil,0,cons(?W,?R)))@now             :- ?W = ?W
move[main](r,?L,?W,cons(?H2,?R2),tape(cons(?W,?L),?H2,?R2))@now :- ?H2 = ?H2
move[main](r,?L,?W,nil,tape(cons(?W,?L),0,nil))@now             :- ?W = ?W
```

Идиом ровно две: самоунификация `X = X` как явный маркер выходной моды (переменные головы живут
внутри составных термов) и `D is V1 - V2` — арифметика, чьи входы приходят от вызывающего.

Отсюда порядок работ: **механизм I сначала** (он маленький, он разблокирует ядро, и он же нужен
линии перспектив — §7), **механизм II вторым** (он крупнее и всё равно упирается в другие линии).

---

## 2. Вопрос 1. Что v0 делает с несвязанной переменной в голове

Код: `prepare()` (`vendor/rofl-v0/src/engine.ts:80-105`) строит `demandRels` — неподвижную точку
по именам отношений: отношение демандное, если хоть одно его `@now`-правило небезопасно, либо
если оно транзитивно зависит от демандного через **позитивную** посылку. `run()`
(`engine.ts:167`) фильтрует `const safeRules = this.rules.filter((r) => r.safe)` — небезопасные
правила снизу вверх не запускаются **никогда**. Раскрутка происходит в `matchPremise`
(`engine.ts:384` `this.demandRels.get(lit.rel)`) → `solveDemandRule` (`engine.ts:407-438`).

Прогон (`/tmp/v0-demand-probe.ts`):

```
=== D1 unbound head var: p(X,Y) :- q(X). ===
    | q(a). q(b). p(X, Y) :- q(X).
    rules: ["r4122722b p[main](?X,?Y)@now :- q[main](?X)@now safe=false hasNeg=false", …]
    demandRels: ["p"]
    ? p(A, B)              -> rows=["A = a, B = ?B","A = b, B = ?B"]
    ? p(a, c)              -> rows=["true"]
    ? p(a, anything_at_all) -> rows=["true"]
    ? p(zzz, c)            -> rows=[]
    store keys for p after the ground queries: ["p[main](a,c)","p[main](a,anything_at_all)"]
    why p(a,c): {"ok":true,"text":"p[main](a,c)  <= r4122722b @tick 0\n  q[main](a) [axiom]"}
```

Три отдельных факта:
1. **Открытый ответ.** На несвязанный аргумент v0 возвращает строку с непривязанной переменной
   (`B = ?B`). Это не «все значения», это «любое».
2. **Основный вызов подтверждается и материализуется.** `p(a, anything_at_all)` истинно, и
   после этого кортеж лежит в хранилище (`solveDemandRule`, `engine.ts:426`
   `this.store.add(call.rel, persp.name, args, { scope: 'tick', base: false })`).
3. **Провенанс есть.** `derived_by` пишется тут же (`engine.ts:432-434`).

Потребитель ниже по потоку доснимает открытую колонку:

```
=== D2 safe consumer of a demand rel: r(X,Y) :- p(X,Y), s(Y). ===
    demandRels: ["p","r"]      ← замыкание вверх
    ? r(A, B) -> rows=["A = a, B = c","A = a, B = d"]
```

Контроли, отделяющие настоящий признак от мнимого:

```
=== D4 head constant: p(X, c) :- q(X).     ===  safe=true   demandRels: []
=== D5 repeated head var: p(X, X) :- q(X). ===  safe=true   demandRels: []
=== D3 wildcard head: p(_) :- q(X).        ===  safe=false  demandRels: ["p"]
                                                ? p(Z) -> ["Z = ?Z"] ; ? p(zzz) -> ["true"]
```

### Что делает RFDB сегодня — молчаливый ноль, а это запрещено инвариантом

```
=== R5 unbound head var: p(X,Y) :- q(X). ===
    -> 0 rows
=== R5b unbound head var, consumed downstream: r(X,Y) :- p(X,Y), s(Y). ===
    -> 0 rows
=== R12 unbound head var with a downstream observer of the SAME rel ===
    -> 0 rows
=== R4 head WILDCARD: p(_) :- q(X). ===
    -> 0 rows
```

Ни ошибки, ни диагностики. Точка потери — `project_head`
(`packages/rfdb-server/src/derive/exec.rs:3687-3700`):

```rust
Term::Var(v) => out.push(row.get(v)?.clone()),
Term::Wildcard => return None,
```

Комментарий над функцией (`exec.rs:3685-3686`) утверждает «Every head variable must be bound
(the planner enforces rule safety)». **Эта посылка ложна и это измерено.** Планировщик не
проверяет безопасность головы: `Rule::is_safe()` существует
(`packages/rfdb-server/src/datalog/types.rs:209-219`), но во всём `packages/rfdb-server/src`
вызывается только из тестов —

```
$ grep -rn "is_safe" --include=*.rs packages/rfdb-server/src/
packages/rfdb-server/src/datalog/tests.rs:176:        assert!(safe_rule.is_safe());
packages/rfdb-server/src/datalog/tests.rs:183:        assert!(!unsafe_rule.is_safe());
packages/rfdb-server/src/datalog/types.rs:209:    pub fn is_safe(&self) -> bool {
packages/rfdb-server/src/datalog/types.rs:253:        self.rules.iter().all(|r| r.is_safe())
packages/rfdb-server/src/derive/plan.rs:2307:    fn ground_probe_leg_is_safe_in_any_position() {
```

`types.rs:253` — метод `Program::is_safe`, тоже без производственных вызовов.

И это прямое нарушение собственного инварианта движка, дословно, `exec.rs:144-145`:

> «Stable, machine-readable executor error codes (invariant I5). **A silently-empty result is a
> forbidden failure mode engine-wide**; every executor deviation carries a code.»

**Следствие для проекта: даже если бы демандный режим никогда не понадобился, этот молчаливый
ноль обязан быть закрыт.** Это не расширение области — это уже существующая дыра, вскрытая
измерением.

---

## 3. Вопрос 2. Небезопасное отрицание, в том числе под перспективой

### 3.1 Каждый отрицаемый литерал — отдельный экзистенциальный квантор

```
=== D9 shared free var across two negations: not r(Y), not s(Y).   r(b) only ===
    | q(a). r(b). p(X) :- q(X), not r(Y), not s(Y).
    ? p(A) -> rows=[]
```

Если бы `Y` была общей, нашёлся бы свидетель (любое значение вне `r` и `s`) и ответ был бы
`["A = a"]`. Ответ пуст ⇒ **переменная не разделяется между литералами**. Механически это видно
в `solveBody` (`engine.ts:333-337`): ветка `neg` кладёт `{ s: a.s, … }` — подстановка проходит
**без изменений**, из отрицаемого литерала не выходит ни одной привязки.

### 3.2 Внутри одного литерала повторная свободная переменная — это диагональ

```
=== D8  p(X) :- q(X), not r(Y, Y).   r(a,b) only  ===  ? p(A) -> ["A = a"]
=== D8b p(X) :- q(X), not r(Y, Y).   r(a,a)       ===  ? p(A) -> []
```

Это убивает единственный дешёвый обходной путь — переписывание `not r(Y)` → `not r(_)` в
трансляторе. Оно корректно для переменной, встречающейся в литерале **один раз**, и
**некорректно** для повторной. Обе стороны измерены:

```
v0   D8  : not r(Y, Y), r(a,b) → ["A = a"]
RFDB R9b : \+ u_r(_, _), u_r("a","b") → 0 rows
```

### 3.3 Что RFDB делает сегодня

Точка отказа — `can_place_and_provides` (`packages/rfdb-server/src/derive/plan.rs:938-950`):

```rust
Literal::Negative(atom) => {
    // Negative literals require ALL Var args to be in bound.
    let all_bound = atom.args().iter().all(|t| match t {
        Term::Var(v) => bound.contains(v),
        _ => true,
    });
    (all_bound, HashSet::new())
}
```

`Term::Wildcard` не является `Term::Var`, поэтому проходит — и именно поэтому подстановочный знак
уже сегодня экзистенциален. Измерено:

```
=== R7  z(X) :- q(X), \+ u_r(_).  (u_r пусто)      -> {"X":"a"}
=== R7b z(X) :- q(X), \+ u_r(_).  u_r("zzz").      -> 0 rows
=== R6  z(X) :- q(X), \+ u_r(Y).
    !! ERROR [E-PLAN-002] (z): cannot order bound-first: no feasible binding for ["u_r"]
```

То есть **семантика уже реализована — недоступна только запись через именованную переменную.**

### 3.4 Под перспективой — тот же самый механизм, и это уже решено соседней линией

`_ai/research/rofl-perspectives-design.md:418-440` фиксирует ровно ту же ситуацию, но по полю
перспективы, с собственным прогоном v0 (`:60-62`):

```
===== A3b  clean(X) :- item(X), not q[P](X). =====
item(a). item(b). q[vault](a).
query clean(X) = ["X = b"]        (семантика: «q(X) не выполняется НИ В ОДНОЙ перспективе»)
```

и выносит вердикт (`:433-440`): перспективная переменная **исключается** из требования
«все аргументы связаны» в `plan.rs:940`, отрицаемая ножка проверяется экзистенциально по всем
записям внутренней карты перспектив.

Это буквально механизм I, применённый к другому полю литерала. Отсюда обязательное
проектное требование: **исключение из `plan.rs:940` реализуется ОДИН раз, обобщённо — по
позициям аргументов и по полю перспективы сразу.** Две независимые правки того же условия
разойдутся.

Второе сцепление там же, `rofl-perspectives-design.md:991` (пункт 1 списка изменений):

> «**include the perspective var in `Atom::variables()`** (this is what makes §3.3's head-var
> safety check work for free)»

Это ровно то, чего не хватает `posVars` транслятора, и ровно то, что нужно вычислению
демандного множества (§5.1), потому что v0 считает голову небезопасной и по перспективе тоже
(`engine.ts:158` `if (!h.args.every(groundIn) || !groundIn(h.persp)) safe = false;`). Измерено:

```
=== D6 head perspective variable: p[P](X) :- q(X). ===
    rules: ["r… p[?P](?X)@now :- q[main](?X)@now safe=false hasNeg=false"]
    demandRels: ["p"]
    ? p[main](A)  -> ["A = a"]
    ? p[audit](A) -> ["A = a"]
    ? p[P](A)     -> ["A = a, P = ?P","A = a, P = audit","A = a, P = main"]
```

Правило с перспективной переменной в голове **принимается** и раскручивается по запросу
по каждой перспективе.

### 3.5 Отрицание НАД демандным отношением имеет побочный эффект

```
=== D10 negation over a demand rel: z(X) :- q(X), not p(X, w). ===
    | q(a). p(X, Y) :- q(X). z(X) :- q(X), not p(X, w).
    ? z(A) -> rows=[]
    store keys for p: ["p[main](a,w)"]
```

Проба отрицания раскрутила `p(a,w)`, та удалась, отрицание провалилось — и **проверенный
экземпляр остался в хранилище**. Это прямое следствие того, что `solveBody`'s ветка `neg`
(`engine.ts:334`) вызывает тот же `matchPremise`, что и позитивная. Для RFDB это значит:
антисоединение по демандному отношению обязано идти через раскрутку, а не через чтение
`Total`.

---

## 4. Вопрос 4. Чем ограничена терминация

Несвязанная переменная в голове именует бесконечное множество. В v0 её ограничивают два
счётчика, оба — в вычислителе, ни один — в семантике:

* `MAX_DEPTH = 512` (`engine.ts:40`), проверяется в `solveDemandRule`
  (`engine.ts:409`): `if (depth > MAX_DEPTH) throw new BudgetExhausted();`
* шаговый бюджет, по умолчанию `100_000` (`engine.ts:60`), `bumpSteps()`
  (`engine.ts:313-316`): `if (this.steps > this.budget) throw new BudgetExhausted();`

Наверху `api.ts:192-224` ловит `BudgetExhausted`, добавляет факт `hole` и ставит
`partial = true`.

Ответ прогоном, не заверением — взаимная демандная рекурсия:

```
=== D11 mutual demand recursion: p(X,Y) :- q(X).   q(X) :- p(X,_). ===
    | base(a). p(X, Y) :- q(X). q(X) :- p(X, _).
    demandRels: ["p","q"]
    ? q(Z)    -> partial=true err=- rows=[]
    ? p(A, B) -> partial=true err=- rows=[]
    elapsed 249 ms
    hole facts: ["hole[main]($load(1),budget_exhausted)",
                 "hole[main]($q(1),budget_exhausted)",
                 "hole[main]($q(2),budget_exhausted)"]
```

**249 мс, три сертификата-дыры, ноль зависаний.** Это и есть граница: её нет в логике, она в
бюджете, и её пересечение — наблюдаемый факт, а не молчание.

В RFDB обе рукоятки **уже проложены и одна из них не потребляется**. `EvalLimits`
(`packages/rfdb-server/src/datalog/eval.rs:509-535`):

```rust
pub struct EvalLimits {
    pub deadline: Option<Instant>,
    pub max_intermediate_results: usize,   // default 100_000
    pub max_recursion_depth: usize,        // default 64
    pub cancelled: Option<Arc<AtomicBool>>,
}
```

`EvalLimits` уже передаётся в `Executor::with_limits` (`exec.rs:805-811`). При этом:

```
$ grep -n "max_recursion_depth\|max_intermediate_results" packages/rfdb-server/src/derive/exec.rs
3134:    /// Per-stratum intermediate-result ceiling (`EvalLimits::max_intermediate_results`).
3136:        if rows.len() > self.limits.max_intermediate_results {
…
```

`max_intermediate_results` потребляется (`exec.rs:3134-3145`, код `E-EXEC-001`),
**`max_recursion_depth` — нет ни одного вхождения в `derive/`**. У восходящей неподвижной точки
нет глубины рекурсии, поэтому поле лежит неиспользованным. Нисходящая раскрутка — его
естественный и единственный потребитель. Значение по умолчанию `100_000` совпадает с бюджетом
v0 буквально; `64` против `512` — параметр, который выставляется при переводе.

---

## 5. Вопрос 6, вынесенный вперёд. Демандный факт — это КЭШ, а не состояние

Этот вопрос стоит шестым в задании, но его ответ определяет весь механизм, поэтому он идёт до §6.

Первое измерение (`/tmp/v0-demand-probe.ts`, D1) показывало кортеж в `factKeys('p')` после
запроса и наводило на мысль, что демандные результаты нужно записывать в хранилище. **Это
опровергнуто.** `/tmp/v0-demand-provenance2.ts`:

```
E10 store p after query:        ["p[main](a,c)"]
E10 store p after assert+eval:  ["p[main](a,c)"]
E10 evaluate():                 {"partial":false}
E10 store p after evaluate:     []                       ← обычный пересчёт СТИРАЕТ его
E10 why p(a,c) now:             {"ok":false,"text":"p[main](a,c) does not hold; …"}

E12 store p before tick:        ["p[main](a,c)"]
E12 tickAdvance:                {"advanced":true,"quiescent":false,"partial":false}
E12 store p after tick:         []                       ← смена такта тоже стирает

E13 store record for p(a,c):
    {"key":"p[main](a,c)","rel":"p","persp":"main","args":[…],
     "scope":"tick","base":false,"frozen":false}
E13 derived_by facts:
    ["derived_by[main]($fact(p,main,$cons(a,$cons(c,$nil))),r4122722b,0)"]
```

Запись `scope: "tick", base: false` в точности соответствует коду `engine.ts:426`
(`{ scope: 'tick', base: false }`), а `derived_by` пишется с `scope: 'timeless'`
(`engine.ts:434`). Код и прогон согласуются.

**Вывод: демандная материализация в v0 — внутрипрогонный кэш, привязанный к такту. Любой полный
пересчёт его сбрасывает, следующий вызов создаёт заново.** Значит RFDB **не обязан** ничего
записывать в хранилище — и не должен.

### 5.1 Побочный эффект, который придётся объявить: состояние зависит от порядка запросов

```
E3 open query rows:             ["A = a, B = ?B","A = b, B = ?B"]
E3 store after open query:      []
E3 canonicalState moved:        false        ← открытый ответ следов не оставляет

E4 store:                       ["p[main](a,c)"]
E4 canonicalState moved:        true         ← основный запрос ЯВЛЯЕТСЯ записью

E6 store A (asked 2 ground):    ["p[main](a,c)","p[main](b,d)"]
E6 store B (asked 1 ground):    ["p[main](b,d)"]
E6 canonicalState equal:        false
```

Два хранилища с одинаковой программой и разной историей запросов **расходятся** в снимке. Это
не наша ошибка и не наш выбор — это свойство v0, и оно живёт ровно в окне между демандным
запросом и следующим полным пересчётом. Для приёмочных сверок по каноническому состоянию это
означает: **снимок сравнивать только на неподвижной точке полного пересчёта.** Раз демандные
результаты в RFDB вообще не идут в хранилище, окно расхождения у RFDB отсутствует —
расхождение появится только при сравнении с v0, снятым внутри окна.

### 5.2 Провенанс уже сегодня не дыра — и это проверяемо на реальном сценарии

Сценарий `p4-sensors` (`packages/rofl-conformance/src/scenarios.ts:508-535`) **требует**
провенанса, проходящего сквозь демандные факты: он проверяет `why('outlier[trust](s3)')` на
совпадение с `/close\[main\]\(95,20\)/`, а `close/2` — демандное отношение. Прогон
(`/tmp/v0-sensors-why.ts`):

```
load BOOT ok=true ; load SENSORS ok=true
demandRels: ["close","corroborated","temp"]
store close BEFORE any query: ["close[main](20,21)","close[main](21,20)"]

--- why outlier[trust](s3) ---  ok=true
  outlier[trust](s3)  <= rdad10017 @tick 0
    reading[s3](t1,95) [axiom]
    not corroborated[trust](s3) [finite failure]
      whynot corroborated[trust](s3):
        rule rc44e6f13: corroborated[trust](?S)@now :- reading[?S](?T,?V1)@now,
                        reading[?S2](?T,?V2)@now, ?S != ?S2, close[main](?V1,?V2)@now
          failed premise: close[main](95,20)
          failed premise: close[main](95,21)
          failed premise: s3 != s3 [builtin fails]

--- excise reading[s1](t1, 20) ---  ok=true
removed: ["close[main](20,21)","close[main](21,20)","corroborated[trust](s1)",
          "corroborated[trust](s2)","reading[s1](t1,20)","temp[verified](t1,20)",
          "temp[verified](t1,21)"]
added:   ["outlier[trust](s2)"]
```

Три вещи, которые отсюда следуют.

**(а) Раскрутка происходит и при восходящем прогоне, не только по запросу.** `close[main](20,21)`
лежит в хранилище **до** первого запроса — `load()` вызывает `ensure()`, безопасные потребители
(`corroborated`) обращаются к `close/2` как к посылке, и `matchPremise` раскручивает её прямо
внутри восходящей неподвижной точки. Это ровно то, что говорит комментарий над `solveBody`
(`engine.ts:319`): «shared by bottom-up firing, demand unfolding, and whynot».

**(б) `why` и `whynot` в v0 расходятся на демандном факте, пока он не материализован.**

```
E1 store BEFORE why:            []
E1 why p(a,c):                  {"ok":false,"text":"p[main](a,c) does not hold; try: whynot p(a, c)"}
E1 store AFTER  why:            []
E2 whynot p(a,c) (IS derivable):{"holds":true,"text":"p(a, c) holds; nothing to demonstrate"}
```

Механизм: `why` (`api.ts:247-249`) — это чистый просмотр хранилища
(`if (!this.store.has(key)) return { ok: false, … }`), а `whynot` (`api.ts:302`) идёт через
`ev.matchPremise(...)`, то есть через раскрутку. На программе `sensors` расхождения не видно
только потому, что безопасные потребители уже материализовали `close/2` во время `load()`.

**(в) Радиус поражения `excise` по демандным отношениям точен там, где их тянет безопасное
правило, и завышен там, где их материализовал только ad-hoc-запрос.** `excise`
(`api.ts:349-384`) — это сухой пересчёт на клоне (`scratch.store = this.store.clone()`;
собственное хранилище не меняется). На `sensors` демандные факты пересоздаются на клоне
безопасными потребителями, поэтому `removed` точен. На игрушечной программе без потребителя:

```
E9 store p:                     ["p[main](a,c)"]
E9 excise q(b) (UNRELATED):     {"ok":true,"removed":["p[main](a,c)","q[main](b)"],"added":[]}
```

`q(b)` не поддерживает `p(a,c)` никак, но `p(a,c)` попадает в `removed` — потому что на клоне
его никто не пересоздал. Это дефект v0, а не семантика; при сверке текста он даст расхождение
только на программах без безопасного потребителя, а таких в наборе нет.

### 5.3 В RFDB провенанс демандного факта получается бесплатно

`witness_fact` (`exec.rs:1222-1258`) устроен ровно как нисходящая раскрутка: он берёт основный
кортеж, строит `head_bound_row(clause.rule.head(), key)` и **проигрывает ножки плана через тот
же `apply_leg`**:

```rust
for clause in clauses.iter().filter(|c| c.head_pred == pred) {
    let Some(init) = head_bound_row(clause.rule.head(), key) else { continue; };
    let mut rows = vec![init];
    for leg in &clause.plan.legs {
        if rows.is_empty() { break; }
        rows = self.apply_leg(leg, rows, relations, false)?;
    }
```

`witness_gap` (`exec.rs:1267-1314`) — то же самое, но следит, на какой ножке привязки схлопнулись
в пустоту. Значит: **как только `apply_leg` научится раскручивать демандную ножку, `why` и
`whynot` получают демандный провенанс без единой дополнительной строки.** Дыры не возникает.

Более того, RFDB получится **строже** v0: `explain_fact` (`exec.rs:3348-3365`) сначала полностью
вычисляет программу, потом воспроизводит тело с привязанной головой, — у него нет разделения
«`why` смотрит в хранилище, `whynot` считает». Разъезда пункта (б) в RFDB не будет.

**Открытый вопрос владельцу, не решаемый в одиночку (§11):** воспроизводить ли расхождение
`why`/`whynot` из пункта (б) ради побайтовой сверки текста, или считать его дефектом v0 и
зафиксировать как заявленное расхождение. Ни один сценарий набора его не проверяет (`why` над
демандным отношением вызывается только в `p4-sensors`, где факт уже материализован), поэтому
проект **рекомендует не воспроизводить** и внести в реестр расхождений.

---

## 6. Вопрос 3. Механизм в RFDB: где живёт и что меняется

Стержень угла Б: **у RFDB уже есть нисходящий вычислитель с привязанной головой.** Это
`head_bound_row` (`exec.rs:3706-3735`) плюс `clause_derives_head` (`exec.rs:1139-1163`),
`witness_fact` (`:1222`), `witness_gap` (`:1267`). Все три делают буквально то же, что
`solveDemandRule` в v0: унифицируют голову с целью, потом проигрывают тело. Не хватает двух
вещей: рекурсии и достижимости из ножки тела.

Поэтому демандный режим строится **как дополнение к существующему исполнителю**, а не рядом с
ним. Ниже — по слоям.

### 6.1 Парсер (`derive/parser_ext.rs`) — БЕЗ ИЗМЕНЕНИЙ

Небезопасное правило уже разбирается; отказ возникает позже, в планировщике
(`E-PLAN-002`, измерено в R6/R8/R9) либо не возникает вовсе (голова, измерено в R5).
Требование фактов-без-тела быть основными остаётся за линией перспектив
(`rofl-perspectives-design.md:993`, `E-PERSP-002`).

### 6.2 Новый модуль `derive/demand.rs` — вычисление демандного множества

```rust
/// Множество отношений, вычисляемых по запросу. Транскрипция v0 `prepare()`
/// (vendor/rofl-v0/src/engine.ts:80-105): отношение демандное, если хоть одно
/// его правило небезопасно, либо если оно зависит от демандного через
/// ПОЗИТИВНУЮ посылку. Неподвижная точка по именам предикатов.
pub struct DemandSet { rels: BTreeSet<String> }

pub fn demand_relations(rules: &[&Rule]) -> DemandSet;
```

Критерий «правило небезопасно» — это `Rule::is_safe()` (`datalog/types.rs:209-219`), сегодня
мёртвый код, **плюс** учёт выходных мод встроенных предикатов (иначе `boot.rofl:20`
`N is M + 1` даст ложное срабатывание — та же ошибка, что у транслятора). Проверка выходных мод
уже существует отдельно: `BuiltinDef::check_mode`
(упомянут в `derive/plan.rs:1241`, код `PlanCode::UnsupportedMode` = `E-PLAN-001`,
`plan.rs:182`). `demand_relations` вызывает её, а не переизобретает.

Уровень имён здесь тот же, что у стратификации, — и это не совпадение: v0 держит демандное
множество на статическом слое имён (`engine.ts:384` `demandRels.get(lit.rel)`), там же, где
стратификацию (`engine.ts:182` `strat.get(r.clause.head.rel)`). Это ровно то разделение,
которое зафиксировала линия перспектив (`rofl-perspectives-design.md:262`). Поэтому демандное
множество и стратификация согласованы по построению, и перспективы его не ломают.

### 6.3 Планировщик (`derive/plan.rs`) — три точечных изменения

**(1) Обобщённое исключение для отрицаемой ножки — механизм I.** `can_place_and_provides`
(`plan.rs:938-950`) перестаёт требовать связанности переменных, встречающихся **только** внутри
отрицаемых литералов, и (по решению линии перспектив) поля перспективы. Такие позиции
помечаются как экзистенциальные в новом поле `PlanLeg`; равенства между повторными вхождениями
внутри **одного** литерала сохраняются как диагональ (§3.2, прогон D8/D8b), между **разными**
литералами — нет (§3.1, прогон D9).

**(2) План демандного правила строится БЕЗ переупорядочивания.** Новая функция
`plan_demand_rule(rule, catalog) -> RulePlan` кладёт ножки в **исходном порядке**, минуя
`order_literals` (`plan.rs:722-830`). Это не упрощение, а точное соответствие: v0 не имеет
планировщика вовсе, `solveBody` (`engine.ts:323`) идёт `for (let i = 0; i < body.length; i++)`.
Побочная выгода — `order_literals` не трогается ни одной строкой, значит золотой файл планов
не может сдвинуться из-за него.

**(3) Гарантия §3 для демандного правила не применяется.** `MAX_MATERIALIZED_FACTS`
(`plan.rs:42`, `10_000_000`) ограничивает восходящую материализацию; у нисходящей раскрутки
размер выхода ограничен вызовом, а не оценкой. Её ограничивают счётчики §4.

### 6.4 Исполнитель (`derive/exec.rs`) — единственное содержательное место

`Executor` получает два поля: `demand: Arc<DemandSet>` и `demand_clauses:
HashMap<String, Vec<Clause>>` (планы демандных правил из пункта 6.3(2)), плюс счётчик глубины.

Единственная развилка ставится в `apply_leg` (`exec.rs:1700-1724`), в существующую ветку:

```rust
LegSource::Derived { name, .. } if self.demand.contains(name) => {
    self.unfold_demand(leg, name, rows, relations)
}
LegSource::Derived { name, .. } => Ok(self.join_derived(leg, name, rows, relations, use_delta)),
```

`unfold_demand` — прямая транскрипция `solveDemandRule` (`engine.ts:407-438`), на структурах
RFDB:

1. счётчик шагов (существующий `check_rows`, `exec.rs:3134`) и глубины
   (`limits.max_recursion_depth`, сегодня не потребляется — §4);
2. для каждой строки `row` и каждого демандного правила: посеять `BindRow`, унифицировав
   аргументы головы с аргументами вызова в текущей подстановке. Это `head_bound_row`
   (`exec.rs:3706-3735`), обобщённый с «основный ключ» на «частично связанный вызов» —
   существующая функция уже умеет и константы, и типизированные литералы, и повтор переменной
   (`:3713-3719` возвращает `None` при несогласии повторного вхождения);
3. прогнать ножки правила через **тот же `apply_leg`** (рекурсия ⇒ вложенные демандные ножки
   раскручиваются сами);
4. для каждой выжившей строки — `project_head` (`exec.rs:3687`). Если кортеж полностью основной:
   положить в `relations[name].total` (**в памяти прогона, не в хранилище** — §5), записать
   свидетельство и продолжить строку вызывающего. Если нет — **открытый результат**: строка
   вызывающего продолжается со связанными позициями, свободные остаются свободными
   (v0 `engine.ts:436`, измерено D1: `"A = a, B = ?B"`).

Отрицаемая ножка по демандному отношению идёт по тому же пути (§3.5, прогон D10): антисоединение
обязано вызвать раскрутку, а не читать `Total`.

`project_head`'s комментарий (`exec.rs:3685-3686`) исправляется на правду, а его `None` перестаёт
быть молчаливым: для **не**демандного правила несвязанная переменная в голове — это отказ, а не
пустой результат (см. §9, шаг 0).

### 6.5 Хранилище — БЕЗ ИЗМЕНЕНИЙ, и это главный вывод §5

Демандные кортежи живут в `Evaluation.relations` на время прогона. Единственная правка вне
`exec.rs` — фильтр в обратной записи: `eval_datalog_v2_materialize` не выгружает демандные
отношения в рёбра. Это защищает `@materialize` с его провенанс-эксклюзивностью
(ruling R-3, `OWNER-RULINGS.md`) и путь обратной записи рёбер целиком.

### 6.6 Радиус по золотому файлу планов

`packages/rfdb-server/src/derive/golden/p3_plan_fingerprints.txt` — 40816 строк
(`wc -l` → `40816`). Генератор `plan_golden.rs:204-238` даёт одну строку на правило, а
отпечаток берётся с `render_plan` (`plan_golden.rs:168-190`), который печатает
`l.literal` через `{:?}`, `l.pattern`, `render_source(&l.source)`, `l.join`, `l.estimate`,
и на уровне правила — `p.head`, `p.estimate`, `p.head_domains`.

Отсюда три обязательства проекта:

* `order_literals` не меняется ⇒ порядок ножек существующих правил не двигается (6.3(2));
* новое поле экзистенциальных позиций в `PlanLeg` (6.3(1)) **не попадает** в `render_plan`;
  на безопасных правилах оно пусто в любом случае;
* новых вариантов `LegSource` не вводится вовсе — демандность является свойством
  **программы**, а не ножки, и живёт в `DemandSet` на исполнителе. Печать источника не
  меняется.

Гейт: `git status --short packages/rfdb-server/src/derive/golden/` пуст после изменения, файл
по-прежнему 40816 строк и побайтово тот же.

---

## 7. Вопрос 5. Инкрементальное сопровождение и удаление по DRed

Ответ вытекает из §5 и оказывается коротким: **демандные отношения исключаются из
сопровождаемой оболочки.**

Обоснование — не удобство, а измерение. v0 сбрасывает демандный кэш при любом полном
пересчёте (`E10 store p after evaluate: []`) и при смене такта (`E12`). То есть у v0
инкрементального сопровождения демандных отношений **не существует**; он их пересчитывает.
Воспроизводить надо это, а не что-то более умное.

Механически в RFDB:

* **Инкрементальный ход.** `maintain_incremental` (`exec.rs:3226`) и дельта-алгебра
  `derive/increment.rs` (457 строк; `RelationDelta`/`diff`/`apply_set`/`apply_counted`/`BaseDelta`)
  работают над дельтой базы. У демандного отношения нет устойчивого `Total` между прогонами,
  значит нечего diff-ить. Программа, содержащая хоть одно демандное отношение, не пользуется
  закреплённым кэшем `(ReadSnapshot, Evaluation)` — она идёт полным пересчётом. Это не новая
  машинерия: у движка уже есть та же развилка «монотонная оболочка ⇒ сопровождать, иначе
  пересчитать».
* **Ножка-дельта.** `LegSource::Base { .. } if use_delta` (`exec.rs:1711`) остаётся как есть;
  демандная ножка никогда не бывает дельта-ножкой, потому что `use_delta` относится к базе или
  к рекурсивной ножке того же слоя.
* **DRed, фаза «сверх-удаление».** `over_delete` (`exec.rs:1005`) собирает кандидатов из
  `relations`; демандные отношения из множества кандидатов **исключаются** — у них нет
  устойчивого `fact_id` в хранилище, и удалять нечего.
* **DRed, фаза «повторный вывод» — здесь механизм угла Б окупается.** `rederive`
  (`exec.rs:1172-1214`) проверяет каждого кандидата через `clause_derives_head`
  (`exec.rs:1139-1163`), а тот идёт по `self.apply_leg(leg, rows, relations, false)`
  (`exec.rs:1156`). **Как только `apply_leg` умеет раскрутку, повторный вывод получает
  демандную поддержку без единой правки в `rederive`.** Ровно то же для `witness_fact`
  (`exec.rs:1238`) и `witness_gap` (`exec.rs:1283`).

Это и есть содержательная причина выбрать точку врезки именно в `apply_leg`, а не выше:
четыре разных обхода тела (восходящий шаг, повторный вывод DRed, `why`, `whynot`) уже проходят
через него, и все четыре получают демандный режим одновременно и согласованно. Ровно так же
устроен v0: `solveBody` объявлен «shared by bottom-up firing, demand unfolding, and whynot»
(`engine.ts:319`).

Что при этом **обязано** сохраниться: потолок итераций `DEFAULT_ITERATION_CAP = 10_000`
(`exec.rs:107`) и его код `E-EXEC-002` (`exec.rs:167`); отмена `E-EXEC-003`
(`exec.rs:1693-1699`) — раскрутка обязана проверять флаг отмены на каждом уровне, иначе глубокая
рекурсия переживёт отключившегося клиента.

---

## 8. Вопрос 7. Сцепление с тремя остальными линиями четырёхчастного ядра

### 8.1 Перспективы — сцепление сильное, в трёх местах

1. **Исключение в `plan.rs:940` — общее.** Механизм I (§3.3) и вердикт линии перспектив
   (`rofl-perspectives-design.md:433-440`) — это одно и то же изменение одного условия. Реализуется
   один раз, обобщённо по позициям и по полю перспективы. Раздельная реализация даст два
   расходящихся правила.
2. **`Atom::variables()` включает перспективную переменную**
   (`rofl-perspectives-design.md:991`). Это то, что делает вычисление демандного множества (§6.2)
   верным для головы с перспективной переменной — v0 требует основности и перспективы тоже
   (`engine.ts:158`), измерено D6.
3. **Раскрутка ключуется по внутренней карте перспектив.** После перспектив
   `relations: HashMap<String, BTreeMap<String, Relation<T>>>`
   (`rofl-perspectives-design.md:275`), и демандный кортеж кладётся в запись разрешённой
   перспективы. Голова с `Persp::Var`, оставшаяся несвязанной, **пропускается с диагностикой**
   (там же, `:475-477`) — и это единственный случай, который вообще возможен только через
   демандную голову.

Порядок: механизм I разумно вести **вместе** с приращением 2 линии перспектив, а не отдельной
волной.

### 8.2 Правила-как-данные — сцепление слабое, но одно требование жёсткое

Демандное множество — функция от текущего набора правил. Правила, добавленные во время
исполнения, меняют его. В RFDB программа приходит текстом в `parse_ext_program`, и
`demand_relations` считается на прогон — инвалидации кэша не возникает. Требование:
`DemandSet` **не кэшируется** между прогонами по имени программы.

Вторая точка: словарь рефлексии (`vendor/rofl-v0/src/reflect.ts`) кодирует правила в факты;
демандные правила кодируются наравне с прочими, и `stratum`/`edb` обязаны согласоваться с
демандным множеством. Согласование обеспечено тем, что оба слоя ключуются именем предиката
(§6.2).

### 8.3 Диалект — жёсткая предпосылка для четырёх из семи настоящих кейсов

`close[main](V1,V2) :- D is -(V1,V2), D <= 2, D >= -2.` требует `is` с выходной модой и
типизированных числовых литералов. Сегодня встроенных `sub`/`lte`/`gte` нет:

```
=== R10 the v0 output-mode idiom: close(V1,V2) :- D is V1-V2, ...  (RFDB has no `is`) ===
    | close(V1, V2) :- sub(V1, V2, D), lte(D, 2), gte(D, -2).
    -> 0 rows
=== R11 self-unification idiom: p(X) :- eq(X, X). ===
    -> 0 rows
```

Плюс ruling R-14 (`OWNER-RULINGS.md`): `wire_string_to_value`
(`bin/rfdb_server.rs:3205-3210`) объявлен **дефектом провода**, подлежащим починке, а не
отсутствующей возможностью. Без него `V = 20` в `p4-sensors` не переживёт круг.

Вывод: демандный режим **не может** закрыть `close/2`, `corroborated/2`, `temp/2` раньше, чем
линия диалекта даст `is` и типизированные числа.

### 8.4 Составные термы — жёсткая предпосылка для оставшихся трёх кейсов

`app/3` и `move/5` держат переменные головы **внутри** `cons(...)` / `tape(...)`. У RFDB
`Term` не имеет составной формы, и линия перспектив это фиксирует прямо
(`rofl-perspectives-design.md:306`: «`Term` has no compound form and does not need one»).

### 8.5 Итог по отдаче: демандный режим сам по себе не закрывает НИ ОДНОГО кейса

Полные списки блокеров семи настоящих демандных кейсов (`/tmp/R14-percase.json`):

```
p1-functor-append     [dialect:untranslatable, missing:compound-terms, missing:demand-mode]
p3-snapshot-roundtrip [dialect, demand-mode, perspectives, rules-as-data, snapshot, temporal]
p4-replay             [dialect, demand-mode, perspectives, rules-as-data, snapshot, temporal]
p4-tm                 [dialect, compound-terms, demand-mode, perspectives, rules-as-data, temporal]
p4-tm-diverge         [dialect, compound-terms, demand-mode, holes, perspectives, rules-as-data, temporal]
p4-sensors            [dialect, demand-mode, excise, perspectives, rules-as-data, temporal, whynot-shape]
p4-forged             [dialect, demand-mode, perspectives, rules-as-data, temporal]
```

Каждый заблокирован ещё как минимум двумя линиями. **Это не довод отложить работу** — это довод
поставить механизм I вперёд механизма II, потому что механизм I разблокирует `boot.rofl`,
от которого зависят 15 из 25 красных кейсов, и стоит он на порядок дешевле.

---

## 9. План приращений

**Шаг 0 — закрыть молчаливый ноль (обязателен независимо от всего остального).**
Несвязанная переменная в голове **не**демандного правила перестаёт быть пустым результатом и
становится отказом планировщика со стабильным кодом. `Rule::is_safe()`
(`datalog/types.rs:209`) впервые получает производственный вызов. Комментарий
`exec.rs:3685-3686` приводится в соответствие. Закрывает нарушение I5, измеренное в R5/R5b/R12/R4.

**Шаг 1 — механизм I: экзистенциальное отрицание** (§3, §6.3(1)), совместно с приращением 2
линии перспектив. Снимает `E-PLAN-002` на `boot.rofl:31`. Ожидаемый эффект: одна из четырёх
подлиний ядра закрыта по-настоящему.

**Шаг 2 — исправить фазу 9 транслятора** (`translate.ts:214-251`): `posVars` учитывает
`b.lit.persp` и выходные моды встроенных; константа и повторная переменная в голове перестают
быть отказом (измерено R1/R2/R3). Ожидаемый эффект: 11 ложных срабатываний
`missing:demand-mode` исчезают, счётчик 18 → 7.

**Шаг 3 — механизм II: `derive/demand.rs` + `unfold_demand`** (§6.2, §6.4). Ставится после
того, как линии диалекта и составных термов дадут свои предпосылки, иначе закрывать всё равно
нечего (§8.5).

---

## 10. Приёмочные тесты

Каждый обязан **уметь провалиться**; для каждого указано, что сегодня даёт красный.

| # | тест | сегодня |
|---|---|---|
| 1 | `derive::exec::unbound_head_variable_is_rejected_not_silently_dropped` — `p(X,Y) :- q(X).` даёт стабильный код отказа, а не `Ok(vec![])` | проваливается: измерено `-> 0 rows` (R5) |
| 2 | `derive::plan::negated_leg_free_named_var_is_existential` — `z(X) :- q(X), \+ u_r(Y).` планируется; `X=a` при пустом `u_r`, 0 строк при `u_r("zzz")` | проваливается: `E-PLAN-002` (R6) |
| 3 | `derive::exec::negated_leg_repeated_free_var_is_a_diagonal` — `\+ u_r(Y,Y)` при `u_r("a","b")` даёт `X=a`; при `u_r("a","a")` — 0 строк | проваливается: `E-PLAN-002` (R9); подстановочный обход даёт **неверный** ответ (R9b) |
| 4 | `derive::exec::two_negated_legs_do_not_share_a_free_var` — `\+ u_r(Y), \+ u_s(Y)` при `u_r("b")` даёт 0 строк | проваливается: `E-PLAN-002` |
| 5 | `derive::exec::boot_leak_clause_plans_and_evaluates` — форма `boot.rofl:31` даёт `{"A":"x","B":"y"}` | проваливается: `E-PLAN-002 (leak)` (R8) |
| 6 | `derive::demand::demand_set_matches_v0_prepare` — на трёх измеренных программах даёт ровно `{app,joined}` / `{close,corroborated,temp}` / `{move,step}` | проваливается: модуля нет |
| 7 | `derive::demand::boot_rofl_has_no_demand_relations` — на ядре демандное множество ПУСТО | проваливается на любой над-аппроксимации (напр. если считать повторную переменную в голове небезопасной) |
| 8 | `derive::exec::demand_leg_yields_an_open_row` — `p(X,Y) :- q(X).` на запрос `p(A,B)` даёт строки со связанным `A` и несвязанным `B` | проваливается: 0 строк |
| 9 | `derive::exec::demand_unfold_depth_is_capped` — взаимная демандная рекурсия завершается кодом лимита, а не зависанием (ориентир v0: 249 мс) | проваливается: пути нет |
| 10 | `derive::exec::demand_results_never_reach_storage` — после материализации программы с демандным отношением в хранилище нет ни одного демандного кортежа | проваливается, если фильтр обратной записи забыт |
| 11 | `derive::exec::why_of_a_demand_derived_fact_names_its_support` — `explain_fact` над демандным фактом возвращает `DerivationWitness` с телом-посылкой | проваливается: факт не выводится |
| 12 | `derive::exec::dred_rederive_sees_demand_support` — удаление базового факта, поддерживающего демандного потребителя, убирает потребителя; восстановление возвращает | проваливается: пути нет |
| 13 | `plan_golden` — `git status --short packages/rfdb-server/src/derive/golden/` пуст; `p3_plan_fingerprints.txt` = 40816 строк и побайтово тот же | проваливается при любом сдвиге порядка ножек или печати плана |
| 14 | `cargo test --lib` — 0 упавших, база 1607 пройденных / 28 пропущенных не уменьшается | проваливается при любой регрессии |
| 15 | конформанс: пофайловые списки блокеров сверяются с ожидаемыми; `missing:demand-mode` = 7, а не 18, после шага 2 | проваливается сегодня: 18 |

---

## 11. Отвергнутые альтернативы

**Магические множества (magic sets) / подстановочная трансформация.** Переписать небезопасные
правила в безопасные с вспомогательными предикатами и оставить чистую восходящую неподвижную
точку. Отвергнуто по двум причинам, одна из которых фатальна. Фатальная: трансформация выводит
**только основные** факты, а v0 возвращает открытые ответы как привязки — измерено D1
(`"A = a, B = ?B"`) и D3 (`"Z = ?Z"`); воспроизвести их магическими множествами нельзя в
принципе. Вторая: трансформация меняет набор правил, а золотой файл даёт одну строку на правило
(`plan_golden.rs:200`), то есть 40816 строк поедут на любой программе, которую она затронет.
Отдельно: никакой такой машинерии в дереве нет —
`grep -rni "magic.set\|demand" --include=*.rs packages/rfdb-server/src` возвращает только
несвязанную прозу.

**Отдельный нисходящий интерпретатор рядом с движком** (буквальный порт `solveBody`).
Отвергнуто: дублирует семантику ножек (встроенные, диспетчеризация базы, антисоединение,
отмена, лимиты), поэтому каждая будущая возможность ножки потребует двух реализаций; и — главное
— не наследует бесплатно `clause_derives_head`, `witness_fact`, `witness_gap`, то есть DRed и
провенанс пришлось бы писать заново (§7).

**Устойчивая материализация демандных результатов в хранилище.** Первое прочтение D1 наводило
именно на это. Отвергнуто измерением: v0 сбрасывает их при первом же полном пересчёте
(`E10 store p after evaluate: []`) и при смене такта (`E12`). Устойчивая запись развела бы RFDB
с v0 после любого пересчёта и отравила бы провенанс-эксклюзивность `@materialize` (ruling R-3).

**Переписывание `not r(Y)` → `not r(_)` в трансляторе.** Дёшево и почти работает. Отвергнуто
как **несостоятельное**: неверно для повторной свободной переменной внутри одного литерала.
Обе стороны измерены: v0 `not r(Y,Y)` при `r(a,b)` → `["A = a"]` (D8); RFDB `\+ u_r(_,_)` при
`u_r("a","b")` → 0 строк (R9b). Это молчаливо неверный ответ, худший исход, чем честный отказ.

**Постоянное расхождение: отвергать небезопасные правила навсегда.** Отвергнуто: семи красным
кейсам механизм нужен по существу, а объём работы ограничен и понятен — это не месячная
неопределённость, а два приращения известной формы.

**Провести демандность через `PlanLeg` / `LegSource` / `render_plan`.** Отвергнуто в пользу
бокового множества на исполнителе: демандность — свойство программы, а не ножки (одно и то же
имя предиката демандно в одной программе и не демандно в другой), и любое попадание в
`render_plan` создаёт риск для 40816 строк там, где риска можно не иметь вовсе.

**Переупорядочивать тело демандного правила планировщиком.** Отвергнуто: v0 планировщика не
имеет и идёт исходным порядком (`engine.ts:323`), а любой заход в `order_literals`
(`plan.rs:722`) — это ровно та функция, чей вывод отпечатан в золотом файле.

---

## 12. Открытые риски и то, что вне периметра

1. **Расхождение `why`/`whynot` в v0 (§5.2(б)) — решение владельца.** Проект рекомендует не
   воспроизводить дефект и внести в реестр расхождений; ни один сценарий его не проверяет, но
   решение о побайтовой сверке текста — не моё.
2. **Завышенный радиус `excise` над демандными отношениями без безопасного потребителя**
   (§5.2(в), прогон E9). В текущем наборе таких программ нет; при сверке `removed` как множества
   это станет расхождением ровно тогда, когда такая программа появится.
3. **Зависимость канонического состояния от порядка запросов в v0** (§5.1, прогон E6). У RFDB
   этого окна нет, потому что демандные результаты не идут в хранилище; но сверка снимков с v0
   обязана делаться на неподвижной точке полного пересчёта, иначе сравниваются разные вещи.
   Это условие приёмки, а не деталь реализации.
4. **`max_recursion_depth = 64` против `MAX_DEPTH = 512` у v0.** Разные значения дадут разную
   границу «где начинается дыра». На `p4-budget-hole` и `p4-tm-diverge` это наблюдаемо. Значение
   придётся выставлять по измерению, а не по умолчанию.
5. **Бюджет как ошибка против бюджета как дыры.** Ruling R-2 (`OWNER-RULINGS.md`) требует
   «дыры побеждают»: частичный результат плюс сертификат `hole/2`, а не отказ без фиксации.
   Сегодняшний исполнитель отказывает (`E-EXEC-001`/`E-EXEC-002`/`E-EXEC-003`). Приведение к
   R-2 — работа линии дыр/темпоральности, не этой; демандный режим обязан лишь **не мешать**
   ей, то есть докладывать исчерпание бюджета отдельным кодом, а не сливать его с
   `E-EXEC-001`.
6. **Расширение периметра, которое я не делаю, но обязан назвать.** Шаг 0 (§9) формально
   выходит за «демандный режим»: он чинит уже существующее нарушение I5, вскрытое измерением
   R5/R5b/R12/R4. Он безусловно нужен и обязан быть отдельным решением владельца, а не тихо
   въехать в эту линию.
7. **Не измерено: стоимость раскрутки на реальном графе.** Все прогоны — на фикстурах ROFL.
   Влияние `unfold_demand` на 35 связанных пакетов правил равно нулю по построению (их
   демандное множество пусто), но это утверждение проверено рассуждением о §6.2, а не прогоном
   на корпусе.
