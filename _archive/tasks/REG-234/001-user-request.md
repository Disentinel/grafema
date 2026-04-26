# REG-234: FunctionCallResolver - Extract buildExportKey() helper

## Summary

Extract duplicate export key building logic into a reusable helper method.

## Background

During REG-232 review, Kevlin noted the same logic appears twice:

* Lines 110-118 (export index building)
* Lines 340-342 (chain resolution)

## Implementation

Extract to private helper:

```typescript
private buildExportKey(exp: ExportNode): string {
  if (exp.exportType === 'default') {
    return 'default';
  }
  return `named:${exp.name || exp.local || 'anonymous'}`;
}
```

## Related

* REG-232 (introduced the duplication)
