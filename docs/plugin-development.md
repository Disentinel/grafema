# Plugin Development Guide

Руководство по созданию плагинов для Navi.

## Архитектура плагинов

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           PIPELINE                                       │
├──────────────┬──────────────┬──────────────┬──────────────┬─────────────┤
│  DISCOVERY   │   INDEXING   │   ANALYSIS   │  ENRICHMENT  │  VALIDATION │
├──────────────┼──────────────┼──────────────┼──────────────┼─────────────┤
│ Находит      │ Строит       │ Парсит AST,  │ Добавляет    │ Проверяет   │
│ сервисы и    │ дерево       │ создаёт      │ семантические│ инварианты  │
│ entry points │ зависимостей │ ноды         │ связи        │             │
└──────────────┴──────────────┴──────────────┴──────────────┴─────────────┘
```

Каждый плагин:
- Наследует от `Plugin` класса
- Объявляет metadata (фаза, приоритет, создаваемые типы)
- Реализует `execute(context)` метод
- Возвращает `PluginResult`

## Типы плагинов

### Discovery Plugins
**Когда использовать:** Проект имеет нестандартную структуру сервисов.

```javascript
// Находит entry points и сервисы
{
  phase: 'DISCOVERY',
  // Возвращает manifest с найденными сервисами
}
```

### Indexing Plugins
**Когда использовать:** Нестандартная система модулей.

```javascript
// Строит дерево зависимостей
{
  phase: 'INDEXING',
  creates: { nodes: ['MODULE'], edges: ['DEPENDS_ON'] }
}
```

### Analysis Plugins
**Когда использовать:** Нужно распознать паттерны специфичной библиотеки.

```javascript
// Парсит AST, создаёт семантические ноды
{
  phase: 'ANALYSIS',
  creates: { nodes: ['http:route', 'db:query'], edges: ['CONTAINS'] }
}
```

### Enrichment Plugins
**Когда использовать:** Нужно добавить связи между существующими нодами.

```javascript
// Обогащает граф связями
{
  phase: 'ENRICHMENT',
  creates: { nodes: [], edges: ['CALLS', 'INSTANCE_OF'] }
}
```

### Validation Plugins
**Когда использовать:** Нужно проверить инварианты графа.

```javascript
// Валидирует граф, находит проблемы
{
  phase: 'VALIDATION',
  // Возвращает warnings/errors
}
```

## Структура плагина

```javascript
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';

export class MyLibraryAnalyzer extends Plugin {
  // 1. Метаданные плагина
  get metadata() {
    return {
      name: 'MyLibraryAnalyzer',
      phase: 'ANALYSIS',           // DISCOVERY | INDEXING | ANALYSIS | ENRICHMENT | VALIDATION
      priority: 70,                // Выше = раньше в фазе (JSASTAnalyzer = 80)
      creates: {
        nodes: ['mylib:endpoint'], // Типы нод которые создаёт
        edges: ['HANDLES']         // Типы edges которые создаёт
      },
      dependencies: ['JSASTAnalyzer']  // Плагины которые должны выполниться раньше
    };
  }

  // 2. Инициализация (опционально)
  async initialize(context) {
    // Вызывается один раз перед первым execute
  }

  // 3. Основная логика
  async execute(context) {
    const { manifest, graph, config } = context;

    try {
      // Получаем модули для анализа
      const modules = await this.getModules(graph);

      let nodesCreated = 0;
      let edgesCreated = 0;

      for (const module of modules) {
        // Анализируем каждый модуль
        const result = await this.analyzeModule(module, graph);
        nodesCreated += result.nodes;
        edgesCreated += result.edges;
      }

      return createSuccessResult(
        { nodes: nodesCreated, edges: edgesCreated },
        { modulesAnalyzed: modules.length }
      );

    } catch (error) {
      return createErrorResult(error);
    }
  }

  // 4. Очистка (опционально)
  async cleanup() {
    // Освобождение ресурсов
  }

  // 5. Вспомогательные методы
  async analyzeModule(module, graph) {
    // Логика анализа
  }
}
```

## Работа с графом

### Создание нод

```javascript
await graph.addNode({
  id: `mylib:endpoint:${uniqueId}`,  // Уникальный ID
  type: 'mylib:endpoint',             // Тип ноды
  name: 'GET /users',                 // Человекочитаемое имя
  file: module.file,                  // Файл где найдено
  line: node.loc.start.line,          // Строка
  column: node.loc.start.column,      // Колонка
  // ... любые другие атрибуты
  method: 'GET',
  path: '/users'
});
```

### Создание edges

```javascript
await graph.addEdge({
  type: 'HANDLES',
  src: endpointNodeId,
  dst: handlerFunctionId,
  // Опциональные атрибуты
  async: true
});
```

### Поиск нод

```javascript
// По типу
for await (const node of graph.queryNodes({ type: 'FUNCTION' })) {
  // ...
}

