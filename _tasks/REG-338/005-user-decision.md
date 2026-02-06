# User Decision: REG-338

## Decision Date: 2026-02-06

## User's Clarification

> Расширение файлов и название пакетов должно быть коротким. `.rfdb` - гуд, `grafema/rfdb` - понятно что речь о КАКОЙ ТО базе данных, `grafema/rega` - непонятно что такое. Т.е. Rega Flow хорошо для полной речи и сокращённого "Закинь в регу" а вот для идентификации rfdb как по мне выглядит понятнее для новых пользователей.

## Resolved Strategy

| Context | Use |
|---------|-----|
| Full name (docs, speech) | "Rega Flow Database" |
| Technical identifiers | `rfdb` (packages, files, classes) |
| Colloquial | "Rega" / "закинь в регу" |

## What This Means

**NOT a rebrand.** This is a documentation update:

1. **RFDB** now officially stands for **"Rega Flow Database"**
2. All technical names stay as `rfdb` (clearer for new users than `rega`)
3. Documentation explains the full name and meaning
4. No breaking changes

## Scope (Revised)

### Change
- [ ] README files: explain "RFDB = Rega Flow Database"
- [ ] Package descriptions: mention full name
- [ ] CLI help: can say "Rega Flow Database server" where appropriate
- [ ] Add pronunciation guide / colloquial usage note

### Keep As-Is
- Directory: `packages/rfdb-server/` (NOT renaming to `rega-flow`)
- Package names: `@grafema/rfdb`, `@grafema/rfdb-client`
- Binary: `rfdb-server`
- File extension: `.rfdb`
- Socket: `rfdb.sock`
- Class names: `RFDBServerBackend`, `RFDBClient`
- Rust crate: `rfdb`

## Estimated Effort

~30 minutes. Just documentation updates, no code changes.
