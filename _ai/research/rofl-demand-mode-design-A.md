# Режим «по запросу» — проект, снятый с реализации эталона v0

**Угол А: сначала верность, потом красота.** Всё, что здесь написано про эталон, снято не с чтения
кода, а с прогонов: каждый механизм подпёрт командой и её выводом. Всё, что написано про RFDB,
подпёрто либо `file:line` в рабочем дереве, либо живой пробой против релизного бинаря
(`packages/rfdb-server/target/release/rfdb-server`, serverVersion 0.4.1, protocol v3, `datalogDerive`
в features).

**Дата:** 2026-08-23. **Эталон:** `packages/rofl-conformance/vendor/rofl-v0/`, rev `052a4c5`.
**Ветка:** rofl-v1, HEAD `09dbe1cf`. Ничего не реализовано — это проект.

Пробы лежат в `/tmp/dmz/` (вне репозитория). Каждая запускается как
`node --experimental-strip-types /tmp/dmz/<файл>.ts` из `/home/dev/grafema-rofl`.

---

## 0. Главный вывод: линия названа неправильно, и это не косметика

Код отказа `missing:demand-mode` выдаётся транслятором в **четырёх** разных местах
(`packages/rofl-conformance/src/translate.ts:214-251`). Я разложил их по одному и проверил каждое
живой пробой. Результат:

| Условие транслятора | Строка | Что делает RFDB сегодня (живая проба) | Настоящий пробел движка? |
|---|---|---|---|
| голова не именованная переменная (константа/литерал в голове) | `translate.ts:231-232` | **принимает**, 2 строки | **нет** |
| повторная переменная в голове | `translate.ts:234-235` | **принимает**, 2 строки | **нет** |
| переменная головы не связана позитивной посылкой | `translate.ts:238-239` | молча **0 строк** | **да** — это Д1 |
| переменная под `not` не связана позитивной посылкой | `translate.ts:245-246` | **отвергает** `E-PLAN-002` | **да** — это Д2 |

Проба (`/tmp/dmz/rfdb-probe.ts`, живой сервер, релизный бинарь):

```
--- head-constant (boot: stratum(Rel,0) :- edb(Rel))
    u_stratum(V0, 0) :- u_edb(V0).   u_edb("a").   u_edb("b").
  => OK 2 rows: [{"V0":"a"},{"V0":"b"}]

--- head-repeated-var (boot: sees(P,P) :- perspective(P))
    u_sees(V0, V0) :- u_perspective(V0).   u_perspective("a").   u_perspective("b").
  => OK 2 rows: [{"V0":"a"},{"V0":"b"}]

--- head-var genuinely unbound (v0 demand: anything(X,Y) :- seed(Y))
    u_anything(V0, V1) :- u_seed(V1).   u_seed("s").
  => OK 0 rows: []

--- unsafe negation (boot:31 leak: not br(R,A,B), R free)
    u_leak(V0, V1) :- u_f(V0, V1), \+ u_br(V2, V0, V1).
  => ERR derive engine error [E-PLAN-002]: plan: E-PLAN-002 (u_leak):
     cannot order bound-first: no feasible binding for ["u_br"]
```

Ещё одно условие того же кода — «переменная головы связана только builtin-ом» (`boot.rofl:20`,
`N is M + 1`). Проверено контролем на существующем builtin-е (`/tmp/dmz/rfdb-probe2.ts`):

```
--- head-var bound by an EXISTING builtin (concat) — control
    u_j(V0, V1) :- u_p(V0), concat(V0, "!", V1).   u_p("a").   u_p("b").
  => OK 2 rows: [{"V0":"a","V1":"a!"},{"V1":"b!","V0":"b"}]
--- same, but the builtin-bound var is ONLY in the head
    u_j(V1) :- u_p(V0), concat(V0, "!", V1).   u_p("a").
  => OK 1 rows: [{"V1":"a!"}]
```

То есть RFDB прекрасно принимает переменную головы, связанную builtin-ом. `boot.rofl:20` не
переводится потому, что **в реестре derive-builtin-ов нет арифметики** (реестр перечислен в
`packages/rfdb-server/src/derive/builtin.rs:1660-1692` — тридцать имён, ни одного арифметического;
`add(V3, 1, V1)` даёт `OK 0 rows`, потому что `add` — не builtin, а несуществующий предикат).
Это линия **диалекта**, а не «по запросу».

**И самое важное.** «Небезопасное отрицание» — вообще **не** механизм режима «по запросу».
Проба `/tmp/dmz/r9.ts`:

```
=== Q: is UNSAFE NEGATION a demand mechanism at all? ===
--- leak with a free var under `not` (the boot.rofl:31 shape)
    load ok=true  demandRels=[]
    SAFE   leak[main](?A,?B)@now :- f[main](?A,?B)@now, not br[main](?R,?A,?B)@now
    ? leak(A, B) -> [A = c, B = d] partial=false
--- boot.rofl:31 verbatim relations
    load ok=true  demandRels=[]
    SAFE   leak[main](?A,?B)@now :- flow[main](?A,?B)@now, not sees[main](?B,?A)@now,
                                    not bridge_decl[main](?R,?A,?B)@now
    ? leak(A, B) -> [] partial=false

=== Q: is a genuinely UNBOUND HEAD VAR a demand mechanism? ===
--- unbound head var
    load ok=true  demandRels=["anything"]
    UNSAFE anything[main](?X,?Y)@now :- seed[main](?Y)@now
    ? anything(X, Y) -> [X = ?X, Y = s] partial=false
```

`demandRels` **пуст** для правила с `not br(R, A, B)`, и само правило классифицировано **SAFE**.
Причина в коде: `classify` (`engine.ts:130-160`) для ветки `neg` (`engine.ts:142-143`) не делает
ничего — отрицание не связывает переменных, но и не делает правило небезопасным. Небезопасность
даёт только несвязанная переменная **в голове** (`engine.ts:158`).

Значит:

* **Д1 — несвязанная переменная в голове.** Это и есть режим «по запросу»: нисходящая раскрутка.
  В корпусе он нужен **7** сценариям.
* **Д2 — свободная переменная под `not`.** Это обычная восходящая оценка с **экзистенциальным
  отрицанием**. Нужен **15** сценариям — тем самым пятнадцати, что делают `load(BOOT)`.

Разложение по сценариям (`/tmp/dmz/probe2.ts`, полный корпус tier-1):

```
real demand: 7   unsafe-neg: 15   both: 5   neither: 13
```

Все семь «настоящих demand» правил корпуса выглядят так:

```
app[main](cons(?H,?T),?Ys,cons(?H,?Zs))@now :- app[main](?T,?Ys,?Zs)@now
app[main](nil,?Ys,?Ys)@now :- ?Ys = ?Ys
close[main](?V1,?V2)@now :- ?D is -(?V1,?V2), ?D <= 2, ?D >= -2
move[main](l,cons(?H2,?L2),?W,?R,tape(?L2,?H2,cons(?W,?R)))@now :- ?H2 = ?H2
move[main](l,nil,?W,?R,tape(nil,0,cons(?W,?R)))@now :- ?W = ?W
move[main](r,?L,?W,cons(?H2,?R2),tape(cons(?W,?L),?H2,?R2))@now :- ?H2 = ?H2
move[main](r,?L,?W,nil,tape(cons(?W,?L),0,nil))@now :- ?W = ?W
```

