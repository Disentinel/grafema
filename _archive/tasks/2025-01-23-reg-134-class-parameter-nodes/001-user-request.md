# REG-134: Class Constructor/Method Parameters Not Created as PARAMETER Nodes

## Linear Issue
https://linear.app/reginaflow/issue/REG-134/class-constructormethod-parameters-are-not-created-as-parameter-nodes

## Problem

When analyzing code like:

```javascript
class Config {
  constructor(handler) {
    this.handler = handler;  // Can't track data flow here
  }

  setHandler(h) {
    this.handler = h;  // Also can't track data flow here
  }
}
```

The parameters `handler` and `h` are **not** created as PARAMETER nodes in the graph. This prevents tracking data flow for `this.prop = param` mutations inside class constructors and methods.

## Impact

- Object mutation tracking (REG-114) cannot create FLOWS_INTO edges for `this.prop = param` patterns
- Loss of data flow visibility in class-based code

## Current State

- `FunctionVisitor.ts` has `createParameterNodes()` helper that works for regular functions and arrow functions
- `ClassVisitor.ts` does NOT create PARAMETER nodes for:
  - Constructor parameters
  - Method parameters
  - Class property function parameters (arrow functions as class properties)

## Skipped Tests

Tests in `/test/unit/ObjectMutationTracking.test.js` are skipped:
- `should track this.prop = value in constructor with objectName "this"`
- `should track this.prop = value in class methods`

## Expected Behavior

Class constructor and method parameters should create PARAMETER nodes with HAS_PARAMETER edges, similar to how function parameters work.

## Solution Direction

Update `ClassVisitor.ts` to call parameter creation logic for:
1. ClassMethod (including constructor)
2. ClassProperty with function values (arrow functions as class properties)
