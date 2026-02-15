# Don's Exploration: Rust, React, Socket Analyzers

**Date:** 2026-02-15
**Task:** REG-368 (branded nodes)
**Scope:** Analyze inline node creations in 5 analyzers

## Summary

Analyzed 5 analyzers that need branded node factory methods:
- RustAnalyzer (446 total nodes)
- RustModuleIndexer (131 single node)
- ReactAnalyzer (319 batch nodes)
- SocketIOAnalyzer (258 + 476 batch nodes)
- SocketAnalyzer (189 batch nodes)

**Key Finding:** All analyzers use `as unknown as NodeRecord` to bypass type safety when creating non-standard node types. These need factory methods following the pattern established in NodeFactory.ts.

## Existing Factory Pattern Analysis

From `NodeFactory.ts` (line 258-797):

**Pattern:**
```typescript
static createXxx(params): BrandedNode {
  return brandNodeInternal(XxxNode.create(params));
}
```

**Key observations:**
1. Factory methods delegate to node contract classes (`XxxNode.create()`)
2. Node contracts live in `./nodes/` (imported lines 15-55)
3. `brandNodeInternal()` wraps the result to produce branded type
4. ID generation patterns vary by node type:
   - Singleton: `type` only (e.g., `net:request`, `net:stdio`)
   - Semantic: `type#name#file#line` (most common)
   - Scoped: Include parent context in ID

## Node Type Definitions

From `packages/types/src/nodes.ts`:

**No definitions found for:**
- `RUST_MODULE`, `RUST_FUNCTION`, `RUST_STRUCT`, `RUST_IMPL`, `RUST_METHOD`, `RUST_TRAIT`, `RUST_CALL`
- `react:component`, `react:state`, `react:effect`, `react:callback`, `react:memo`, `react:ref`, `react:reducer`, `react:context`
- `socketio:emit`, `socketio:on`, `socketio:room`, `socketio:event`
- `os:unix-socket`, `os:unix-server`, `net:tcp-connection`, `net:tcp-server`
- `canvas:context`, `canvas:draw`
- `browser:storage`, `browser:timer`, `browser:observer`, `browser:async`, `browser:worker`, `browser:api`
- `dom:event`
- Various `issue:*` types (stale-closure, missing-cleanup, raf-leak, canvas-leak, state-after-unmount)

These are **namespaced types** (using `:` separator) which `nodes.ts` supports via `isNamespacedType()` helper.

---

## Analyzer 1: RustAnalyzer

**File:** `packages/core/src/plugins/analysis/RustAnalyzer.ts`

**Error location:** Line 446
```typescript
await graph.addNodes(nodes);  // nodes is NodeRecord[], needs AnyBrandedNode[]
```

### Inline Node Creations

#### 1. RUST_CALL (lines 296-308)
```typescript
nodes.push({
  id: `RUST_CALL#${parentName}#${call.line}#${call.column}#${module.file}`,
  type: 'RUST_CALL',
  file: module.file,
  line: call.line,
  column: call.column,
  callType: call.callType, // "function" | "method" | "macro"
  name: call.name || null,
  receiver: call.receiver || null,
  method: call.method || null,
  argsCount: call.argsCount,
  sideEffect: call.sideEffect || null // "fs:write", "panic", "io:print", etc.
} as unknown as NodeRecord);
```

**ID pattern:** `RUST_CALL#<parentName>#<line>#<column>#<file>`
**Required fields:** `id`, `type`, `file`, `line`, `column`, `callType`, `argsCount`
**Optional fields:** `name`, `receiver`, `method`, `sideEffect`

#### 2. RUST_FUNCTION (lines 319-338)
```typescript
nodes.push({
  id: nodeId,  // `RUST_FUNCTION#${fn.name}#${module.file}#${fn.line}`
  type: 'RUST_FUNCTION',
  name: fn.name,
  file: module.file,
  line: fn.line,
  column: fn.column,
  pub: fn.isPub,
  async: fn.isAsync,
  unsafe: fn.isUnsafe,
  const: fn.isConst,
  napi: fn.isNapi,
  napiJsName: fn.napiJsName || null,
  napiConstructor: fn.napiConstructor || false,
  napiGetter: fn.napiGetter || null,
  napiSetter: fn.napiSetter || null,
  params: fn.params || [],
  returnType: fn.returnType || null,
  unsafeBlocks: fn.unsafeBlocks?.length || 0
} as unknown as NodeRecord);
```

**ID pattern:** `RUST_FUNCTION#<name>#<file>#<line>`
**Required:** `id`, `type`, `name`, `file`, `line`, `column`
**Optional:** `pub`, `async`, `unsafe`, `const`, `napi`, `napiJsName`, `napiConstructor`, `napiGetter`, `napiSetter`, `params`, `returnType`, `unsafeBlocks`

