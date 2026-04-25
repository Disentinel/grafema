# Анализ Semantic ID vs Positional ID для нод JS/TS

**Автор:** Donald Knuth (Problem Solver)
**Дата:** 2025-01-22

## Предисловие

Переход на Semantic ID — это архитектурно корректное решение для инструмента анализа кода. Позиционные ID (содержащие `line:column`) нестабильны: добавление пустой строки или комментария меняет ID всех нод ниже. Это создает ложные "изменения" при инкрементальном анализе.

**Цель Semantic ID:** ID должен меняться только когда меняется *семантика* сущности, а не её позиция.

---

## Текущее состояние

Анализ текущих реализаций в `/packages/core/src/core/nodes/`:

| Тип ноды | Текущий формат ID | Использует позицию? |
|----------|-------------------|---------------------|
| MODULE | `MODULE:{contentHash}` | Нет (хеш контента) |
| FUNCTION | `{file}:FUNCTION:{name}:{line}:{column}` | **Да** |
| CLASS | `{file}:CLASS:{name}:{line}` | **Да** |
| METHOD | `{file}:METHOD:{className}.{name}:{line}` | **Да** |
| VARIABLE_DECLARATION | `{file}:VARIABLE_DECLARATION:{name}:{line}:{column}` | **Да** |
| PARAMETER | `{file}:PARAMETER:{name}:{line}:{index}` | **Да** (line) |
| IMPORT | `{file}:IMPORT:{source}:{name}` | **Нет** (уже Semantic!) |
| EXPORT | `{file}:EXPORT:{name}:{line}` | **Да** |
| CALL_SITE | `{file}:CALL_SITE:{targetName}:{line}:{column}` | **Да** |
| METHOD_CALL | `{file}:METHOD_CALL:{object}.{method}:{line}:{column}` | **Да** |
| LITERAL | `{file}:LITERAL:{argIndex}:{line}:{column}` | **Да** |
| SCOPE | `{file}:SCOPE:{name}:{line}` | **Да** |

**Вывод:** ImportNode — единственная нода с чисто семантическим ID. Остальные зависят от позиции.

---

## Анализ по типам нод

### 1. MODULE

**Текущий ID:** `MODULE:{contentHash}`

**Анализ:**
- ContentHash — это **гибридный** подход: не позиционный, но и не семантический
- При любом изменении контента файла (даже комментария) — ID меняется
- Это корректно для инкрементального анализа (определяет, нужен ли reparse)

**Рекомендация:** Использовать **путь файла** как семантический ID:
```
{file}:MODULE
```

**Обоснование:**
- Путь файла — это семантический идентификатор модуля
- `contentHash` следует хранить как атрибут для инвалидации кеша
- При переименовании файла это другой модуль (корректная семантика)

**Edge cases:**
- Переименование файла → новый модуль (OK)
- Перемещение файла в другую директорию → новый модуль (OK)
- Симлинки → могут создать дубликаты (решение: канонизировать путь через `realpath`)

---

### 2. FUNCTION (обычная, arrow, method, anonymous)

**Текущий ID:** `{file}:FUNCTION:{name}:{line}:{column}`

#### 2.1 Именованные функции (function declarations)

```javascript
function processUser(user) { }  // Уникально в module scope
```

**Semantic ID:** `{file}:FUNCTION:{scope}:{name}`

Где `{scope}` — это chain родительских scope (module → function → block).

**Примеры:**
```javascript
// File: /src/utils.js

function outer() {           // ID: /src/utils.js:FUNCTION:module:outer
  function inner() { }       // ID: /src/utils.js:FUNCTION:outer:inner

  if (true) {
    function blockScoped() { }  // ID: /src/utils.js:FUNCTION:outer.if#1:blockScoped
  }
}
```

#### 2.2 Arrow Functions присвоенные переменной

```javascript
const process = (x) => x * 2;  // Семантически это "переменная process"
```

**Semantic ID:** `{file}:FUNCTION:{scope}:{variableName}`

Arrow function привязана к переменной — её имя = имя переменной.

#### 2.3 Anonymous Functions (callbacks)

```javascript
users.map(function(user) { return user.name; });  // Нет имени!
```

**Проблема:** Нет семантического идентификатора.

**Решение 1: По контексту вызова**
```
{file}:FUNCTION:{parentScope}:~callback~{callTarget}~{argIndex}
```
Пример: `{file}:FUNCTION:module:~callback~users.map~0`