Каждое требует либо составных термов (`cons`, `tape`), либо арифметики (`is`, `<=`). **Ни одно из
них нельзя прогнать на RFDB до того, как приедут линии составных термов и диалекта.** Это жёсткое
ограничение порядка работ, и оно вытекает из измерения, а не из вкуса.

А `boot.rofl` — тот самый узкий проход, через который проходят 15 из 25 RED — **не содержит ни
одного demand-правила вообще**. Проба `/tmp/dmz/r1.ts`:

```
load ok= true diags= []
--- rules: safe / hasNeg / head ---
SAFE   neg=n  breach[audit](?R)@now :- concludes[main](?R,?Rel)@now, reserved[main](?Rel)@now
...   (все 21 правило — SAFE)
--- demandRels ---
[]
```

**Отсюда следствие, отменяющее обоснование в трансляторе.** `translate.ts:232` мотивирует отказ
цитатой «v0 tolerates such heads via demand/moded evaluation (engine.ts:80-127)». Для `boot.rofl`
эта цитата ложна: раскрутки там нет, `demandRels` пуст. Обоснование надо переписать вместе с этой
линией (см. §8, тест П-1).

---

## 1. Механизм эталона — то, что он делает на самом деле

Не магические множества, не табуляция, не преобразование по требованию. Это **SLD-раскрутка в
стиле Пролога с ограничителем глубины и складом в роли мемоизации** — и ниже каждый её шаг с
кодом и с прогоном.

### 1.1 Классификация правил: восходящая материализуемость в написанном порядке

`classify` (`engine.ts:130-160`) идёт по телу **в написанном порядке**, накапливая множество
связанных переменных:

```ts
for (const b of r.clause.body) {
  if (b.t === 'pos') { posRels.push(b.lit.rel); for (const a of b.lit.args) bindAll(a); bindAll(b.lit.persp); }
  else if (b.t === 'neg') { hasNeg = true; }                    // не связывает НИЧЕГО
  else { if (b.op === '=') { if (groundIn(b.l)) bindAll(b.r); else if (groundIn(b.r)) bindAll(b.l); else safe = false; }
         else if (b.op === 'is') { if (groundIn(b.r)) bindAll(b.l); else safe = false; }
         else { if (!groundIn(b.l) || !groundIn(b.r)) safe = false; } }
}
const h = r.clause.head;
if (!h.args.every(groundIn) || !groundIn(h.persp)) safe = false;
```

Три следствия, каждое подтверждено прогоном:

1. **Отрицание не влияет на безопасность** (`/tmp/dmz/r9.ts`, выше: `leak` — SAFE).
2. **Builtin-ы связывают** (`=` в обе стороны, `is` слева направо), поэтому `close(V1,V2) :- D is
   V1 - V2, ...` небезопасно (`V1`,`V2` не связаны ничем), а `stratum(Rel,N) :- dep_neg(Rel,Q),
   stratum(Q,M), N is M + 1` — безопасно (`/tmp/dmz/r1.ts`: строка `SAFE ... ?N is +(?M,1)`).
3. **Перспектива головы участвует наравне с аргументами** (`engine.ts:158`, `groundIn(h.persp)`),
   и позитивная посылка связывает свою перспективу (`engine.ts:139`, `bindAll(b.lit.persp)`).

Порядок здесь буквально написанный: правило, которое стало бы безопасным при перестановке посылок,
эталон считает небезопасным. Это не деталь реализации, это семантика (`LIMITS.md:35-37`: «Rules
that are not range-restricted **in written premise order** are unfolded top-down at call sites;
premise order matters (Prolog-style)»).

### 1.2 Замыкание demand-отношений

`prepare()` (`engine.ts:79-105`), комментарий на месте:

> A relation is demand-backed (unfolded at call sites) when some `@now` rule defining it is unsafe,
> or transitively depends on a demand-backed relation through a positive premise. `@next` rules
> never unfold.

Замыкание — по позитивным посылкам, до неподвижной точки (`engine.ts:91-100`). `@next`-правила
выброшены до этого (`engine.ts:85`). Правила, заключающие в зарезервированное kernel-отношение,
выброшены ещё раньше, до классификации (`engine.ts:73-76`).

Проба `/tmp/dmz/r2.ts` показывает замыкание в работе на реальном `examples/sensors.rofl`:

```
demandRels = ["close","corroborated","temp"]
  UNSAFE rule: close[main](?V1,?V2)@now :- ?D is -(?V1,?V2), ?D <= 2, ?D >= -2
```

Небезопасно **одно** правило (`close`), а demand-отношений — три: `corroborated` затянуто, потому
что вызывает `close` позитивной посылкой, `temp` — потому что вызывает `corroborated`.

### 1.3 Нижний фикспойнт исключает только НЕБЕЗОПАСНЫЕ правила

`run()` (`engine.ts:173`): `const safeRules = this.rules.filter((r) => r.safe);`. Дальше монотонные
и отрицающие фазы работают только над `safeRules`. То есть **demand-отношение с безопасными
правилами продолжает пополняться снизу вверх** — исключаются именно небезопасные клаузы, не
отношение целиком. В `matchPremise` (`engine.ts:384-385`) при вызове demand-отношения перебираются
**все** его `@now`-правила, включая безопасные.

### 1.4 Раскрутка на месте вызова

`matchPremise` (`engine.ts:358-403`): сначала факты склада, потом — если отношение demand-backed —
`solveDemandRule` по каждому его правилу, с дедупликацией через `seen` и итоговой сортировкой по
ключу.

`solveDemandRule` (`engine.ts:407-438`):

```ts
this.bumpSteps();
if (depth > MAX_DEPTH) throw new BudgetExhausted();
const rn = this.renameClause(r.clause);        // переименование переменных врозь
let s2 = unify(h.persp, walk(call.persp, s), s);
for (let i = 0; i < h.args.length && s2; i++) s2 = unify(h.args[i], call.args[i], s2);
const sols = this.solveBody(rn.body, s2, depth + 1);
```

и дальше для каждого решения: если перспектива — атом и **все** аргументы головы основные, факт
кладётся в склад (`store.add`), регистрируется свидетельство (`store.support`) и `derived_by`;
иначе выдаётся **открытый ответ** `{ t: 'bi', desc: 'open ' + resolvedLitKey(call, sol.s) }`.

**Ни табуляции, ни проверки поглощения, ни очереди вариантов.** Единственная мемоизация — это
`store.add` основных результатов, и она видна снаружи (`/tmp/dmz/r3.ts`, случай А):

```
=== A. fresh store, demand-only relation queried with NOTHING materialized ===
  ? close(X, Y)  ->  []  partial=false
  ? close(20, 21)  ->  [true]  partial=false
  ? close(X, Y)  ->  [X = 20, Y = 21]  partial=false
```

Между первой и третьей строкой не изменилось ничего, кроме осадка в складе. Кстати, это опровергает
`LIMITS.md:42-43` («`? close(X, Y)` returns nothing rather than the infinite set») — верно только
на складе без осадка.

### 1.5 Открытый ответ

`? anything(X, Y)` при `anything(X, Y) :- seed(Y).` и `seed(s).` даёт `[X = ?X, Y = s]`
(`/tmp/dmz/r3.ts`, случай Г; `/tmp/dmz/r9.ts`). `?X` — это рендер несвязанной переменной через
`canonTerm` в `api.ts:192-224`. Строка ответа **не является фактом**: до основного вызова
`why anything(zzz, s)` отвечает «does not hold» (`/tmp/dmz/r8.ts`, случай В):

