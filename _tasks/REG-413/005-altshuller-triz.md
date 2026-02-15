# REG-413: ТРИЗ-анализ — Противоречия в подходе к подсказкам для AI

**Дата:** 2026-02-15
**Автор:** Генрих Альтшуллер (ТРИЗ-консультант)
**Статус:** Критический анализ предложенного подхода

---

## Исполнительное резюме

**Главный вывод:** Команда пытается решить **неправильно сформулированную задачу**.

Проблема не в том, что AI нужны подсказки о ЧТО менять. Проблема в том, что **Grafema с подсказками УХУДШИЛА результат** (Baseline 45% → Grafema 20%). Это не просто "не помогла" — она **активно навредила**.

ТРИЗ-анализ показывает: команда столкнулась с **физическим противоречием**, которое невозможно решить добавлением информации. Подсказки должны быть **одновременно детальными (чтобы помочь рассуждать) И краткими (чтобы не перегрузить)**. Это классический сигнал: вы пытаетесь улучшить систему в направлении, которое ведёт в тупик.

**Рекомендация:** ОСТАНОВИТЬ исследование подсказок. Вместо этого применить принцип ТРИЗ "сделать наоборот" и "обратить вред в пользу".

---

## 1. Формулировка противоречий

### 1.1 Техническое противоречие

**Что мы хотим улучшить:**
Resolve rate (процент успешных решений задач)

**Что ухудшается при попытке улучшить:**
- **Перегрузка контекста** — модель получает больше информации, но хуже рассуждает
- **Стоимость** — больше токенов на обработку подсказок
- **Когнитивная нагрузка на модель** — больше данных → труднее выбрать релевантное

**Классическая формулировка:**
> Если мы добавляем подсказки → resolve rate должен расти, но **фактически падает** (45% → 20%).
> Если мы не добавляем подсказки → навигация эффективна (−50% стоимости), но resolve rate не растёт.

**Вывод:** Это не техническое противоречие. Это **сигнал, что подсказки — неправильное направление**.

### 1.2 Физическое противоречие

**Подсказки должны быть:**
- **Детальными** — чтобы дать модели достаточно информации для правильного рассуждения
- **Краткими** — чтобы не перегрузить контекст и не затруднить выбор релевантной информации

**Это физическое противоречие:** один и тот же элемент системы (подсказка) должен обладать **противоположными свойствами одновременно**.

**Примеры из исследований:**

