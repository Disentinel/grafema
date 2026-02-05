# Steve Jobs Review: REG-340

**Verdict: APPROVE (with one mandatory clarification)**

---

## What I Like

1. **Right approach, right timing**: Users install `npm install @grafema/rfdb` and it just works. This is UX done right. No surprise Rust installations, no "sorry your platform isn't supported" nonsense. That's what we need.

2. **Clean separation of concerns**: The two-workflow pattern (build + manual download) is pragmatic. We're not over-automating. The build happens on tag push, and the download is a deliberate step before publish. That's honest and traceable.

3. **Actually supports all platforms we said we would**: darwin-x64, darwin-arm64, linux-x64, linux-arm64. Not shipping with half support. Don's architectural decision to use native runners where possible and only cross-compile for linux-arm64 is exactly right.

4. **Realistic about platform limitations**: The postinstall script already handles unsupported platforms gracefully (warning, not error). The plan doesn't pretend to support Windows. We acknowledge our boundary and give users a clear fallback (build from source). No false promises.

5. **The download script is solid**: Using `gh CLI`, auto-detecting latest release, renaming on download, idempotent with `--clobber`. It's simple and it works. Not a hack — a proper solution.

6. **Binary size and optimization**: Already using `lto = "fat"` and `codegen-units = 1` in Cargo.toml. Stripping is planned. These binaries won't bloat npm downloads.

---

## Concerns

### 1. BLOCKING: "Download binaries before publish" is a manual step — but where does it live?

The tech plan mentions updating the release skill, but there's ambiguity here. The postinstall.js already fails gracefully if binaries are missing. But the release skill doesn't mention rfdb at all.

**The question**: When someone runs the release workflow for @grafema/rfdb specifically, will they:
- Know to run `download-rfdb-binaries.sh` BEFORE publishing?
- Know which tag to download from?
- Know that publishing without binaries will still "succeed" but install a broken package?

This is a user experience trap. The postinstall.js won't fail on missing binaries — it'll just warn and exit(0). Then the package installs successfully, but Grafema won't work.

**What needs to happen**: The release skill MUST be updated with a mandatory **Step 0** that is unavoidable.

### 2. Testing validation is light

The tech plan says "manual testing checklist" but doesn't specify:
- Who validates each platform before publishing?
- If linux-arm64 build fails, do we publish anyway with 3 binaries?
- What happens if a user installs the partial package?

### 3. Artifact naming consistency is good, but verification is missing

What if GitHub Release ends up with duplicates somehow? What if download script fails silently? No validation (e.g., checksum, binary signature, size sanity check).

### 4. glibc compatibility is deferred, not solved

If we publish and a user on Ubuntu 18.04 installs it, it'll fail at runtime. The postinstall script won't catch this. Needs documentation.

---

## Blocking Issues (if REJECT)

There is ONE blocking issue that requires clarification before approval:

**The release skill must be updated with explicit, mandatory steps for downloading binaries before publishing @grafema/rfdb.**

---

## Recommendations

### 1. Update Release Skill (REQUIRED)

The grafema-release skill needs a new section at the top:

```markdown
### When Publishing @grafema/rfdb

If releasing the rfdb package specifically:

1. Ensure `rfdb-vX.Y.Z` tag was pushed and CI completed
2. Run: `./scripts/download-rfdb-binaries.sh rfdb-vX.Y.Z`
3. Verify all 4 binaries downloaded:
   ls -la packages/rfdb-server/prebuilt/*/rfdb-server
4. Only then proceed to Step 1 (version bumping)

If any platform is missing, DO NOT PUBLISH. Check CI logs.
```

### 2. Add Checksum Validation (NICE-TO-HAVE)

### 3. Platform Testing Matrix (FUTURE LINEAR ISSUE)

### 4. Document Minimum Requirements

---

## Final Assessment

This plan is **RIGHT**. The CI/CD itself will work. The download script will work. The binaries will be correct. The postinstall.js already works. This is low-risk, high-value infrastructure.

Approve, but require the release skill update before merging.
