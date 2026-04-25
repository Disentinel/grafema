# REG-256: Config-based cross-service routing rules for HTTPConnectionEnricher

## Problem

HTTPConnectionEnricher can't match frontend requests to backend routes when URL prefixes differ due to infrastructure-level routing (nginx, API gateway).

Example:
- Frontend sends `GET /api/invitations/received`
- Nginx proxies `/api/*` to backend
- Backend route is `GET /invitations/received`

No INTERACTS_WITH edge created because paths don't match.

## Proposed Solution

Add `routing` section to `.grafema/config.yaml` for declaring cross-service URL mappings:

```yaml
services:
  - name: backend
    path: apps/backend
    entrypoint: src/index.ts
  - name: auth-service
    path: apps/auth
    entrypoint: src/index.ts
  - name: frontend
    path: apps/frontend
    entrypoint: src/main.tsx
  - name: admin-panel
    path: apps/admin
    entrypoint: src/main.tsx

# Routing rules (describes what nginx/gateway does)
routing:
  - from: frontend
    to: backend
    stripPrefix: /api        # /api/users → /users
  - from: frontend
    to: auth-service
    stripPrefix: /auth       # /auth/login → /login
  - from: admin-panel
    to: backend
    stripPrefix: /backend    # Different prefix for admin panel
```

## Covers Use Cases

1. **Different prefixes → different backends**: separate rules with different `to`
2. **Same backend, different prefixes from different frontends**: separate rules with different `from` and `stripPrefix`

## Implementation

1. Parse `routing` config in ConfigLoader
2. Pass routing rules to HTTPConnectionEnricher
3. When matching request to route, apply stripPrefix transformation based on which services the nodes belong to

## Related

- REG-253 (Express router mount points - application-level)
- This issue covers infrastructure-level routing (nginx/gateway)
