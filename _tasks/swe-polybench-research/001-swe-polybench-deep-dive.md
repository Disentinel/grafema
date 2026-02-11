# SWE-PolyBench Deep-Dive Research Report

**Date:** 2026-02-09
**Purpose:** Evaluate SWE-PolyBench as an alternative benchmark to Multi-SWE-bench for Grafema evaluation

---

## Executive Summary

SWE-PolyBench is a multi-language benchmark from Amazon containing **2,110 instances** from **21 repositories** across **4 languages** (Java, JavaScript, TypeScript, Python). It focuses on repository-level code understanding and issue resolution.

**Key Findings:**
- **Strong JS/TS coverage:** 1,746 instances (1,017 JS + 729 TS) = 82.7% of dataset
- **Docker-heavy infrastructure:** 1.2TB for PB500 subset, 7-8 hours evaluation time
- **Well-designed evaluation:** CST node-level retrieval metrics, three task categories
- **Setup complexity:** Instance-specific Docker images, substantial resource requirements
- **No repository overlap with SWE-Bench** by design

**Recommendation for Grafema:** SWE-PolyBench is suitable but resource-intensive. Multi-SWE-bench may offer easier setup for initial validation.

---

## 1. Setup & Installation

### Prerequisites

- **Python:** 3.10+ (3.11 recommended in conda environment)
- **Docker:** Required, must be running
- **Hardware:** 16+ CPU cores, 64GB RAM recommended
- **Storage:**
  - PB500 (500 instances): 1.2TB total Docker images
  - Full dataset (2,110 instances): up to 5TB
  - Can use `--delete-image` flag to reduce to negligible storage (trades speed)

### Installation Steps

```bash
# Clone repository
git clone https://github.com/amazon-science/SWE-PolyBench

# Install dependencies
pip install -r requirements.txt

# Install package
pip install -e .
```

### Storage Management

**Trade-off:** Storage vs. speed
- **With images cached:** Fast re-evaluation (no rebuild time)
- **With `--delete-image`:** Minimal storage, but rebuilds images each run (significantly slower)

Pre-built Docker images are available on HuggingFace, reducing setup time.

---

## 2. Dataset Format & Structure

### Dataset Variants

Three datasets available on HuggingFace:

1. **PB (Full):** 2,110 instances across 21 repositories
2. **PB500 (Stratified):** 500 instances (125 per language)
   - 40% Bug Fix, 40% Feature, 20% Refactoring
   - Designed for rapid experimentation
3. **PBv (Verified):** 382 curated instances
   - 72 Java, 100 JavaScript, 113 Python, 100 TypeScript
   - Higher quality, manually validated

### Instance Structure

Each instance contains:
- **instance_id:** Unique identifier
- **problem_statement:** Issue description (varying informativeness)
- **repo:** Repository identifier
- **base_commit:** Starting point
- **patch:** Ground truth solution
- **test_patch:** Tests to validate solution
- **PASS_TO_PASS_tests:** Tests that must remain passing
- **FAIL_TO_PASS_tests:** Tests that must transition from fail to pass

### Data Files

- `data/annotations.jsonl` — Enhanced instance metadata
- Dataset files available on HuggingFace:
  - `AmazonScience/SWE-PolyBench`
  - `AmazonScience/SWE-PolyBench_500`
  - `AmazonScience/SWE-PolyBench_Verified`

---

## 3. JS/TS Repositories Included

### Language Distribution

| Language   | Instances | Percentage | Repositories |
|------------|-----------|------------|--------------|
| JavaScript | 1,017     | 48.2%      | 12           |
| TypeScript | 729       | 34.6%      | 10           |
| Python     | 199       | 9.4%       | (unknown)    |
| Java       | 165       | 7.8%       | (unknown)    |
| **TOTAL**  | **2,110** | **100%**   | **21**       |

**JS + TS Combined:** 1,746 instances (82.7% of dataset) — excellent for web-focused evaluation.

### Repository Characteristics

**Selection Criteria:**
- Implementation-focused (no tutorials/guides)
- Minimum 100 pull requests
- Updated within last 12 months (at time of collection)
- Permissive licensing
- English as primary language

**Average Repository Sizes:**
- TypeScript projects: ~8,946 files on average
- Python projects: ~1,928 files on average
- JavaScript projects: (specific data not available, but likely between these)