```
  ? anything(X, Y)  ->  [X = ?X, Y = s]  partial=false
  why anything(zzz, s) BEFORE any ground call:
    "anything[main](zzz,s) does not hold; try: whynot anything(zzz, s)"
  ? anything(zzz, s)  ->  [true]  partial=false
  why anything(zzz, s) AFTER the ground call:
    anything[main](zzz,s)  <= r58f0d212 @tick 0
      seed[main](s) [axiom]
```

Открытые ответы живут только на пути запроса. В склад попадают исключительно основные результаты.

### 1.6 Экзистенциальное отрицание (Д2) — механика, снятая с прогонов

`solveBody`, ветка `neg` (`engine.ts:333-337`):

```ts
} else if (b.t === 'neg') {
  if (this.matchPremise(b.lit, a.s, depth, null).length === 0) {
    const inst = this.resolvedLitKey(b.lit, a.s);
    next.push({ s: a.s, prems: [...a.prems, { t: 'neg', key: inst }] });
  }
}
```

То есть отрицание = «под текущей подстановкой у литерала нет ни одного совпадения». Свободные
переменные внутри `not` квантифицированы **экзистенциально внутри отрицания** и после него
остаются несвязанными (подстановка `a.s` передаётся дальше без изменений).

Тонкая структура, измеренная (`/tmp/dmz/r7.ts`):

```
=== A. repeated FREE var inside a negated literal: not p(R,R) ===   (факты: p(x,y), p(z,z))
  ? n1(X)  ->  []          -- n1(X) :- i(X), not p(R, R).
  ? n2(X)  ->  []          -- n2(X) :- i(X), not p(R, S).

=== B. same, with NO reflexive fact ===                             (факты: p(x,y))
  ? n1(X)  ->  [X = a]
  ? n2(X)  ->  []
```

**Повторная свободная переменная — это ограничение самосоединения, а не подстановочный знак.**
`not p(R,R)` держится, когда нет ни одного рефлексивного факта, и падает, когда `p(z,z)` есть.
`not p(R,S)` падает при любом факте `p`. Значит анти-джойн **нельзя** реализовать простым
выбрасыванием свободных колонок — надо навязывать равенство внутри классов повторов.

И вторая, более острая находка — **написанный порядок доминирует**:

```
=== C. free var in a negation BOUND BY A LATER positive premise ===  (факты: i(a), i(b), j(b), p(a))
  ? before(X, Y)  ->  []                              -- before :- i(X), not p(Y), j(Y).
  ? after(X, Y)  ->  [X = a, Y = b | X = b, Y = b]    -- after  :- i(X), j(Y), not p(Y).
```

Два правила с одинаковым множеством литералов дают **разные** ответы. А документация планировщика
RFDB утверждает обратное — `packages/rfdb-server/src/derive/plan.rs:716-718`:

> Reordering is order-independent (I1): it changes only the join ORDER, never WHICH facts the rule
> derives.

Для тел без отрицания это верно. Для тел с отрицанием — **опровергнуто прогоном C выше**. Правка
этого комментария входит в объём линии.

### 1.7 Отрицание над demand-отношением

`LIMITS.md:38-41`: «A negated premise over a demand-only relation is decided by attempting the
unfolding under the current bindings; unbound arguments there mean the existential check ranges only
over derivable instances reachable from those bindings». Прогон (`/tmp/dmz/r5.ts`, случай Г):

```
  load: close(V1,V2) :- D is V1 - V2, D <= 2, D >= -2.  v(20). v(95).
        lonely(A) :- v(A), not close(A, W).
  ? lonely(A)  ->  [A = 20 | A = 95]
```

Оба одиноки, потому что `close(20, W)` с несвязанным `W` раскручивается в `D is 20 - W`, где `is`
не может считать при несвязанном правом операнде, — совпадений нет, отрицание держится.

### 1.8 Перспектива под отрицанием

`/tmp/dmz/r5.ts`, случаи А и В:

```
=== A. negation with a FREE PERSPECTIVE VARIABLE ===
  load: item(a). item(b). q[vault](a).   clean(X) :- item(X), not q[P](X).
  ? clean(X)  ->  [X = b]
  why clean(b):
    clean[main](b)  <= ra514603f @tick 0
      item[main](b) [axiom]
      not q[?P](b) [finite failure]
```

Свободная переменная-перспектива ведёт себя точно как свободный аргумент: экзистенциальная внутри
отрицания, несвязанная после. `Persp` — просто нулевая колонка одного и того же механизма. Это
ровно то, что уже записано в `_ai/research/rofl-perspectives-design.md` §3.2 — и наши правки
попадают в **одну и ту же** строку `plan.rs:940-946` (см. §7).

---

## 2. Куда механизм ложится в RFDB

Опорная точка: RFDB **уже владеет** примитивом «прокрутить тело клаузы при зафиксированной голове».
Он живёт в трёх местах и везде выглядит одинаково — `head_bound_row` плюс цикл по `plan.legs` с
`apply_leg`:

* `clause_derives_head` — `packages/rfdb-server/src/derive/exec.rs:1139-1163` (DRed, фаза
  «выводимо ли сейчас»),
* `witness_fact` — `exec.rs:1222-1257` (why),
* `witness_gap` — `exec.rs:1267-1310` (why-not).

Нисходящий решатель — это тот же примитив, у которого сняты два ограничения: ключ головы
становится **частичным**, а посылки идут в **написанном порядке** с рекурсией в demand-отношения.

### 2.1 Парсер — без изменений

Проба выше показала: программа с несвязанной переменной в голове **компилируется** и возвращает
`OK 0 rows`. Отказа нигде нет. `Rule::is_safe()` существует
(`packages/rfdb-server/src/datalog/types.rs:209-219`), но на derive-пути **не вызывается** —

```
$ grep -rn "is_safe" packages/rfdb-server/src/
packages/rfdb-server/src/datalog/types.rs:209:    pub fn is_safe(&self) -> bool {
packages/rfdb-server/src/datalog/types.rs:253:    pub fn is_safe(&self) -> bool {
packages/rfdb-server/src/datalog/types.rs:254:        self.rules.iter().all(|r| r.is_safe())
packages/rfdb-server/src/derive/plan.rs:2307:    fn ground_probe_leg_is_safe_in_any_position() {
packages/rfdb-server/src/datalog/tests.rs:176:        assert!(safe_rule.is_safe());
packages/rfdb-server/src/datalog/tests.rs:183:        assert!(!unsafe_rule.is_safe());
```

— ни одного вызова из `derive/`. Строки теряются позже и молча:

```rust
// packages/rfdb-server/src/derive/exec.rs:3687-3700
fn project_head(head: &Atom, row: &BindRow) -> Option<Box<[Value]>> {
    for t in head.args() {
        match t {
            ...
            Term::Var(v) => out.push(row.get(v)?.clone()),   // <-- вот здесь строка исчезает
            Term::Wildcard => return None,
        }
    }
```

Это **неверный ответ**, а не отказ. Первое, что должна сделать линия, — превратить молчание в
явное поведение.

### 2.2 Новый модуль `derive/demand.rs`: классификатор и замыкание

Зеркало `engine.ts:130-160` и `engine.ts:79-105`, один в один по написанному порядку.