// По атрибутам
for await (const node of graph.queryNodes({ type: 'CALL', name: 'express' })) {
  // ...
}

// По ID
const node = await graph.getNode('MODULE:/src/index.js');
```

### Поиск edges

```javascript
// Исходящие edges
const edges = await graph.getOutgoingEdges(nodeId, ['CONTAINS', 'CALLS']);

// Входящие edges
const edges = await graph.getIncomingEdges(nodeId, ['CALLS']);
```

## Пример: Fastify Analyzer

Полный пример плагина для библиотеки Fastify:

```javascript
/**
 * FastifyRouteAnalyzer - детектит Fastify endpoints
 *
 * Паттерны:
 * - fastify.get('/path', handler)
 * - fastify.route({ method: 'GET', url: '/path', handler })
 */

import { readFileSync } from 'fs';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
const traverse = traverseModule.default || traverseModule;

import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';

export class FastifyRouteAnalyzer extends Plugin {
  get metadata() {
    return {
      name: 'FastifyRouteAnalyzer',
      phase: 'ANALYSIS',
      priority: 75,
      creates: {
        nodes: ['http:route'],
        edges: ['CONTAINS', 'HANDLED_BY']
      },
      dependencies: ['JSASTAnalyzer']
    };
  }

  async execute(context) {
    const { graph } = context;

    try {
      const modules = await this.getModules(graph);
      let routesCreated = 0;
      let edgesCreated = 0;

      for (const module of modules) {
        // Проверяем есть ли импорт fastify
        if (!await this.hasFastifyImport(module, graph)) {
          continue;
        }

        const result = await this.analyzeModule(module, graph);
        routesCreated += result.routes;
        edgesCreated += result.edges;
      }

      console.log(`[FastifyRouteAnalyzer] Found ${routesCreated} routes`);
      return createSuccessResult({ nodes: routesCreated, edges: edgesCreated });

    } catch (error) {
      return createErrorResult(error);
    }
  }

  async hasFastifyImport(module, graph) {
    // Проверяем DEPENDS_ON edges на fastify
    const deps = await graph.getOutgoingEdges(module.id, ['DEPENDS_ON']);
    return deps.some(e => e.dst.includes('fastify'));
  }

  async analyzeModule(module, graph) {
    const code = readFileSync(module.file, 'utf-8');
    const ast = parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript']
    });

    let routes = 0;
    let edges = 0;
    const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'];

    traverse(ast, {
      CallExpression: (path) => {
        const { node } = path;

        // Паттерн: fastify.get('/path', handler)
        if (node.callee.type === 'MemberExpression' &&
            HTTP_METHODS.includes(node.callee.property?.name)) {

          const method = node.callee.property.name.toUpperCase();
          const pathArg = node.arguments[0];

          if (pathArg?.type === 'StringLiteral') {
            const routePath = pathArg.value;
            const routeId = `http:route:${module.file}:${node.loc.start.line}`;

            graph.addNode({
              id: routeId,
              type: 'http:route',
              name: `${method} ${routePath}`,
              method,
              path: routePath,
              file: module.file,
              line: node.loc.start.line,
              framework: 'fastify'
            });

            // CONTAINS edge от модуля
            graph.addEdge({
              type: 'CONTAINS',
              src: module.id,
              dst: routeId
            });

            routes++;
            edges++;
          }
        }

        // Паттерн: fastify.route({ method: 'GET', url: '/path', handler })
        if (node.callee.type === 'MemberExpression' &&
            node.callee.property?.name === 'route' &&
            node.arguments[0]?.type === 'ObjectExpression') {

          const config = this.parseObjectLiteral(node.arguments[0]);
          if (config.method && config.url) {
            const routeId = `http:route:${module.file}:${node.loc.start.line}`;

            graph.addNode({
              id: routeId,
              type: 'http:route',
              name: `${config.method} ${config.url}`,
              method: config.method,
              path: config.url,
              file: module.file,
              line: node.loc.start.line,
              framework: 'fastify'
            });

            graph.addEdge({
              type: 'CONTAINS',
              src: module.id,
              dst: routeId
            });

            routes++;
            edges++;
          }
        }
      }
    });

    return { routes, edges };
  }

  parseObjectLiteral(node) {
    const result = {};
    for (const prop of node.properties) {
      if (prop.type === 'ObjectProperty' && prop.key.type === 'Identifier') {
        if (prop.value.type === 'StringLiteral') {
          result[prop.key.name] = prop.value.value;
        }
      }
    }
    return result;
  }
}
```

## Регистрация плагина

### Способ 1: Встроенный плагин

Добавьте в `src/v2/plugins/analysis/`:

```
src/v2/plugins/analysis/
├── JSASTAnalyzer.js
├── ExpressRouteAnalyzer.js
├── FastifyRouteAnalyzer.js    ← ваш плагин
└── ...
```

Добавьте импорт в MCP server (`src/mcp/server.js`):

```javascript
import { FastifyRouteAnalyzer } from '../v2/plugins/analysis/FastifyRouteAnalyzer.js';
```

### Способ 2: Кастомный плагин в проекте

Создайте `.rflow/plugins/`:

```
your-project/
├── .rflow/
│   ├── config.json
│   └── plugins/
│       └── MyCustomAnalyzer.mjs    ← ваш плагин
└── ...
```

```javascript
// .rflow/plugins/MyCustomAnalyzer.mjs
import { Plugin, createSuccessResult } from 'navi/plugins/Plugin.js';