**Решение 2: По порядку в scope (fallback)**
```
{file}:FUNCTION:{parentScope}:~anon~{counter}
```

**Рекомендация:** Решение 1 для callbacks, Решение 2 как fallback.

**Edge cases:**
- Несколько `users.map()` на разных строках:
  ```javascript
  users.map(function(u) { });   // ~callback~users.map~0:1 (первое вхождение)
  users.map(function(u) { });   // ~callback~users.map~0:2 (второе вхождение)
  ```
  Нужен **счётчик вхождений** в пределах scope.

#### 2.4 IIFE (Immediately Invoked Function Expression)

```javascript
(function() {
  // module pattern
})();
```

**Semantic ID:** `{file}:FUNCTION:{scope}:~iife~{counter}`

IIFE не имеет имени и используется для создания изолированного scope.

#### 2.5 Method в объектном литерале

```javascript
const obj = {
  process(data) { }   // Это method property
};
```

**Semantic ID:** `{file}:FUNCTION:{scope}.{variableName}:process`

Привязано к переменной-объекту.

---

### 3. CLASS

**Текущий ID:** `{file}:CLASS:{name}:{line}`

**Semantic ID:** `{file}:CLASS:{scope}:{name}`

```javascript
class User { }              // /src/user.js:CLASS:module:User

function factory() {
  class LocalUser { }       // /src/user.js:CLASS:factory:LocalUser
}
```

**Анонимные классы:**
```javascript
const Model = class { };    // ID через переменную: CLASS:module:Model
export default class { };   // CLASS:module:~default
```

**Edge cases:**
- Два класса с одинаковым именем в разных if-блоках:
  ```javascript
  if (condition) {
    class Config { }   // CLASS:module.if#1:Config
  } else {
    class Config { }   // CLASS:module.if#1.else:Config
  }
  ```
  Scope path решает эту проблему.

---

### 4. VARIABLE_DECLARATION (var, let, const)

**Текущий ID:** `{file}:VARIABLE_DECLARATION:{name}:{line}:{column}`

**Semantic ID:** `{file}:VAR:{scope}:{name}`

```javascript
const API_URL = 'https://...';        // VAR:module:API_URL
let count = 0;                         // VAR:module:count

function process() {
  const result = compute();            // VAR:process:result

  if (true) {
    let temp = 1;                      // VAR:process.if#1:temp
  }
}
```

**Важно:** `var` имеет function scope, `let/const` — block scope. Это влияет на scope path.

**Destructuring:**
```javascript
const { name, age } = user;   // Два VAR: VAR:module:name, VAR:module:age
const [first, second] = arr;  // Два VAR: VAR:module:first, VAR:module:second
```

**Nested destructuring:**
```javascript
const { address: { city } } = user;   // VAR:module:city (финальное binding)
```

**Edge cases:**
- Одноимённые переменные в разных block scopes — OK, scope path различает
- Re-declaration с `var` (hoisting) — одна переменная, один ID
- Shadowing — разные переменные, разные ID (разные scope paths)

---

### 5. PARAMETER

**Текущий ID:** `{file}:PARAMETER:{name}:{line}:{index}`

**Semantic ID:** `{file}:PARAM:{functionId}:{name}`

```javascript
function process(input, options) {
  // PARAM:/src/utils.js:FUNCTION:module:process:input
  // PARAM:/src/utils.js:FUNCTION:module:process:options
}
```

**Почему без index в ID:**
- Имя параметра уникально в сигнатуре функции
- Index полезен как атрибут, но не как часть ID

**Destructuring в параметрах:**
```javascript
function process({ name, age }) {
  // PARAM:...process:name
  // PARAM:...process:age
}
```

**Rest параметры:**
```javascript
function log(first, ...rest) {
  // PARAM:...:first
  // PARAM:...:rest
}
```

**Edge cases:**
- Дубликаты параметров (валидно в non-strict mode):
  ```javascript
  function bad(x, x) { }  // Последний wins в runtime
  ```
  **Решение:** Добавить counter: `PARAM:...:x:1`, `PARAM:...:x:2`

---

### 6. IMPORT

**Текущий ID:** `{file}:IMPORT:{source}:{name}` — **УЖЕ SEMANTIC!**

Это правильный подход. Import семантически определяется:
- Откуда (source module)
- Что именно (imported name / local binding)

