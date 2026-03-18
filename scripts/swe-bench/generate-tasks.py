#!/usr/bin/env python3
"""
Generate tasks.json from HuggingFace SWE-bench Multilingual dataset.

Requirements:
    pip install datasets

Usage:
    python scripts/swe-bench/generate-tasks.py > scripts/swe-bench/tasks.json
"""

import json
from datasets import load_dataset

ds = load_dataset("swe-bench/SWE-Bench_Multilingual", split="test")

# Filter JS/TS tasks (repos that use JavaScript or TypeScript)
JS_REPOS = {
    "axios/axios",
    "preactjs/preact",
    "babel/babel",
    "facebook/docusaurus",
    "vuejs/core",
    "mrdoob/three.js",
    "immutable-js/immutable-js",
}

tasks = []
for row in ds:
    repo = row["repo"]
    if repo not in JS_REPOS:
        continue
    tasks.append({
        "instance_id": row["instance_id"],
        "repo": repo,
        "base_commit": row["base_commit"],
        "problem_statement": row["problem_statement"],
        "hints_text": row.get("hints_text", ""),
    })

tasks.sort(key=lambda t: t["instance_id"])

print(json.dumps(tasks, indent=2))