#### 3. RUST_STRUCT (lines 350-359)
```typescript
nodes.push({
  id: nodeId,  // `RUST_STRUCT#${s.name}#${module.file}#${s.line}`
  type: 'RUST_STRUCT',
  name: s.name,
  file: module.file,
  line: s.line,
  pub: s.isPub,
  napi: s.isNapi,
  fields: s.fields || []
} as unknown as NodeRecord);
```

**ID pattern:** `RUST_STRUCT#<name>#<file>#<line>`
**Required:** `id`, `type`, `name`, `file`, `line`
**Optional:** `pub`, `napi`, `fields`

#### 4. RUST_IMPL (lines 368-375)
```typescript
nodes.push({
  id: implId,  // `RUST_IMPL#${impl.targetType}${impl.traitName ? ':' + impl.traitName : ''}#${module.file}#${impl.line}`
  type: 'RUST_IMPL',
  name: impl.targetType,
  traitName: impl.traitName || null,
  file: module.file,
  line: impl.line
} as unknown as NodeRecord);
```

**ID pattern:** `RUST_IMPL#<targetType>[:<traitName>]#<file>#<line>`
**Required:** `id`, `type`, `name`, `file`, `line`
**Optional:** `traitName`

#### 5. RUST_METHOD (lines 392-414)
```typescript
nodes.push({
  id: methodId,  // `RUST_METHOD#${method.name}#${module.file}#${method.line}`
  type: 'RUST_METHOD',
  name: method.name,
  file: module.file,
  line: method.line,
  column: method.column,
  pub: method.isPub,
  async: method.isAsync,
  unsafe: method.isUnsafe,
  const: method.isConst,
  napi: method.isNapi,
  napiJsName: method.napiJsName || null,
  napiConstructor: method.napiConstructor || false,
  napiGetter: method.napiGetter || null,
  napiSetter: method.napiSetter || null,
  params: method.params || [],
  returnType: method.returnType || null,
  selfType: method.selfType || null,
  implId: implId,
  implType: impl.targetType,
  unsafeBlocks: method.unsafeBlocks?.length || 0
} as unknown as NodeRecord);
```

**ID pattern:** `RUST_METHOD#<name>#<file>#<line>`
**Required:** `id`, `type`, `name`, `file`, `line`, `column`
**Optional:** `pub`, `async`, `unsafe`, `const`, `napi`, `napiJsName`, `napiConstructor`, `napiGetter`, `napiSetter`, `params`, `returnType`, `selfType`, `implId`, `implType`, `unsafeBlocks`

#### 6. RUST_TRAIT (lines 428-440)
```typescript
nodes.push({
  id: nodeId,  // `RUST_TRAIT#${t.name}#${module.file}#${t.line}`
  type: 'RUST_TRAIT',
  name: t.name,
  file: module.file,
  line: t.line,
  pub: t.isPub,
  methods: (t.methods || []).map(m => ({
    name: m.name,
    params: m.params,
    returnType: m.returnType
  }))
} as unknown as NodeRecord);
```

**ID pattern:** `RUST_TRAIT#<name>#<file>#<line>`
**Required:** `id`, `type`, `name`, `file`, `line`
**Optional:** `pub`, `methods`

---

## Analyzer 2: RustModuleIndexer

**File:** `packages/core/src/plugins/indexing/RustModuleIndexer.ts`

**Error location:** Line 131
```typescript
await graph.addNode({...} as unknown as NodeRecord);
```

### Inline Node Creation

