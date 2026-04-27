<!-- captured-at: 2026-04-27 -->
<!-- fixture: this repo (Grafema itself) -->

## doctor-tldr

```
named  (packages/cli/src/commands/doctor.ts:34) {
  o- exports doctorCommand
}
Command  (packages/cli/src/commands/doctor.ts:34) {
  > passes 'doctor'
  > calls Command
}
<obj>.action  (packages/cli/src/commands/doctor.ts:34) {
  > derived from action
  > passes λ → <obj>.action
  > receiver call <obj>.addHelpText
  ~>> exposes cli:command:'doctor'
}
commander  (packages/cli/src/commands/doctor.ts:17)
```
