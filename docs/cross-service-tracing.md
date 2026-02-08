# Cross-Service Tracing

Grafema's killer feature: trace data flow from frontend HTTP requests to backend API routes and back.

## Overview

**Cross-service tracing** connects frontend code that makes HTTP requests to the backend code that handles those requests. This allows you to:

- Find which backend route handles a specific `fetch()` call
- Trace the response data from backend `res.json()` to frontend variables
- Understand the full data flow across service boundaries
- Navigate directly from request to handler in VS Code

Traditional code analysis stops at service boundaries. Grafema bridges that gap by understanding that `fetch('/api/users')` in your React component connects to `router.get('/api/users')` in your Express server.

## How It Works

Cross-service tracing involves three components working together:

### 1. Frontend Analysis (FetchAnalyzer)

The `FetchAnalyzer` plugin detects HTTP requests in frontend code and creates `http:request` nodes.

**Detected patterns:**

```javascript
// Native fetch
const response = await fetch('/api/users');
const data = await response.json();

// Axios
const { data } = await axios.get('/api/users');
await axios.post('/api/users', payload);

// Custom wrappers (authFetch, apiFetch, etc.)
const data = await authFetch('/api/users');
```

Each detected request becomes an `http:request` node with:
- `method`: HTTP method (GET, POST, etc.)
- `url`: The request URL (or `dynamic` if computed at runtime)
- `library`: Which library made the request (fetch, axios, custom name)
- `responseDataNode`: Link to the `response.json()` call node (for data flow)

### 2. Backend Analysis (ExpressRouteAnalyzer)

The `ExpressRouteAnalyzer` plugin detects route handlers and creates `http:route` nodes.

**Detected patterns:**

```javascript
// Express Router
router.get('/users', (req, res) => { ... });
router.post('/users/:id', middleware, handler);

// Express App
app.get('/status', (req, res) => { ... });
app.use('/api', apiRouter);
```

Each detected route becomes an `http:route` node with:
- `method`: HTTP method (GET, POST, etc.)
- `path`: The route path (e.g., `/users/:id`)
- `fullPath`: Complete path including mount prefixes (e.g., `/api/users/:id`)

### 3. Connection Enrichment (HTTPConnectionEnricher)

The `HTTPConnectionEnricher` plugin runs during the enrichment phase and creates edges connecting requests to routes.

**Created edges:**

- `INTERACTS_WITH`: Links `http:request` to matching `http:route`
- `HTTP_RECEIVES`: Links frontend response data node to backend response data node

**URL matching:**

| Frontend URL | Backend Route | Match Type |
|--------------|---------------|------------|
| `/api/users` | `/api/users` | Exact |
| `/api/users/${id}` | `/api/users/:id` | Parametric |
| `/api/users/123` | `/api/users/:id` | Parametric |

## Example Workflow

Consider a typical full-stack application:

**Frontend (client.js):**
```javascript
export async function getUsers() {
  const response = await fetch('/api/users');
  const data = await response.json();
  return data;
}
```

**Backend (routes.js):**
```javascript
router.get('/users', (req, res) => {
  res.json({ users: [], total: 0 });
});
```

**Main app (app.js):**
```javascript
import userRoutes from './routes.js';
app.use('/api', userRoutes);
```

### Analyzing the Connection

After running `npx @grafema/cli analyze`:

```bash
# Find HTTP requests
npx @grafema/cli query "http:request"
# Shows: GET /api/users at client.js:3

# Find HTTP routes
npx @grafema/cli query "http:route"
# Shows: GET /users at routes.js:1

# Trace from a route's response
npx @grafema/cli trace --from-route "GET /users"
# Shows what data the route returns
```

### Querying with Datalog

```bash
# Find all frontend-backend connections
npx @grafema/cli query --raw 'edge(Req, Route, "INTERACTS_WITH"), type(Req, "http:request")'

# Find routes that receive POST requests
npx @grafema/cli query --raw 'type(R, "http:route"), attr(R, "method", "POST")'

# Find requests with dynamic URLs (not fully traceable)
npx @grafema/cli query --raw 'type(R, "http:request"), attr(R, "url", "dynamic")'
```

### Using VS Code Extension

With the Grafema VS Code extension:

