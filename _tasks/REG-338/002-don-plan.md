# REG-338: Rename RFDB to Rega Flow Database - Analysis & Plan

## Executive Summary

Rename RFDB branding to "Rega Flow Database" while maintaining technical backward compatibility and minimizing disruption to users. The renaming primarily affects documentation, user-facing text, and directory structure. Technical abbreviation RFDB will be retained in code (now stands for "Rega Flow Database").

## Current State Analysis

### Directory Structure
```
packages/
├── rfdb/                  # TypeScript client library
│   ├── package.json (@grafema/rfdb-client)
│   ├── ts/
│   └── README.md
└── rfdb-server/          # Rust server implementation
    ├── package.json (@grafema/rfdb)
    ├── Cargo.toml (crate name: "rfdb")
    ├── src/
    ├── bin/rfdb-server
    ├── README.md
    └── prebuilt/         # Platform-specific binaries
```

### Package Metadata
- `@grafema/rfdb`: "High-performance disk-backed graph database server" (npm package for server)
- `@grafema/rfdb-client`: "TypeScript client for RFDB graph database" (npm package for client)
- Rust crate: `rfdb` v0.1.0
- Binary: `rfdb-server` (Node.js wrapper + native binary)

### Files & Mentions
- **213 files** contain "rfdb", "RFDB", or "rfdb-server" references
- Code references: ~50 files (imports, type names, paths)
- Documentation: ~20 files (README, docs, comments)
- Infrastructure: ~10 files (GitHub Actions, scripts, configs)
- Test fixtures: ~133 files (test directory patterns)

## Scope & Decisions

### Directory Rename: `packages/rfdb-server` → `packages/rega-flow`

**Rationale:**
- Clearer branding in repository structure
- Aligns with "Rega Flow Database" naming
- Most imports are internal (npm packages), not file paths
- Reduces cognitive load when exploring codebase

**Impact:**
- Update all path references in code (about 30 locations)
- Update GitHub Actions workflow paths
- Update post-install scripts
- Update CLI help text and error messages

### Package Names: KEEP as-is

**Decision:** Keep `@grafema/rfdb` and `@grafema/rfdb-client`

**Rationale:**
- Changing npm package name requires republish and breaks all existing projects
- RFDB abbreviation is now "Rega Flow Database" - meaning preserved
- Can update descriptions in package.json to clarify full name
- Technical name in code doesn't need to change

### Binary Name: KEEP `rfdb-server`

**Decision:** Keep binary named `rfdb-server`

**Rationale:**
- Binary is internal implementation detail
- Changing would require updating user installations and scripts
- Backwards compatible - users won't need to change anything
- RFDB = Rega Flow Database, so name still makes sense

### Class & Type Names: UPDATE descriptions, KEEP abbreviations

**Classes to keep:**
- `RFDBServerBackend` (usage: ~20 files)
- `RFDBClient` (usage: ~15 files)
- Comments can clarify: "RFDB = Rega Flow Database"

**Rationale:**
- These are internal APIs
- Changing would require refactoring ~35+ code locations
- Abbreviation still valid with new meaning
- Users accessing via npm types see descriptions in docs

### User-Facing Text: UPDATE all

**Update in:**
- README.md files (3 locations: root, packages/rfdb-server/, packages/rfdb/)
- CLI help text (server command)
- Error messages
- Comments that explain the purpose
- Documentation files

## What Needs to Change

### 1. Directory Rename (1 directory)
```
packages/rfdb-server/  →  packages/rega-flow/
```
- Update internal path references (~30 files)
- Update GitHub Actions workflow
- Update download script
- Update postinstall script

### 2. Package Metadata (2 files)

**packages/rega-flow/package.json:**
- Description: Change to "Rega Flow Database server - high-performance disk-backed graph engine"
- Keywords: Consider adding "rega-flow" for discoverability

**packages/rfdb/package.json:**
- Description: "TypeScript client for Rega Flow Database"
- Keywords: Consider adding "rega-flow"

### 3. Documentation (3-5 files)

**packages/rega-flow/README.md:**
- Change title from `# @grafema/rfdb` to `# Rega Flow Database (@grafema/rfdb)`
- Update all references in text from "RFDB" → "Rega Flow Database" or "Rega Flow"
- Update installation instructions
- Update usage examples

**packages/rfdb/README.md:**
- Change title to "Rega Flow Database Client"
- Update references and examples

**Root README.md:**
- Add mention of "Rega Flow Database" as full name for RFDB

### 4. User-Facing Text (multiple files)

**CLI Help Text** (packages/cli/src/commands/server.ts):
- Update description: "Manage Rega Flow Database server lifecycle"
- Update error messages mentioning RFDB
- Update console output text

**CLI Doctor Command** (packages/cli/src/commands/doctor/checks.ts):
- Update check descriptions mentioning RFDB server
- Update success/failure messages

**CLI Other Commands**:
- Review all commands for RFDB mentions
- Update descriptions and help text

**Error Messages** (packages/core/src/storage/backends/RFDBServerBackend.ts):
- Update error messages to say "Rega Flow Database server"

### 5. Comments & Internal Docs

