# Donald Run — REG-378

## Execution
Unable to execute `grafema analyze` in this environment (Node.js not available).

## Expected Validation Steps
- `pnpm --filter @grafema/cli test`
- ToolJet fixture:
  - `npx @grafema/cli init`
  - `npx @grafema/cli analyze --auto-start`
  - Expect clean exit without manual interrupt.
