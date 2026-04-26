# REG-7: 1.2. Связь governs

**Linear:** https://linear.app/reginaflow/issue/REG-7/12-svyaz-governs

## Описание

Связь между гарантией и кодом который она покрывает.

```
guarantee:queue#orders --governs--> queue:publish#order-api#...
guarantee:queue#orders --governs--> queue:consume#processor#...
```

## Файлы (из описания задачи)

* `src/v2/storage/backends/ReginaFlowBackend.js` — добавить edge type `GOVERNS` в KNOWN_EDGE_TYPES
* Или использовать namespaced `guarantee:governs`

## Требования

1. Добавить поддержку edge type `GOVERNS` (или namespaced варианта)
2. Связь должна связывать guarantee ноды с кодом который они покрывают