**Различные типы импортов:**
```javascript
import React from 'react';              // IMPORT:react:React (default)
import { useState } from 'react';       // IMPORT:react:useState (named)
import * as Utils from './utils';       // IMPORT:./utils:Utils (namespace)
import { foo as bar } from './mod';     // IMPORT:./mod:bar (renamed)
```

**Edge cases:**
- Re-import того же под другим именем:
  ```javascript
  import { foo } from './mod';     // IMPORT:./mod:foo
  import { foo as bar } from './mod';  // IMPORT:./mod:bar
  ```
  Разные local names = разные imports. Корректно.

- Dynamic imports:
  ```javascript
  const mod = await import('./module');
  ```
  Это CALL_SITE, не IMPORT. Семантика другая.

---

### 7. EXPORT

**Текущий ID:** `{file}:EXPORT:{name}:{line}`

**Semantic ID:** `{file}:EXPORT:{name}`

Export уникален по имени в модуле. Не может быть двух экспортов с одинаковым именем.

```javascript
export const API = 'url';           // EXPORT:API
export function process() { }       // EXPORT:process
export default class User { }       // EXPORT:default
export { foo, bar };                // EXPORT:foo, EXPORT:bar
export { local as external };       // EXPORT:external
```

**Re-exports:**
```javascript
export { foo } from './other';      // EXPORT:foo (re-export)
export * from './utils';            // EXPORT:* или специальная обработка
export * as Utils from './utils';   // EXPORT:Utils (namespace re-export)
```

**Edge cases:**
- `export *` — не создаёт именованный export, а делегирует. Возможно, это EDGE, не NODE.
- Несколько `export *` — все валидны, если нет конфликтов имён.

---

### 8. CALL_SITE

**Текущий ID:** `{file}:CALL_SITE:{targetName}:{line}:{column}`

**Проблема:** Call sites по определению множественны. Один и тот же `process()` может вызываться 10 раз в функции.

**Semantic ID:** `{file}:CALL:{scope}:{targetName}:{counter}`

```javascript
function handler() {
  process(data);     // CALL:handler:process:1
  validate(data);    // CALL:handler:validate:1
  process(data);     // CALL:handler:process:2  (второй вызов process)
}
```

**Counter** — порядковый номер вызова данной функции в данном scope.

**Альтернатива: использовать AST path**
```
{file}:CALL:{scope}:{astPath}:{targetName}
```
Где astPath — это путь в AST (body[0].consequent[2]...).

**Минус:** AST path нестабилен при изменениях кода выше.

**Рекомендация:** Counter в пределах scope. Это даёт стабильность при изменениях выше call site, но нестабильность при добавлении/удалении вызовов.

**Компромисс:** Принять, что call sites частично позиционны. Их слишком много, и они не имеют семантического имени.

---

### 9. METHOD_CALL

**Текущий ID:** `{file}:METHOD_CALL:{object}.{method}:{line}:{column}`

Аналогично CALL_SITE:

**Semantic ID:** `{file}:MCALL:{scope}:{object}.{method}:{counter}`

```javascript
function process() {
  user.validate();    // MCALL:process:user.validate:1
  user.save();        // MCALL:process:user.save:1
  user.validate();    // MCALL:process:user.validate:2
}
```

**Проблема:** `object` может быть выражением:
```javascript
getUser().save();           // object = <expr>, method = save
users[0].process();         // object = users[0]
```

**Решение:** Для complex expressions использовать `<expr>` или normalized form.

---

### 10. LITERAL

**Текущий ID:** `{file}:LITERAL:{argIndex}:{line}:{column}`

**Проблема:** Литералы по определению не имеют имени.

**Подходы:**

1. **По контексту использования:**
   ```javascript
   const x = "hello";        // LITERAL:VAR:x:init
   process("config");        // LITERAL:CALL:process:arg0
   obj.method(42, true);     // LITERAL:MCALL:obj.method:arg0, LITERAL:...:arg1
   ```

2. **По значению (для уникальных):**
   ```javascript
   const API = "https://api.example.com";  // LITERAL:"https://api.example.com"
   ```
   **Минус:** Длинные строки, дублирующиеся значения.

**Рекомендация:**
- Для литералов в argument position: `{file}:LITERAL:{callId}:arg{index}`
- Для литералов в assignment: `{file}:LITERAL:{varId}:init`
- Fallback: `{file}:LITERAL:{scope}:{counter}`

