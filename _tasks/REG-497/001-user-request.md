# REG-497: Add onProgress to validation plugins

## Request

Add `onProgress()` callback to validation plugins. Most have basic `logger.info('Starting...')` but no periodic progress.

### Validators to update:
- CallResolverValidator
- EvalBanValidator — has timing debug logs, but no onProgress
- SQLInjectionValidator
- AwaitInLoopValidator
- ShadowingDetector
- GraphConnectivityValidator
- DataFlowValidator
- TypeScriptDeadCodeValidator
- UnconnectedRouteValidator
- PackageCoverageValidator

### Reference
BrokenImportValidator already has good onProgress support — use it as a reference.

### Notes
Validators are usually faster than enrichers, so onProgress interval can be larger (every 200-500 items).