**Note:** Specific repository names are not publicly documented in accessible web materials. They appear in Table 9 of the paper appendix, which requires downloading the full PDF from arXiv (https://arxiv.org/abs/2504.08703).

### Task Distribution by Language

From the paper's complexity analysis:

**JavaScript:**
- **84.27% function-only modifications** (highest among all languages)
- **2.2 files modified** on average
- Simpler modification profiles overall

**TypeScript:**
- **30.59% config/other modifications** (highest non-class/function changes)
- **3.1 files modified** on average
- More diverse modification types
- Larger repositories (8,946 files avg)

### Initial Collection Stats

- **~377,300 candidate PRs** collected initially
- Filtered through metadata + execution-based validation
- Final dataset: 2,110 high-quality instances

---

## 4. Task Categories

### Primary Classification

| Category        | Percentage | Count (approx) |
|-----------------|-----------|----------------|
| **Bug Fix**     | 74.5%     | 1,572          |
| **Feature**     | 21.94%    | 463            |
| **Refactoring** | 2.94%     | 62             |

**Note:** PB500 (stratified subset) intentionally oversamples features and refactoring to 40-40-20 split for balanced evaluation.

### Secondary Classification: Problem Statement Quality

Issues rated on three dimensions:
1. **Descriptiveness:** How well the issue is described
2. **Solution Hints:** Whether issue contains hints about implementation
3. **Localization:** Whether issue identifies affected code locations

This classification helps assess whether AI systems can work with varying levels of problem specification quality.

### Complexity Classification (by CST Node Modifications)

Based on Concrete Syntax Tree analysis:

| Modification Type          | JS    | TS    | Python | Java  |
|---------------------------|-------|-------|--------|-------|
| Single node               | —     | —     | —      | —     |
| Function-only             | 84.27%| —     | —      | —     |
| Class-only                | —     | —     | —      | —     |
| Config/other              | —     | 30.59%| —      | —     |
| Mixed (class+function)    | —     | —     | —      | 66.06%|

**Average nodes modified per instance:** 5.76 (Python baseline)

**Key Insight:** JavaScript shows simpler modification profiles (mostly function-level), while Java requires complex mixed changes.

---

## 5. Evaluation Process

### Running Evaluation

**Main Script:** `src/poly_bench_evaluation/run_evaluation.py`

**Key Parameters:**

```bash
python src/poly_bench_evaluation/run_evaluation.py \
  --dataset-path /path/to/dataset \
  --result-path /path/to/results \
  --predictions-path predictions.jsonl \
  --num-threads 10 \
  --delete-image \
  --skip-existing \
  --node-metrics
```

**Parameter Descriptions:**

- `--dataset-path` (required): Location of dataset (HuggingFace download)
- `--result-path` (required): Where to write instance-level results
- `--predictions-path`: Model predictions file (`.jsonl` format)
- `--num-threads`: Parallelism level (10-12 recommended for 16-core machine)
- `--evaluate-gold`: Test reference patches (for sanity checking)
- `--delete-image`: Remove Docker images after evaluation (saves storage)
- `--skip-existing`: Skip already-evaluated instances (for resume)
- `--node-metrics`: Enable CST node retrieval metric computation

### Submission Format

Predictions must be in **JSONL format** with two required fields:

```jsonl
{"instance_id": "repo__issue-123", "model_patch": "diff --git a/file.js..."}
{"instance_id": "repo__issue-456", "model_patch": "diff --git a/other.js..."}
```

**Field Requirements:**
- `instance_id`: String, must match dataset instance
- `model_patch`: String, unified diff format (git patch)

### Evaluation Metrics

#### Primary Metric: Pass Rate

**Definition:** Percentage of instances where generated patch:
1. Makes all FAIL_TO_PASS tests pass
2. Keeps all PASS_TO_PASS tests passing

This is the main success criterion.

#### Retrieval Metrics

**File-level Retrieval:**
- **Recall:** % of modified files identified by agent
- **Precision:** % of identified files that were actually modified

**Node-level Retrieval (CST-based):**
- **Recall:** % of modified functions/classes identified
- **Precision:** % of identified nodes that were actually modified

**Methodology:** CST analysis identifies deepest affected node in code changes, providing fine-grained view of agent's navigation capability.

#### Complexity Breakdown

Results segmented by:
- **Single-file vs. multi-file** modifications
- **Function-only, class-only, mixed, config** modifications
- **Number of files** modified (1, 2, 3+)

### Performance Characteristics

**Expected Runtime (PB500):**
- **With 7-8 threads:** ~7-8 hours
- **With 10-12 threads:** Likely 5-6 hours (not explicitly documented)
- **If building images from scratch:** Significantly longer

**Multi-threaded Pipeline:**
- Orchestrates containerized testing environments
- Processes instances in parallel
- Applies patches, executes tests, aggregates results
- Configurable concurrency level

### Output Structure

**Instance-level Results:** Written to `--result-path`
- One result file per instance
- Contains test execution logs, pass/fail status

**Aggregate Report:** `./result.json`
- Overall pass rate
- Breakdown by language, complexity, file count
- Retrieval metrics (if `--node-metrics` enabled)

**Test Logs:** `./run_logs_{language}/`
- Detailed test execution output
- Useful for debugging failures

---

## 6. Docker Infrastructure

### Docker Image Strategy

**Instance-specific images:** Each task gets its own Docker environment
- Repository at specific commit
- Correct dependencies installed
- Test environment configured

**Why this matters:**
- Ensures reproducibility
- Isolates test execution
- Handles diverse build systems

**Trade-off:**
- More storage required
- Longer setup time
- Higher reliability

### Building vs. Pulling Images

**Pre-built images available** on HuggingFace registry:
- Significantly faster than building
- Recommended approach for first-time users

**Local building:**
- Required if pre-built images unavailable
- Can take substantial time (hours for full dataset)
- Requires stable network connection

### Storage Management

**Storage Requirements:**

| Dataset | With Cache | With --delete-image |
|---------|-----------|---------------------|
| PB500   | 1.2TB     | Negligible          |
| Full PB | ~5TB      | Negligible          |

**Recommendation:** Use `--delete-image` unless:
1. Running multiple evaluations
2. Storage is cheap/abundant
3. Time is more valuable than space

---

## 7. Comparison: SWE-PolyBench vs. Multi-SWE-bench

### Overview

| Aspect               | SWE-PolyBench                          | Multi-SWE-bench                        |
|---------------------|----------------------------------------|----------------------------------------|
| **Source**          | Amazon                                 | Academic consortium                    |
| **Total Instances** | 2,110                                  | 1,632                                  |
| **Languages**       | 4 (Java, JS, TS, Python)               | 7 (Java, JS, TS, Go, Rust, C, C++)     |
| **Repositories**    | 21                                     | Unknown                                |
| **JS/TS Focus**     | 82.7% (1,746 instances)                | Unknown %                              |

### Overlap Analysis

**SWE-PolyBench explicitly excludes all SWE-Bench repositories** by design to ensure independence and diversity. No documented overlap with Multi-SWE-bench, but specific repository lists are not publicly available for detailed comparison.

### Task Classification

**SWE-PolyBench:**
- Bug Fix: 74.5%
- Feature: 21.94%
- Refactoring: 2.94%
- LLM-based informativeness rating

**Multi-SWE-bench:**
- Three difficulty levels (human-annotated)
- 68 expert annotators for quality assurance
- More rigorous curation process

### Evaluation Approach

**SWE-PolyBench:**
- Docker-based, instance-specific images
- CST node-level retrieval metrics
- 7-8 hours for 500 instances
- Pass/fail based on test suite

**Multi-SWE-bench:**
- Docker-based (similar infrastructure)
- Config file-driven evaluation
- Runtime not explicitly documented
- Emphasizes multilingual coverage

### Quality & Curation

**SWE-PolyBench:**
- Execution-based filtering (tests must fail-to-pass)
- Automated quality checks
- PBv (Verified) subset for higher quality

**Multi-SWE-bench:**
- **68 expert annotators** manually curating 1,632 instances from 2,456 candidates
- Human-annotated difficulty levels
- Higher curation bar

**Quality edge: Multi-SWE-bench** (more human validation)

### Setup Complexity

**SWE-PolyBench:**
- Well-documented setup process
- Clear evaluation script with extensive parameters
- Pre-built Docker images available
- 1.2TB storage for PB500 (or `--delete-image`)

**Multi-SWE-bench:**
- Docker setup guide available
- Config-based evaluation
- Storage requirements not explicitly documented
- Less detailed evaluation docs (based on web search)

**Setup edge: SWE-PolyBench** (better documentation)

### Performance Metrics

**SWE-PolyBench Results (from paper):**
- Python: 20-24% pass rate (best)
- Java: 10-16%
- JavaScript: 6-12%
- TypeScript: 4-13% (worst)

**Multi-SWE-bench Results:**
- Evaluated 9 models across 3 agent frameworks
- Specific pass rates not available in search results

### Ease of Use

**SWE-PolyBench Advantages:**
- Single evaluation script with clear parameters
- `--skip-existing` for resume capability
- `--delete-image` for storage management
- `--node-metrics` for detailed analysis
- Active leaderboard with ongoing submissions

**Multi-SWE-bench Advantages:**
- More languages (if Go/Rust/C/C++ needed)
- Higher curation quality
- Potentially simpler setup (needs validation)

---

## 8. Specific JS/TS Repository Details

### What We Know

**JavaScript (1,017 instances from 12 repositories):**
- Function-level modifications dominate (84.27%)
- Average 2.2 files modified per instance
- Simpler modification profiles
- Real-world projects with 100+ PRs

**TypeScript (729 instances from 10 repositories):**
- More diverse modification types (30.59% config/other)
- Average 3.1 files modified per instance
- Larger repositories (~8,946 files)
- Higher complexity overall

### What We Don't Know

**Specific repository names are not publicly available** in web-accessible documentation. According to the paper:

> "Table 9 lists the repositories and total number of PRs collected for four languages"

**To get repository list:**
1. Download full paper PDF: https://arxiv.org/abs/2504.08703
2. Check Table 9 in appendix
3. Alternatively, download dataset from HuggingFace and inspect instance metadata

**Typical Repository Characteristics (inferred):**
- Active open-source projects
- 100+ pull requests (minimum threshold)
- Updated within 12 months of collection (2024-2025 timeframe)
- Permissive licenses (MIT, Apache, etc.)
- Implementation-focused (not docs/tutorials)

### Repository Size Context

**From paper statistics:**
- Average repository size varies significantly by language
- TypeScript projects are notably large (8,946 files)
- JavaScript projects likely smaller (but specific data not available)
- All projects represent real-world, production-grade codebases

---

## 9. Recommendations for Grafema

### Is SWE-PolyBench Suitable for Grafema?

**YES, with caveats:**

**Pros:**
1. **Excellent JS/TS coverage:** 82.7% of dataset (1,746 instances)
2. **Real-world complexity:** Repository-level tasks, multi-file changes
3. **Good evaluation metrics:** CST node-level retrieval aligns with graph-based analysis
4. **Three task types:** Bug/feature/refactor matches real development
5. **No SWE-Bench overlap:** Fresh evaluation, no training contamination

**Cons:**
1. **Resource-intensive:** 1.2TB storage (PB500), 7-8 hours evaluation time
2. **Docker-heavy:** Requires container infrastructure, complex setup
3. **Repository names not public:** Can't pre-analyze repos to prepare Grafema
4. **Long feedback loop:** 7-8 hours per eval run makes iteration slow

### Comparison with Multi-SWE-bench for Grafema

| Criterion                    | SWE-PolyBench | Multi-SWE-bench | Better For Grafema |
|------------------------------|---------------|-----------------|-------------------|
| JS/TS coverage               | 82.7% (known) | Unknown %       | SWE-PolyBench (proven) |
| Setup complexity             | Well-documented | Less clear    | SWE-PolyBench |
| Evaluation time              | 7-8 hours     | Unknown         | Unknown |
| Quality curation             | Automated     | 68 annotators   | Multi-SWE-bench |
| Graph-relevant metrics       | Node-level CST| Standard       | SWE-PolyBench |
| Total instances              | 2,110         | 1,632           | SWE-PolyBench |

### Recommended Approach

**Phase 1: Initial Validation (Use Multi-SWE-bench if easier)**
- Start with smaller subset (50-100 instances)
- Validate Grafema's basic issue resolution capability
- Quick feedback loop for iteration

**Phase 2: Rigorous Evaluation (Use SWE-PolyBench)**
- PB500 for comprehensive benchmarking
- Leverage CST node retrieval metrics (aligns with Grafema's graph focus)
- Compare against leaderboard

**Phase 3: Production Validation (Consider Both)**
- Full SWE-PolyBench (2,110 instances)
- Multi-SWE-bench for multilingual coverage
- Cross-validate results

### Action Items for Next Steps

1. **Download SWE-PolyBench dataset** from HuggingFace
   - Start with PB500 (500 instances)
   - Inspect `data/annotations.jsonl` for repository names
   - Extract specific JS/TS repository list

2. **Analyze overlap with Multi-SWE-bench**
   - Once repo names are known
   - Check for duplicate repos
   - Assess quality differences

3. **Resource planning**
   - Provision 16-core machine with 64GB RAM
   - Allocate 1.2TB storage (or plan for `--delete-image` workflow)
   - Set up Docker environment

4. **Pilot evaluation**
   - Run evaluation on 10-20 instances manually
   - Validate Grafema integration
   - Measure actual evaluation time

5. **Compare with Multi-SWE-bench**
   - Set up Multi-SWE-bench in parallel
   - Run same-sized sample (50 instances each)
   - Compare setup complexity, evaluation time, result quality

### Open Questions

1. **Multi-SWE-bench JS/TS coverage:** What percentage of 1,632 instances are JS/TS?
2. **Repository overlap:** Do the two benchmarks share any repositories?
3. **Actual evaluation time:** How long does Multi-SWE-bench take vs. SWE-PolyBench?
4. **Graph integration:** Can Grafema's CST analysis map to SWE-PolyBench's node metrics?

---

## 10. Sources

### Primary Sources

- [SWE-PolyBench GitHub Repository](https://github.com/amazon-science/SWE-PolyBench)
- [SWE-PolyBench Paper (arXiv)](https://arxiv.org/abs/2504.08703)
- [SWE-PolyBench Paper (HTML)](https://arxiv.org/html/2504.08703v3)
- [SWE-PolyBench Official Website](https://amazon-science.github.io/SWE-PolyBench/)
- [AWS DevOps Blog: SWE-PolyBench Announcement](https://aws.amazon.com/blogs/devops/amazon-introduces-swe-polybench-a-multi-lingual-benchmark-for-ai-coding-agents/)

### Dataset Locations

- [HuggingFace: SWE-PolyBench (Full)](https://huggingface.co/datasets/AmazonScience/SWE-PolyBench)
- [HuggingFace: SWE-PolyBench_500](https://huggingface.co/datasets/AmazonScience/SWE-PolyBench_500)
- [HuggingFace: SWE-PolyBench_Verified](https://huggingface.co/datasets/AmazonScience/SWE-PolyBench_Verified)

### Multi-SWE-bench References

- [Multi-SWE-bench GitHub Repository](https://github.com/multi-swe-bench/multi-swe-bench)
- [Multi-SWE-bench Leaderboard](https://llm-stats.com/benchmarks/multi-swe-bench)
- [Multi-SWE-bench Paper (OpenReview)](https://openreview.net/forum?id=MhBZzkz4h9)

### Additional Context

- [SWE-bench Original (for context)](https://www.swebench.com/)
- [Epoch AI: Running SWE-bench Efficiently](https://epoch.ai/blog/swebench-docker)

---

## Appendix: Technical Details

### Concrete Syntax Tree (CST) Analysis

SWE-PolyBench uses CST analysis to classify modification complexity:

1. **Parse original and modified code** into CST
2. **Identify deepest affected nodes** (function, class, module, etc.)
3. **Classify modification type:**
   - Single node
   - Function-only
   - Class-only
   - Mixed (function + class)
   - Configuration/other

This provides fine-grained view of code navigation capability.

**Relevance to Grafema:** Grafema builds AST-based graphs. SWE-PolyBench's CST node metrics could directly map to Grafema's node-level retrieval queries.

### Execution-Based Filtering

**SWE-PolyBench's quality process:**

1. Collect PRs from repositories (377,300 candidates)
2. Filter for PRs that:
   - Resolve issues
   - Include test code
   - Don't create new files tested within patch (avoids trivial additions)
3. Run test suite before patch (must have failures)
4. Run test suite after patch (must have passes)
5. Require at least one FAIL_TO_PASS transition

**Result:** 2,110 high-quality instances with verified executability.

### Informativeness Rating

LLM-based classification of problem statements:

**Three dimensions:**
1. **Descriptiveness:** 0-10 scale, how well issue is described
2. **Solution Hints:** 0-10 scale, whether implementation hints provided
3. **Localization:** 0-10 scale, whether affected code locations identified

**Purpose:** Assess AI system's ability to work with varying problem specification quality.

---

**End of Report**