**Edge cases:**
- Template literals: `\`Hello ${name}\`` — это не один литерал, а выражение
- Object literals: отдельный тип (OBJECT_LITERAL)
- Array literals: отдельный тип (ARRAY_LITERAL)

---

### 11. SCOPE (block, if, for, while, try/catch)

**Текущий ID:** `{file}:SCOPE:{name}:{line}`

**Semantic ID:** `{file}:SCOPE:{parentScope}:{type}:{counter}`

```javascript
function process() {              // FUNCTION scope
  if (condition) {                // SCOPE:process:if:1
    for (let i = 0; i < 10; i++) {  // SCOPE:process.if#1:for:1
      while (running) { }          // SCOPE:process.if#1.for#1:while:1
    }
  }

  try {                           // SCOPE:process:try:1
    // ...
  } catch (e) {                   // SCOPE:process.try#1:catch:1
    // ...
  }
}
```

**Scope types:** `block`, `if`, `else`, `for`, `for-in`, `for-of`, `while`, `do-while`, `switch`, `try`, `catch`, `finally`, `with`, `class-body`

**Edge cases:**
- Arrow function body без `{}`:
  ```javascript
  const fn = x => x * 2;  // Нет block scope
  ```
  Нет SCOPE ноды, expression scope = function scope.

---

### 12. INTERFACE (TypeScript)

**Semantic ID:** `{file}:INTERFACE:{scope}:{name}`

```typescript
interface User {              // INTERFACE:module:User
  name: string;
}

function factory() {
  interface LocalConfig { }   // INTERFACE:factory:LocalConfig
}
```

**Declaration merging:**
```typescript
interface User { name: string; }
interface User { age: number; }  // Merged с первым
```

**Решение:** Один ID для merged interface. Атрибуты содержат все declarations.

---

### 13. TYPE (TypeScript type aliases)

**Semantic ID:** `{file}:TYPE:{scope}:{name}`

```typescript
type ID = string | number;          // TYPE:module:ID
type Handler<T> = (data: T) => void; // TYPE:module:Handler
```

**Edge cases:**
- Generic types: имя без generic parameters в ID
- Conditional types: `type Extract<T, U> = T extends U ? T : never;` — ID по имени

---

### 14. ENUM (TypeScript)

**Semantic ID:** `{file}:ENUM:{scope}:{name}`

```typescript
enum Status {
  Active,
  Inactive
}
// ENUM:module:Status
```

**Enum members:**
```
{file}:ENUM_MEMBER:{enumName}:{memberName}
```
`ENUM_MEMBER:Status:Active`

**const enum:** Та же семантика, атрибут `const: true`.

---

### 15. DECORATOR (TypeScript/Stage 3)

**Semantic ID:** `{file}:DECORATOR:{targetId}:{decoratorName}:{index}`

```typescript
@Controller('/users')
@Auth('admin')
class UserController {
  @Get('/:id')
  getUser() { }
}
```

```
DECORATOR:CLASS:module:UserController:Controller:0
DECORATOR:CLASS:module:UserController:Auth:1
DECORATOR:METHOD:UserController.getUser:Get:0
```

**Edge cases:**
- Decorator factories: `@Log()` vs `@Log` — семантически одинаковы, ID одинаковый
- Computed decorators: `@decorators[type]` — использовать `<computed>` placeholder

---

### 16. EXPRESSION (Generic)

**Проблема:** Expressions — это catch-all категория. В чистом виде не нужны в графе.

**Рекомендация:** Не создавать отдельные ноды для expressions. Вместо этого:
- Binary/Unary expressions → часть родительского контекста
- Call expressions → CALL_SITE / METHOD_CALL
- Assignment expressions → обновление VARIABLE
- Member expressions → access patterns (атрибуты на edges)

Если нужна нода для dataflow: `{file}:EXPR:{scope}:{counter}`

---

## Общие принципы формирования Scope Path

### Структура scope path

```
module                          # Корневой scope файла
module.functionName             # Function scope
module.functionName.if#1        # Block scope (if statement)
module.functionName.if#1.for#1  # Nested block scope
module.ClassName                # Class scope
module.ClassName.methodName     # Method scope
```

### Правила

1. **Module scope** — всегда корень: `module`
2. **Named scopes** (functions, classes, methods) — по имени
3. **Anonymous scopes** (blocks, loops) — по типу + counter: `if#1`, `for#2`
4. **Counter** — в пределах parent scope, начиная с 1

