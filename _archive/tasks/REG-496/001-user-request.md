# REG-496: Add onProgress to analysis plugins

**Source:** Linear issue REG-496
**Config:** Single Agent (repetitive pattern application, well-understood)

## Request

Add `onProgress()` callback to analysis plugins that iterate over modules:

- ExpressRouteAnalyzer
- ServiceLayerAnalyzer
- ExpressResponseAnalyzer
- FetchAnalyzer
- DatabaseAnalyzer
- SocketAnalyzer / SocketIOAnalyzer
- NestJSRouteAnalyzer

Pattern: `Processing module N/M`. Reference: JSASTAnalyzer, enrichment plugins (REG-494).
