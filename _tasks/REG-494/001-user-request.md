# REG-494: Add onProgress to enrichment plugins (batch 1)

## Source
Linear issue REG-494

## Request
Add `onProgress()` callback and consistent logging to 5 enrichment plugins:
- FunctionCallResolver
- CallbackCallResolver
- InstanceOfResolver
- MountPointResolver
- PrefixEvaluator

Pattern to follow from MethodCallResolver:
```ts
const { graph, onProgress } = context;
// ... collect items ...
logger.info('Found items to process', { count: items.length });
for (const item of items) {
  processed++;
  if (onProgress && processed % 50 === 0) {
    onProgress({ phase: 'enrichment', currentPlugin: 'PluginName', message: `Processing ${processed}/${items.length}`, totalFiles: items.length, processedFiles: processed });
  }
}
```

## Config
Single Agent (well-understood, mechanical, same pattern applied to 5 files)
