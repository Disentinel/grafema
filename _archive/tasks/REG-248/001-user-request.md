# REG-248: HTTPConnectionEnricher doesn't account for router mount prefixes

## Problem

HTTPConnectionEnricher fails to create INTERACTS_WITH edges between frontend requests and backend routes when routers are mounted with prefixes.

## Observed Behavior

On Jammers project:

* Frontend requests use `/api/invitations/received`
* Backend routes are registered as `/invitations/received` (without `/api` prefix)
* Express router is mounted at `/api`, but HTTPConnectionEnricher doesn't account for this
* **Result:** 64 routes, 131 requests, 0 connections

## Expected Behavior

HTTPConnectionEnricher should resolve mount prefixes when matching requests to routes. When a router is mounted at `/api` and registers route `/invitations/received`, it should match requests to `/api/invitations/received`.

## Impact

This is a critical gap for the core Grafema value proposition. Without HTTP connections, the graph can't show frontend-to-backend dependencies — one of the primary use cases for understanding full-stack applications.

## Acceptance Criteria

- [ ] HTTPConnectionEnricher accounts for router mount prefixes
- [ ] INTERACTS_WITH edges are created between matching requests and routes
- [ ] Test coverage for mounted router scenarios
