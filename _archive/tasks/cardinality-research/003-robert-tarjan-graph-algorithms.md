# Анализ алгоритмов для отслеживания кардинальности в Grafema

**Автор:** Robert Tarjan
**Дата:** 2 февраля 2026
**Контекст:** Исследовательский отчёт для проекта Grafema

---

## 1. Формализация задачи

### 1.1 Структура графа

Граф Grafema можно формализовать как ориентированный граф G = (V, E), где:

- **V** = V_LOOP ∪ V_DATA ∪ V_COLLECTION ∪ V_OTHER — вершины разных типов
- **E** = E_CONTAINS ∪ E_ITERATES ∪ E_DATAFLOW — рёбра разных отношений

Ключевые типы рёбер:
- `CONTAINS(parent, child)` — структурная вложенность
- `ITERATES_OVER(loop, collection)` — какую коллекцию итерирует цикл
- `DATAFLOW(source, target)` — поток данных

### 1.2 Формальная задача

**Вход:** Граф G с аннотациями кардинальности на некоторых коллекциях.

**Выход:** Все пары (L_outer, L_inner), где:
1. L_inner структурно вложен в L_outer
2. Обе итерации по "большим" коллекциям (кардинальность ≥ порога)
3. Нет раннего выхода (break на первой итерации)

---

## 2. Алгоритм обнаружения вложенных циклов

### 2.1 Наивный подход и его проблемы

Наивный O(n²) подход — проверить каждую пару циклов:

```
for each loop L1 in LOOPS:
    for each loop L2 in LOOPS:
        if is_nested(L1, L2):
            report(L1, L2)
```

**Проблема:** При 10,000 циклов = 100,000,000 проверок. Неприемлемо.

### 2.2 Оптимальный подход: DFS с передачей контекста

Используем структурную вложенность графа AST. Ключевое наблюдение: **отношение CONTAINS образует дерево (или лес)**.

```
Algorithm: FindNestedLoops(G)
Input: Graph G with LOOP nodes and CONTAINS edges
Output: List of (outer_loop, inner_loop) pairs

1. Build containment tree T from CONTAINS edges
2. ancestor_loops ← empty stack
3. results ← empty list

4. procedure DFS(node):
5.     if node.type == LOOP:
6.         for each ancestor in ancestor_loops:
7.             results.append((ancestor, node))
8.         ancestor_loops.push(node)
9.
10.    for each child in T.children(node):
11.        DFS(child)
12.
13.    if node.type == LOOP:
14.        ancestor_loops.pop()

15. for each root in T.roots():
16.     DFS(root)

17. return results
```

**Сложность:** O(V + E + R), где R — количество найденных пар.

В худшем случае R = O(d × L), где d — максимальная глубина вложенности, L — количество циклов. На практике d ≤ 10, поэтому R ≈ O(L).

**Итого: O(V + E)** — линейно по размеру графа.

---

## 3. Отслеживание кардинальности через граф потока данных

### 3.1 Формализация задачи

Нужно ответить на вопрос: **какова кардинальность коллекции, по которой итерирует цикл L?**

### 3.2 Алгоритм пропагации кардинальности

Это классическая задача **прямого анализа потока данных** (forward dataflow analysis):

```
Algorithm: PropagateCardinality(G)
Input: Graph G with DATAFLOW edges and some annotated cardinalities
Output: Cardinality estimates for all collection nodes

1. worklist ← all nodes with known cardinality
2. cardinality[n] ← ∞ for all nodes  // unknown = potentially large
3.
4. for each annotated node n:
5.     cardinality[n] ← annotation(n)

6. while worklist not empty:
7.     node ← worklist.pop()
8.     for each (node, target) in DATAFLOW:
9.         new_card ← transfer(node, target, cardinality[node])
10.        if new_card < cardinality[target]:
11.            cardinality[target] ← new_card
12.            worklist.add(target)

13. return cardinality
```

**Transfer function** зависит от операции:
- `filter(pred)` → card × selectivity (по умолчанию 0.5)
- `map(f)` → card (сохраняется)
- `slice(0, k)` → min(card, k)

### 3.3 Связь с алгоритмом Килдалла

**Сложность:** O(V × H × E), где H — высота решётки.

Для практических целей ограничиваем кардинальность категориями (H = 5):
- TINY (< 10)
- SMALL (< 100)
- MEDIUM (< 10,000)
- LARGE (< 1,000,000)
- HUGE (≥ 1,000,000)

**Сложность O(V × E)**, а на практике близко к O(E) из-за быстрой сходимости.

