## Dijkstra Plan Verification — RFD-41

**Verdict:** APPROVE with two noted gaps (non-blocking, but must be addressed in implementation)

**Completeness tables:** 4 tables built for 4 rules

---

### Table 1: sed pattern — which Cargo.toml lines match `^version = "..."`?

The sed pattern proposed: `'s/^version = "[0-9]*\.[0-9]*\.[0-9]*.*"$/version = "'"$NEW_VERSION"'"/'`

Read the actual file at `/Users/vadimr/grafema-worker-1/packages/rfdb-server/Cargo.toml`.

| Line | Content | Starts line with `version =`? | Matches `^version = "..."` ? |
|------|---------|-------------------------------|-------------------------------|
| 3 | `version = "0.1.0"` | YES | YES — correct, this is the target |
| 14 | `memmap2 = "0.9"` | NO | NO |
| 17 | `blake3 = "1.5"` | NO | NO |
| 29 | `serde = { version = "1.0", features = ["derive"] }` | NO (`serde =` starts line) | NO — `^version` does not match |
| 35 | `tokio = { version = "1.38", features = ["full"] }` | NO (`tokio =` starts line) | NO |
| 52 | `napi = { version = "2.16", optional = true, ... }` | NO | NO |
| 53 | `napi-derive = { version = "2.16", optional = true }` | NO | NO |
| 56 | `syn = { version = "2", features = [...] }` | NO | NO |
| 58 | `proc-macro2 = { version = "1", features = [...] }` | NO | NO |
| 66 | `criterion = { version = "0.5", features = [...] }` | NO | NO |

**Verdict for Table 1:** Don's claim holds. In the actual Cargo.toml, ALL dependency version references are written as inline table values (`depname = { version = "..." }`), never as bare `version = "..."` at the start of a line. The `^` anchor is sufficient protection against false matches for this file.

**One theoretical risk acknowledged:** If the Cargo.toml ever gains a workspace `[workspace.package]` section with a bare `version = "x.y.z"` line, OR if a future dependency is written as a multi-line table where `version = "..."` starts a line, the pattern would match it as well. This is not a current problem but worth noting for future-proofing. The plan does not address this.

**Conclusion:** Safe for current file. Non-blocking.

---

### Table 2: Version format completeness — does the sed regex handle all produced formats?

The regex pattern side: `[0-9]*\.[0-9]*\.[0-9]*.*`
The replacement side uses literal `$NEW_VERSION` (shell-expanded before sed sees it).

All version formats the release script can produce, enumerated from reading `scripts/release.sh`:

| Source | Produced format | Example | Contains sed-special chars? | Pattern matches? |
|--------|----------------|---------|---------------------------|-----------------|
| `patch` bump | `MAJOR.MINOR.PATCH` | `0.2.12` | No | YES |
| `minor` bump | `MAJOR.MINOR.0` | `0.3.0` | No | YES |
| `major` bump | `MAJOR.0.0` | `1.0.0` | No | YES |
| `prerelease` from clean | `BASE-beta.1` | `0.2.4-beta.1` | `.` (metachar on pattern side only — not here) | YES — `.*` at end swallows `-beta.1` in old value |
| `prerelease` increment | `BASE-PREFIX.N` | `0.2.4-beta.2` | No | YES |
| Explicit version `0.2.5-beta` | Whatever user typed (validated by `^[0-9]+\.[0-9]+\.[0-9]+`) | `0.2.5-beta` | No | YES |
| Explicit version with `/` | e.g., `1.0/2` | BLOCKED by validation regex at line 159 | Would break sed delimiter | BLOCKED before reaching sed |

**The replacement side concern:** `$NEW_VERSION` is shell-expanded **before** sed sees it, and it becomes the literal replacement string. In sed with `/` as delimiter, a `/` in the replacement would break parsing. However: the validation at line 159 (`[[ "$VERSION_ARG" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]`) for explicit versions, and the computed versions for `patch/minor/major/prerelease`, all produce versions that only contain digits, `.`, and `-`. None of these are sed `/` delimiters.

**Conclusion:** All reachable version formats are safe. The `.*` in the regex correctly swallows any pre-release suffix in the old value. No false negative or false positive found.

