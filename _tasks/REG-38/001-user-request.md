# REG-38: Architecture: Universal System Graph — Multi-layer Plugin System

## Цель

Спроектировать архитектуру Universal System Graph — единого графа системы с поддержкой множества слоёв (code, infra, cloud, observability) через plugin system.

## Ключевые идеи

1. **Абстрактный граф** — language/tool agnostic узлы и рёбра
2. **Plugin architecture** — каждый язык/инструмент маппится в абстракции
3. **Cross-layer queries** — запросы, пересекающие все слои
4. **Schema inference** — автоматическое извлечение схем из кода

## Слои графа

```
Code Layer        → function, http:route, queue:publish, db:query
Infra Layer       → k8s:deployment, terraform:resource, helm:chart
Cloud Layer       → aws:lambda, aws:sqs, iam:policy
Observability     → alert:rule, slo:definition, trace:span
```

## Вопросы для проработки

- [ ] Core graph schema (node types, edge types, attributes)
- [ ] Plugin interface specification
- [ ] Cross-layer edge resolution (как связать code → k8s → aws)
- [ ] Query language design
- [ ] Schema inference architecture
- [ ] Plugin prioritization (какие языки/tools первые)

## Критерии готовности

- [ ] RFC документ с архитектурой
- [ ] Plugin interface spec
- [ ] Proof-of-concept: TypeScript + Kubernetes linking
- [ ] Risk assessment

## Ресурсы

* Joern CPG (code property graphs)
* Terraform graph model
* Backstage entity model

## Тип задачи

Это архитектурная задача — нужен RFC документ, а не код. Основной deliverable:
- Архитектурный документ с обоснованиями решений
- Plugin interface specification
- PoC план (не реализация)
