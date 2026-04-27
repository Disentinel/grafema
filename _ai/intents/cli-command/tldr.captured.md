<!-- captured-at: 2026-04-27 -->
<!-- fixture: this repo (Grafema itself) -->

## compact-overview-of-a-single-command-file
```
/Users/vadimr/grafema-worker-1/packages/cli/src/commands/doctor.ts  (packages/cli/src/commands/doctor.ts:1) {
  ...+3 more <obj>.option
  doctorCommand < assigned from <obj>.action  (packages/cli/src/commands/doctor.ts:34)
  <obj>.option  (packages/cli/src/commands/doctor.ts:34) {
    > passes '-v, --verbose', 'Show detailed diagnostics'
    > derived from option
    > receiver call <obj>.option
  }
  ...+3 more calls
  action  (packages/cli/src/commands/doctor.ts:34) {
    < reads <obj>.addHelpText
  }
  ...+3 more property_access
  [import: commander, path, ./doctor/checks.js, ./doctor/output.js, ./doctor/types.js]
  [import_binding: Command, resolve, checkBinaries, checkGrafemaInitialized, checkServerStatus, checkConfigValidity, checkEntrypoints, checkDatabaseExists, checkGraphStats, checkConnectivity, checkFreshness, checkVersions, formatReport, buildJsonReport, DoctorOptions, DoctorCheckResult]
  [literal: 'after', <template>, '-v, --verbose', 'Show detailed diagnostics', '-q, --quiet', 'Only show failures', '-j, --json', 'Output as JSON', '-p, --project <path>', 'Project path', '.', 'Diagnose Grafema setup issues', 'doctor']
  named  (packages/cli/src/commands/doctor.ts:34) {
    o- exports doctorCommand
  }
  λ → <obj>.action  (packages/cli/src/commands/doctor.ts:47) {
    < receives options
    > awaits checkBinaries, checkGrafemaInitialized, checkConfigValidity, checkEntrypoints, checkServerStatus, checkDatabaseExists, checkGraphStats, checkConnectivity, checkFreshness, checkVersions
  }
  Command  (packages/cli/src/commands/doctor.ts:34) {
    > passes 'doctor'
... (truncated, 11 more lines)
```