```rust
pub(crate) enum Safety { Safe, Unsafe }

/// Зеркало engine.ts:130-160. Идёт по телу в НАПИСАННОМ порядке.
pub(crate) fn classify(rule: &Rule) -> Safety;

/// Зеркало engine.ts:79-105: замыкание по позитивным посылкам до неподвижной точки.
/// Ключ — имя предиката, значение — ВСЕ его @now-клаузы (включая безопасные, engine.ts:384).
pub(crate) fn demand_relations<'a>(rules: &[&'a Rule]) -> BTreeMap<String, Vec<&'a Rule>>;
```

Оракул связывания для builtin-ов у классификатора должен быть **тот же самый**, что у планировщика
(`plan.rs:1039` и `plan.rs:1114` — списки имён с их режимами). Иначе получится расхождение
классификатор↔планировщик — ровно тот класс дефекта, который в языковом раунде 2026-06-13
проявлялся как дрейф словарей анализатор↔резолвер и маскировался юнит-тестами с ручными
метаданными. Поэтому: **один источник истины, `builtin::lookup` + режимная таблица**, и тест-шов,
который падает при расхождении (§8, тест Р-6).

### 2.3 Стратификация и планирование: небезопасные клаузы выходят из фикспойнта

`packages/rfdb-server/src/derive/mod.rs:236-256` — точка входа. Сейчас:

```rust
let strat = stratify(&program)?;
let rules = program.rules();
let plans = plan::plan_program_with_catalog(&rules, &strat, &stats, &mut catalog)?;
```

Становится: между `parse_ext_program` и `stratify` считается `demand_relations`; в `stratify` и
`plan_program_with_catalog` уходит `rules ∖ {небезопасные клаузы}` — зеркало `engine.ts:173`
(`safeRules`). Небезопасные клаузы уходят отдельным списком в исполнитель как **клаузы для
раскрутки** (без bound-first-плана: у них его и не может быть).

Проверка неподвижности отрицания (`checkUnstratified`, `engine.ts:179`, определение — `engine.ts:201`) в эталоне выполняется **и
при исчерпании бюджета** (`engine.ts:189`), то есть стратификация — не часть фикспойнта. В RFDB
`stratify` уже отдельная стадия; надо лишь не потерять небезопасные клаузы **из графа
зависимостей** (иначе цикл через отрицание, проходящий по demand-правилу, останется незамеченным).
Это отдельный тест (§8, тест Р-5).

### 2.4 Планировщик: отрицание остаётся на написанном месте

`packages/rfdb-server/src/derive/plan.rs:938-950`:

```rust
fn can_place_and_provides(lit: &Literal, bound: &HashSet<String>) -> (bool, HashSet<String>) {
    match lit {
        Literal::Negative(atom) => {
            // Negative literals require ALL Var args to be in bound.
            let all_bound = atom.args().iter().all(|t| match t {
                Term::Var(v) => bound.contains(v),
                _ => true,
            });
            (all_bound, HashSet::new())
        }
        Literal::Positive(atom) => positive_can_place_and_provides(atom, bound),
    }
}
```

Две правки, обе обязательные и обе — в этой функции и в `order_literals`:

1. **Свободные переменные в отрицаемом литерале разрешены** и ничего не связывают (второй элемент
   пары остаётся пустым множеством — он уже пуст).
2. **Отрицаемый литерал закрепляется на своём написанном индексе.** Позитивные литералы и builtin-ы
   переупорядочиваются по стоимости только **внутри промежутков** между отрицаниями. Это ровно то,
   что делает утверждение I1 (`plan.rs:716-718`) снова истинным: внутри промежутка без отрицаний
   перестановка действительно не меняет множество выводимых фактов, а через отрицание — меняет
   (прогон C, §1.6).

Режим включается диалектом ROFL, не глобально (см. §7 и §10, риск 1).

`E-PLAN-002` при этом не исчезает: он остаётся для случая, когда **позитивный** литерал невозможно
поставить (циклическая связуемость). Уходит только его срабатывание на отрицании со свободными
переменными.

### 2.5 Исполнитель: анти-джойн с экзистенциальными свободными переменными

`packages/rfdb-server/src/derive/exec.rs:1824-1872`, ветка `negated` в `join_derived`, уже содержит
**ровно нужную конструкцию** — но только для подстановочных знаков:

```rust
let wc_free: Vec<usize> = (0..atom_args.len())
    .filter(|&i| !matches!(atom_args[i], Term::Wildcard))
    .collect();
if wc_free.len() < atom_args.len() { /* проекция и фактов, и зонда на НЕ-wildcard позиции */ }
```

Обобщение: «не-wildcard позиции» → «позиции, связанные под текущей строкой (константа, литерал или
связанная переменная)». Свободная именованная переменная ведёт себя как подстановочный знак —
**кроме** повторов: для каждой свободной переменной, встречающейся на ≥2 позициях, факт обязан
иметь равные значения на этих позициях. Формально строка **выживает**, если не существует факта
`f`, для которого одновременно:

* `f[i] == probe[i]` на всех связанных позициях `i`, и
* `f[j] == f[k]` для любых `j`,`k`, где стоит одна и та же свободная переменная.

Wildcard-позиции ограничения не дают никогда (каждый `_` — свой).

Эта формула — не изобретение, она вычитана из прогонов A и B §1.6, и оба прогона становятся
регрессионными тестами (§8, тест Р-2). Заметьте, что существующие тесты
`negated_derived_leg_with_wildcard_is_existential` (`exec.rs:4253`) и
`negated_derived_leg_wildcard_arrangements` (`exec.rs:4274`) — это частный случай новой формулы при
нуле повторов, поэтому они обязаны остаться зелёными без правок.

### 2.6 Исполнитель: частичный ключ головы и нисходящий решатель

`head_bound_row` (`exec.rs:3706-3735`) принимает **основной** ключ. Обобщаем:

```rust
/// Частичный образец вызова: None = позиция не связана вызовом.
fn head_pattern_row(head: &Atom, pattern: &[Option<Value>]) -> Option<BindRow>;

/// Сегодняшняя функция становится тонкой обёрткой — поведение трёх её потребителей
/// (clause_derives_head, witness_fact, witness_gap) обязано остаться байт-в-байт.
fn head_bound_row(head: &Atom, key: &[Value]) -> Option<BindRow> {
    head_pattern_row(head, &key.iter().cloned().map(Some).collect::<Vec<_>>())
}
```

Решатель (новый, в `exec.rs` рядом с `clause_derives_head`, потому что ему нужны те же приватные
куски исполнителя):

```rust
struct DemandAnswer { row: BindRow, ground_key: Option<Box<[Value]>> }

fn solve_demand(
    &self,
    pred: &str,
    pattern: &[Option<Value>],
    depth: u32,
    relations: &mut HashMap<String, Relation<T>>,
) -> ExecResult<Vec<DemandAnswer>>;
```

Порядок шагов — зеркало `matchPremise` + `solveDemandRule`:

1. **Сначала факты склада.** Перебрать `relations[pred].total`, унифицировать образцом. Уже есть
   `unify_atom` (`exec.rs:3740`) — унификация позитивного атома с одним кортежем при частичной
   строке.
2. **Потом раскрутка**, по каждой `@now`-клаузе отношения (включая безопасные — `engine.ts:384`).
   Переименовывать переменные не нужно: в RFDB каждая клауза работает в своей `BindRow`, эффект
   `renameClause` (`engine.ts:441-455`) достигается конструктивно.
