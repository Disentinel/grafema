# H012 Prompt Ablation Matrix

## Features (7 dimensions)

| Code | Feature | 0 | 1 | 2 |
|------|---------|---|---|---|
| F1 | Tool listing | absent | listed (names only) | described (with explanations) |
| F2 | Framing | neutral | "code analyst" | "graph database expert" |
| F3 | Bootstrap seed | none | stats summary | graph snippet (architecture overview) |
| F4 | Routing hint | none | soft ("consider using...") | explicit routing rules |
| F5 | Few-shot example | none | 1 example | — |
| F6 | Prohibition | none | "avoid grep for structure" | — |
| F7 | Attention anchor | none | "graph has N nodes M edges" | — |

## Prompt Variants (20)

| ID | F1 | F2 | F3 | F4 | F5 | F6 | F7 | Description |
|----|----|----|----|----|----|----|----|----|
| abl-00 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | Pure baseline (no graph mention, no MCP) |
| abl-01 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | Current grafema.md (control) |
| abl-02 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | Verbose tool descriptions |
| abl-03 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | Analyst framing |
| abl-04 | 1 | 2 | 0 | 0 | 0 | 0 | 0 | Graph expert framing |
| abl-05 | 1 | 0 | 1 | 0 | 0 | 0 | 0 | Stats summary prepended |
| abl-06 | 1 | 0 | 2 | 0 | 0 | 0 | 0 | Architecture overview from graph |
| abl-07 | 1 | 0 | 0 | 1 | 0 | 0 | 0 | Soft routing suggestions |
| abl-08 | 1 | 0 | 0 | 2 | 0 | 0 | 0 | Explicit routing rules |
| abl-09 | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 1 few-shot MCP example |
| abl-10 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | "Avoid grep for structure" |
| abl-11 | 1 | 0 | 0 | 0 | 0 | 0 | 1 | Attention anchor with numbers |
| abl-12 | 2 | 1 | 1 | 1 | 0 | 0 | 1 | Kitchen sink (soft combo) |
| abl-13 | 2 | 2 | 2 | 2 | 1 | 1 | 1 | Kitchen sink (max everything) |
| abl-14 | 1 | 0 | 1 | 0 | 1 | 0 | 0 | Bootstrap + few-shot |
| abl-15 | 1 | 1 | 0 | 1 | 0 | 0 | 1 | Analyst + soft routing + anchor |
| abl-16 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | No tools listed, graph data injected (context-only) |
| abl-17 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | "Start by calling get_stats" instruction |
| abl-18 | 2 | 0 | 0 | 2 | 0 | 0 | 0 | Verbose descriptions + explicit routing |
| abl-19 | 1 | 0 | 1 | 1 | 1 | 0 | 1 | Balanced combo |

## Controls

- **abl-00**: Pure baseline — identical to `baseline.md` but with MCP attached (tests: does MCP presence alone matter?)
- **abl-01**: Current grafema prompt (replicates existing `grafema.md`)
- **abl-16**: Context injection without tools (tests H006/H009)

## Run Protocol

```bash
# Single question, all 20 prompts, N=3
for mode in abl-{00..19}; do
  for rep in 1 2 3; do
    node autoresearch/harness/run.mjs \
      --mode $mode \
      --model sonnet \
      --questions autoresearch/questions.yaml \
      --question-id Q16 \
      --run-id "${mode}-r${rep}"
  done
done

# Evaluate all
for dir in autoresearch/results/abl-*; do
  node autoresearch/harness/evaluate.mjs --run "$dir" --judge --judge-model haiku
done
```

## Analysis

After all runs complete, extract from answers.jsonl:
- `mcp_calls`: total MCP tool calls
- `mcp_adoption`: 1 if mcp_calls > 0, else 0
- `total_tokens`: input_tokens + output_tokens
- `judge_score`: from evaluation.jsonl

Build dataframe with features F1-F7 per prompt + dependent variables.

**Logistic regression:** `mcp_adoption ~ F1 + F2 + F3 + F4 + F5 + F6 + F7`
**Linear regression:** `judge_score ~ F1 + F2 + F3 + F4 + F5 + F6 + F7`
**Linear regression:** `total_tokens ~ F1 + F2 + F3 + F4 + F5 + F6 + F7`

Look for: significant coefficients, interaction effects, diminishing returns.
