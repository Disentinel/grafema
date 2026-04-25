# REG-541: Унифицировать создание нод и рёбер через абстрактную фабрику

## User Request

Унифицировать создание нод (NodeFactory уже есть) и добавить EdgeFactory + GraphFactory.

Цель: все вызовы `graph.addNode`, `graph.addEdge`, `graph.addNodes`, `graph.addEdges` за пределами фабричного слоя должны быть заменены на вызовы через фабрику.

## Текущее состояние

- **NodeFactory**: существует — facade поверх 8 domain factories (CoreFactory, HttpFactory, RustFactory, ReactFactory, SocketFactory, DatabaseFactory, ServiceFactory, ExternalFactory)
- **EdgeFactory**: не существует — все 37+ addEdge вызовов создают inline `{ type, src, dst }`
- **GraphFactory**: не существует
- **95 нарушений** документировано в `.grafema/guarantees.yaml`:
  - 28 addNode, 37 addEdge, 15 addNodes, 15 addEdges
  - В 30+ файлах

## Acceptance Criteria

1. `EdgeFactory` создан — builder methods для edge creation
2. `GraphFactory` создан — wrapper/facade с вызовами addNode/addEdge + debug logging + validation
3. Все 95 call sites мигрированы через фабрики
4. Тесты покрывают EdgeFactory и GraphFactory
5. `grafema check --file .grafema/guarantees.yaml` → 0/4 нарушений

## Context

- **Linear:** REG-541
- **Priority:** Normal, v0.2
- **Config:** Mini-MLA (Don → Dijkstra → Uncle Bob → Kent ∥ Rob → 3-Review → Vadim)
- **Guarantees baseline:** 95 нарушений задокументированы в `.grafema/guarantees.yaml`
- **Исключения из гарантий:** `packages/core/src/storage/` (RFDBServerBackend — это и есть реализация addNode/addEdge)
