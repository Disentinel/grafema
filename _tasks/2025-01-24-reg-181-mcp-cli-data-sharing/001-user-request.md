# REG-181: MCP не видит данные, проанализированные через CLI

## Источник
Linear Issue: https://linear.app/reginaflow/issue/REG-181/mcp-ne-vidit-dannye-proanalizirovannye-cherez-cli

## Проблема

При анализе проекта через CLI (`grafema analyze`) создаётся 9,674 ноды. Но при подключении через MCP и вызове `get_stats` показывается только 1 нода (SERVICE).

## Воспроизведение

1. `cd /path/to/project`
2. `grafema analyze` → успешно, 9674 ноды
3. Запустить MCP сервер с `GRAFEMA_PROJECT_PATH=/path/to/project`
4. Вызвать `get_stats` → показывает 1 ноду

## Ожидаемое поведение

MCP должен видеть те же данные, что и CLI. Если база уже проанализирована (nodeCount > 0), MCP НЕ должен её очищать.

## Анализ из issue

В `packages/mcp/src/state.ts:237-243` есть проверка:

```typescript
const nodeCount = await backend.nodeCount();
if (nodeCount > 0) {
  isAnalyzed = true;
  log('Connected to existing database: ${nodeCount} nodes');
}
```

Но в `packages/mcp/src/analysis.ts:66-70`:

```typescript
if (force || !getIsAnalyzed()) {
  log('Clearing database before analysis...');
  await db.clear();
}
```

Возможные причины:

1. RFDBServerBackend запускает новый RFDB сервер вместо подключения к существующему
2. Socket path отличается между CLI и MCP
3. Race condition между `getOrCreateBackend()` и `ensureAnalyzed()`

## Acceptance Criteria

- [ ] CLI → MCP: данные видны без повторного анализа
- [ ] MCP → CLI: данные видны без повторного анализа
- [ ] Добавить E2E тест на этот сценарий