#### RUST_MODULE (lines 131-140)
```typescript
await graph.addNode({
  id: nodeId,  // `RUST_MODULE#${moduleName}#${prefixedPath}`
  type: 'RUST_MODULE',
  name: moduleName,  // "crate", "ffi::napi_bindings", etc.
  file: filePath,
  contentHash: hash,
  isLib: basename(filePath) === 'lib.rs',
  isMod: basename(filePath) === 'mod.rs',
  isTest: this.isTestFile(filePath)
} as unknown as NodeRecord);
```

**ID pattern:** `RUST_MODULE#<moduleName>#<relativePath>`
**Required:** `id`, `type`, `name`, `file`, `contentHash`
**Optional:** `isLib`, `isMod`, `isTest`

---

## Analyzer 3: ReactAnalyzer

**File:** `packages/core/src/plugins/analysis/ReactAnalyzer.ts`

**Error locations:**
- Line 319: `await graph.addNodes(nodes);`
- Line 320: `await graph.addEdges(edges);`

**NOTE:** ReactAnalyzer doesn't create nodes inline in the main file. It delegates to helper modules:
- `./react-internal/jsx.js` - component, JSX analysis
- `./react-internal/hooks.js` - hook analysis
- `./react-internal/browser-api.js` - browser API detection

Nodes are created in those modules and collected in `AnalysisResult` interface (lines 147-154), then added via `addToGraph()` at lines 269-321.

**Node types created (from metadata lines 44-52):**
- `react:component`, `react:state`, `react:effect`, `react:callback`, `react:memo`, `react:ref`, `react:reducer`, `react:context`
- `dom:event`
- `browser:storage`, `browser:timer`, `browser:observer`, `browser:async`, `browser:worker`, `browser:api`
- `canvas:context`, `canvas:draw`
- `issue:stale-closure`, `issue:missing-cleanup`, `issue:raf-leak`, `issue:canvas-leak`, `issue:state-after-unmount`

**To catalog React node creations, we need to read the helper modules.**

---

## Analyzer 4: SocketIOAnalyzer

**File:** `packages/core/src/plugins/analysis/SocketIOAnalyzer.ts`

**Error locations:**
- Line 258: `await graph.addNodes(nodes);` (event channels phase)
- Line 476: `await graph.addNodes(nodes);` (module analysis phase)

### Inline Node Creations

#### 1. socketio:emit (lines 340-351)
```typescript
emits.push({
  id: `socketio:emit#${event}#${module.file}#${line}`,
  type: 'socketio:emit',
  event: event,
  room: room,
  namespace: namespace,
  broadcast: broadcast,
  objectName: objectName,
  file: module.file!,
  line: line,
  column: column
});
```

**ID pattern:** `socketio:emit#<event>#<file>#<line>`
**Required:** `id`, `type`, `event`, `file`, `line`, `column`, `objectName`, `broadcast`
**Optional:** `room`, `namespace`

#### 2. socketio:on (lines 380-390)
```typescript
listeners.push({
  id: `socketio:on#${event}#${module.file}#${line}`,
  type: 'socketio:on',
  event: event,
  objectName: objectName,
  handlerName: handlerName,
  handlerLine: handlerLine,
  file: module.file!,
  line: line,
  column: getColumn(node)
});
```

**ID pattern:** `socketio:on#<event>#<file>#<line>`
**Required:** `id`, `type`, `event`, `objectName`, `handlerName`, `handlerLine`, `file`, `line`, `column`

#### 3. socketio:room (lines 404-412)
```typescript
rooms.push({
  id: `socketio:room#${roomName}#${module.file}#${line}`,
  type: 'socketio:room',
  room: roomName,
  objectName: objectName,
  file: module.file!,
  line: line,
  column: getColumn(node)
});
```

**ID pattern:** `socketio:room#<roomName>#<file>#<line>`
**Required:** `id`, `type`, `room`, `objectName`, `file`, `line`, `column`

#### 4. socketio:event (lines 220-225)
```typescript
const eventNode: SocketEventNode = {
  id: eventNodeId,  // `socketio:event#${eventName}`
  type: 'socketio:event',
  name: eventName,
  event: eventName
};
```

**ID pattern:** `socketio:event#<eventName>` (SINGLETON per event name)
**Required:** `id`, `type`, `name`, `event`
**Optional:** (none - file/line not applicable for channel nodes)

---

