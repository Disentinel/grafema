# REG-226: ExternalCallResolver: Handle external package and built-in function calls

## Summary

Create enrichment plugin to handle external package calls and built-in function calls.

## Background

After FunctionCallResolver runs, remaining unresolved calls fall into three categories:

1. External package calls (lodash, react, etc.)
2. JavaScript built-in calls (parseInt, setTimeout)
3. Truly unresolvable calls (dynamic, aliased)

See REG-206 design doc for full analysis.

## Implementation

ExternalCallResolver should:

1. Run after FunctionCallResolver (priority 70)
2. For unresolved CALL_SITE nodes:
   * Check if call name matches an IMPORT from external module
   * If yes: create CALLS edge to EXTERNAL_MODULE with `exportedName` metadata
   * If no: check if name is JavaScript built-in
   * If built-in: add `resolutionType='builtin'` metadata, no edge
   * Otherwise: add `resolutionType='unresolved'` metadata with reason

## Built-ins List

```javascript
// Global functions
'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'eval',
'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent'

// Timers
'setTimeout', 'setInterval', 'setImmediate',
'clearTimeout', 'clearInterval', 'clearImmediate'

// Environment globals (from Linus review)
'globalThis', 'window', 'document', 'global'

// CommonJS
'require'
```

## Acceptance Criteria

- [ ] External package calls link to EXTERNAL_MODULE nodes
- [ ] Edge metadata includes `exportedName`
- [ ] Built-in calls marked with metadata, no edge created
- [ ] Unresolved calls marked with reason (`dynamic` | `alias` | `unknown`)
- [ ] Validator treats built-ins and external calls as resolved

## Dependencies

* REG-225 (FunctionCallResolver) should run first - **DONE**
* REG-206 (Design doc) - **DONE**

## Blocks

* REG-227 (Update CallResolverValidator for new resolution types)