3. `head_pattern_row(clause.head, pattern)` → начальная строка; `None` ⇒ клауза не подходит.
4. Тело **в написанном порядке**:
   * позитивный derived-литерал demand-отношения → рекурсия `solve_demand(..., depth + 1)` с
     образцом, спроецированным из текущей строки;
   * позитивный derived-литерал обычного отношения → унификация с `relations[..].total`;
   * base/builtin → `resolve_arg_spec` + вычисление из реестра (сегодняшний путь
     `join_extensional`, он уже умеет частично связанные спецификации аргументов);
   * отрицание → анти-джойн из §2.5, вычисленный **на своём написанном месте**.
5. Проекция головы: если основная — материализовать (см. §2.7) и вернуть основной ответ; если
   нет — вернуть **открытый** ответ (`ground_key = None`), в склад не класть (`engine.ts:433-435`).
6. Дедупликация по ключу и сортировка — зеркало `engine.ts:396-402`; она даёт детерминированный
   порядок строк, а он для конформанса значим.

### 2.7 Материализация и провенанс

Основной результат раскрутки должен попасть в `relations[pred].total` **с тем же провенансом, что и
восходящий вывод**, — тогда `witness_fact` (`exec.rs:1222`) продолжит отвечать без единой правки.
В эталоне это `store.add` + `store.support` + `derived_by` (`engine.ts:424-432`); в RFDB
эквивалент — обычная запись в `Relation.total` со штампом `materialize::rule_ast_hash(clause.rule)`,
который `witness_fact` уже возвращает.

Важное ограничение (см. §4): материализованный demand-результат **не должен переживать оценку**.

### 2.8 Открытый ответ на проводе

Сегодня строка ответа — карта основных значений: `{"V0":"a"}`. Открытая строка несёт несвязанную
переменную. Эталон рендерит её как `?X` (`api.ts:192-224`).

Решение, наименее инвазивное и совместимое с уже приехавшим типизированным кодеком значений
(`~int:`, `~float:`, `~big:` — измерено в `run-migration/R14-blocker-matrix.md:142-186`): **новая
типовая метка `~open:<ИмяПеременной>`**, только на пути запроса. Открытые строки **не** попадают в
хранилище фактов, поэтому ни storage, ни `@materialize`, ни ключи explain-протокола не затрагиваются
— это подтверждено поведением эталона (`/tmp/dmz/r8.ts`, случай В: `why` до основного вызова
отвечает «does not hold»).

Метка — решение **линии диалекта** (она владеет кодеком значений). Я фиксирую здесь требование и
предлагаемое умолчание; если линия диалекта выберет другое кодирование, меняется одна строка
рендера, а не механизм.

### 2.9 Сводная таблица изменений

| Файл | Место | Что меняется |
|---|---|---|
| `derive/demand.rs` | новый | `classify` (зеркало `engine.ts:130-160`), `demand_relations` (зеркало `engine.ts:79-105`) |
| `derive/mod.rs` | `evaluate_with_materialize_shared`, стр. 236-256 | посчитать demand-множество; в `stratify`/`plan_program_with_catalog` отдать только безопасные клаузы |
| `derive/plan.rs` | `can_place_and_provides`, стр. 938-950 | свободные переменные в отрицаемом литерале разрешены |
| `derive/plan.rs` | `order_literals`, стр. 709-829 | отрицание закреплено на написанном индексе; переупорядочение — внутри промежутков; исправить комментарий I1 (стр. 716-718) |
| `derive/exec.rs` | `join_derived`, ветка `negated`, стр. 1824-1872 | обобщить экзистенциальную проекцию с wildcard на любые свободные позиции + равенство повторов |
| `derive/exec.rs` | `head_bound_row`, стр. 3706 | обобщить до `head_pattern_row(&[Option<Value>])`; сегодняшняя сигнатура — обёртка |
| `derive/exec.rs` | новое, рядом со стр. 1139 | `solve_demand` — нисходящий решатель |
| `derive/exec.rs` | `project_head`, стр. 3687 | несвязанная позиция головы больше не молчаливое `None`: либо клауза demand-овая (и сюда не попадает), либо это дефект — явный код |
| `derive/exec.rs` | `EvalLimits`, стр. 104 и далее | глубина `MAX_DEPTH = 512` и счётчик шагов раскрутки |
| `rofl-conformance/src/translate.ts` | Фаза 9, стр. 214-251 | снять два ложных отказа (константа в голове, повтор в голове); переписать обоснование стр. 232 |

---

## 3. Завершаемость — прогонами, а не обещаниями

**У эталона нет гарантии завершаемости. Есть ограничитель.** Это надо реализовать буквально, иначе
«верность» превратится в «мы лучше эталона» — а конформанс это поймает как расхождение.

Прогон первый — левая рекурсия через demand-правило (`/tmp/dmz/r4.ts`):

```
=== left recursion THROUGH a demand relation (unsafe + self-call) ===
  load: {"ok":true,"diagnostics":[]}          --  z(X) :- z(W).
  demandRels= [ 'z' ]
  UNSAFE z[main](?X)@now :- z[main](?W)@now
  ? z(a) -> rows=0 partial=true in 51ms
  hole: hole[main]($q(1),budget_exhausted)
```

Прогон второй — вызов **с основными аргументами** над бесконечным генератором:

```
=== unbounded demand generator: does the CALL bound it? ===
  load: succ(X, Y) :- Y is X + 1.
        reach2(X, Y) :- succ(X, Y).
        reach2(X, Y) :- succ(X, Z), reach2(Z, Y).
  demandRels= [ 'reach2', 'succ' ]
  ? reach2(0,3) -> rows=0 partial=true in 55226ms
  hole: hole[main]($q(1),budget_exhausted)
  materialized reach2: 1 succ: 512
```

Читайте внимательно: `reach2(0,3)` **выводим** (0→1→2→3), а эталон отвечает **0 строк и partial**.
Соседняя бесконечная ветка съела бюджет раньше. 55 секунд. Верность означает воспроизвести именно
это — «0 строк + дыра», а не «1 строка».

Третий прогон — конечная глубина не спасает от бесконечного множества (`/tmp/dmz/r3.ts`, случай В):

```
=== C. demand relation generating an infinite set ===
  ? nat(X) -> rows=100002 partial=true
  hole facts: hole[main]($load(1),budget_exhausted)
```

Ограничители эталона: `MAX_DEPTH = 512` (`engine.ts:40`, проверка на `engine.ts:409`) и счётчик
шагов `budget` по умолчанию `100_000` (`engine.ts:61`, `bumpSteps` на `engine.ts:313-316`).
Исчерпание — исключение `BudgetExhausted`, перехваченное в `run()` (`engine.ts:187-193`), которое
даёт `partial = true` и факт `hole[main](<id>, budget_exhausted)` со `scope: 'timeless', base: true,
frozen: true` — то есть дыра **переживает** `clearDerived`.

**Осторожная ловушка.** Моя первая проба на левую рекурсию была `p(X, Y) :- p(X, Y).` — и она дала
`rows=0 partial=false in 1ms` (`/tmp/dmz/r3.ts`, случай Б), потому что это правило эталон считает
**безопасным** (тело связывает обе переменные головы), раскрутки нет вообще. Небезопасность даёт
только `z(X) :- z(W).`. Если писать тест на завершаемость по первому образцу, он пройдёт, ничего не
проверив.

### Что здесь придётся сделать в RFDB

У RFDB сегодня три способа прекратить оценку, и все три — **аварийные**, без фиксации:

