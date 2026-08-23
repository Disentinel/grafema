# R14 — `boot.rofl` конструкция за конструкцией: чем именно он закрывается и что остаётся

**Дата:** 2026-08-23. **Ветка:** `rofl-v1`. **Предмет:** `run-migration/boot.rofl` (41 строка,
21 клауза). **Вопрос раунда:** переводим ли `boot.rofl` целиком тем, что уже спроектировано в
четырёх линиях (диалект, правила-как-данные, режим «по запросу», перспективы), и если нет — где
именно дыра.

Правило этого документа: **ни одно утверждение о семантике v0 не взято из чтения исходника.**
Всё, что сказано про эталон, напечатал сам эталон в прогоне; всё, что сказано про RFDB, напечатал
живой сервер на релизном бинаре. Ссылки на проектные документы — цитаты механизма, а не отсылки
к названию линии.

---

## 1. Что измерено в этом раунде

Четыре пробы, все прогнаны заново непосредственно перед написанием этого текста.

```
cd /home/dev/grafema-rofl
node --experimental-strip-types --no-warnings /tmp/R14-boot-v0.ts      > /tmp/R14-out-bootv0.txt
node --experimental-strip-types --no-warnings /tmp/R14-diag-v0.ts      > /tmp/R14-out-diagv0.txt
node --experimental-strip-types --no-warnings /tmp/R14-boot-rfdb.ts    > /tmp/R14-out-rfdb1.txt
node --experimental-strip-types --no-warnings /tmp/R14-boot-rfdb2.ts   > /tmp/R14-out-rfdb2.txt
node --experimental-strip-types --no-warnings /tmp/R14-bootset-probe.ts > /tmp/R14-out-bootset.txt
```

Эталон — `packages/rofl-conformance/vendor/rofl-v0/` (rev `052a4c5`) через `OracleEngine`.
Субъект — `packages/rfdb-server/target/release/rfdb-server`, живой сокет; шапка прогона:
`server 0.4.1 proto v3 features multiDatabase,ephemeral,semanticIds,streaming,datalogDerive`.

### 1.1 `boot.rofl` в v0 грузится и все требуемые ответы пусты

```
=== 1. boot.rofl loads into a bare v0 kernel ===
  load ok=true diagnostics=[]

=== 2. the required-results block at boot.rofl:38-41 ===
  ? unstratified(X)            -> []
  ? malformed[audit](R)        -> []
  ? breach[audit](R)           -> []
  ? leak[audit](A, B)          -> []
  ? forged[audit](F)           -> []
  ? unmoded[audit](R)          -> []
  whynot unstratified(reach) holds=false
    whynot unstratified[main](reach):
      rule r25ecbd01: unstratified[main](?Rel)@now :- dep_neg[main](?Rel,?Q)@now, reach[main](?Q,?Rel)@now
        failed premise: dep_neg[main](reach,?Q#0)
```

Это и есть приёмка: шесть пустых ответов и конечная демонстрация. Всё, что ниже, — про то, из
чего эти шесть пустот складываются.

### 1.2 Что `boot.rofl` реально выводит в v0 (числа, а не ожидания)

```
  ? perspective(P)     -> ["P = audit","P = main"]
  ? sees(P, Q)         -> ["P = audit, Q = audit","P = main, Q = main"]
  ? flow(A, B)         -> ["A = main, B = audit","A = main, B = main"]
  ? bridge_decl(R,A,B) -> 6 строк, все вида "A = main, B = audit, R = r…"
  ? reads_from(R, P)   -> 21 строка, все "P = main"
  ? writes_to(R, P)    -> 6 строк "P = audit" + 15 строк "P = main"
  ? dep_neg(A, B)      -> ["forged/authority","leak/bridge_decl","leak/sees",
                           "malformed/has_conclusion","malformed/has_premise","unmoded/mode"]
  ? authority(P, W)    -> ["P = audit, W = $kernel","P = main, W = $kernel"]
  ? mode(B, M)         -> 7 строк, значение вида $cons(out,$cons(in,$nil))
  ? stratum(Rel, N)    -> 38 строк; leak/malformed/forged/unmoded стоят и на 0, и на 1
```

и словарь рефлексии, который склад v0 держит после загрузки `boot.rofl`:

```
authority/2 =2      bridge_decl/3 =6    concludes/2 =21    conclusion_lit/3 =21
dep/2 =33           dep_neg/2 =6        derived_by/3 =166  edb/1 =20
flow/2 =2           has_conclusion/2=21 has_premise/2 =39  mode/2 =7
perspective/1 =2    premise_lit/3 =39   premise_neg/2 =6   premise_pos/2 =32
reach/2 =49         reads_from/2 =21    reserved/1 =20     rule/1 =21
rule_known/1 =21    sees/2 =2           stratum/2 =38      uses_builtin/2 =1
writes_to/2 =21
```

**`rule/1 = 21` — это и есть «21 конструкция»**, по которой идёт разбор ниже: ровно столько
клауз v0 положил в склад из 41-строчного файла.

### 1.3 Что из этого RFDB умеет сегодня — по конструкциям

Прогон `/tmp/R14-boot-rfdb.ts` (сокращённо, полные тексты в `/tmp/R14-out-rfdb1.txt`):

