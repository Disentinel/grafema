# REG-301: AST: Track new.target

## Gap
`new.target` not tracked.

## Example
```javascript
class Base {
  constructor() {
    if (new.target === Base) throw new Error('Abstract class');
  }
}
```

## Acceptance Criteria
- Track new.target usage in constructors
- Useful for abstract class detection
