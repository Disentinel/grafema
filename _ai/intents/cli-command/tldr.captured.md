<!-- captured-at: 2026-04-27 -->
<!-- fixture: this repo (Grafema itself) -->

## compact-overview-of-a-single-command-file
```
/Users/vadimr/grafema-worker-1/packages/cli/src/commands/doctor.ts  (packages/cli/src/commands/doctor.ts:1) {
  o- depends on /Users/vadimr/grafema-worker-1/packages/cli/src/commands/doctor/output.ts, /Users/vadimr/grafema-worker-1/packages/cli/src/commands/doctor/types.ts, /Users/vadimr/grafema-worker-1/packages/cli/src/commands/doctor/checks.ts
  ...+3 more <obj>.option
  doctorCommand < assigned from <obj>.action  (packages/cli/src/commands/doctor.ts:34)
  action  (packages/cli/src/commands/doctor.ts:34) {
    < reads <obj>.addHelpText
  }
  ...+3 more property_access
  checkBinaries  (packages/cli/src/commands/doctor.ts:20) {
    o- imports from checkBinaries
  }
  ...+13 more import_bindings
  ./doctor/types.js  (packages/cli/src/commands/doctor.ts:32) {
    o- imports from /Users/vadimr/grafema-worker-1/packages/cli/src/commands/doctor/types.ts
  }
  ...+3 more imports
  [literal: '-j, --json', 'after', 'Show detailed diagnostics', '.', 'Project path', '-q, --quiet', 'doctor', '-p, --project <path>', 'Diagnose Grafema setup issues', 'Only show failures', '-v, --verbose', 'Output as JSON', <template>]
  <obj>.option  (packages/cli/src/commands/doctor.ts:34) {
    > receiver call <obj>.option
    > derived from option
    > passes 'Show detailed diagnostics', '-v, --verbose'
    > calls METHOD:option@<builtin>
  }
  <obj>.addHelpText  (packages/cli/src/commands/doctor.ts:34) {
    > receiver call <obj>.option
... (truncated, 39 more lines)
```