| проба | форма | результат живого сервера |
|---|---|---|
| RD-a | `u_sees(P, P) :- u_persp(P).` (форма boot:7) | `{"Y":"main","X":"main"}` — **работает** |
| RD-b | `u_stratum(R, 0) :- u_edb(R).` (форма boot:19) | `{"R":"concludes","N":"~int:0"}` — **работает** |
| RD-c | голова связана только выходом билтина `concat/3` | `{"X":"a","Y":"a!"}` — **работает** |
| RD-d | `add(M, 1, N)` (форма boot:20) | только базовая строка; рекурсивная клауза **молча ничего** |
| RD-e | `u_idty(X, X) :- u_p(X).` | `{"Y":"a","X":"a"}` — **работает** |
| RD-f | одно отношение в двух арностях | `E-BIND-002` |
| B31-d | `\+ u_mode(B, _)` (форма boot:36) | `{"R":"r2"}` — **работает** |
| B31-e | то же с **именованной** свободной `M` | `E-PLAN-002 … no feasible binding` |
| B31-a | `\+ u_bridge(R, A, B)` (форма boot:31) | `E-PLAN-002 … no feasible binding` |
| P-a/P-b | `u_leak[audit](X) :- …` / `u_p[audit]("a").` | `Datalog parse error … unexpected input` |
| C-a | `u_p(cons(a, nil)).` | `Datalog parse error … unexpected input` |
| C-b/C-c | тот же терм как непрозрачная строка `~term:…` | джойнится, **работает** |
| K-a | `mode/2` со списочным значением как `~term:` | возвращается байт в байт, **работает** |

### 1.4 Диагональ под отрицанием — эталон против переписывания в подстановочный знак

`/tmp/R14-out-diagv0.txt` (v0) и `/tmp/R14-out-rfdb2.txt` (RFDB), одни и те же данные:

```
v0   res(X) :- p(X), not q(X, Y, Y).   -> ["X = x"]      RFDB \+ u_q(X, Y, Y) -> E-PLAN-002
v0   res(X) :- p(X), not q(X, _, _).   -> []             RFDB \+ u_q(X, _, _) -> 0 rows
```

Переписывание именованной свободной переменной в `_` **меняет ответ эталона** — и это ровно то,
что фиксирует линия «по запросу»: «переписывание `not p(Y,Y)` → `not p(_,_)` в трансляторе
несостоятельно» (`rofl-demand-mode-design.md` §2.3).

Но у **формы boot:31** свободная переменная `R` встречается **один раз**, и там переписывание
точно:

```
v0   leak(A,B) :- flow(A,B), not sees(B,A), not bridge(R, A, B).  -> ["A = x, B = y"]
v0   … not bridge(_, A, B).                                       -> ["A = x, B = y"]
RFDB … \+ u_bridge(_, A, B).                                      -> {"B":"y","A":"x"}
```

Три ответа совпадают. То есть **сегодняшний движок уже даёт правильный ответ на семантику
boot:31** — если свободную позицию записать подстановочным знаком. Отказ `E-PLAN-002` возникает
исключительно из-за того, что переменная названа.

### 1.5 Несвязанная переменная в голове: открытый ответ против молчаливого нуля

```
v0    idty(X, Y) :- p(X).      ? idty(X, Y)   -> ["X = a, Y = ?Y"]
                                ? idty(a, zzz) -> ["true"]
RFDB  u_idty(X, Y) :- u_p(X).  -> 0 rows, без ошибки
```

Ноль строк без ошибки — прямое нарушение собственного инварианта движка
(`exec.rs:144-145`: «A silently-empty result is a forbidden failure mode engine-wide»), и
причина видна в коде: комментарий над `project_head` (`derive/exec.rs:3685-3686`) утверждает
«Every head variable must be bound (the planner enforces rule safety)», а `Rule::is_safe()`
(`datalog/types.rs:209-219`) во всём `src/` вызывается только из тестов.

### 1.6 Незарегистрированный билтин — тоже тихий ноль

```
xq(X, Y) :- u_n(X), totally_not_a_builtin(X, Y).   u_n(7).   -> 0 rows
```

Ни ответа, ни отказа. Это важно для `boot.rofl:20`: когда арифметика приедет под другим именем
или с другой арностью, ошибка будет неотличима от пустого отношения.

### 1.7 Сколько RED закрывает «`boot.rofl` стал переводимым» — измерено

`/tmp/R14-out-bootset.txt`. Точное множество подлиний, которое задевает сам `boot.rofl`:

```
dialect:untranslatable/builtins            missing:demand-mode/head-not-named-var
dialect:untranslatable/int-constants       missing:demand-mode/repeated-head-var
missing:perspectives/perspectives-named    missing:demand-mode/unbound-head-var
missing:rules-as-data/reflection-vocabulary  missing:demand-mode/unsafe-negation
missing:rules-as-data/stratification-interface
```

и что это стоит:

```
## RED cases whose ENTIRE sub-lane set is inside the boot set: 6 / 25
   p1-arith  p2-persp-isolation  p3-runtime-rule  p3-write-protected  p3-breach  boot-load

## greedy sub-lane closure STARTING FROM the boot set
  start (boot set alone)                       → 6 / 25
  + missing:rules-as-data/strata-plan            → 8 / 25
  + missing:holes/budget                         → 10 / 25
  + dialect:untranslatable/naive-mode            → 11 / 25
```

И контрольное измерение, объясняющее, почему части нельзя сдавать по одной:

```
  int-constants alone                        → 0 / 25
  int-constants + builtins                   → 0 / 25
  ALL dialect:untranslatable sub-lanes       → 1 / 25
```

---

## 2. Конструкция за конструкцией: 21 клауза

Обозначения: **[Д]** — линия диалекта (`run-migration/R14-dialect-decisions.md`), **[П]** —
правила-как-данные (`_ai/research/rofl-rules-as-data-design.md`), **[З]** — режим «по запросу»
(`_ai/research/rofl-demand-mode-design.md`), **[Пс]** — перспективы
(`_ai/research/rofl-perspectives-design.md`).

