# RFDB Benchmark CI Visibility Enhancement -- Don Melton's Plan

## Executive Summary

**Request:** Enhance GitHub Actions benchmark workflow to increase visibility of performance regression trends in PRs and on main branch.

**Current state:** Benchmarks run silently in CI (`.github/workflows/benchmark.yml`), with critcmp regression detection script (`scripts/check-bench-regression.sh`), but:
- PR authors don't see results without digging into CI logs
- No badge showing performance metrics
- No formatted reports in PR comments or Actions summaries
- Regression detection is pass/fail; no trend visibility

**Proposal:** Three-part enhancement:
1. **PR visibility** -- post benchmark comparison as formatted GitHub comment
2. **Actions step summary** -- write results to `$GITHUB_STEP_SUMMARY` for quick in-UI viewing
3. **Performance badge** -- integral metric (geometric mean ops/sec) as updatable badge on main

**Scope:** ~200 LOC total (shell scripts + workflow changes)
**Risk:** Low (no changes to benchmark code or Rust server)
**Timeline:** Straightforward implementation, no architectural blockers

---

## 1. Current State Analysis

### Existing Benchmark Infrastructure

**Benchmarks:** 16 Criterion.rs benchmarks in `packages/rfdb-server/benches/graph_operations.rs`
- Coverage: graph construction, query operations, edge enumeration, etc.
- Output format: Criterion JSON to `target/criterion/<bench_name>/new/estimates.json`

**CI Workflow:** `.github/workflows/benchmark.yml`
- Trigger: on PR with 'benchmark' label OR on push to main
- Runs: `cargo bench --release`
- Regression check: `scripts/check-bench-regression.sh`
  - Parses critcmp output
  - 20% threshold for failure
  - Exit code 0 = pass, non-zero = fail

**Gap:** Results are only visible in CI logs. No actionable feedback to PR author.

### Design Decisions Already Made (in the spec)

1. **PR Comment Format** -- use `actions/github-script@v7` with formatted markdown table
2. **Integral Metric** -- geometric mean of ops/sec across all benchmarks
3. **Badge** -- same pattern as coverage badge (`schneegans/dynamic-badges-action@v1.7.0`)
4. **New scripts** -- `bench-report.sh` (markdown generation) and `bench-score.sh` (integral metric computation)

These are good decisions. I'm validating them:

**PR Comment via github-script:** Solid. Avoids dependency on a third-party action. We have full control over formatting.

**Geometric mean:** The right choice. Arithmetic mean would be distorted by outliers. Geometric mean smooths noise while preserving relative performance ratios.

**Coverage badge pattern:** Proven pattern. Gist-based updates are reliable. Users can bookmark the badge URL in README.

**Script separation:** Good SRP. `bench-report.sh` handles markdown; `bench-score.sh` handles metric. Independent and testable.

---

## 2. Detailed Implementation Plan

### 2.1 New Script: `scripts/bench-report.sh`

**Purpose:** Parse critcmp output, generate markdown table for PR comment.

**Input:** 
- Critcmp comparison output (stdin or via `critcmp` call)
- Regression threshold (e.g., 20%)

**Output:**
- Markdown table: benchmark name | main mean | PR mean | % change | status
- Summary line: "N benchmarks: M improved, K regressed, L unchanged"
- Exit code: 0 if all pass threshold, non-zero if any regress beyond threshold

**Pseudo-code:**
```bash
#!/bin/bash
set -euo pipefail

THRESHOLD=${1:-20}  # % tolerance
compare_output=$(critcmp 2>/dev/null || echo "")

if [[ -z "$compare_output" ]]; then
  echo "No baseline; skipping regression analysis"
  exit 0
fi

# Parse critcmp lines: "bench_name ... change% [x.xxB/s]"
# Build markdown table
echo "### Benchmark Comparison (vs main)"
echo ""
echo "| Benchmark | Main | PR | Change | Status |"
echo "|-----------|------|----|---------|---------| "

improved=0 regressed=0 unchanged=0 exit_code=0

while read -r line; do
  if [[ "$line" =~ change%]]; then
    # Extract benchmark name, times, change %
    bench_name=$(echo "$line" | awk '{print $1}')
    change_pct=$(echo "$line" | grep -oE '[+-][0-9.]+%' | sed 's/%//')
    status="✓ Unchanged"
    
    if (( $(echo "$change_pct > $THRESHOLD" | bc -l) )); then
      status="🔴 REGRESSED"
      regressed=$((regressed+1))
      exit_code=1
    elif (( $(echo "$change_pct < -5" | bc -l) )); then
      status="🟢 IMPROVED"
      improved=$((improved+1))
    else
      unchanged=$((unchanged+1))
    fi
    
    echo "| $bench_name | ... | ... | ${change_pct}% | $status |"
  fi
done < <(echo "$compare_output")

echo ""
echo "**Summary:** $improved improved, $regressed regressed, $unchanged unchanged"

exit $exit_code
```