```
// packages/rfdb-server/src/derive/exec.rs:147-169
pub enum ExecCode {
    IterationCap,    // E-EXEC-002 — стратум не сошёлся за 10k раундов
    LimitExceeded,   // E-EXEC-001 — потолок промежуточных результатов / дедлайн
    Cancelled,       // E-EXEC-003 — клиент отвалился
}
```

Правящее решение по бюджету — `run-migration/OWNER-RULINGS.md:55-62`, R-2: «**holes win**. Budget
exhaustion produces committed partial results + `hole/2` certificates (partial ⊑ total);
abort-no-commit (E-EXEC-002/003 today) is replaced on the ROFL path when ТЗ-P1 lands».

Значит, **линия дыр** — необходимая пара к этой линии, и я её не поглощаю. Контракт стыка:

* режим «по запросу» **производит сигнал**: «глубина 512 / бюджет шагов исчерпаны на этом вызове»;
* линия дыр **превращает** сигнал в зафиксированный частичный результат + факт `hole/2`;
* до тех пор режим «по запросу» обязан отдавать **явный типизированный отказ** (`E-DEMAND-001`) —
  **никогда** усечённый ответ. Урок W8 (отмена, выглядевшая как сходимость, 1726 потерянных рёбер)
  здесь применяется дословно: «частично» обязано быть механически отличимо от «сошлось», а
  отсутствие дыры — доказуемо.

То есть до линии дыр эти сценарии останутся RED, но с кодом `holes`, а не молча зелёными с неверным
ответом. Это **правильный** порядок: сначала громко, потом верно.

---

## 4. Инкрементальность и DRed

Ответ эталона: **инкрементальности нет, и это наблюдаемо**.

`run()` начинается с `this.store.clearDerived()` (`engine.ts:168`), а `clearDerived`
(`store.ts:111-118`) сносит **каждый** факт, у которого не стоит `base` или `frozen`. Демандовые
результаты кладутся как `{ scope: 'tick', base: false }` (`engine.ts:424`) — значит сносятся.

Проба (`/tmp/dmz/r8.ts`, случай А):

```
=== A. does a demand-materialized result SURVIVE the next tick? ===
  ? close(20, 21)  ->  [true]  partial=false
  store close facts after the ground call: close[main](20,21)
  store close facts after loading a new base fact: (none)
  ? close(X, Y)  ->  []  partial=false
  after re-querying open: (none)
```

Загрузка одного нового базового факта запускает новую оценку — и осадок исчез.

**Следствие для RFDB, и оно жёсткое.** У RFDB есть межпрогонный кэш `(ReadSnapshot, Evaluation)` на
долгоживущем движке (Gate D2, подход (d)) и инкрементальное сопровождение
`maintain_datalog_v2`/`maintain_incremental`. Если demand-результаты попадут в этот кэш или в
binding-blob, RFDB ответит на `? close(X, Y)` непустым множеством там, где эталон отвечает пустым, —
и это **прямо наблюдаемое расхождение**, у которого уже есть готовая пара прогонов (выше).

Поэтому:

* demand-материализованные факты помечаются как **эфемерные для оценки**: не входят в
  binding-blob, не входят в `@materialize`-запись, не переживают смену снимка;
* предикат, оказавшийся demand-backed, делает программу **некэшируемой** для D2-кэша (или
  demand-осадок сбрасывается при попадании в кэш — эквивалентно и проще проверяется);
* DRed (`over_delete` `exec.rs:1005`, `rederive` `exec.rs:1172`) demand-факты **никогда не видит**,
  потому что они не переживают оценку. Специального удаления не требуется — и это не упрощение
  «чтобы не делать», а зеркало эталона.

Если позже понадобится табуляция ради скорости — это **отдельное** решение, меняющее наблюдаемое
поведение (`? close(X,Y)` начнёт отвечать), и оно требует правки эталона, а не движка.

---

## 5. why / why-not: провенанс не становится дырой

Эталон даёт полное дерево вывода для demand-фактов. Проба `/tmp/dmz/r2.ts` на реальном
`examples/sensors.rofl`:

```
--- why temp[verified](t1, 20) ---
temp[verified](t1,20)  <= r821b648f @tick 0
  reading[s1](t1,20) [axiom]
  corroborated[trust](s1)  <= rc44e6f13 @tick 0
    reading[s1](t1,20) [axiom]
    reading[s2](t1,21) [axiom]
    s1 != s2 [builtin]
    close[main](20,21)  <= r8fac564c @tick 0
      -1 is -(20,21) [builtin]
      -1 <= 2 [builtin]
      -1 >= -2 [builtin]
```

`close[main](20,21)` — результат раскрутки, и он вложен в дерево наравне с обычными выводами, со
своим `rule id` и своими builtin-посылками. Механика: `store.support` + `derived_by` в
`solveDemandRule` (`engine.ts:426-432`) — те же вызовы, что и на восходящем пути
(`engine.ts:299-309`).

why-not тоже отвечает содержательно, называя **неудавшийся demand-вызов**:

```
--- whynot corroborated[trust](s3) ---
  rule rc44e6f13: corroborated[trust](?S)@now :- reading[?S](?T,?V1)@now, reading[?S2](?T,?V2)@now,
                                                 ?S != ?S2, close[main](?V1,?V2)@now
    failed premise: close[main](95,20)
    failed premise: close[main](95,21)
    failed premise: s3 != s3 [builtin fails]
```

И на «пустой» форме (`/tmp/dmz/r8.ts`, случай В):

```
  whynot anything(zzz, nope):
    whynot anything[main](zzz,nope):
      rule r58f0d212: anything[main](?X,?Y)@now :- seed[main](?Y)@now
        failed premise: seed[main](nope)
```

Отсюда контракт для RFDB — и он приятно дешёвый:

1. Основной demand-результат материализуется с `rule_ast_hash` → `witness_fact` (`exec.rs:1222`)
   отвечает **без единой правки**. Это не предположение: `witness_fact` ищет клаузу по
   `head_pred`, строит `head_bound_row` и прокручивает `plan.legs`. Для demand-клаузы плана
   `plan.legs` нет — поэтому `witness_fact` для demand-клауз должен идти через тот же
   `solve_demand` с полностью основным образцом. Это **одна ветка**, а не второй движок.
2. why-not: `witness_gap` (`exec.rs:1267`) ищет первую посылку, на которой строки обнулились. Для
   demand-клаузы — та же прокрутка в написанном порядке с записью удовлетворённого префикса.
   Обратите внимание на уже существующую строчку эталона `api.ts:317`
   (`if (k >= rn.body.length) return; // a derivation branch survives (demand)`): если ветка дошла
   до конца тела, а факта нет — это открытый (не основной) результат, и объяснять там нечего.
3. **Отрицание со свободной переменной не разворачивается.** `api.ts:265`:
   `if (expandNeg && !p.key.includes('?'))` — посылка `not q[?P](b)` печатается как есть, с
   пометкой `[finite failure]`, и вглубь не идёт (прогон §1.8). Это ровно то, что должен делать
   `GapWitness.failing_is_negative`.
4. Провенанс demand-факта **относителен вызову**: до основного вызова `why` честно отвечает «does
   not hold» (`/tmp/dmz/r8.ts`, случай В). RFDB обязан вести себя так же — иначе `explain` начнёт
   отвечать на факты, которых в этой оценке не выводили.

---

## 6. Взаимодействие с остальными линиями

