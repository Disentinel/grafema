# REG-425: Refactor ReactAnalyzer.ts — Reduce Complexity

## Цель

Декомпозировать ReactAnalyzer.ts (1,377 строк). Отдельный анализатор для React-специфичных паттернов.

## Workflow

1. **Safety net** — snapshot tests (REG-421, Done)
2. **Uncle Bob review** — определить внутренние split boundaries (hooks detection, JSX analysis, component patterns)
3. **Рефакторинг** — извлечение по ответственностям
4. **Graph identity check**

## Acceptance Criteria

- [ ] Основной файл < 500 строк
- [ ] Snapshot tests проходят
- [ ] Каждая ответственность в отдельном модуле

## Context

- Blocker REG-421 (snapshot tests) is Done
- This is a refactoring task — Mini-MLA + Refactor configuration
- Configuration: Don → Uncle Bob → Kent ∥ Rob → Auto-Review → Vadim