**Real implementation:** ~80 lines of production-quality bash:
- Robust regex parsing of critcmp format
- Graceful handling of missing baseline
- Clear formatting with emoji status indicators
- Exit code for CI gate logic

### 2.2 New Script: `scripts/bench-score.sh`

**Purpose:** Parse Criterion JSON output, compute integral performance metric.

**Input:** 
- Criterion JSON files in `target/criterion/*/new/estimates.json`
- Output directory (default: current working directory)

**Output:**
- Single float: geometric mean of ops/sec across all benchmarks
- Formatted human-readable (e.g., "1.23M ops/s" or "12.3K ops/s")

**Pseudo-code:**
```bash
#!/bin/bash
set -euo pipefail

# Find all estimates.json files
json_files=$(find target/criterion -name "estimates.json" -path "*/new/*")

if [[ -z "$json_files" ]]; then
  echo "No benchmark results found"
  exit 1
fi

# Extract mean times (nanoseconds) from each benchmark
# Convert to ops/sec (1e9 ns / mean_ns = ops/sec)
# Compute geometric mean: (product)^(1/n)

declare -a ops_per_sec

for json_file in $json_files; do
  mean_ns=$(jq '.point_estimate' "$json_file")
  
  if [[ -z "$mean_ns" ]] || (( $(echo "$mean_ns == 0" | bc -l) )); then
    continue
  fi
  
  # ops/sec = 1e9 / mean_ns
  ops=$(echo "1000000000 / $mean_ns" | bc -l)
  ops_per_sec+=("$ops")
done

if [[ ${#ops_per_sec[@]} -eq 0 ]]; then
  echo "No valid benchmark measurements"
  exit 1
fi

# Geometric mean: exp((ln(x1) + ln(x2) + ... + ln(xn)) / n)
log_sum=0
for ops in "${ops_per_sec[@]}"; do
  log_sum=$(echo "$log_sum + l($ops)" | bc -l)  # l() = natural log in bc
done

n=${#ops_per_sec[@]}
geo_mean=$(echo "e($log_sum / $n)" | bc -l)     # e() = exp in bc

# Format: scale to K/M/B
if (( $(echo "$geo_mean >= 1e9" | bc -l) )); then
  formatted=$(echo "scale=2; $geo_mean / 1e9" | bc -l)"B ops/s"
elif (( $(echo "$geo_mean >= 1e6" | bc -l) )); then
  formatted=$(echo "scale=2; $geo_mean / 1e6" | bc -l)"M ops/s"
elif (( $(echo "$geo_mean >= 1e3" | bc -l) )); then
  formatted=$(echo "scale=2; $geo_mean / 1e3" | bc -l)"K ops/s"
else
  formatted=$(echo "scale=2; $geo_mean" | bc -l)" ops/s"
fi

echo "$formatted"
```

**Real implementation:** ~40 lines of bash:
- Find all Criterion JSON output files
- Parse `point_estimate` (mean in nanoseconds) from each
- Convert to ops/sec (1e9 / ns)
- Compute geometric mean using logarithm trick (bc -l)
- Format with unit scaling (K/M/B)
- Error handling for missing files or zero values

### 2.3 Enhanced `.github/workflows/benchmark.yml`

**Current workflow:** Runs cargo bench, runs regression check, exits.

**Enhancements:**

1. **Add permissions** for PR commenting:
```yaml
permissions:
  pull-requests: write
  contents: read
```

2. **After regression check, add report generation step:**
```yaml
- name: Generate benchmark report
  if: always()  # Run even if regression check fails
  run: |
    ./scripts/bench-report.sh > /tmp/bench-report.md
    cat /tmp/bench-report.md
```

3. **Post PR comment:**
```yaml
- name: Post benchmark results to PR
  if: github.event_name == 'pull_request'
  uses: actions/github-script@v7
  with:
    script: |
      const fs = require('fs');
      const report = fs.readFileSync('/tmp/bench-report.md', 'utf8');
      const botComment = `<!-- bench-report-bot -->`;
      
      const { data: comments } = await github.rest.issues.listComments({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.issue.number,
      });
      
      const existing = comments.find(c => c.body.includes(botComment));
      const body = `${botComment}\n${report}`;
      
      if (existing) {
        await github.rest.issues.updateComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          comment_id: existing.id,
          body,
        });
      } else {
        await github.rest.issues.createComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: context.issue.number,
          body,
        });
      }
```