### 2.1 Стратум 0, монотонный (строки 4-21)

**boot:4 `rule_known(R) :- has_conclusion(R, _).`**
`has_conclusion/2` — первая из десяти относительных форм Projection F: «Ten relations, all
arguments atoms or small integers, all derivable from a parsed `ExtProgram` with no new `Term`
variant» (**[П]** §2.1), и в списке стоит буквально `has_conclusion(R, 1)`. Подстановочный знак
в позитивной ножке движок уже держит: `plan.rs:145` считает `Term::Wildcard` связанным наравне с
константой. Отказ транслятора здесь — `checkLitMeta` (`translate.ts:129-131`), подлиния
`reflection-vocabulary`. Покрыто целиком.

**boot:5 `perspective(P) :- authority(P, _).`**
Форма правила покрыта тем же механизмом, а вот `authority/2` — **нет**: **[П]** §2.3 прямо
выводит его из кодировщика — «`authority`/`reserved`/`mode`/`edb` are *asserted* by the boot
layer, not produced by `encodeRule`, so they need only the ordinary EDB path». «Ordinary EDB
path» — это отсылка к тому, кто эти факты положит. В v0 их кладёт ядро: `registerPersp`
(`vendor/rofl-v0/src/reflect.ts:239-241`) добавляет `authority(p, $kernel)` при первом
употреблении перспективы. Измерено: `authority(P, W)` = ровно 2 строки, `P = audit` и
`P = main`, обе с `W = $kernel` — то есть `audit` попал в `authority` **потому что** встретился
в квадратных скобках, а не потому что кто-то его объявил. Ни один проект этого шага не
описывает → **остаточный пробел 1**.

**boot:7 `sees(P, P) :- perspective(P).`**
Повторная переменная в голове. На движке это **уже работает** (RD-a → `{"X":"main","Y":"main"}`),
отказ чисто трансляторный (`missing:demand-mode/repeated-head-var`). Механизм, который обязан
это сохранить при переходе на демандный путь, назван поимённо: `head_pattern_row`, и «Проверка
согласия повторного вхождения уже внутри (`exec.rs:3713-3719` возвращает `None` при
несогласии) — её надо сохранить» (**[З]** §4.4).

**boot:8 `sees(P, Q) :- imports(P, Q).` и boot:9 `sees(P, Q) :- imports(P, X), sees(X, Q).`**
Обычное транзитивное замыкание над пользовательским EDB `imports/2`; ни одна линия не нужна.
Измерено: без фактов `imports` v0 даёт только рефлексивные строки — `sees` = 2 строки.

**boot:11-13 `dep/2` ×2 и `dep_neg/2`**
`concludes/2`, `premise_pos/2`, `premise_neg/2` — все три в списке Projection F. **[П]** §2.1
явно проверяет именно этот блок: «Projection F is what `boot.rofl`'s stratum-0 block actually
consumes: `rule_known/1`, `dep/2`, `dep_neg/2`, `reach/2`, `unstratified/1`, `stratum/2` are all
defined purely over `has_conclusion`, `concludes`, `premise_pos`, `premise_neg`, `edb`
(`run-migration/boot.rofl:4-21`). No reified term appears above the negation line.» Измерено:
`dep/2` = 33, `dep_neg/2` = 6, и содержимое `dep_neg` совпадает с шестью отрицаниями файла.

**boot:15-16 `reach/2`** — рекурсия без отрицания, движок держит нативно. Измерено: 49 строк.

**boot:17 `unstratified(Rel) :- dep_neg(Rel, Q), reach(Q, Rel).`**
`unstratified/1` — не резервное отношение, а **интерфейс**: `IFACE`
(`vendor/rofl-v0/src/reflect.ts:37-39`), и транслятор отказывает отдельным кодом
(`translate.ts:133-134`, подлиния `stratification-interface`). Механизм покрытия — **[П]** §3.3,
нормативно: «`strataPlan()` reads levels from `stratum/2` FACTS in the evaluated fact set, and
reports `level: null` for any relation with no such fact. It must NOT consult `stratify.rs`.»
То есть RFDB обязан не подменить это своим внутренним `derive/stratify.rs`, а принять как
данные. Измерено, что ответ действительно пуст, и что `whynot` даёт конечную демонстрацию через
`dep_neg`.

**boot:19 `stratum(Rel, 0) :- edb(Rel).`**
Целая константа в голове. На движке **уже работает**: RD-b → `{"R":"concludes","N":"~int:0"}`.
Отказ — `translate.ts:115-121`, и его обоснование протухло (разобрано в
`R14-blocker-matrix.md`); решение линии — **[Д]** §1 «Целая константа — `translate-as-is`».
Второй участник, `edb/1`, — снова бутстрап-множество ядра: измерено `edb/1 = 20`, ровно по числу
`reserved/1 = 20`, потому что `bootstrapKernel` кладёт каждое зарезервированное имя и в
`reserved`, и в `edb` (`reflect.ts:221-235`). Плюс `api.ts:119` доращивает `edb` на каждом
assert-е незабронированного отношения. → **остаточный пробел 1**.