1. Open a file with a `fetch()` call
2. Click on the Grafema lens above the call
3. Select "Go to Handler" to jump directly to the backend route
4. Or select "Trace Response Data" to see where the response data comes from

The extension uses the same graph connections that the CLI queries.

## Supported Patterns

### Frontend Libraries

| Library | Patterns |
|---------|----------|
| **fetch** | `fetch(url)`, `fetch(url, options)`, `await fetch(...)` |
| **axios** | `axios.get(url)`, `axios.post(url, data)`, `axios({ url, method, ... })` |
| **Custom wrappers** | Any function with "fetch" or "request" in name (e.g., `authFetch`, `apiRequest`) |

### Backend Frameworks

| Framework | Patterns |
|-----------|----------|
| **Express** | `router.get()`, `router.post()`, `app.use()`, mounted routers |
| **Fastify** | Planned for future release |

### URL Patterns

| Pattern | Example | Notes |
|---------|---------|-------|
| Static path | `/api/users` | Exact match |
| Express params | `/users/:id` | Matches template literals |
| Template literal | `/users/${userId}` | Normalized to `:param` |
| Mounted routes | `/api` + `/users` = `/api/users` | MountPointResolver handles this |

## Limitations

### Dynamic URLs Not Fully Resolved

URLs constructed at runtime cannot be statically traced:

```javascript
// This creates an http:request with url: "dynamic"
const endpoint = getEndpoint(); // computed at runtime
await fetch(endpoint);
```

These requests appear in the graph but won't connect to specific routes.

### External APIs Not Traced Internally

Requests to external services create `EXTERNAL` nodes but don't trace inside:

```javascript
await fetch('https://api.stripe.com/charges');
// Creates EXTERNAL#api.stripe.com node, no internal tracing
```

### Multiple Match Candidates

When multiple routes could match (e.g., overlapping patterns), Grafema picks the first match. This may not always be the actual runtime route.

### Response Data Tracking Scope

The `responseDataNode` tracking works for the common pattern of:
```javascript
const response = await fetch(url);
const data = await response.json();
```

More complex patterns (destructuring, intermediate processing) may not connect properly.

## Troubleshooting

### "Why isn't my route connected?"

**1. Check mount prefixes**

If your routes are mounted under a prefix:
```javascript
app.use('/api', userRouter);
```

The `MountPointResolver` needs to detect this. Verify the route has `fullPath` set:

```bash
npx @grafema/cli query --type http:route
# Check that fullPath includes /api/users, not just /users
```

**2. Check URL patterns match**

Template literals must use the `${...}` syntax, not string concatenation:

```javascript
// Good - normalized to /users/:id
fetch(`/users/${id}`)

// Bad - becomes "dynamic"
fetch('/users/' + id)
```

**3. Check method matches**

The HTTP method must match exactly:

```javascript
// Frontend: GET
fetch('/api/users');

// Backend: must be GET, not POST
router.get('/users', ...);  // matches
router.post('/users', ...); // does NOT match
```

### "Why is my URL showing as 'dynamic'?"

The URL couldn't be statically determined. Common causes:

- URL comes from a variable assigned elsewhere
- URL is computed with function calls
- URL uses string concatenation instead of template literals

### "How do I check what connections were made?"

Run analysis with debug output:

```bash
npx @grafema/cli analyze --verbose
# Look for "HTTPConnectionEnricher" logs showing connections found
```

Or query the INTERACTS_WITH edges:

```bash
npx @grafema/cli query --raw 'edge(_, _, "INTERACTS_WITH")'
```

## Configuration

Cross-service tracing requires multi-service configuration in `grafema.config.yaml`:

```yaml
services:
  - name: backend
    path: ./server
    entryPoint: app.js

  - name: frontend
    path: ./client
    entryPoint: index.js

plugins:
  - JSModuleIndexer
  - JSASTAnalyzer
  - FetchAnalyzer
  - ExpressRouteAnalyzer
  - ExpressResponseAnalyzer
  - MountPointResolver      # Resolves mount prefixes
  - HTTPConnectionEnricher  # Creates cross-service edges
```

Both services must be analyzed together for the enricher to create connections.

## Related Documentation

- [Configuration](./configuration.md) - Full configuration reference
- [Datalog Cheat Sheet](./datalog-cheat-sheet.md) - Query patterns
- [Plugin Development](./plugin-development.md) - Creating custom analyzers