## Analyzer 5: SocketAnalyzer

**File:** `packages/core/src/plugins/analysis/SocketAnalyzer.ts`

**Error location:** Line 189
```typescript
await graph.addNodes(nodes);
```

### Inline Node Creations

All socket nodes are created via helper methods `createClientNode()` and `createServerNode()`, which return `SocketNode` interface (lines 34-47).

#### 1. os:unix-socket (lines 441-451)
```typescript
return {
  id: `os:unix-socket#${args.path}#${module.file}#${line}`,
  type: 'os:unix-socket',
  name: `unix:${args.path}`,
  protocol: 'unix',
  path: args.path,
  library: 'net',
  file: module.file!,
  line,
  column
};
```

**ID pattern:** `os:unix-socket#<path>#<file>#<line>`
**Required:** `id`, `type`, `name`, `protocol`, `path`, `library`, `file`, `line`, `column`

#### 2. net:tcp-connection (lines 456-467)
```typescript
return {
  id: `net:tcp-connection#${host}:${args.port}#${module.file}#${line}`,
  type: 'net:tcp-connection',
  name: `tcp:${host}:${args.port}`,
  protocol: 'tcp',
  host,
  port: args.port,
  library: 'net',
  file: module.file!,
  line,
  column
};
```

**ID pattern:** `net:tcp-connection#<host>:<port>#<file>#<line>`
**Required:** `id`, `type`, `name`, `protocol`, `host`, `port`, `library`, `file`, `line`, `column`

#### 3. os:unix-server (lines 485-496)
```typescript
return {
  id: `os:unix-server#${args.path}#${module.file}#${line}`,
  type: 'os:unix-server',
  name: `unix-server:${args.path}`,
  protocol: 'unix',
  path: args.path,
  library: 'net',
  backlog: args.backlog,
  file: module.file!,
  line,
  column
};
```

**ID pattern:** `os:unix-server#<path>#<file>#<line>`
**Required:** `id`, `type`, `name`, `protocol`, `path`, `library`, `file`, `line`, `column`
**Optional:** `backlog`

#### 4. net:tcp-server (lines 501-513)
```typescript
return {
  id: `net:tcp-server#${host}:${args.port}#${module.file}#${line}`,
  type: 'net:tcp-server',
  name: `tcp-server:${host}:${args.port}`,
  protocol: 'tcp',
  host,
  port: args.port,
  library: 'net',
  backlog: args.backlog,
  file: module.file!,
  line,
  column
};
```

**ID pattern:** `net:tcp-server#<host>:<port>#<file>#<line>`
**Required:** `id`, `type`, `name`, `protocol`, `host`, `port`, `library`, `file`, `line`, `column`
**Optional:** `backlog`

---

## Proposed Factory Methods

Following NodeFactory.ts patterns, we need to create node contracts and factory methods.

### General Pattern

1. **Create node contract classes** in `packages/core/src/core/nodes/`:
   - `RustFunctionNode.ts`, `RustStructNode.ts`, etc.
   - Each class implements `create()` and `validate()` static methods

2. **Add factory methods** to `NodeFactory.ts`:
   ```typescript
   static createRustFunction(name: string, file: string, line: number, column: number, options: RustFunctionOptions = {}) {
     return brandNodeInternal(RustFunctionNode.create(name, file, line, column, options));
   }
   ```

3. **Update validators** in `NodeFactory.validate()` to include new types

### Factory Method Signatures

#### Rust Nodes