**Правила-как-данные.** Эталон классифицирует **после** декодирования правил из склада:
`prepare()` начинается с `decodeRules(this.store)` (`engine.ts:70`). Значит, когда правила приезжают
данными, классификатор просто получает те же `Rule`, и нового шва не нужно — он встаёт там же, где
`_ai/research/rofl-rules-as-data-design.md` §3.1 ставит шов внутри `parse_ext_program`. Одна деталь,
которую легко потерять: эталон **выбрасывает** правила, заключающие в зарезервированное kernel-
отношение, ещё до классификации (`engine.ts:73-76`), с диагностикой. Если этого не сделать,
kernel-отношение может стать demand-backed и начать раскручиваться — прямая дыра в защите записи.

**Диалект.** Классификатор зависит от режимов связывания builtin-ов (`=` в обе стороны, `is` слева
направо — `engine.ts:145-152`). Это тот же реестр, что у планировщика (`plan.rs:1039`, `plan.rs:1114`)
— единый источник истины обязателен. Плюс: арифметики в реестре нет
(`builtin.rs:1660-1692`), поэтому `boot.rofl:20` (`N is M + 1`) не переводится **независимо** от
этой линии. И метка `~open:` — решение линии диалекта (§2.8).

**Перспективы.** Три точки стыка, и все три уже описаны в
`_ai/research/rofl-perspectives-design.md`:

* §3.2 — свободная переменная-перспектива под отрицанием экзистенциальна и **исключается** из
  требования «все аргументы связаны» в `plan.rs:940`. Моя правка §2.4 обобщает это на **любые**
  свободные переменные. **Это одна и та же строка кода** — правки обязаны делаться одним
  изменением, иначе они конфликтуют.
* §3.3 — голова правила может нести `Persp::Var`. У эталона это прямо влияет на классификацию:
  `groundIn(h.persp)` (`engine.ts:158`) — несвязанная перспектива головы делает правило
  небезопасным, то есть demand-backed. Значит `Persp` — нулевая колонка образца вызова.
* §3.10 — «голова, чья перспектива не атом, ПРОПУСКАЕТСЯ с диагностикой». Это буквально
  else-ветка `solveDemandRule` (`engine.ts:433-435`): не основная голова → открытый ответ, в склад не
  кладём. Два проекта описывают одно поведение — надо свести к одной формулировке.

**Темпоральное.** `@next`-правила **никогда** не раскручиваются (`engine.ts:85`). Линия
темпорального обязана держать `@next` вне demand-множества; в противном случае раскрутка начнёт
выводить факты следующего тика в текущем.

**Дыры.** Необходимая пара, контракт стыка выписан в §3.

**Составные термы.** Все 7 «настоящих demand» правил корпуса требуют либо `cons`/`tape`, либо
арифметики (§0). До этих линий Д1 нельзя прогнать конец-в-конец на RFDB.

---

## 7. Что отвергнуто и почему

**Магические множества / преобразование по требованию (magic sets).** Классический способ дать
Datalog-у demand: переписать программу так, чтобы восходящий фикспойнт считал только достижимое от
запроса. Отвергнуто по верности: magic sets **завершаются** там, где эталон уходит в дыру, и
**отвечают** там, где эталон отвечает пустотой. Прогон `reach2(0,3)` (§3) — прямой контрпример:
magic sets вернули бы одну строку, эталон возвращает ноль строк и `partial=true`. Плюс magic sets
не воспроизводят открытый ответ `?X` и не сохраняют зависимость от написанного порядка. Это
«красивее» и **неверно**.

**Табуляция / SLG-резолюция.** Дала бы завершаемость на левой рекурсии `z(X) :- z(W).`, где эталон
даёт дыру (`/tmp/dmz/r4.ts`). То же возражение: расхождение с эталоном, наблюдаемое конформансом.
Плюс табличный кэш конфликтует с §4 (эталон сносит производные факты каждую оценку).

**Отвергать небезопасные правила (сегодняшнее поведение).** Это ровно то, из-за чего 18 кейсов
красные. Не вариант по постановке.

**Молча выводить ноль строк (сегодняшнее поведение для Д1).** `project_head` (`exec.rs:3694`)
теряет строку через `?`. Это неверный ответ без сигнала. Отвергнуто по принципу «дыры выигрывают»
(R-2) и по уроку W8.

**Разрешить свободную переменную под `not`, выбросив её колонку из ключа анти-джойна.** Просто и
неверно: прогон A/B §1.6 показывает, что повтор свободной переменной — ограничение самосоединения.
`not p(R,R)` при фактах `p(x,y)` держится, при `p(z,z)` — падает; выбрасывание колонок дало бы
одинаковый ответ в обоих случаях.

**Оставить переупорядочение планировщика как есть, положившись на I1.** Опровергнуто прогоном C
§1.6: два правила с одинаковым множеством литералов дают разные ответы. Комментарий
`plan.rs:716-718` придётся исправить, а не сослаться на него.

**Включить режим глобально, для всех программ RFDB.** Отвергнуто по радиусу поражения: сегодня
правило с несвязанной переменной в голове тихо не выводит ничего, и пакеты `@stdlib/` живут с этим
поведением. Включение demand изменило бы вывод продовых пакетов. Режим включается диалектом ROFL —
та же позиция, что у `rofl-rules-as-data-design.md` §3.2 («Opt-in, because the blast radius of
always-on is unacceptable»). При этом требуется механический гейт (§8, тест Р-6), доказывающий, что
ни один вложенный пакет не содержит небезопасных клауз, — иначе «opt-in» держится на честном слове.

**Требовать явную аннотацию `@demand` на правиле.** Красиво и **неверно**: у эталона demand — это
вывод из формы правила (`classify` + замыкание), а не объявление. Программа `boot.rofl` не несёт
никаких аннотаций, и её классификация обязана получиться сама.

---

## 8. Приёмочные тесты

Каждый обязан уметь **падать** — ниже указано, на чём именно он красный сегодня.

**Р-1. `unbound_head_var_is_answered_not_silently_dropped`** (Rust, `derive/exec.rs` tests).
Программа `u_anything(V0, V1) :- u_seed(V1).` + `u_seed("s")`; запрос-цель `u_anything(V0, V1)`.
Ожидание: одна строка с `V1 = "s"` и открытым `V0`. *Сегодня падает:* живая проба даёт `OK 0 rows`.

**Р-2. `negated_leg_free_var_is_existential_with_repeat_equality`** (Rust). Четыре подслучая
прогона §1.6: `not p(R,R)` при `{p(x,y), p(z,z)}` → пусто; `not p(R,R)` при `{p(x,y)}` → одна
строка; `not p(R,S)` при `{p(x,y)}` → пусто; и wildcard-контроль `not p(_,_)`. *Сегодня падает:*
`E-PLAN-002` на первых трёх.

**Р-3. `negation_stays_at_its_written_position`** (Rust). Пара правил прогона C §1.6:
`before(X,Y) :- i(X), not p(Y), j(Y)` → пусто; `after(X,Y) :- i(X), j(Y), not p(Y)` → две строки, на
одних и тех же фактах. *Сегодня падает:* оба правила отвергаются `E-PLAN-002`; после наивной правки
только §2.4-пункта 1 (без закрепления позиции) `before` даст две строки вместо нуля.

