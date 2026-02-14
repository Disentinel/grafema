# REG-379: NestJS Route Analyzer (Controller/Get/Post decorators)

## Goal

Provide first-class NestJS HTTP route detection (controllers + method decorators).

## Acceptance Criteria

* Creates `http:route` nodes for `@Controller` + `@Get/@Post/...` patterns.
* Resolves base path from `@Controller('path')` and method path from `@Get('sub')` (including empty `@Get()`), including array form `@Controller(['a','b'])`).
* Creates `http:handler` nodes and `HANDLED_BY` edges to method functions.
* Works on ToolJet server controllers (NestJS) and produces non-zero routes.

## Context

ToolJet backend is NestJS. Built-in ExpressRouteAnalyzer produces 0 routes. We built a local custom plugin scanning `@Controller` and `@Get/@Post/...` to create `http:route` and `http:handler` nodes and link responses.

Reference plugin (local sample):
* `/Users/vadim/grafema-fixtures/ToolJet/.grafema/plugins/tooljet-nest-http.mjs`

Expected this functionality to be in core for onboarding NestJS projects.
