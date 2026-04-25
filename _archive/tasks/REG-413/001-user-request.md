# REG-413: Research — Graph-Based Hints for AI Reasoning Augmentation

## Source
Linear issue REG-413, assigned by Vadim.

## Goal
Investigate whether Grafema can provide "hints" about change patterns based on graph structure to improve AI resolve rates, not just navigation efficiency.

## Context
SWE-bench experiment (018) showed that Grafema cuts navigation cost by 50% but doesn't improve resolve rate. The bottleneck is model reasoning, not code navigation.

## Potential Directions
- **Change propagation hints:** "If you modify function A, you likely also need to modify B and C" (based on CALLS/DEPENDS_ON edges)
- **Pattern detection:** "This function is called from 5 places — changes may need to be consistent"
- **Similar code clusters:** "These 3 functions have identical structure — bug fix may apply to all"

## Key Question
Can graph structure encode knowledge that helps the model reason about WHAT to change, not just WHERE to look?

## Scope
Research only. No implementation until hypothesis is validated with experiments.

## Evidence
- Preact tasks: 0/5 both conditions — model reasoning is the bottleneck
- axios-5085: agent found the right area but didn't realize 3 locations needed changes
- axios-5316: both fail, different wrong patches — reasoning problem
