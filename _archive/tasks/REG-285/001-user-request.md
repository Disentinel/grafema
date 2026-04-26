# REG-285: AST: Track TryStatement (TRY_BLOCK, CATCH_BLOCK, FINALLY_BLOCK)

## Gap

`TryStatement` AST node is completely ignored.

## Example

```javascript
try {
  await riskyOperation();
} catch (error) {
  logger.error(error);
  throw new AppError('Failed', { cause: error });
} finally {
  cleanup();
}
```

## User Impact

- Can't trace error handling paths
- Can't identify unhandled exceptions
- Can't analyze error propagation patterns

## Acceptance Criteria

- [ ] TRY_BLOCK node for try statement
- [ ] CATCH_BLOCK node for catch clause
- [ ] FINALLY_BLOCK node for finally clause
- [ ] DECLARES edge for catch parameter
- [ ] Support optional catch binding
