# Glossary

Definitions of terms used in Grafema documentation.

## A

### Analysis Phase
The phase where Grafema parses source code AST and creates semantic nodes (functions, classes, calls, routes, etc.). Runs after indexing, before enrichment.

### AST (Abstract Syntax Tree)
A tree representation of source code structure. Grafema parses AST to understand code semantics.

## C

### CALL Node
A node representing a function call in the code. Example: `fetchUsers()` creates a CALL node.

### CALLS Edge
An edge connecting a CALL node to its target FUNCTION/METHOD node. Indicates "this call invokes that function."

### CONTAINS Edge
An edge indicating parent-child relationship. Example: MODULE contains FUNCTION, FUNCTION contains CALL.

## D

### Datalog
A declarative query language used by Grafema to search the code graph. Similar to SQL but for graph queries. See [Datalog Cheat Sheet](datalog-cheat-sheet.md).

### DEPENDS_ON Edge
An edge connecting two MODULE nodes when one imports the other.

### Discovery Phase
The first phase where Grafema finds services and entry points in the project.

## E

### Edge
A connection between two nodes in the graph. Has a type (CALLS, CONTAINS, etc.) and direction (source → destination).

### Enrichment Phase
The phase where Grafema adds relationships between existing nodes. For example, resolving which function a CALL actually invokes. Runs after analysis.

### Entry Point
The starting file for analysis. Typically `src/index.js` or the `main` field from `package.json`.

## G

### Graph
The data structure Grafema builds from your code. Consists of nodes (code elements) and edges (relationships).

### Guarantee
A rule that code must satisfy. Written in Datalog. Example: "no eval() calls". Guarantees are checked and violations are reported.

## I

### Indexing Phase
The phase where Grafema builds the module dependency tree by following imports from entry points.

## M

### Manifest
Internal data structure describing discovered services and entry points.

### METHOD_CALL Node
A node representing a method call like `obj.method()`. Has `object` and `method` attributes.

### MODULE Node
A node representing a JavaScript/TypeScript file in the project.

## N

### Node
An element in the code graph. Can be a module, function, class, call, variable, etc. Has a type, ID, and attributes.

### Node Type
The category of a node. Examples: `MODULE`, `FUNCTION`, `CALL`, `http:route`.

## P

### Phase
A stage in the analysis pipeline. Phases run in order: DISCOVERY → INDEXING → ANALYSIS → ENRICHMENT → VALIDATION.

### Plugin
A module that adds capabilities to Grafema. Each plugin runs in a specific phase and creates specific node/edge types.

### Priority
A number determining plugin execution order within a phase. Higher priority = runs earlier.

## R

### Resolution
The process of connecting a CALL node to its target FUNCTION node. "Resolved" means the connection was found; "unresolved" means it wasn't.

## S

### Semantic Node
A node representing a meaningful code concept (HTTP route, database query, etc.) rather than just syntax. Created by analysis plugins.

### Service
A distinct application unit in a project. In monorepos, each package might be a separate service.

## V

### Validation Phase
The final phase where Grafema checks invariants and reports issues. Guarantees are checked here.

### Violation
A node that matches a guarantee's Datalog query. Indicates the guarantee is broken at that location.

## See Also

- [Datalog Cheat Sheet](datalog-cheat-sheet.md) — Query syntax and examples
- [Configuration](configuration.md) — Plugin configuration
- [Project Onboarding](project-onboarding.md) — Getting started
