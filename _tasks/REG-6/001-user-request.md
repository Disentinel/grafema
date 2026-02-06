# REG-6: 1.1. Guarantee как тип узла

## Original Request

Добавить поддержку guarantee узлов в граф.

```
guarantee:queue#orders
guarantee:api#users
guarantee:permission#s3-write
```

## Files to Modify

* `src/v2/core/nodes/NodeKind.js` — добавить guarantee:* типы
* `src/v2/core/nodes/GuaranteeNode.js` — создать класс
* `rust-engine/src/graph/engine.rs` — поддержка в find_by_type

## Guarantee Node Fields

* `priority`: critical | important | observed | tracked
* `status`: discovered | reviewed | active | changing | deprecated
* `owner`: string (team/person)
* `schema`: JSON (для queue/api contracts)
* `condition`: string (для rules)

## Context

This is part of the GuaranteeManager system — a core feature of Grafema for tracking code guarantees and contracts.
