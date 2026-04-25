# Semantic ID Analysis Summary

## Experts Consulted
- Donald Knuth (deep analysis)
- Linus Torvalds (architectural review)
- Генрих Альтшуллер (TRIZ contradiction analysis)

## Consensus Solution

### Architecture
```
NODE = {
  id: "file::scope::type::name[#discriminator]"  // STABLE
  location: {line, column, ...}                   // EPHEMERAL
}
```

### Semantic ID Format
```
{file}::{scope_path}::{type}::{name}[#discriminator]
```

Examples:
- `src/utils.js::global::function::processData`
- `src/api.js::UserService::method::login`
- `src/app.js::handler.if#1::call::log#2`

### Discriminator Rules
1. If unique in scope → no discriminator
2. If collision → try context: `[in:if-block]`, `[in:else-block]`
3. If still collision → stable ordering: `#1`, `#2` (by content hash)

### Categories

| Category | Nodes | Approach |
|----------|-------|----------|
| Pure semantic | MODULE, IMPORT, EXPORT | name-based, no line |
| Scope-based | FUNCTION, CLASS, VARIABLE | scope::name |
| Counter-based | CALL_SITE, LITERAL | scope::name#N |

## Decision

Expand REG-98:
1. First: Design and implement Semantic ID system
2. Second: Update NodeFactory to use Semantic ID
3. Third: Migrate existing inline creations
