# User Request: REG-114

## Linear Issue
[REG-114: Data Flow - Track object property mutations](https://linear.app/reginaflow/issue/REG-114/data-flow-track-object-property-mutations)

## Problem

Similar to arrays, object property mutations aren't tracked:

```javascript
const config = {};
config.handler = myFunc;  // No edge!
register(config);         // We don't know myFunc flows into register
```

## Mutations to Track

```javascript
obj.prop = value    → value FLOWS_INTO obj (via prop)
obj['prop'] = value → value FLOWS_INTO obj (via prop)
Object.assign(obj, source) → source properties FLOW_INTO obj
{ ...obj, prop: value } → value + obj FLOWS_INTO new object
```

## Acceptance Criteria

- [ ] `obj.prop = value` creates data flow edge
- [ ] `Object.assign()` tracked
- [ ] Spread operator tracked
- [ ] Tests pass

## Related

- REG-113: Array mutations
- REG-117: Track nested array mutations (obj.arr.push)