**Р-4. `demand_depth_cap_is_512_and_signals`** (Rust). `z(X) :- z(W).`, вызов `z("a")`. Ожидание:
ноль строк **и** сигнал исчерпания (до линии дыр — `E-DEMAND-001`; после — `partial` + факт
`hole/2`). *Сегодня падает:* сигнала не существует. Тест обязан использовать `z(X) :- z(W).`, а
**не** `p(X,Y) :- p(X,Y).` — второе безопасно и раскрутки не вызывает (`/tmp/dmz/r3.ts`, случай Б).

**Р-5. `demand_clauses_still_enter_the_negation_dependency_graph`** (Rust). Программа, где цикл
через отрицание проходит по небезопасной клаузе. Ожидание: стратификатор отвергает. *Сегодня
падает по-другому:* сегодня небезопасная клауза вообще не выделена, а после §2.3 её легко потерять
из графа — тест ловит именно эту потерю.

**Р-6. `every_bundled_pack_has_zero_unsafe_clauses`** (Rust). Прогнать `demand::classify` по всем
`derive::stdlib::STDLIB_PACKS` и потребовать пустое множество небезопасных клауз. *Может упасть:*
если хоть один продовый пакет опирается на сегодняшнее молчаливое отбрасывание строк, радиус
поражения перестаёт быть нулевым и это надо увидеть до включения, а не после.

**Р-7. `classifier_binding_modes_agree_with_the_planner`** (Rust). Для каждого имени из
`builtin::lookup` сравнить режимы связывания, которыми пользуется `demand::classify`, с теми,
которыми пользуется `plan.rs`. *Может упасть:* при добавлении builtin-а в один список и не в другой
— тот самый класс дрейфа словарей.

**Р-8. `demand_results_do_not_survive_the_evaluation`** (Rust). Основной вызов материализует
demand-факт; следующая оценка на том же движке (в т.ч. по D2-кэшу) обязана его не видеть. Пара
наблюдений — из `/tmp/dmz/r8.ts`, случай А. *Может упасть:* именно так, если demand-осадок попадёт
в межпрогонный кэш или в binding-blob.

**Р-9. `why_of_a_demand_fact_is_a_full_tree`** (Rust + конформанс). После основного вызова
`explainDatalogFact` на demand-факте возвращает свидетельство с `rule_ast_hash` и телом; **до**
вызова — `null`. *Сегодня падает:* demand-фактов не существует.

**Р-10. `whynot_of_a_demand_gap_names_the_failed_call`** (конформанс). Форма
`whynot corroborated[trust](s3)` из §5.

**П-1. Транслятор: два ложных отказа сняты** (`packages/rofl-conformance/test/*.test.ts`).
`u_stratum(V0, 0) :- u_edb(V0).` и `u_sees(V0, V0) :- u_perspective(V0).` обязаны
**переводиться**, а не давать `missing:demand-mode`. Плюс обоснование `translate.ts:232` не должно
ссылаться на `engine.ts:80-127` для `boot.rofl` (там `demandRels` пуст —`/tmp/dmz/r1.ts`).
*Сегодня падает:* транслятор отвергает обе формы.

**П-2. Дифференциал tier-0 не сдвинулся.** 120 сидов / 0 расхождений, why 325/325, why-not 554/554
— базовая линия R14 (`run-migration/R14-blocker-matrix.md:46-56`). *Может упасть:* правка
`order_literals` трогает общий путь; этот тест — гейт на то, что она не изменила ни одного
существующего вывода.

**П-3. Полный Rust-сьют.** `cd packages/rfdb-server && cargo test --lib` — базовая линия
1607 passed / 0 failed / 28 ignored. В частности,
`negated_derived_leg_with_wildcard_is_existential` (`exec.rs:4253`) и
`negated_derived_leg_wildcard_arrangements` (`exec.rs:4274`) обязаны остаться зелёными **без
правок** — они частный случай новой формулы анти-джойна.

---

## 9. Порядок работ, который вытекает из измерений

1. **Д2 (экзистенциальное отрицание) — первым.** Он нужен 15 сценариям, он не требует ни составных
   термов, ни арифметики, и он вообще не про demand. Три правки: `can_place_and_provides`,
   `order_literals`, ветка `negated` в `join_derived`. Тесты Р-2, Р-3, П-2, П-3.
2. **Снятие двух ложных отказов транслятора** — тривиально, тест П-1, никакого кода движка.
3. **Д1 (нисходящая раскрутка)** — классификатор, замыкание, `head_pattern_row`, `solve_demand`,
   провенанс. Тесты Р-1, Р-4…Р-9. Прогнать конец-в-конец на корпусе можно будет только после
   составных термов и арифметики (§0), поэтому первые проверки — на собственных фикстурах.
4. **Стык с линией дыр** — превратить сигнал исчерпания в зафиксированный частичный результат.

Отдельно: линия **не закрывает ни одного RED в одиночку** (в матрице R14 у неё «единственный
блокер: 0»). Её ценность — в том, что без неё не закрываются 18. Ожидать зелёных кейсов по её
завершении в отрыве от {правила-как-данные, диалект, перспективы} не следует — это прямо следует из
кривой жадного закрытия (`run-migration/R14-blocker-matrix.md:86-99`).

---

## 10. Риски и то, что я не смог проверить

**Риск 1 (радиус поражения).** Я **не измерил**, есть ли небезопасные клаузы во вложенных пакетах
`@stdlib/`. Классификатора ещё нет, а грепом это не считается. Риск закрыт тестом Р-6, но до его
написания включение demand глобально — неизвестный риск. Поэтому диалектный гейт обязателен.

**Риск 2 (стоимость закрепления порядка).** Закрепление отрицания на написанном месте отбирает у
планировщика часть свободы. На продовых пакетах отрицаемые литералы обычно стоят последними, так
что цена, вероятно, нулевая, — но **это не измерено**, и «вероятно» не является evidence. Мерять
надо на pack-фазе (базовая линия — 56.2 с прогретого прогона).

**Риск 3 (`witness_fact` для demand-клауз).** Сегодняшняя функция прокручивает `clause.plan.legs`;
у demand-клаузы плана нет. Я описал решение (та же ветка через `solve_demand`), но не проверил, что
структуры `Clause<'_>` хватает для смешанного списка (плановые + demand-клаузы) без изменения её
времени жизни. Это первое, обо что может споткнуться реализация.

**Риск 4 (детерминированность порядка строк).** Эталон сортирует результаты `matchPremise`
(`engine.ts:396-402`), а RFDB местами джойнит параллельно (`par_join_rows`, `exec.rs:348`).
Порядок открытых ответов конформанс сравнивает; канонизация есть (`canonical.ts`), но для нового
вида строк её надо проверить отдельно.

**Риск 5 (стоимость раскрутки).** Прогон `reach2(0,3)` занял 55 секунд у эталона. Если RFDB
воспроизведёт механизм буквально, он воспроизведёт и стоимость. Для конформанса это приемлемо
(корпус мал), для продового пути — нет. Ускорять придётся **не меняя наблюдаемого поведения**, что
исключает и табуляцию, и magic sets (§7).

**Что я предлагаю расширить за пределы выданного объёма** (не делаю, только называю): три ложных
утверждения в документации, найденных прогонами, — `translate.ts:232` (ссылка не подтверждает
утверждение для `boot.rofl`), `plan.rs:716-718` (I1 неверно для тел с отрицанием) и
`vendor/rofl-v0/LIMITS.md:42-43` (`? close(X, Y)` отвечает после материализации осадка). Первые два
— в объёме этой линии; третье — в вендоренном эталоне, трогать который без отдельного решения
нельзя.
