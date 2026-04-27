---
whenToUse: |
  Deep-dive into a single node. Returns operator-shorthand DSL with
  the node's relationships: imports, exports, calls, throws, reads,
  writes. Use after `tldr` (file overview) or `who` (caller list)
  zooms you in on a candidate node — `describe` is the next click.
seeAlso:
  - cli:command:tldr
  - cli:command:get
  - mcp:tool:describe
gotchas:
  - Pass a semantic ID (e.g. `cli:command:'analyze'@packages/cli/...`)
    for precision. Bare names work via fuzzy resolution but may pick
    a sibling.
---

## Describe a single node

```sh
grafema describe handleRequest
```

```
{captured: describe-fn}
```

## With deeper expansion

```sh
grafema describe handleRequest --depth 2
```