```typescript
// RustModuleIndexer
static createRustModule(
  moduleName: string,
  file: string,
  contentHash: string,
  options: { isLib?: boolean; isMod?: boolean; isTest?: boolean } = {}
): RustModuleNodeRecord;

// RustAnalyzer
static createRustFunction(
  name: string,
  file: string,
  line: number,
  column: number,
  options: {
    pub?: boolean;
    async?: boolean;
    unsafe?: boolean;
    const?: boolean;
    napi?: boolean;
    napiJsName?: string;
    napiConstructor?: boolean;
    napiGetter?: string;
    napiSetter?: string;
    params?: string[];
    returnType?: string;
    unsafeBlocks?: number;
  } = {}
): RustFunctionNodeRecord;

static createRustStruct(
  name: string,
  file: string,
  line: number,
  options: { pub?: boolean; napi?: boolean; fields?: unknown[] } = {}
): RustStructNodeRecord;

static createRustImpl(
  targetType: string,
  file: string,
  line: number,
  options: { traitName?: string } = {}
): RustImplNodeRecord;

static createRustMethod(
  name: string,
  file: string,
  line: number,
  column: number,
  implId: string,
  implType: string,
  options: {
    pub?: boolean;
    async?: boolean;
    unsafe?: boolean;
    const?: boolean;
    napi?: boolean;
    napiJsName?: string;
    napiConstructor?: boolean;
    napiGetter?: string;
    napiSetter?: string;
    params?: string[];
    returnType?: string;
    selfType?: string;
    unsafeBlocks?: number;
  } = {}
): RustMethodNodeRecord;

static createRustTrait(
  name: string,
  file: string,
  line: number,
  options: {
    pub?: boolean;
    methods?: Array<{ name: string; params: string[]; returnType: string }>;
  } = {}
): RustTraitNodeRecord;

static createRustCall(
  parentName: string,
  file: string,
  line: number,
  column: number,
  callType: 'function' | 'method' | 'macro',
  argsCount: number,
  options: {
    name?: string;
    receiver?: string;
    method?: string;
    sideEffect?: string;
  } = {}
): RustCallNodeRecord;
```

#### Socket.IO Nodes

```typescript
static createSocketIOEmit(
  event: string,
  objectName: string,
  file: string,
  line: number,
  column: number,
  options: { room?: string; namespace?: string; broadcast?: boolean } = {}
): SocketIOEmitNodeRecord;

static createSocketIOListener(
  event: string,
  objectName: string,
  handlerName: string,
  handlerLine: number,
  file: string,
  line: number,
  column: number
): SocketIOListenerNodeRecord;

static createSocketIORoom(
  roomName: string,
  objectName: string,
  file: string,
  line: number,
  column: number
): SocketIORoomNodeRecord;

static createSocketIOEvent(
  eventName: string
): SocketIOEventNodeRecord;  // Singleton
```

#### Socket (net module) Nodes

```typescript
static createUnixSocket(
  path: string,
  file: string,
  line: number,
  column: number,
  options: { library?: string } = {}
): UnixSocketNodeRecord;

static createTcpConnection(
  host: string,
  port: number,
  file: string,
  line: number,
  column: number,
  options: { library?: string } = {}
): TcpConnectionNodeRecord;

static createUnixServer(
  path: string,
  file: string,
  line: number,
  column: number,
  options: { library?: string; backlog?: number } = {}
): UnixServerNodeRecord;

static createTcpServer(
  host: string,
  port: number,
  file: string,
  line: number,
  column: number,
  options: { library?: string; backlog?: number } = {}
): TcpServerNodeRecord;
```

#### React Nodes

**Requires reading helper modules to catalog exact field shapes.**
Deferred to next exploration step.

---

## Next Steps

1. **Read React helper modules** to catalog node shapes:
   - `packages/core/src/plugins/analysis/react-internal/jsx.js`
   - `packages/core/src/plugins/analysis/react-internal/hooks.js`
   - `packages/core/src/plugins/analysis/react-internal/browser-api.js`

2. **Create node contracts** in `packages/core/src/core/nodes/`:
   - Rust: 7 contracts (module, function, struct, impl, method, trait, call)
   - Socket.IO: 4 contracts (emit, listener, room, event)
   - Socket: 4 contracts (unix-socket, tcp-connection, unix-server, tcp-server)
   - React: TBD after reading helpers

3. **Add factory methods** to NodeFactory.ts

4. **Update analyzers** to use factory methods instead of inline objects

5. **Add validators** to NodeFactory.validate()

---

## Questions for Review

1. **React helper modules:** Should we read them now or defer to implementation?
2. **Namespace pattern:** All new types use `:` separator (e.g., `socketio:emit`). Do we want separate factory naming (`createSocketIOEmit`) or generic (`createNamespacedNode`)?
3. **ID generation:** Some IDs include multiple path components (e.g., `RUST_IMPL#MyStruct:MyTrait#file#line`). Should contracts handle this complexity or pass pre-formatted IDs?
