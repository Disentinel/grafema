# REG-348: VS Code: Add setting for rfdb-server binary path

## Request

Add VS Code setting `grafema.rfdbServerPath` to allow users to specify custom binary path.

## Current workaround

Extension checks:

1. Shared utility (env var, npm package, ~/.local/bin)
2. Hardcoded dev paths (`~/grafema`, `/Users/vadimr/grafema`, `/home/vadimr/grafema`)

## Implementation

Add to package.json contributes.configuration:

```json
"grafema.rfdbServerPath": {
  "type": "string",
  "default": "",
  "description": "Path to rfdb-server binary. If empty, auto-detect."
}
```

Then read this setting in `findServerBinary()` and pass to `findRfdbBinary({ explicitPath })`.