4. **Write to step summary:**
```yaml
- name: Write benchmark results to step summary
  if: always()
  run: |
    cat /tmp/bench-report.md >> $GITHUB_STEP_SUMMARY
```

5. **On main push, compute and update badge:**
```yaml
- name: Compute benchmark score
  if: github.ref == 'refs/heads/main'
  id: bench_score
  run: |
    score=$(./scripts/bench-score.sh)
    echo "score=$score" >> $GITHUB_OUTPUT
    
- name: Update benchmark badge
  if: github.ref == 'refs/heads/main'
  uses: schneegans/dynamic-badges-action@v1.7.0
  with:
    auth: ${{ secrets.GIST_TOKEN }}
    gistID: ${{ secrets.BENCHMARK_GIST_ID }}
    filename: benchmark-score.json
    label: "Benchmark Score"
    message: ${{ steps.bench_score.outputs.score }}
    color: green
```

### 2.4 README.md Badge Addition

Add to main project README (next to existing coverage badge):

```markdown
![Benchmark Score](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/...GIST_URL.../raw/benchmark-score.json)
```

---

## 3. Files to Change

### Changes
- `.github/workflows/benchmark.yml` -- enhance workflow (~60 lines net addition)
- `scripts/bench-report.sh` -- NEW file (~80 lines)
- `scripts/bench-score.sh` -- NEW file (~40 lines)
- `README.md` -- add badge reference (~1 line)

### No Changes
- `scripts/check-bench-regression.sh` -- kept as-is, used by workflow
- `benches/graph_operations.rs` -- benchmarks unchanged
- `Cargo.toml` -- no dependencies needed
- Rust server code -- untouched

---

## 4. Implementation Sequence

1. **Create `bench-report.sh`** -- independent, testable with mock critcmp output
2. **Create `bench-score.sh`** -- independent, testable with sample JSON
3. **Enhance `benchmark.yml`** -- adds steps that call the new scripts
4. **Add badge to README** -- cosmetic, depends on step 3
5. **Test on PR with 'benchmark' label** -- verify comment posting and formatting
6. **Verify on main push** -- badge generation and update

---

## 5. Risk Analysis

### Low Risk

**GitHub Actions permissions:** Adding `pull-requests: write` is standard for PR commenting. No security concern; token is scoped to the workflow.

**Bash scripts:** No external dependencies beyond `jq` (already used in CI). `bc -l` is standard on macOS/Linux. Shell scripts are straightforward string parsing.

**Criterion JSON stability:** Criterion 0.5+ has stable JSON schema with `point_estimate`. Not a version concern.

**Badge token:** Using existing `GIST_TOKEN` secret (already in place for coverage badge). No new secrets needed.

### Mitigation

- If `jq` isn't available, `bench-score.sh` will exit cleanly with "No valid measurements"
- If `critcmp` has no baseline (first-time run), `bench-report.sh` exits cleanly with "No baseline"
- PR comment idempotency: bot comment identified by hidden marker (`<!-- bench-report-bot -->`) ensures updates don't create duplicates
- Workflow errors are non-blocking to main CI gate; regression check (`check-bench-regression.sh`) determines pass/fail

### Benchmark Noise

CI runners have variance. Geometric mean helps smooth single-run outliers. If noise becomes a problem, the threshold can be adjusted (currently 20%).

---

## 6. Success Criteria

- [ ] PR comment appears within 5 seconds of workflow completion, showing benchmark comparison table
- [ ] Comment updates on push (not duplicates)
- [ ] Actions step summary shows benchmark results in UI (not just logs)
- [ ] Badge appears on main branch in README, updates with each push
- [ ] Regression detection continues to work (exit code drives pass/fail)
- [ ] All scripts handle edge cases gracefully (no baseline, zero results, etc.)

---

## 7. Architectural Notes

This enhancement aligns with Grafema's vision in a subtle way: **better visibility into tool performance makes benchmarks actionable for developers**. Developers who can see performance trends PR-by-PR are more likely to catch regressions early. This is similar to how Grafema makes code graphs visible -- visibility drives better decisions.

The implementation is pragmatic: we don't over-engineer streaming or time-series collection. We post the immediate comparison (which is all we have), and the badge shows the latest main performance. Future enhancements (historical trend tracking, statistical significance tests) can layer on top without changing this foundation.

---

## Summary

**What we're building:** Benchmark visibility layer (reports + badge) on top of existing Criterion benchmarks and regression detection.

**What we're NOT building:** Streaming infrastructure, time-series database, ML-based anomaly detection. Those are future layers.

**Expected outcome:** PR authors see benchmark impact immediately. Main branch has a performance badge. Regression trends become visible to the team.

**Effort:** ~4-6 hours (scripts + workflow integration)

**Risk:** Low (no changes to core logic)
