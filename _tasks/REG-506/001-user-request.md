# REG-506: Datalog slow query warnings (full scan detection)

## Problem

Некоторые паттерны запросов вызывают full scan всего графа:

* `node(X, Y)` — итерирует ВСЕ типы и ВСЕ ноды (уже помечено "expensive!" в коде)
* `edge(X, Y, T)` с unbound source — вызывает `get_all_edges()`
* `path(X, Y)` — BFS до глубины 100

На больших графах (10k+ нод) это может быть медленно, а пользователь не узнает почему.

## Acceptance Criteria

1. QueryStats/QueryProfile (из EvaluatorExplain) включает `warnings: string[]`
2. Warning при `node(X, Y)` с обеими переменными: "Full node scan: consider binding type"
3. Warning при `edge(X, ...)` с unbound source: "Full edge scan: consider binding source node"
4. Warnings доступны в explain mode response
5. CLI выводит warnings в stderr

## Implementation Notes

* Добавить `warnings: Vec<String>` в `QueryResult`
* Детектировать в `eval_node()`, `eval_edge()` при полном переборе
* Порог: предупреждать если результат > 1000 элементов