---

## 4. Применение алгоритмов теории графов

### 4.1 Доминаторы для анализа неизбежного выполнения

**Задача:** Определить, выполняется ли внутренний цикл *обязательно* или только условно.

**Алгоритм Ленгауэра-Тарьяна** для построения дерева доминаторов:

**Сложность:** O(E × α(E, V)) ≈ O(E) на практике.

**Применение:** Если внешний цикл доминирует над внутренним → внутренний выполняется на каждой итерации внешнего → сложность умножается.

### 4.2 SCC для анализа рекурсивных структур

**Задача:** Обнаружить паттерны, где рекурсия создаёт неявную вложенную итерацию.

```javascript
function process(node) {
    for (child of node.children) {  // O(n) на каждый вызов
        process(child);              // рекурсия
    }
}
```

Строим граф вызовов и применяем алгоритм Тарьяна для поиска SCC.

**Сложность:** O(V + E) для поиска SCC.

---

## 5. Полный алгоритм анализа сложности

```
Algorithm: ComplexityAnalysis(G)
Input: Grafema graph G
Output: List of complexity warnings

Phase 1: Structural Analysis [O(V + E)]
1. nested_pairs ← FindNestedLoops(G)
2. dominators ← FindDominators(CFG(G))

Phase 2: Cardinality Propagation [O(V × E)]
3. cardinality ← PropagateCardinality(G)

Phase 3: Complexity Estimation [O(|nested_pairs|)]
4. warnings ← []
5. for each (outer, inner) in nested_pairs:
6.     outer_card ← cardinality[iterates_over(outer)]
7.     inner_card ← cardinality[iterates_over(inner)]
8.
9.     if outer_card > THRESHOLD and inner_card > THRESHOLD:
10.        if dominates(outer, inner):
11.            complexity ← outer_card × inner_card
12.        else:
13.            complexity ← max(outer_card, inner_card)
14.
15.        if complexity > ALERT_THRESHOLD:
16.            warnings.append(Warning(outer, inner, complexity))

Phase 4: Recursive Analysis [O(V + E)]
17. sccs ← TarjanSCC(CallGraph(G))
18. for each scc in sccs where |scc| > 1:
19.     warnings.extend(AnalyzeRecursiveComplexity(scc))

20. return warnings
```

### Анализ общей сложности

| Фаза | Сложность | Обоснование |
|------|-----------|-------------|
| Структурный анализ | O(V + E) | DFS по дереву |
| Пропагация кардинальности | O(V × E) | Worklist с ограниченной решёткой |
| Оценка сложности | O(L² × d) | L циклов, d глубина |
| Рекурсивный анализ | O(V + E) | Алгоритм Тарьяна |

**Общая сложность: O(V × E)**

---

## 6. Рекомендации по реализации

### 6.1 Структуры данных

```typescript
interface LoopNode {
  id: string;
  containsLoops: LoopNode[];
  ancestorLoops: LoopNode[];
  iteratesOver: CollectionRef;
  dominatedBy: LoopNode | null;
}

interface CardinalityLattice {
  category: 'TINY' | 'SMALL' | 'MEDIUM' | 'LARGE' | 'HUGE';
  estimate?: number;
  confidence: number;
}
```

### 6.2 Индексы для быстрых запросов

```typescript
Map<LoopId, Set<LoopId>> nestedLoopsIndex;
Map<CollectionId, Set<LoopId>> collectionToLoops;
LRUCache<[LoopId, CollectionId], boolean> reachabilityCache;
```

### 6.3 Инкрементальность

При изменении графа:
1. **Добавление цикла:** O(h + s) — обновить только затронутые пары
2. **Изменение кардинальности:** Запустить worklist только от изменённой вершины
3. **Удаление цикла:** Удалить из индексов за O(1)

---

## 7. Заключение

Предложенный алгоритм решает задачу обнаружения O(n²) паттернов за **O(V × E)** в худшем случае и **O(V + E)** на практике. Это существенно лучше наивного O(n⁴) подхода.

Ключевые алгоритмические компоненты:
1. **DFS с контекстом** — поиск вложенных циклов
2. **Worklist dataflow** — пропагация кардинальности
3. **Доминаторы Ленгауэра-Тарьяна** — обязательность выполнения
4. **SCC Тарьяна** — рекурсивные паттерны

Все компоненты имеют линейную или почти линейную сложность — анализ O(n²) кода не создаёт O(n²) анализ.

---

*Robert Tarjan*
*Февраль 2026*
