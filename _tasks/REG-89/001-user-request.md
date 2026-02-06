# REG-89: Track RFDB performance bottlenecks

## User Request

Labels: Improvement

## Описание

Не оптимизировать заранее. Фиксировать метрики.

## Acceptance Criteria

* ✅ Метрики:
  * graph size
  * query latency
  * update cost
* ✅ Оптимизация только по факту боли

## Instrumentation

* Добавить простой benchmark suite
* Log slow queries (>100ms)
* Track memory usage

## Принцип

"Measure, don't guess"

## Deliverable

Dashboard с ключевыми метриками

Linear: https://linear.app/reginaflow/issue/REG-89/track-rfdb-performance-bottlenecks