1. **Information overload в LLM** ([How to Stop Overloading Your LLM with Irrelevant Info](https://medium.com/@ayoubkirouane3/how-to-stop-overloading-your-llm-with-irrelevant-info-0a80d971310c)):
   > "LLMs have a structural limitation called information overload, where too much context leads to worse outcomes, with performance peaking and then declining as more context is added."

2. **Constraint-based approach** ([Dumber LLM Agents Need More Constraints and Better Tools](https://www.llamaindex.ai/blog/dumber-llm-agents-need-more-constraints-and-better-tools-17a524c59e12)):
   > "Agents implemented with 'dumber' models need more interaction constraints in order to make more reliable, less erroneous decisions."

3. **Cognitive Load Theory** ([The Cognitive Load Theory in Software Development](https://thevaluable.dev/cognitive-load-theory-software-developer/)):
   > "At the level of programming language statements, a programmer needs to consider a multitude of details, most likely overwhelming the working memory limits."

**Вывод:** Подсказки усиливают extraneous cognitive load (посторонняя нагрузка из-за плохого дизайна), вместо того чтобы снижать intrinsic load (сложность самой задачи).

---

## 2. ИКР (Идеальный Конечный Результат)

### 2.1 Классическая формула ИКР в ТРИЗ

> **"Система сама выполняет нужную функцию, не создавая новых проблем."**

Применительно к Grafema:

**Идеальная подсказка — это подсказка, которой нет, но функция (улучшение рассуждений AI) выполняется.**

### 2.2 Что это означает для Grafema?

**Переформулировка задачи:**
- **Текущая формулировка:** "Какие подсказки нужно добавить, чтобы AI лучше рассуждал?"
- **ИКР-формулировка:** "Как AI может лучше рассуждать БЕЗ дополнительных подсказок?"

**Примеры систем, приближённых к ИКР:**

1. **Constraint-based problem solving** ([AI-Driven Constraint Programming](https://fullvibes.dev/posts/ai-driven-constraint-programming-solving-impossible-puzzles-with-smart-boundaries)):
   > "Constraints define the allowable combinations of values for the variables, thereby reducing the search space and guiding the solver towards valid solutions."

   **Ключ:** Не добавлять информацию о правильных решениях, а **убрать неправильные** из пространства поиска.

2. **Context Pruning** ([When More Is Less: Information Overload in AI-Driven Finance](https://clsbluesky.law.columbia.edu/2025/06/19/when-more-is-less-information-overload-in-ai-driven-finance/)):
   > "Three specific tactics that help prevent an agent's context from collapsing under its own weight include Context Pruning, Context Summarization, and Tool Loadout."

   **Ключ:** Убирать лишнее важнее, чем добавлять нужное.

### 2.3 ИКР для Grafema

**Идеальная система:**
> Граф структурирует пространство решений так, что модель **физически не может** выбрать неправильный вариант, при этом не получая никаких дополнительных подсказок.

**Как это может выглядеть:**
- Не "подсказать, что нужно изменить 3 метода", а **показать только те 3 метода, которые можно изменять** (остальные скрыты/недоступны)
- Не "подсказать, что cleanup функции хранятся на function object", а **предоставить только API для записи в function object** (запись в vnode недоступна в контексте)
- Не "подсказать паттерн forEach caller", а **показать только caller код** (callee не видна в контексте этого шага)

---

## 3. Анализ ресурсов (АРИЗ Шаг 2)

### 3.1 Какие ресурсы НЕ используются?

**Ресурс 1: Структура графа как ОГРАНИЧЕНИЕ, а не как ИНФОРМАЦИЯ**

Сейчас:
- Граф используется для **добавления информации** (вот все вызовы, вот все зависимости)
- Модель сама решает, что из этого релевантно

ИКР:
- Граф используется для **сужения пространства решений**
- Модель видит только то, что может быть правильным ответом

**Аналогия из Constraint Satisfaction Problems** ([Constraint Satisfaction Problems in AI](https://www.geeksforgeeks.org/artificial-intelligence/constraint-satisfaction-problems-csp-in-artificial-intelligence/)):
> "Constraint propagation works by iteratively narrowing down the domains of variables based on the constraints, making it easier to find a valid solution."

**Пример для axios-5085:**

❌ **Текущий подход (подсказки):**
```
Вы изменяете: AxiosHeaders.toJSON()
Hint: Функции, которые часто меняются вместе:
  - AxiosHeaders.normalize() [3/5 commits]
  - AxiosHeaders.set() [2/5 commits]
Рассмотрите их для консистентности.
```
→ Модель получает 2 кандидата + исходную функцию = 3 варианта выбора
→ Extraneous cognitive load растёт
→ Модель может проигнорировать подсказку или неправильно интерпретировать

✅ **Constraint-based подход:**
```
Шаг 1: Выберите метод для изменения в классе AxiosHeaders
Доступные методы (предфильтрованные по dataflow из bug report):
  - toJSON()
  - normalize()
  - set()

[Модель выбирает toJSON]

Шаг 2: Изменения в toJSON() влияют на:
  - normalize() (shared data flow)
  - set() (shared data flow)

Хотите изменить эти методы также? [yes/no для каждого]
```
→ Модель видит **только релевантные варианты**
→ Решение структурировано как последовательность бинарных выборов
→ Cognitive load снижен (bounded choice)

**Ресурс 2: Dataflow граф как МАРШРУТИЗАТОР решений**

Сейчас:
- Dataflow используется для показа связей
- Модель сама решает, по каким связям идти

ИКР:
- Dataflow используется для **предложения следующего шага** (как GPS навигация)
- "Вы изменили A. Данные из A текут в B и C. Следующий шаг: проверить B или C?"

**Аналогия:** Не карта всех дорог города (information overload), а **пошаговая навигация** "через 100м поверните направо" (constraint-guided flow).

**Ресурс 3: Граф гарантий (GuaranteeManager) как ВАЛИДАТОР**

Сейчас:
- Guarantees проверяются после анализа (статический линтинг)

Потенциал:
- Guarantees как **runtime constraints** для AI agent
- "Вы хотите добавить try/catch в callee? Это нарушает guarantee 'error-handling-pattern: early-return'. Доступные альтернативы: [список]"

### 3.2 Какие ресурсы используются НЕПРАВИЛЬНО?

**Проблема: Граф используется для ДОБАВЛЕНИЯ контекста, а должен использоваться для СУЖЕНИЯ выбора**

**Пример из исследований:**

[LLM Reasoning and Test Time Scaling](https://developer.nvidia.com/blog/an-easy-introduction-to-llm-reasoning-ai-agents-and-test-time-scaling/):
> "AI systems can learn which variables to assign first and which values to try, dramatically pruning the search space."

**Ключевое слово:** "PRUNING" (отсечение), а не "AUGMENTING" (дополнение).

---

## 4. Альтернативные направления (вместо подсказок)

### 4.1 Направление 1: Constraint-Guided Workflow

**Принцип:** Граф ограничивает пространство действий агента, а не предлагает дополнительную информацию.

**Механика:**

**Шаг 1: Проблема → Граф строит "область воздействия"**
- Вход: баг-репорт (например, "Set-Cookie headers are duplicated")
- Граф находит все узлы, связанные с Set-Cookie (via dataflow, calls, string literals)
- Агент видит **только эти узлы**, остальная кодовая база скрыта

**Шаг 2: Агент выбирает стартовую точку**
- Из отфильтрованного списка (10-15 узлов вместо всей кодовой базы)
- Cognitive load снижен на 95%

**Шаг 3: Агент делает изменение → Граф показывает "волны воздействия"**
- "Вы изменили toJSON(). Это влияет на 3 метода (dataflow): normalize(), set(), get()"
- "Какие из них нужно адаптировать?" — бинарный выбор для каждого

**Шаг 4: Граф валидирует консистентность**
- "Вы изменили обработку массивов в toJSON(), но не в normalize(). Это может вызвать inconsistency. Проверить?"

**Аналогия из разработки ПО:**

[Cognitive Load in Modern IDEs](https://www.devx.com/enterprise-zone/cognitive-load/):
> "Decision fatigue accumulates when developers repeatedly face unclear, inconsistent, or complex choices. Establishing clear coding standards, architectural guidelines, and consistent technology stacks simplifies decision-making, freeing cognitive resources for more impactful tasks."

**Ключ:** Не давать больше данных, а **структурировать принятие решений**.

### 4.2 Направление 2: Inverted Information Flow (принцип ТРИЗ "наоборот")

**Текущий подход:**
- Агент запрашивает → Grafema отвечает (pull model)
- Агент решает, что спросить
- Risk: агент не знает, что спросить

**Инверсия:**
- Grafema проактивно предлагает → Агент выбирает (push model)
- Grafема анализирует баг-репорт и **сама строит граф решения** (solution graph)
- Агент навигирует по уже построенному графу решения

**Пример (axios-5085):**

❌ Сейчас:
```
1. Агент: get_context("AxiosHeaders")
2. Grafema: [показывает 50 методов]
3. Агент: get_context("toJSON")
4. Grafema: [показывает код + 5 вызовов]
5. Агент пишет патч для toJSON
6. FAIL — пропустил normalize()
```

✅ Инверсия:
```
1. Grafema анализирует "Set-Cookie duplication" + граф
2. Grafema строит Solution Graph:
   - Root: bug symptom (duplicated headers)
   - Candidates: toJSON, normalize, set (scored by relevance)
   - Dependencies: "if toJSON changed → normalize likely needs change"
3. Агент получает Solution Graph как structured task
4. Агент идёт по графу: toJSON → normalize → validate
```

**Преимущество:**
- Граф делает то, в чём он силён (структурный анализ)
- Агент делает то, в чём он силён (генерация кода)
- Разделение ответственности

### 4.3 Направление 3: Two-Phase Architecture (Обратить вред в пользу)

**Наблюдение из данных:**
> "Grafema reduces file exploration by 34-100%, agents reach relevant code 2-3x faster, but resolve rate drops."

**ТРИЗ-приём "Обратить вред в пользу":**
- Вред: Grafema сокращает exploration → агент видит меньше контекста → пропускает важное
- **Инверсия:** Сделать это ФИЧЕЙ, а не багом

**Механика:**

**Phase 1: Narrow Focus (Grafema-driven)**
- Граф строит минимальный контекст (только bug-relevant код)
- Агент работает в "узком фокусе"
- Fast, cheap, targeted

**Phase 2: Breadth Validation (Traditional exploration)**
- Только если Phase 1 не даёт полного решения
- Агент переключается в режим "широкого поиска"
- Использует традиционные инструменты (grep, cat)

**Гипотеза:**
- axios-5085 в Phase 1 найдёт toJSON (граф видит связь с Set-Cookie)
- Phase 1 патч: фикс toJSON
- Grafema валидирует: "normalize() имеет аналогичную структуру и dataflow. Phase 1 недостаточна."
- Phase 2: агент расширяет поиск, находит normalize()

**Ключ:** Не "или Grafema, или exploration", а **"Grafema сужает → exploration расширяет"** (two-phase).

### 4.4 Направление 4: Graph-Constrained Code Generation

**Радикальный подход:** Не давать агенту генерировать произвольный код, а **ограничить генерацию через граф**.

**Механика:**

**Сейчас:**
- Агент генерирует патч в виде diff
- Патч может быть где угодно

**Constraint-based:**
- Агент генерирует патч через structured API:
  ```
  modify_node(semantic_id, transformation_type, params)
  ```
- Grafема валидирует:
  - transformation_type разрешён для этого типа узла?
  - Не нарушены ли dependencies?
  - Нужны ли cascading changes в связанных узлах?

**Пример (axios-5085):**
```javascript
// Агент запрашивает:
modify_node(
  semantic_id: "axios:AxiosHeaders.toJSON",
  transformation: "fix_array_handling",
  pattern: "join_with_comma_space"
)

// Grafema отвечает:
{
  primary_change: "axios:AxiosHeaders.toJSON:line_45",
  cascading_candidates: [
    "axios:AxiosHeaders.normalize" // аналогичный паттерн
  ],
  confidence: 0.85,
  action: "apply_to_primary_and_ask_about_cascading"
}
```

**Преимущество:**
- Граф контролирует консистентность изменений
- Агент не может "забыть" про связанные изменения — граф напоминает
- Structured output → легче валидировать

**Аналогия:** [Constraint Logic Programming](https://www.larksuite.com/en_us/topics/ai-glossary/constraint-logic-programming) — вместо того чтобы давать все ответы и просить выбрать правильный, даём только правильные ответы.

---

## 5. Почему Grafema УХУДШИЛА результат? (Root Cause Analysis)

### 5.1 Данные из эксперимента

- **Baseline:** 45% (5/11 tasks)
- **Grafema:** 20% (2/10 tasks)
- **axios-5085:** Baseline PASS → Grafema FAIL

### 5.2 Гипотеза: "Ложная уверенность"

**Эффект:**
- Grafema даёт агенту **точный ответ на вопрос "где код?"**
- Агент интерпретирует это как **"вот ВСЁ, что нужно изменить"**
- Агент **прекращает поиск раньше времени**

**Пример (axios-5085):**
```
Агент: get_context("AxiosHeaders.toJSON")
Grafema: [точный код функции + список вызовов]
Агент: "Нашёл! Проблема в toJSON, вот патч."
→ FAIL, потому что пропустил normalize()
```

**Baseline (без Grafema):**
```
Агент: grep "Set-Cookie"
Bash: [показывает 10 файлов]
Агент: cat axios/headers.js
Bash: [показывает ВЕСЬ класс AxiosHeaders, включая toJSON И normalize]
Агент: "Вижу два метода с похожей логикой. Изменю оба."
→ PASS
```

**Вывод:** **Точность Grafema привела к tunnel vision.**

**Подтверждение из исследований:**

[Cognitive Load in Programming](https://github.com/zakirullin/cognitive-load):
> "If you keep the entire class in your head, you'll reject improper approaches without even trying them."

**Парадокс:**
- Baseline заставляет агента читать **больше кода**
- Больше кода → больше контекста → **лучше глобальное понимание**
- Grafema даёт **меньше кода** → меньше контекста → **хуже глобальное понимание**

### 5.3 Вторая гипотеза: "Semantic Mismatch"

**Проблема:** Граф показывает **структурные связи** (CALLS, DEPENDS_ON), а баги требуют понимания **семантических связей** (обрабатывают одинаковые данные).

**Пример:**
- `toJSON()` и `normalize()` НЕ вызывают друг друга
- Граф НЕ показывает прямой связи
- Но они обрабатывают **одинаковую структуру данных** (headers array)
- Baseline видит их рядом в одном файле → понимает семантическую связь
- Grafema показывает их как **отдельные узлы** → семантическая связь потеряна

**Вывод:** Граф правильно показывает структуру, но **скрывает семантику**.

### 5.4 Третья гипотеза: "Premature Optimization"

**Cognitive Load Theory** ([Applying Cognitive Load Theory to Computer Science Education](https://www.researchgate.net/publication/250790986_Applying_Cognitive_Load_Theory_to_Computer_Science_Education)):
> "Intrinsic load (material complexity) cannot be reduced without changing the task itself. Extraneous load (poor design) can and should be reduced. Germane load (schema building) should be maximized."

**Grafema сокращает extraneous load (навигация), но ТАКЖЕ сокращает germane load (построение ментальной модели кодовой базы).**

**Аналогия:**
- Студент читает учебник целиком → строит целостную модель (germane load)
- Студенту дают только релевантные страницы → не видит контекста → модель фрагментирована

**Для axios-5085:**
- Baseline: агент читает весь AxiosHeaders класс → видит методы рядом → строит модель "это cohesive unit"
- Grafema: агент получает toJSON изолированно → не видит cohesion → модель "это независимый метод"

**Вывод:** Оптимизация навигации **разрушила schema building**.

---

## 6. Рекомендации

### 6.1 СТОП-сигнал: Остановить исследование подсказок

**Почему:**
1. **Физическое противоречие** (подсказки должны быть детальными И краткими) указывает на тупиковое направление
2. **Ухудшение результата** (45% → 20%) — это не "недостаточно данных для выводов", это **сигнал о фундаментальной проблеме**
3. **5 направлений подсказок** в плане Don — это попытка решить противоречие **в рамках той же парадигмы** (добавление информации). ТРИЗ говорит: выйти за рамки парадигмы.

**Action:** Не запускать Phase 1 (Quick Validation) из плана Don. Вместо этого — следующие шаги.

### 6.2 Приоритет 1: Constraint-Based Navigation (2 недели)

**Гипотеза:**
- Grafema строит "область воздействия" (impact zone) из графа
- Агент видит только узлы в impact zone
- Search space сужен на 90-95%
- Cognitive load снижен → resolve rate растёт

**MVP:**
1. Новый MCP tool: `get_impact_zone(bug_description)` → возвращает список semantic IDs
2. Агент использует только узлы из impact zone для первых N шагов
3. Если не находит решение → fallback на полный граф

**Эксперимент:**
- Re-run axios-5085 с impact zone (toJSON, normalize, set)
- Measure: находит ли агент все 3 метода?

**Success criteria:**
- axios-5085: FAIL → PASS
- Resolve rate > Baseline (>45%)
- Token cost < Baseline + 20%

**Effort:** 10-12 дней (граф impact analysis + MCP integration + validation)

### 6.3 Приоритет 2: Two-Phase Workflow (1 неделя)

**Гипотеза:**
- Phase 1: Узкий фокус (Grafema) — fast & cheap
- Phase 2: Широкий поиск (baseline tools) — только если Phase 1 недостаточна
- Лучшее из обоих миров

**MVP:**
1. Промпт для агента: "Start with Grafema tools, switch to grep/cat only if stuck"
2. Metric: "escalation rate" (как часто переключается на Phase 2)

**Эксперимент:**
- Re-run все 11 tasks с two-phase strategy
- Measure: resolve rate, cost, escalation rate

**Success criteria:**
- Resolve rate > max(Baseline, Grafema)
- Tasks с escalation в Phase 2 имеют higher resolve rate

**Effort:** 5-7 дней (промпт инжиниринг + validation)

### 6.4 Приоритет 3: Semantic Clustering в графе (3 недели)

**Гипотеза:**
- Текущий граф показывает структурные связи (CALLS)
- Нужно добавить семантические связи (SIMILAR_STRUCTURE, HANDLES_SAME_DATA)
- Это не "подсказка", а **расширение графа**

**Пример для axios-5085:**
```
toJSON() --[SIMILAR_STRUCTURE]--> normalize()
         --[HANDLES_SAME_DATA]---> set()
```

**Механика:**
1. AST-based similarity (structural)
2. Dataflow-based similarity (обрабатывают одинаковые переменные)
3. Новые рёбра в графе

**Эксперимент:**
- Обогатить граф семантическими рёбрами
- Re-run с расширенным графом (БЕЗ подсказок — просто расширенный `get_context`)

**Success criteria:**
- axios-5085: агент видит toJSON + normalize в одном результате `get_context`
- FAIL → PASS

**Effort:** 15-18 дней (AST similarity + dataflow analysis + integration)

### 6.5 Что НЕ делать (Anti-Roadmap)

❌ **Направление 1 из плана Don (Co-Change Patterns):**
- Требует git историю (не работает на новом коде)
- Correlation ≠ causation
- Добавляет информацию → усиливает information overload

❌ **Направление 3 из плана Don (Constraint-Based Reasoning Hints):**
- "Pattern mining" (10-12 дней) → всё равно подсказка → всё равно overload
- Название "Constraint-Based" обманчиво — это не constraints, а hints про паттерны

❌ **Направление 5 из плана Don (Historical Diff Patterns):**
- Benchmark-specific
- Не обобщается
- 12-15 дней на тупиковое направление

❌ **Phase 1 Quick Validation из плана Don:**
- "Manual hint baseline" измеряет потолок hints, но **hints не нужны**
- "Call Site Expansion" (Direction 4) — это меньшее зло, но всё равно overload
- Трата 1-2 недель на подтверждение того, что мы уже знаем (hints вредят)

### 6.6 Критерии успеха новых направлений

**Минимальный порог:**
- Resolve rate > 45% (лучше Baseline)
- Cost < Baseline + 20%

**Целевой результат:**
- Resolve rate > 55% (+22% relative improvement)
- Cost ~ Baseline (сохранить текущую эффективность навигации)
- Multi-location bugs: >50% успеха (сейчас 0%)

**Qualitative:**
- Агент не показывает признаков information overload (нет "debating", нет игнорирования контекста)
- Агент строит coherent mental model (упоминает связи между методами)

---

## 7. Источники

### ТРИЗ и System Thinking

- [Ideal Final Result — TRIZ Knowledge Base](https://wiki.matriz.org/knowledge-base/triz/problem-solving-tools-5890/ariz-5892/ideal-final-result-5922/) — определение ИКР, примеры
- [Find the Ideal Final Result](https://the-trizjournal.com/innovation-methods/innovation-triz-theory-inventive-problem-solving/find-ideal-final-result/) — tutorial по ИКР
- [TRIZ (Wikipedia)](https://en.wikipedia.org/wiki/TRIZ) — обзор ТРИЗ, технические противоречия
- [Comparing TRIZ and brainstorming in human–agent design collaboration](https://www.cambridge.org/core/journals/ai-edam/article/comparing-triz-and-brainstorming-in-humanagent-design-collaboration-effects-on-cognitive-processes-and-performance/6C9C84A5D1956B702F71AA7F7193D22C) — TRIZ в контексте AI collaboration

### Cognitive Load Theory

- [The Cognitive Load Theory in Software Development](https://thevaluable.dev/cognitive-load-theory-software-developer/) — CLT для программирования
- [Cognitive load is what matters](https://github.com/zakirullin/cognitive-load) — практические примеры
- [Reducing Cognitive Load: The Developer's Guide](https://bytex.net/blog/reducing-cognitive-load-the-developers-guide-to-efficient-coding/) — strategies для снижения нагрузки
- [Cognitive Load in Modern IDEs](https://www.devx.com/enterprise-zone/cognitive-load/) — decision fatigue в программировании

### Information Overload в LLM

- [How to Stop Overloading Your LLM with Irrelevant Info](https://medium.com/@ayoubkirouane3/how-to-stop-overloading-your-llm-with-irrelevant-info-0a80d971310c) — information overload в LLM
- [When More Is Less: Information Overload in AI-Driven Finance](https://clsbluesky.law.columbia.edu/2025/06/19/when-more-is-less-information-overload-in-ai-driven-finance/) — эффекты избыточного контекста
- [Dumber LLM Agents Need More Constraints and Better Tools](https://www.llamaindex.ai/blog/dumber-llm-agents-need-more-constraints-and-better-tools-17a524c59e12) — constraint-based approach для AI agents
- [LLM Reasoning and Test Time Scaling](https://developer.nvidia.com/blog/an-easy-introduction-to-llm-reasoning-ai-agents-and-test-time-scaling/) — reasoning в LLM, pruning search space

### Constraint-Based Problem Solving

- [Constraint Satisfaction Problems (CSP) in AI](https://www.geeksforgeeks.org/artificial-intelligence/constraint-satisfaction-problems-csp-in-artificial-intelligence/) — основы CSP
- [AI-Driven Constraint Programming](https://fullvibes.dev/posts/ai-driven-constraint-programming-solving-impossible-puzzles-with-smart-boundaries) — constraint programming для AI
- [Constraint Logic Programming](https://www.larksuite.com/en_us/topics/ai-glossary/constraint-logic-programming) — CLP обзор

---

## Заключение

**Команда Grafema столкнулась с классической ловушкой: попытка решить проблему добавлением сложности.**

ТРИЗ показывает: если система ухудшается при "улучшениях" — вы двигаетесь в неправильном направлении.

**Ключевой инсайт:**
> Grafema не должна подсказывать AI **ЧТО думать**.
> Grafema должна ограничивать **ГДЕ AI может ошибиться**.

Это фундаментальная смена парадигмы:
- От **information augmentation** (добавление данных)
- К **solution space constraint** (сужение пространства решений)

**Рекомендация:** Остановить research подсказок. Переключиться на constraint-based navigation.

Если constraint-based подход НЕ сработает — это будет означать, что проблема в модели (reasoning ceiling), а не в инструментах. Тогда выводы будут другими. Но **подсказки — это доказанный тупик** (45% → 20%).

---

**Генрих Альтшуллер**
ТРИЗ-консультант
2026-02-15
