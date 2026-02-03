# REG-319: Обновить и структурировать документацию по конфигурации

## Проблема

Документация по конфигурации разрозненная и устаревшая:

1. `docs/project-onboarding.md` использует:
   * Старое название `.rflow/` вместо `.grafema/`
   * `config.json` вместо `config.yaml`
   * Устаревший список плагинов
2. Нет отдельного docs/configuration.md с полным описанием формата
3. Не документированы:
   * `services` field для multi-service projects
   * `plugins` field с конфигурацией по фазам (discovery, indexing, analysis, enrichment, validation)
   * Все доступные плагины и их опции
   * include/exclude patterns

## Что нужно сделать

1. Создать `docs/configuration.md` с полным reference
2. Обновить `docs/project-onboarding.md`
3. Добавить раздел в `plugin-development.md`

## Acceptance Criteria

- [ ] `docs/configuration.md` создан с полным reference
- [ ] `docs/project-onboarding.md` обновлён с правильными путями
- [ ] Все плагины документированы с описанием что они делают
- [ ] Примеры для типичных сценариев (monorepo, single service, etc.)