### Реализация

```typescript
interface ScopeContext {
  path: string[];           // ['module', 'processUser', 'if#1']
  counters: Map<string, number>;  // { 'if': 1, 'for': 0 }
}

function pushScope(ctx: ScopeContext, type: string, name?: string): ScopeContext {
  if (name) {
    return {
      path: [...ctx.path, name],
      counters: new Map()
    };
  }

  const count = (ctx.counters.get(type) || 0) + 1;
  ctx.counters.set(type, count);

  return {
    path: [...ctx.path, `${type}#${count}`],
    counters: new Map()
  };
}

function getScopePath(ctx: ScopeContext): string {
  return ctx.path.join('.');
}
```

---

## Таблица рекомендаций

| Тип ноды | Semantic ID Format | Стабильность |
|----------|-------------------|--------------|
| MODULE | `{file}:MODULE` | Абсолютная |
| FUNCTION (named) | `{file}:FUNCTION:{scope}:{name}` | Высокая |
| FUNCTION (anonymous) | `{file}:FUNCTION:{scope}:~callback~{callTarget}~{argIndex}` | Средняя |
| FUNCTION (IIFE) | `{file}:FUNCTION:{scope}:~iife~{counter}` | Средняя |
| CLASS | `{file}:CLASS:{scope}:{name}` | Высокая |
| METHOD | `{file}:METHOD:{className}.{name}` | Высокая |
| VARIABLE | `{file}:VAR:{scope}:{name}` | Высокая |
| PARAMETER | `{file}:PARAM:{functionId}:{name}` | Высокая |
| IMPORT | `{file}:IMPORT:{source}:{localName}` | Абсолютная |
| EXPORT | `{file}:EXPORT:{exportedName}` | Абсолютная |
| CALL_SITE | `{file}:CALL:{scope}:{target}:{counter}` | Низкая |
| METHOD_CALL | `{file}:MCALL:{scope}:{obj}.{method}:{counter}` | Низкая |
| LITERAL | `{file}:LITERAL:{context}:{counter}` | Низкая |
| SCOPE | `{file}:SCOPE:{parentScope}:{type}:{counter}` | Средняя |
| INTERFACE | `{file}:INTERFACE:{scope}:{name}` | Высокая |
| TYPE | `{file}:TYPE:{scope}:{name}` | Высокая |
| ENUM | `{file}:ENUM:{scope}:{name}` | Высокая |
| DECORATOR | `{file}:DECORATOR:{targetId}:{name}:{index}` | Высокая |

---

## Edge Cases Сводка

### Проблемы уникальности

1. **Одноимённые функции в разных scopes** — решается scope path
2. **Несколько anonymous callbacks** — counter + call context
3. **Destructuring** — каждый binding = отдельная переменная
4. **Re-exports** — отдельный тип edge или специальная обработка
5. **Declaration merging (TS)** — один ID, merged атрибуты
6. **Duplicate parameters (non-strict)** — counter suffix

### Что остаётся позиционным

Call sites и literals по природе множественны и не имеют семантического имени. Для них counter в пределах scope — лучшее приближение к семантике.

---

## План миграции

1. **Фаза 1:** MODULE и IMPORT (уже сделаны или почти)
2. **Фаза 2:** FUNCTION, CLASS, METHOD — высокая стабильность, большой impact
3. **Фаза 3:** VARIABLE, PARAMETER, EXPORT
4. **Фаза 4:** SCOPE, INTERFACE, TYPE, ENUM, DECORATOR
5. **Фаза 5:** CALL_SITE, METHOD_CALL, LITERAL — принять ограничения

Каждая фаза требует:
- Обновление NodeFactory
- Миграция тестов
- Backward compatibility shim (если нужно)

---

## Заключение

Полный переход на Semantic ID возможен для **большинства** типов нод. Исключения:
- **Call sites** — по природе множественны, counter необходим
- **Literals** — не имеют имени, зависят от контекста
- **Anonymous scopes** — используют counter в parent scope

Эти исключения — не дефект дизайна, а отражение семантики JS. Важно понимать, что "semantic" не означает "абсолютно стабильный", а означает "изменяется только при изменении семантики".

Рефакторинг "переместить функцию" меняет scope path — и это **корректно**, потому что семантически функция теперь в другом контексте. Рефакторинг "добавить пустую строку выше" **не должен** менять ID — и с Semantic ID не будет.
