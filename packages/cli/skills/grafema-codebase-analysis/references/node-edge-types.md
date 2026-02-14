# Grafema Graph Schema: Node and Edge Types

## Node Types

### Core Entities

| Type | Description | Key Attributes |
|------|-------------|----------------|
| `MODULE` | A source file/module | name, file |
| `FUNCTION` | Function declaration | name, file, line, async |
| `METHOD` | Class method | name, file, line, className |
| `CLASS` | Class declaration | name, file, line |
| `VARIABLE` | Variable declaration | name, file, line, kind (const/let/var) |
| `PARAMETER` | Function parameter | name, file, line, index |

### Call & Access Nodes

| Type | Description | Key Attributes |
|------|-------------|----------------|
| `CALL` | Function call expression | name, file, line, resolved |
| `METHOD_CALL` | Method call expression | name, file, line, object, resolved |
| `CALL_SITE` | Call site context | file, line |
| `PROPERTY_ACCESS` | Property access (obj.prop) | name, object, file, line |

### Domain-Specific Nodes

| Type | Description | Key Attributes |
|------|-------------|----------------|
| `http:route` | HTTP route definition | path, method |
| `http:request` | HTTP request handler | path, method, file, line |
| `db:query` | Database query | file, line |
| `socketio:emit` | Socket.IO emit call | event, file, line |
| `socketio:on` | Socket.IO event listener | event, file, line |

### Structural Nodes

| Type | Description |
|------|-------------|
| `SCOPE` | Code scope (function body, if block, loop) |
| `OBJECT_LITERAL` | Object literal expression |
| `ARRAY_LITERAL` | Array literal expression |
| `LITERAL` | Primitive literal value |
| `IMPORT` | Import declaration |
| `EXPORT` | Export declaration |

## Edge Types

| Type | Direction | Description |
|------|-----------|-------------|
| `CONTAINS` | Parent -> Child | Structural containment (module contains function) |
| `CALLS` | Caller -> Callee | Function/method call relationship |
| `DEPENDS_ON` | Module -> Module | Module dependency (import) |
| `ASSIGNED_FROM` | Variable -> Source | Value assignment source |
| `INSTANCE_OF` | Instance -> Class | Class instantiation |
| `PASSES_ARGUMENT` | Call -> Value | Argument passing at call site |
| `HAS_SCOPE` | Function -> Scope | Function's scope chain |
| `EXTENDS` | Class -> Class | Class inheritance |
| `IMPLEMENTS` | Class -> Interface | Interface implementation |
| `RETURNS` | Function -> Type | Return type relationship |
| `DATAFLOW` | Source -> Sink | Data flow edge |
| `GUARDED_BY` | Node -> Scope | Conditional guard relationship |

## Common Attribute Names

These can be used with `attr(Id, Name, Value)` in Datalog queries:

| Attribute | Types | Description |
|-----------|-------|-------------|
| `name` | All named nodes | Entity name |
| `file` | All nodes | Source file path (relative) |
| `line` | All located nodes | Line number |
| `column` | All located nodes | Column number |
| `type` | All nodes | Node type (via `node(Id, Type)`) |
| `async` | FUNCTION, METHOD | Is async function |
| `kind` | VARIABLE | const, let, or var |
| `method` | http:request | HTTP method (GET, POST, etc.) |
| `path` | http:request, http:route | URL path pattern |
| `resolved` | CALL, METHOD_CALL | Whether call target is resolved |
| `object` | METHOD_CALL, PROPERTY_ACCESS | Receiver object name |
| `className` | METHOD | Owning class name |
| `event` | socketio:emit, socketio:on | Socket.IO event name |

## Quick Reference: Finding Common Patterns

### Find all functions
```
node(X, "FUNCTION")
```

### Find all classes
```
node(X, "CLASS")
```

### Find all HTTP endpoints
```
node(X, "http:request")
```

### Find calls to a specific function
```
node(X, "CALL"), attr(X, "name", "targetFunction")
```

### Find all methods of a class
```
node(C, "CLASS"), attr(C, "name", "MyClass"), edge(C, M, "CONTAINS"), node(M, "METHOD")
```

### Find module dependencies
```
edge(A, B, "DEPENDS_ON"), node(A, "MODULE"), node(B, "MODULE")
```

### Find data flow from a variable
```
node(X, "VARIABLE"), attr(X, "name", "myVar"), edge(X, Y, "DATAFLOW")
```

### Find unresolved calls
```
node(X, "CALL"), attr(X, "resolved", "false")
```