export class MyCustomAnalyzer extends Plugin {
  // ...
}

export default MyCustomAnalyzer;
```

Добавьте в `.rflow/config.json`:

```json
{
  "plugins": {
    "analysis": ["JSASTAnalyzer", "MyCustomAnalyzer"]
  }
}
```

## Именование типов

### Соглашения

| Категория | Формат | Примеры |
|-----------|--------|---------|
| Framework-specific | `framework:type` | `http:route`, `socketio:emit`, `db:query` |
| Generic | `UPPERCASE` | `MODULE`, `FUNCTION`, `CALL`, `VARIABLE` |
| Edges | `UPPERCASE` | `CONTAINS`, `CALLS`, `DEPENDS_ON` |

### Существующие типы

**Nodes:**
- `MODULE`, `FUNCTION`, `CLASS`, `METHOD`, `VARIABLE`, `PARAMETER`
- `CALL`, `METHOD_CALL`, `EXPRESSION`
- `http:route`, `http:request`, `http:api`
- `db:query`, `db:table`
- `socketio:emit`, `socketio:on`
- `react:component`, `react:hook`
- `GUARANTEE`

**Edges:**
- `CONTAINS`, `CALLS`, `DEPENDS_ON`
- `ASSIGNED_FROM`, `DERIVES_FROM`
- `INSTANCE_OF`, `PASSES_ARGUMENT`, `HAS_PARAMETER`
- `USES_MIDDLEWARE`, `HANDLED_BY`
- `GOVERNS`, `VIOLATES`

## Тестирование плагина

### Unit test структура

```javascript
// test/unit/FastifyRouteAnalyzer.test.js
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

const FIXTURE_PATH = 'test/fixtures/fastify-app';

describe('FastifyRouteAnalyzer', () => {
  let backend;

  beforeEach(async () => {
    backend = createTestBackend();
    await backend.connect();
  });

  after(async () => {
    await backend.cleanup();
  });

  it('should detect fastify routes', async () => {
    const orchestrator = createTestOrchestrator(backend);
    await orchestrator.run(FIXTURE_PATH);

    // Проверяем что routes найдены
    const routes = [];
    for await (const node of backend.queryNodes({ type: 'http:route' })) {
      if (node.framework === 'fastify') {
        routes.push(node);
      }
    }

    assert.ok(routes.length > 0, 'Should find fastify routes');
  });
});
```

### Test fixture

```javascript
// test/fixtures/fastify-app/index.js
import Fastify from 'fastify';

const fastify = Fastify();

fastify.get('/users', async (request, reply) => {
  return { users: [] };
});

fastify.post('/users', async (request, reply) => {
  return { created: true };
});

fastify.route({
  method: 'GET',
  url: '/health',
  handler: async () => ({ status: 'ok' })
});

export default fastify;
```

## Debugging

### Логирование

```javascript
console.log(`[${this.metadata.name}] Processing ${modules.length} modules...`);
console.log(`[${this.metadata.name}] Found pattern at ${file}:${line}`);
```

### Проверка результатов

```javascript
// После анализа, проверьте через MCP:
// get_stats() - количество нод по типам
// query_graph({ query: "violation(X) :- node(X, \"http:route\")." })
```

### Распространённые проблемы

| Проблема | Решение |
|----------|---------|
| Плагин не находит паттерны | Добавьте `console.log(JSON.stringify(node, null, 2))` в traverse для просмотра AST |
| Ноды создаются но не видны | Проверьте уникальность ID |
| Edges не создаются | Проверьте что src и dst ноды существуют |
| Плагин выполняется слишком рано | Уменьшите priority (меньше = позже) |

## Чеклист разработки плагина

- [ ] Определён тип плагина (analysis/enrichment/validation)
- [ ] Metadata корректны (phase, priority, creates, dependencies)
- [ ] Execute возвращает PluginResult
- [ ] Ноды имеют уникальные ID
- [ ] Ноды имеют file/line для навигации
- [ ] Edges связывают существующие ноды
- [ ] Написаны тесты с fixture
- [ ] Плагин зарегистрирован

## См. также

- `get_documentation({ topic: "project-onboarding" })` — внедрение Navi
- `get_documentation({ topic: "guarantee-workflow" })` — создание гарантий