**boot:20 `stratum(Rel, N) :- dep_neg(Rel, Q), stratum(Q, M), N is M + 1.`**
Единственная конструкция файла, требующая **нового кода в движке**. Арифметики в RFDB нет
никакой: **[Д]** §5 — «В `registry()` (`derive/builtin.rs:1358-1568`) ровно 29 имён, ни одного
арифметического», и это «the sole registration point (spec §7)» по комментарию на
`builtin.rs:1357`. Измерено на живом сервере (RD-d): форма `add(M, 1, N)` даёт только базовую
строку `{"R":"a","N":"~int:0"}` — рекурсивная клауза не выдаёт **ничего и молча**. Линия «по
запросу» подтверждает жёсткость предпосылки: «`boot.rofl:20` (`N is M + 1`) не переводится
**независимо** от этой линии» (**[З]** §8). Механизм покрытия — регистрация в существующем
реестре по образцу `concat/3`, у которого свободный режим уже доказан (RD-c), плюс девять
прогонов эталона в **[Д]** §5, задающих семантику побайтово: усечение к нулю (`-7 / 3 = -2`),
знак остатка по делимому (`-7 mod 3 = -1`), деление и остаток на ноль = **тихий провал посылки**,
приоритет `*` `/` над `+` `-`, нецелый операнд = тихий провал.

**boot:21 `stratum(Rel, N) :- dep(Rel, Q), stratum(Q, N).`** — та же рекурсия без арифметики;
измерено, что вместе с boot:20 она даёт 38 строк, причём `leak` стоит и на 0, и на 1
одновременно (v0 не берёт максимум внутри отношения — максимум берёт читатель, `readStrata`).

### 2.2 Ниже линии отрицания (строки 25-36)

**boot:25 `malformed[audit](R) :- rule_known(R), not has_premise(R, _).`**
Три механизма сразу.
*Перспектива головы* — **[Пс]** §2.1: «Perspective is a first-class field of a relational
literal, sibling to the predicate name and to the argument tuple — never an argument, never part
of the name. The evaluator's relation key becomes the pair `(perspective, predicate)`», плюс
трёхвариантный `Persp { Implicit, Name(String), Var(String) }`, где `Implicit` намеренно **не**
равен `Name("main")`, потому что «`reflect.ts:171-176` gates `bridge_decl` emission on the
explicitness bit. A two-variant enum destroys it». Измерено, что сегодня парсер RFDB такую форму
не принимает вовсе (P-a: `Datalog parse error … unexpected input`).
*Отрицание с подстановочным знаком* — на движке **уже работает** (B31-d на форме boot:36 →
`{"R":"r2"}`), и это тот самый закреплённый случай, который **[З]** §4.4 обязуется не сломать:
«Существующие тесты `negated_derived_leg_with_wildcard_is_existential` (`exec.rs:4253`) и
`negated_derived_leg_wildcard_arrangements` (`exec.rs:4274`) — частный случай новой формулы при
нуле повторов и обязаны остаться зелёными **без правок**».
*Словарь рефлексии* — Projection F.

**boot:26 `malformed[audit](R) :- has_premise(R, _), not has_conclusion(R, _).`** — то же самое;
две клаузы `malformed` важны отдельно, потому что `p3-malformed-sibling` требует у них **разных**
идентификаторов правил (**[П]** §5.1).

**boot:28 `breach[audit](R) :- concludes(R, Rel), reserved(Rel).`**
`concludes/2` — Projection F; `reserved/1` — бутстрап-множество (измерено 20 строк) →
**остаточный пробел 1**. Перспектива головы — **[Пс]**.

**boot:30 `flow(A, B) :- reads_from(R, A), writes_to(R, B).`**
Обе ножки — Projection F, причём именно они несут перспективу как **значение**: **[П]** §2.1 —
«`P`/`Q` are perspective atoms — in a perspective-less RFDB they are all the constant `main`,
which is exactly what `perspAudit` degenerates to». Измерено, почему на этом нельзя остановиться:
`writes_to` даёт 6 строк `P = audit` и 15 строк `P = main`, а `reads_from` — 21 строку, все
`main`. Если перспектива схлопнута в константу, `flow` вырождается в `{(main,main)}`, и весь
аудит boot:31 становится тождественно пустым по неверной причине.

**boot:31 `leak[audit](A, B) :- flow(A, B), not sees(B, A), not bridge_decl(R, A, B).`** — §3.