---

### Table 3: CI extraction correctness

The CI check: `grep '^version = ' packages/rfdb-server/Cargo.toml | head -1 | sed 's/version = "\(.*\)"/\1/'`

| Input condition | grep output | head -1 output | sed output | CARGO_VERSION | CI result |
|----------------|-------------|----------------|------------|---------------|-----------|
| Normal: `version = "0.2.11"` | `version = "0.2.11"` | `version = "0.2.11"` | `0.2.11` | `0.2.11` | Correct |
| Cargo.toml missing | (empty, grep exit 1) | (empty) | (empty) | `""` | `"" != ROOT_VERSION` → exit 1 — CORRECT, CI blocks |
| No version line (corrupted) | (empty) | (empty) | (empty) | `""` | exit 1 — CORRECT |
| Line with leading spaces: `  version = "0.2.11"` | No match (grep `^version`) | (empty) | (empty) | `""` | exit 1 — **potentially confusing** but safe: drift detected |
| Trailing spaces: `version = "0.2.11"  ` | `version = "0.2.11"  ` | full line | sed captures `0.2.11  ` (with spaces after closing `"`) | `0.2.11  ` (with trailing spaces) | FAIL even when versions actually match |
| Extra `"` in version string (impossible in valid Cargo.toml) | Would match | Would extract | sed breaks | Corrupted value | exit 1 — safe |

**Gap found in Table 3:** The `grep '^version = '` pattern does NOT anchor to the closing `"`. The sed expression `s/version = "\(.*\)"/\1/` captures everything between the first `"` and the LAST `"` on the line. In the actual Cargo.toml the line is clean (`version = "0.1.0"` with no trailing content), so this is not a current issue. But: if someone writes `version = "0.2.11" # comment`, the sed would produce `0.2.11" # comment` (stopping at the last `"`). The result would be `0.2.11" # comment` without the final `"`, which is wrong.

