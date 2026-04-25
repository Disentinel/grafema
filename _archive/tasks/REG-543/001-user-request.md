# REG-543: grafema impact показывает 0 callers для методов через abstract/interface type

## Проблема

`grafema impact "addNode"` показывает 0 callers, хотя в кодовой базе 28 call sites для `graph.addNode()`.

## Root Cause

Вызовы методов через переменную абстрактного типа (`graph: GraphBackend`) не создают CALLS edge к конкретной реализации. В графе есть CALL-нода `graph.addNode` в каждом файле, но нет связи с `RFDBServerBackend.addNode`.

Это ожидаемое поведение для dynamically-typed кода без type inference, но делает `impact` бесполезным для случаев когда:

* Метод вызывается через interface/abstract class
* Receiver — параметр функции (не конкретный объект)

## Что работает вместо

Прямой Datalog-запрос через `attr(X, "method", "addNode")` — находит все CALL-ноды корректно.

## Acceptance Criteria

- [ ] Документировать ограничение в `grafema impact --help` или output
- [ ] (Опционально) Для TS-кодов с type annotations: резолвить метод через тип receiver
- [ ] Или: `grafema impact` показывает CALL-сайты даже без CALLS edge (через атрибут `method`)

## Контекст

Обнаружено при исследовании REG-541 (догфудинг Grafema для анализа Grafema). CALL-ноды с атрибутом `method` уже есть в графе — вопрос только в том чтобы `impact` их находил.

## Labels: Bug, v0.2