**boot:33 `forged[audit](F) :- asserted_by(F, Who), in_perspective(F, P), not authority(P, Who).`**
`F` пробегает **терм** `$fact(rel, persp, $cons(...))` (`reflect.ts:112-114`). **[П]** §2.3
относит это к классу представления Projection T: «`derived_by`'s subject is a whole ground fact
reified as `$fact(rel, persp, $cons(...))` (`reflect.ts:112-114`), so it lands in Projection T's
representation class and inherits its limitation». Само же Projection T объявлено на **двух**
отношениях — «Two relations: `conclusion_lit(R, 1, Term)` and `premise_lit(R, K, Term)»
(**[П]** §2.2) — и `asserted_by`/`in_perspective`/`derived_by` в нём поимённо не заведены →
**остаточный пробел 2**. Измерено, что механически это работает уже сегодня, если терм
непрозрачен: C-c воспроизводит форму boot:33 на `~term:"$fact"("p","main")` и возвращает
`{"F":"~term:\"$fact\"(\"p\",\"main\")"}`; и измерено, что записать составной терм **в тексте
программы** нельзя (C-a → parse error). Ограничение **[П]** §2.2 сформулировано ровно так:
«a query cannot pattern-match inside a `Value::Term`… you cannot join through its arguments»,
и `boot.rofl` внутрь `$fact` действительно не заглядывает.

**boot:36 `unmoded[audit](R) :- uses_builtin(R, B), not mode(B, _).`**
`uses_builtin/2` — Projection F (измерено: 1 строка, единственный `is` из boot:20). `mode/2` —
бутстрап-множество со **списочным** значением; измерено, что v0 хранит `$cons(out,$cons(in,$nil))`,
и что RFDB такой аргумент принимает и возвращает без потерь как `~term:` (K-a). Стык, которого
нет ни в одном проекте: v0 кладёт имя операции **строкой** (`mks(op)` в `reflect.ts:169` против
`mka(...)` у остальных аргументов), и на проводе RFDB это `~str:`-кодировка; если `uses_builtin`
и `mode` разойдутся в кодировке имени операции хотя бы на один тег, `unmoded[audit]` **молча**
наполнится ложными строками, и приёмка boot:39-40 («-> empty») перестанет что-либо значить →
**остаточный пробел 5**.

### 2.3 Строки 38-41 — блок приёмки

Три комментария и одно требование `whynot unstratified(reach) -> finite demonstration via
dep/reach`. Форма демонстрации — линия `whynot-shape` (в матрице подлинии `whynot-demo-shape`,
2 кейса), в разборе `boot.rofl` она нужна только как приёмка, и её текст измерен в §1.1.

---

## 3. `boot.rofl:31` в полный рост

```
leak[audit](A, B)     :- flow(A, B), not sees(B, A), not bridge_decl(R, A, B).
```

Одна строка задевает три линии, и они сходятся в одной точке кода.

### 3.1 Что в ней есть

1. **Явная перспектива головы** `[audit]` при **неявной** перспективе всех трёх ножек. Это не
   догадка о разборе — так это лежит в складе эталона после загрузки:

   ```
   conclusion_lit[main](rd4b824ac,1,$lit(leak,audit,$cons($var("A"),$cons($var("B"),$nil)),$now))
   premise_lit[main](rd4b824ac,3,$not($lit(bridge_decl,main,$cons($var("R"),…),$now)))
   ```

   У головы в поле перспективы стоит `audit`, у отрицаемой ножки — `main`. По решению **[Пс]**
   §2.1 ключ отношения у исполнителя становится парой `(perspective, predicate)`, значит эта
   клауза **читает** `(main, bridge_decl)` и **пишет** `(audit, leak)`.

2. **Свободная переменная `R` только под отрицанием.** `R` не встречается ни в голове, ни в
   одной позитивной ножке. Сегодня движок на такой форме отказывает:

   ```
   B31-a  \+ u_bridge(R, A, B)  ->  E-PLAN-002 (xleak): cannot order bound-first:
                                    no feasible binding for ["u_bridge"]
   B31-b  \+ u_bridge(_, A, B)  ->  0 rows           (то есть отвечает, и отвечает верно)
   B31-c  без ножки bridge      ->  {"A":"main","B":"audit"}
   ```

3. **`bridge_decl/3` — рефлексивное отношение**, десятое в списке Projection F (**[П]** §2.1),
   которое ядро производит **из самих правил**.

### 3.2 Рефлексивная ловушка, доказанная патчем

`bridge_decl` порождается кодировщиком для каждого правила, у которого голова написана явно и
читает другую перспективу (`reflect.ts:171-176`, условие `c.head.perspExplicit && pk !==
canonTerm(headP)`). В `boot.rofl` таких правил ровно шесть — строки 25, 26, 28, 31, 33, 36, — и
измеренный склад это подтверждает с двух сторон: `writes_to` даёт **6** строк `P = audit`, а
`bridge_decl(R, A, B)` — **6** строк, все `A = main, B = audit`, среди них `R = rd4b824ac` — это
идентификатор **самого правила boot:31**.

Отсюда: правило boot:31 объявляет **себя** мостом `main → audit`, и это же объявление гасит
утечку, о которой оно должно было бы доложить. Проверено не рассуждением, а патчем — та же
программа со снятой ножкой `not bridge_decl`:

```
=== 4. does the leak rule suppress ITSELF via bridge_decl? ===
  load ok=true diagnostics=[]
  ? leak2[audit](A, B)   -> ["A = main, B = audit"]
  ? bridge_decl(R, A, B) -> 6 строк; rd4b824ac заменился на r24ae6a0b
  ? flow(A, B)           -> ["A = main, B = audit","A = main, B = main"]
  ? sees(P, Q)           -> ["P = audit, Q = audit","P = main, Q = main"]