**More importantly:** `grep` with `grep '^version = '` does not error out with non-zero exit code when it finds nothing on some implementations — it exits 1 when no match. In this CI snippet, the output is piped through `head -1` and `sed`. With `set -e` absent in this specific CI step (it's not set), the empty result would propagate. `CARGO_VERSION=""` → `"" != "$ROOT_VERSION"` → exit 1. The CI correctly blocks. No silent false pass.

**The `head -1` ordering concern:** Can the package `version` line fail to be first? In the actual Cargo.toml, the `[package]` section is at the top (lines 1-6) and `version = "0.1.0"` is line 3. There is no other line starting with `version = ` in the file. `head -1` is redundant but harmless.

**Conclusion for Table 3:** One real gap — trailing comment on version line would produce corrupt `CARGO_VERSION`. Low probability in practice (Cargo.toml doesn't conventionally use inline comments on the version line) but not impossible. Non-blocking, worth noting.

---

### Table 4: Edge cases enumeration

| Scenario | What happens | Safe? |
|----------|-------------|-------|
| `if [ -f "$CARGO_TOML" ]` — file missing | Guard triggers, skip with echo | YES — explicit guard |
| Second `version = "..."` line manually added to Cargo.toml | Both matched by `^version = "..."`, both replaced. Cargo.toml now has two correct version lines. Cargo parser uses first `[package]` version. | ACCEPTABLE — both lines get updated, no corruption |
| macOS `sed -i.bak` | BSD sed accepts this syntax: `-i.bak` means edit in-place, backup with `.bak` extension. `rm -f "$CARGO_TOML.bak"` cleans up. | YES — works on macOS. On GNU/Linux, `-i.bak` also works (GNU sed accepts it). Cross-platform safe. |
| Linux `sed -i.bak` | GNU sed: `-i[SUFFIX]` — `-i.bak` is treated as `-i` with suffix `.bak`. | YES — works correctly |
| `DRY_RUN=true` path | Script exits at line 227 (`exit 0`) BEFORE STEP 3. Cargo.toml update would be placed in STEP 3 (after npm version loop). **Dry-run does NOT show Cargo.toml in its "would update" list.** | GAP — dry-run output misleads user by omitting Cargo.toml |
| Release with `--skip-changelog` | Cargo.toml update is in STEP 3, changelog check in STEP 5. Orthogonal. | Safe — unaffected |
| `pnpm build` fails (STEP 4) | `git checkout -- .` rolls back all changes including Cargo.toml update. | CORRECT — Cargo.toml rollback handled by existing rollback logic |

---

### Precondition Verification

| Precondition | Status at point of use | Verified? |
|-------------|----------------------|-----------|
| `$NEW_VERSION` defined when Cargo.toml update runs | Computed in STEP 2 (lines 159-206), Cargo.toml update in STEP 3 (after line 246). Unconditional assignment. | YES |
| `$ROOT_DIR` defined when Cargo.toml update runs | Set at line 16, top of script. Unconditional. | YES |
| `$CARGO_TOML` file existence checked before sed | `if [ -f "$CARGO_TOML" ]` guard present in plan. | YES |
| `git add -A` (STEP 6, line 289) picks up Cargo.toml change | `git add -A` stages all changes in working tree. Cargo.toml update happens in STEP 3. Covered. | YES |
| CI job has `packages/rfdb-server/Cargo.toml` available | `actions/checkout@v4` checks out full repo. | YES |
| `grep` exit code does not abort CI step | `set -e` behavior: `grep` exits 1 when no matches. If CI step uses `set -e`, this aborts the step rather than setting `CARGO_VERSION=""`. | **PRECONDITION GAP — see below** |

**Precondition gap — `grep` exit code in CI:**

The proposed CI snippet does not explicitly disable `set -e` or use `grep ... || true`. In GitHub Actions, each `run` step uses `bash` without `set -e` by default unless the step starts with `set -e`. However, the existing `version-sync` job step (lines 209-247) does NOT begin with `set -e`. So by default, `grep` returning exit 1 (no match) would NOT abort the CI step in the current workflow context.

But: if the CI step is ever changed to add `set -e`, a missing version line in Cargo.toml would cause `grep` to exit 1, aborting the step before the comparison runs. The comparison would never execute, the `exit 1` would never be reached, but the step itself would fail (which is the desired outcome anyway). **Net effect:** safe under both `set -e` and non-`set -e` contexts.

**Conclusion:** Both preconditions for `$NEW_VERSION` and `$ROOT_DIR` are fully satisfied. The `grep` exit code edge case is safe in both contexts.

---

### Summary of Gaps Found

**Gap 1 — Dry-run path omits Cargo.toml (non-blocking):**
The script exits at line 227 for `--dry-run`, before STEP 3 where the Cargo.toml update would live. The dry-run output "Packages that would be updated" lists only npm packages, not Cargo.toml. A user running `--dry-run` to preview the release would not see that Cargo.toml will be modified. This is a usability gap, not a correctness gap — the actual release still works correctly.

**Fix:** Add Cargo.toml to the dry-run output section (lines 210-227).

**Gap 2 — Inline comment on version line corrupts CI extraction (low probability, non-blocking):**
If Cargo.toml ever contains `version = "0.2.11" # release`, the CI sed command `s/version = "\(.*\)"/\1/` captures `0.2.11" # release` (everything up to the last `"`). `CARGO_VERSION` would contain `0.2.11" # release`, which would never equal `$ROOT_VERSION`, causing CI to permanently block even when versions are correctly synced.

**Fix:** Use a more precise sed: `sed 's/^version = "\([^"]*\)".*/\1/'` (non-greedy via negated character class `[^"]*`).

**Neither gap is a REJECT condition.** The core logic — sed pattern safety, version format coverage, CI detection of drift — is sound. The plan is approvable with these gaps noted for the implementor.

---

**Final Verdict: APPROVE**

The plan is logically correct. The two gaps are minor and do not affect the correctness of version synchronization. Implementation may proceed with the following notes for the implementor:

1. Add `packages/rfdb-server/Cargo.toml` to the dry-run output section to make `--dry-run` faithful.
2. Use `sed 's/^version = "\([^"]*\)".*/\1/'` in the CI extraction (non-greedy match) instead of the greedy `\(.*\)` variant, to be robust against future inline comments.
