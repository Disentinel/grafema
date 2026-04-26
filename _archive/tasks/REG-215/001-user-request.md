# REG-215: grafema init: Improve error message for non-JS projects

## Problem

```bash
cd rust-project && grafema init
# → ✗ No package.json found
```

Message is not helpful — user doesn't know Grafema is JS/TS only.

## Expected Behavior

Clear error message:

```
✗ Grafema currently supports JavaScript/TypeScript projects only.
  No package.json found in /path/to/project

  Supported: Node.js, React, Express, Next.js, Vue, Angular, etc.
  Coming soon: Python, Go, Rust

  If this IS a JS/TS project, create package.json first:
    npm init -y
```

## Acceptance Criteria

- [ ] Error message explains JS/TS requirement
- [ ] Lists supported frameworks
- [ ] Suggests next steps
- [ ] Tests pass