```

Читается так: поток `main → audit` реально существует, `sees(audit, main)` реально нет, то есть
утечка **есть** — и в неизменённом `boot.rofl` её ровно и полностью гасит третья ножка. Пустой
ответ `leak[audit](A,B) -> []` из блока приёмки — это не «утечек не бывает», это «все шесть
переходов объявлены». Заодно видно, что идентификатор правила — **содержимое клаузы**: стоило
переписать голову и убрать ножку, как `rd4b824ac` превратился в `r24ae6a0b`.

Практическое следствие для миграции: тест на `leak[audit]` пуст в обеих реализациях **и когда всё
верно, и когда рефлексивная эмиссия `bridge_decl` сделана слишком широко**. Значит приёмка
boot:31 обязана включать патч-вариант (снять ножку → получить ровно одну строку `main, audit`),
иначе она не различает эти два случая.

### 3.3 Точка, где две линии совпадают

Обе линии указывают на одну функцию — `can_place_and_provides` (`derive/plan.rs:938-950`), и
внутри неё на один и тот же оператор:

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

**[З]** §4.3(1) требует править это **один раз**: «Реализуется **один раз, обобщённо по позициям
аргументов и по полю перспективы сразу**: `rofl-perspectives-design.md:433-440` правит то же
условие, и две независимые правки разойдутся». **[Пс]** §3.2 с той же стороны: «The perspective
variable is explicitly **excluded** from `plan.rs:940`'s all-args-bound requirement, and this
exclusion is a named test (T3b, §8.1), not an oversight». И **[З]** §2.8 формулирует, почему это
одно изменение, а не два: «`Persp` — нулевая колонка одного и того же механизма».

В этом они согласны. Дальше — расхождения, все три реальные.

### 3.4 Расхождение 1: объём исключения

**[Пс]** §3.2 выводит из-под требования связанности **только поле перспективы**; цитируемое ею
предложение «Negative literals require ALL Var args to be in bound» остаётся в силе для позиций
аргументов. **[З]** §4.3(1) снимает требование и с аргументов: `can_place_and_provides`
«перестаёт требовать связанности переменных отрицаемого литерала и — по решению линии перспектив
— поля перспективы».

Это не противоречие в фактах, но это разные правки, и разница измерима: если приедет только
приращение перспектив, `boot.rofl:31` **по-прежнему** упрётся в `E-PLAN-002` (B31-a), потому что
свободна не перспектива, а аргумент `R`. Сам **[Пс]** §6.1 это и предполагает — ожидаемый эффект
своего первого приращения он заявляет как «`missing:perspectives` count 1 → 0; GREEN 5 → 6», то
есть без загрузки `boot.rofl`. Разрешение для плана: правка одна, в формулировке **[З]**, а поле
перспективы входит в неё как нулевая колонка.

### 3.5 Расхождение 2: сама формула анти-джойна

**[Пс]** §3.2: «the negated leg's anti-join probes every inner entry and passes only if all miss»
— чисто поколоночный экзистенциал, без условия на повторы.
**[З]** §4.4 требует сверх этого диагонали: строка выживает, если не существует факта `f`, у
которого одновременно `f[i] == probe[i]` на всех связанных позициях **и** `f[j] == f[k]` для
любых `j`,`k` с одной и той же свободной переменной.

На **одной** колонке (перспектива) обе формулировки совпадают — повторяться там нечему. Перенесённая
дословно на позиции аргументов, формулировка **[Пс]** несостоятельна, и это измерено на эталоне:

```
v0  res(X) :- p(X), not q(X, Y, Y).  -> ["X = x"]     (диагональ ограничивает)
v0  res(X) :- p(X), not q(X, _, _).  -> []            (без неё ответ другой)
```

Поскольку правка по §3.3 обязана быть одной, нормативным текстом для неё должна быть формула
**[З]** §4.4; формулировка **[Пс]** остаётся верной как её частный случай для нулевой колонки.

### 3.6 Расхождение 3: что именно легитимирует прецедент с подстановочным знаком

**[Пс]** §3.2 заканчивает мысль ссылкой: «This is the same shape as the already-pinned existential
wildcard rule (`exec.rs::negated_derived_leg_with_wildcard_is_existential`, cited by
`rofl-conformance/src/translate.ts:314-319`'s comment)» — то есть опирается на комментарий
транслятора как на подтверждение.
**[З]** §2.3 на том же прецеденте доказывает **обратное** про транслятор: «переписывание
`not p(Y,Y)` → `not p(_,_)` в трансляторе несостоятельно».

Тонкость, которая делает это расхождение опасным именно здесь: **на форме boot:31 переписывание
точно**, потому что `R` встречается один раз. Три измерения совпадают до строки:

```
v0   … not bridge(R, A, B).   -> ["A = x, B = y"]
v0   … not bridge(_, A, B).   -> ["A = x, B = y"]
RFDB … \+ u_bridge(_, A, B).  -> {"B":"y","A":"x"}
```

То есть чисто трансляторный обход — «переименовать свободную переменную под отрицанием в `_`» —
**заставил бы `boot.rofl` загрузиться и ответить верно уже сегодня, без единой правки движка**.
И именно поэтому его брать нельзя: он верен для boot:31 и неверен в общем случае (§3.5), а
конформанс сравнивает две реализации, а не одну программу. Решение: обход не берём; берём правку
движка, а `boot.rofl:31` держим как приёмочный случай, где обе трактовки совпадают, и добавляем
диагональный случай `not q(X, Y, Y)`, где они расходятся.

---

## 4. Остаточные пробелы

Проверено по всем 21 конструкции: линия, покрывающая механизм, называется в §2 для каждой. Ниже —
то, для чего такой линии не нашлось. Все шесть ограничены (bounded): каждый — известное изменение
с измеренной формой, не исследовательская задача.

**1. Бутстрап-множество ядра как данные.** `boot.rofl` читает `authority/2`, `reserved/1`,
`edb/1`, `mode/2`, но ни одна линия не описывает, кто их кладёт в RFDB. В v0 их кладёт ядро, и
измеренные формы такие: `reserved/1` = 20 строк и `edb/1` = 20 строк из `bootstrapKernel`
(`reflect.ts:221-235`, одно и то же множество имён в оба отношения); `edb/1` при этом **растёт
динамически** — `api.ts:118-119` добавляет `edb(rel)` при каждом assert-е незабронированного
отношения; `mode/2` = 7 строк со списочным значением; `authority/2` появляется побочным эффектом
`registerPersp` (`reflect.ts:239-241`), вызываемого из `api.ts:115` на каждом факте. В **[П]**
§2.1 их нет (десять относительных форм Projection F перечислены поимённо), а §2.3 выводит их
явно: «are *asserted* by the boot layer, not produced by `encodeRule`». «Boot layer» в RFDB не
существует. Ограничено: список конечен и измерен, механизм — обычные EDB-факты.

**2. `$fact(...)`-термы в `in_perspective/2` и `asserted_by/2`.** boot:33 джойнит по терму
`$fact(rel, persp, $cons(...))` (`factTerm`, `reflect.ts:112-114`). **[П]** §2.2 определяет
Projection T на **двух** отношениях — `conclusion_lit` и `premise_lit`; §2.3 относит `derived_by`
к тому же классу представления, но `in_perspective`/`asserted_by` поимённо не заведены нигде.
Измерено, что механически это работает уже сегодня (C-c воспроизводит форму boot:33 и возвращает
строку), и измерено побочное условие: **записать составной терм в тексте программы нельзя**
(C-a → `Datalog parse error`), поэтому кодировщик обязан строить блоб программно — ровно как
**[П]** §2.2 и оговаривает («the encoder must build these blobs programmatically from the parsed
`ExtProgram`»). Ограничено, с проверяемым побочным условием.

**3. Порядок исполнения, читаемый из данных.** v0 не стратифицирует сам: `run()`
(`engine.ts:167-186`) сначала гонит монотонные правила до фикспойнта, потом берёт уровни из
**фактов** — `readStrata()` (`engine.ts:211-219`) берёт по отношению **максимум** (`n.v > cur`),
а правила с неизвестным уровнем идут последним проходом (`?? Infinity`, `engine.ts:182`).
Это и объясняет измеренные 38 строк `stratum`, где `leak` стоит и на 0, и на 1: максимум берёт
читатель. **[П]** §3.3 фиксирует контракт `strataPlan()` («must NOT consult `stratify.rs`»), но
контракт **порядка исполнения** — что RFDB обязан исполнять отрицательные правила по уровням из
данных, а не по своей внутренней стратификации, — не сформулирован ни в одном проекте.
Ограничено: правило вычисления уровня измерено целиком.

**4. Молчаливая пустота на незарегистрированном билтине.** Измерено: `totally_not_a_builtin(X, Y)`
→ 0 строк, без ошибки. Это ни ответ, ни отказ, и ни одна линия этого не покрывает. Для boot:20
это прямой риск: арифметика, зарегистрированная под другим именем или другой арностью, даст
неотличимый от пустого отношения результат, а `stratum/2` при этом не свалится, а тихо потеряет
уровни — то есть сломается **порядок исполнения** из пробела 3, а не сам ответ. Ограничено:
отказ с кодом на неизвестное имя в позиции билтина.

**5. Джойн `uses_builtin`/`mode` по строке v0.** Имя операции кодировщик кладёт **строкой**
(`mks(op)`, `reflect.ts:169`), остальные аргументы — атомами (`mka(...)`), и измерено, что на
проводе RFDB строка и атом различимы (`~str:"hello"` против `hello`, проба S-a). boot:36
джойнит `uses_builtin(R, B)` с `mode(B, _)` именно по этому значению. Если словарь рефлексии и
бутстрап-множество разойдутся в кодировке хотя бы на один тег, `unmoded[audit]` **молча**
наполнится ложными строками — а приёмка boot:39-40 требует пустоты, и пустота там же ожидается в
верном случае. Значит это должно быть **одним** решением, а не двумя. Ограничено.

**6. Идентичность `rule id`.** v0: `ruleIdOf(c) = 'r' + fnv1a(canonClause(c))`
(`reflect.ts:134-136`), и идентификаторы **наблюдаемы в ответах**, а не только в `why`: измерено
`bridge_decl(R, A, B) -> R = r66afcc0f …`, и измерено, что id — содержимое клаузы (патч §3.2
превратил `rd4b824ac` в `r24ae6a0b`). **[П]** §5.1 постановляет обратное: «keep RFDB's hash as
the identity and define the ROFL surface id as its first 8 hex digits, prefixed `r`. Do NOT port
FNV-1a». Ни один сценарий сегодня не фиксирует конкретный id (`grep -n "r[0-9a-f]\{8\}"
packages/rofl-conformance/src/scenarios.ts` — пусто), то есть решение пока не опровергнуто
тестом; но поверхность запросов эти значения возвращает, и любое построчное сравнение эталона с
субъектом по рефлексивному отношению с колонкой `R` разойдётся. Ограничено, но требует решения
владельца: либо портировать `canonClause` + FNV-1a, либо объявить id непрозрачными и
нормализовать их в оракуле.

**Проверено и НЕ является пробелом.** Перспективно-слепая таблица `groundFacts`
(`translate.ts:283`, `Map<string, string[][]>` по имени отношения, ключ дедупликации
`${rel}(${args})`) — покрыта нормативным пунктом 1 из **[Пс]** §6.3: «`TransFact`/`groundFacts`
become keyed by `(rel, persp)`; the dedup key becomes `${rel}[${persp}](${args})`», и там же
разобрано, почему это не «полировка»: без пункта 12 целиком снятие фазового гейта превращает
честный RED в «silent wrong answer inside the conformance harness».

---

## 5. Порядок работ

Колонка «закрывает RED» — **измеренная верхняя граница**: проба считает снятые *отказы
транслятора*, а не прохождение сценария. Шаги-предпосылки дают 0 поодиночке и выход **совместно**
— это свойство самой матрицы (`int-constants alone → 0/25`, `ALL dialect sub-lanes → 1/25`), а не
осторожность оценки.

**Шаг 0 — аудит точек отказа `translate.ts` против HEAD.** Каждая ссылка `file:line` в тексте
отказа обязана существовать и содержать утверждаемое; каждый выживший отказ подтверждается пробой
на живом сервере. Здесь же `X = X` переклассифицируется из `dialect:untranslatable` в
`missing:demand-mode` (**[Д]** §6), а протухшее обоснование `translate.ts:115-121` снимается.
Закрывает: **0** (измерено).

**Шаг 1 — молчаливый ноль в `project_head`** (`derive/exec.rs:3687-3700`). Несвязанная переменная
в голове **не**демандного правила даёт отказ со стабильным кодом, а не пустой результат. Это
самостоятельная починка нарушенного инварианта движка, и **[З]** §4.4 ставит её первой:
«Молчаливый ноль закрывается отдельно и первым». Приёмка: сегодняшнее поведение измерено (Q3-a:
0 строк молча против `X = a, Y = ?Y` у эталона); `cargo test --lib` без регрессий.
Закрывает: **0**.

**Шаг 2 — арифметика в `builtin::registry()`** (`is` и `+ - * / mod`). Зависит от шага 0.
Приёмка: девять прогонов эталона из **[Д]** §5 воспроизводятся побайтово (усечение к нулю, знак
остатка по делимому, `/0` и `mod 0` = пустой ответ, приоритет, скобки, нецелый операнд = пустой
ответ); форма boot:20 перестаёт быть тихим нулём (сегодня RD-d). Закрывает: **0**.

**Шаг 3 — экзистенциальное отрицание в движке.** Одна обобщённая правка `can_place_and_provides`
(`plan.rs:938-950`), покрывающая позиции аргументов **и** поле перспективы разом (§3.3-3.4);
анти-джойн по формуле **[З]** §4.4 с диагональю; закрепление порядка по условию **[З]** §5.
Зависит от шага 1. Приёмка: B31-a (форма boot:31 с именованной `R`) отвечает `{"A":"main"…}`
вместо `E-PLAN-002`; диагональ `not q(X, Y, Y)` даёт `x`, а не пусто (измерено на эталоне);
`negated_derived_leg_with_wildcard_is_existential` (`exec.rs:4253`) и
`negated_derived_leg_wildcard_arrangements` (`exec.rs:4274`) зелёные **без правок**;
`p3_plan_fingerprints.txt` побайтово тот же (40816 строк). Закрывает: **0**.

**Шаг 4 — перспективы, первое приращение.** `Persp { Implicit, Name, Var }`, парсер `rel[persp](args)`,
двухуровневые карты, элизия `Implicit` при рендеринге, полный круг конформанса по пяти
нормативным пунктам **[Пс]** §6.3. Зависит от шага 3 (общая правка планировщика). Приёмка:
`p2-persp-isolation` RED → GREEN; T8c (две строки таблицы A2 классифицируются по-разному);
парсер принимает `u_leak[audit](X) :- u_p(X).` (сегодня — parse error, P-a).
Закрывает: **1** (`p2-persp-isolation` — единственный кейс, у которого это единственный блокер).

**Шаг 5 — рефлексивный EDB, авторитет = стор.** Projection F + бутстрап-множество (пробел 1) +
Projection T (пробел 2); шов внутри `parse_ext_program` (`derive/parser_ext.rs:863`) по **[П]**
§3.1. Зависит от шага 4: `P`/`Q` в `reads_from`/`writes_to`/`bridge_decl` обязаны быть настоящими
перспективами, иначе `flow` вырождается (§2.2, boot:30). Приёмка — живым запросом после
`load(BOOT)` те же числа, что напечатал эталон: `bridge_decl` = 6 строк `main → audit`,
`flow` = {(main,audit),(main,main)}, `reads_from` = 21, `writes_to` = 6+15, и патч-вариант §3.2
даёт ровно одну строку `leak2[audit](main, audit)`. Закрывает: **0** поодиночке.

**Шаг 6 — интерфейс стратификации из данных.** `stratum/2` и `unstratified/1` как факты; порядок
исполнения отрицательных правил по `readStrata` с максимумом и `Infinity` для неизвестных
(пробел 3); `checkUnstratified` как приёмочный гейт. Зависит от шага 5. Приёмка: `unstratified(X)`
пусто, `stratum` = 38 строк с `leak` и на 0, и на 1, `whynot unstratified(reach)` даёт конечную
демонстрацию через `dep_neg`/`reach` — текст сверяется с §1.1. **Здесь закрывается совокупный
выход:** закрывает **5** (итого **6 из 25**: `p1-arith`, `p3-runtime-rule`, `p3-write-protected`,
`p3-breach`, `boot-load` плюс уже закрытый `p2-persp-isolation`).

**Шаг 7 — `strataPlan` на поверхности API** (`level: null` без boot). Зависит от шага 6.
Закрывает: **+2** → **8 из 25** (измерено).

**Шаг 8 — линия дыр**: бюджет → частичный результат + факт `hole/2` (R-2 из `OWNER-RULINGS.md`),
против `E-EXEC-002`. Форма эталона измерена: `engine.ts:188-192` при `BudgetExhausted` ставит
`partial = true` и пишет `hole(id, budget_exhausted)`. Зависит от шага 6.
Закрывает: **+2** → **10 из 25** (измерено).

**Шаг 9 — флаг `naive` принять-и-игнорировать** (`adapter.ts:33-39`, **[Д]** §9). Зависит от
шага 0. Закрывает: **+1** → **11 из 25** (измерено).

Дальше кривая продолжается как в §1.7 (составные термы → 12, форма why-дерева → 13, …), и это уже
за пределами вопроса «переводится ли `boot.rofl`».