**Locations:**
- `packages/rega-flow/src/lib.rs` - Add module documentation
- `packages/rega-flow/src/bin/rfdb_server.rs` - Update comments
- `packages/core/src/utils/findRfdbBinary.ts` - Update description comments
- `packages/core/src/storage/backends/RFDBServerBackend.ts` - Update class documentation
- `packages/rfdb/ts/client.ts` - Update class documentation

**Pattern:** Change "RFDB" → "Rega Flow Database" in doc comments, but keep class names unchanged

### 6. Infrastructure (4 files)

**.github/workflows/build-binaries.yml:**
- Update job name: "Build Rega Flow Database Binaries" or just keep as is (internal)
- Update comments to explain RFDB = Rega Flow Database

**scripts/download-rfdb-binaries.sh:**
- Keep script name as-is for backwards compatibility
- Update comments: "Download Rega Flow Database binaries"

**scripts/publish.sh** (if it exists):
- Check and update any RFDB references

**Cargo.toml (packages/rega-flow/Cargo.toml):**
- Update description: "High-performance disk-backed graph engine for semantic code analysis (Rega Flow Database)"
- Update package name stays as "rfdb" (Rust crate)

### 7. Comments in Code

**Search and replace pattern:**
- "RFDB" in comments → "Rega Flow Database" or keep as-is with clarification
- "rfdb-server" in comments → "Rega Flow Database server" (clarification)
- Add doc-string clarifications where appropriate

## Implementation Order

### Phase 1: Directory & Paths (Low Risk)
1. Rename `packages/rfdb-server` → `packages/rega-flow`
2. Update all path references in:
   - CLI commands (packages/cli/src/commands/*.ts)
   - Core module (packages/core/src/Orchestrator.ts, findRfdbBinary.ts, RustAnalyzer.ts)
   - GitHub Actions workflow
   - Download script
   - Postinstall script

### Phase 2: Documentation (Medium Risk)
3. Update README files:
   - packages/rega-flow/README.md
   - packages/rfdb/README.md
   - Root README.md
4. Update comments in code (low risk, mechanical change)

### Phase 3: User-Facing Text (High Risk - affects UX)
5. Update CLI help text and error messages
6. Update package.json descriptions
7. Update error messages in backend
8. Run manual testing of CLI commands

### Phase 4: Verification & Testing
9. Update tests that check error messages
10. Update test descriptions
11. Run full test suite
12. Manual testing of:
    - `grafema server start/stop/status`
    - `grafema doctor`
    - Error messages when server fails
    - CLI help text

## Breaking Changes

### None for Users
- File extensions `.rfdb` stay the same
- Socket path `rfdb.sock` stays the same
- Binary name `rfdb-server` stays the same
- Package names stay the same
- No API changes

### For Developers
- Path references change (refactoring needed)
- Some import paths updated

## Git Strategy

**Branch:** `task/REG-338-rename-rfdb-to-rega-flow`

**Commit structure:**
1. Commit 1: Rename directory `packages/rfdb-server` → `packages/rega-flow`
2. Commit 2: Update all path references in code
3. Commit 3: Update documentation (README files)
4. Commit 4: Update CLI help text and user-facing messages
5. Commit 5: Update package.json descriptions
6. Commit 6: Update comments and documentation strings
7. Commit 7: Run tests and verify everything works

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Path references broken | Systematic grep/replace with verification |
| Tests fail due to path changes | Update test fixtures if any reference the path |
| Users confused by mixed naming | Keep "RFDB" in technical names, use "Rega Flow" in docs |
| Binary build breaks | Verify Cargo.toml paths are correct |
| CLI help text unclear | Have someone read help text before merging |

## Validation Checklist

- [ ] `packages/rega-flow` directory renamed and builds successfully
- [ ] All path references updated (no broken imports)
- [ ] `grafema server start/stop/status` works
- [ ] `grafema doctor` works and shows updated text
- [ ] CLI help text reads naturally
- [ ] README files are clear about "Rega Flow Database"
- [ ] All tests pass
- [ ] npm package descriptions updated
- [ ] No reference to old directory path in code

## Not Changing (Intentional)

- `@grafema/rfdb` package name (backwards compatibility)
- `@grafema/rfdb-client` package name (backwards compatibility)
- `rfdb-server` binary name (backwards compatible)
- `.rfdb` file extension (backwards compatible)
- `rfdb.sock` socket path (backwards compatible)
- `rfdb_server` Rust binary name (internal)
- Class names `RFDBServerBackend`, `RFDBClient` (internal APIs)
- Crate name `rfdb` in Cargo.toml (Rust ecosystem standard)

## Estimated Scope

- **Files to change:** ~40-50 files (paths, docs, comments, help text)
- **Time estimate:** 2-3 hours
- **Risk level:** LOW (no API changes, backwards compatible)
- **Testing effort:** MEDIUM (verify CLI commands, error messages)

## Next Steps

1. Get approval for:
   - Directory rename strategy
   - Keeping package names unchanged
   - Keeping binary name unchanged
2. Create implementation task (Joel)
3. Execute Phase 1-4 systematically
4. Manual testing before merge
