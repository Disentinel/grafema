# REG-354: Library Coverage Report Implementation

## Summary

Added library call tracking and coverage reporting to MethodCallResolver.

## Changes

### `packages/core/src/plugins/enrichment/MethodCallResolver.ts`

1. **Added `LIBRARY_SEMANTIC_GROUPS` mapping**
   - Maps library namespaces (axios, socket, jwt, etc.) to semantic categories
   - Each entry includes: semantic type, suggested plugin, description
   - Categories: http-client, http-response, websocket, database, auth, validation, logging, telegram-bot

2. **Added `LibraryCallStats` interface**
   - Tracks: object name, methods map, total calls, semantic info

3. **Modified `execute()` method**
   - Now tracks external method calls instead of just skipping them
   - Collects stats per library namespace
   - Returns stats in plugin summary
   - Logs library coverage report

4. **Added helper methods**
   - `isBuiltInObject()` - checks if object is JS built-in (not library)
   - `trackLibraryCall()` - records library method call stats

### `packages/core/src/index.ts`

- Export `LIBRARY_SEMANTIC_GROUPS` and `LibraryCallStats` type

## Output Example

```json
{
  "libraries": [
    {"library": "res", "calls": 189, "semantic": "http-response", "suggestion": "ExpressResponseAnalyzer"},
    {"library": "socket", "calls": 40, "semantic": "websocket", "suggestion": "SocketIOAnalyzer"},
    {"library": "bot", "calls": 31, "semantic": "telegram-bot", "suggestion": "TelegramBotAnalyzer"},
    {"library": "jwt", "calls": 14, "semantic": "auth", "suggestion": "AuthAnalyzer"},
    {"library": "axios", "calls": 2, "semantic": "http-client", "suggestion": "FetchAnalyzer"}
  ]
}
```

## Next Steps

1. Add formatted CLI output (not just JSON logs)
2. Add `--library-coverage` flag for detailed report
3. Suggest missing plugins based on coverage gaps
