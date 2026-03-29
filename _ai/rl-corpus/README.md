# Grafema RL Corpus

Adversarial self-play testing for Grafema's graph query capabilities.

## Architecture

- **Questioner** — reads code, generates questions + ground truth answers
- **Answerer** — answers using ONLY Grafema MCP graph tools (no file reads)
- **Judge** — compares graph answer to ground truth, classifies result

## Verdicts

- **CORRECT** — graph answer matches ground truth
- **PARTIAL** — graph answer covers part of truth (gap in coverage)
- **WRONG** — graph answer contradicts ground truth (bug)
- **IMPOSSIBLE** — answerer couldn't answer at all (missing capability)

## Question Levels

| Level | Type | Description |
|-------|------|-------------|
| L1 | Existence | "Does X exist in Y?" |
| L2 | Structure | "What does module Z export?" |
| L3 | Direct ref | "Who calls X?" / "What does X call?" |
| L4 | Data flow | "Where does value V come from?" |
| L5 | Impact | "If I change X, what breaks?" |
| L6 | Pattern | "Are there similar patterns to X?" |
| L7 | Cross-cut | "How do data flow from A to B?" |
| L8 | Architectural | "Which modules form cycles?" |

## Metrics

Target resolution rates:
- L1-L2: >95%
- L3-L4: >80%
- L5-L6: >60%
- L7-L8: >40%

## Files

Each round: `round-NNN.yaml` with full questions, ground truth, answers, verdicts, and gaps.
