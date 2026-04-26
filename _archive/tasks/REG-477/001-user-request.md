# User Request: REG-477

**Date:** 2026-02-16
**Workflow:** Full MLA
**Source:** REG-477 (Linear)

## Request

REG-477: ANALYSIS phase performance — O(services × plugins × all_modules) bottleneck.

User request: "По полному MLA, попроси Кнута проверить где у нас цикломатическая сложность необоснованно зашкаливает."

## Context

The Linear issue describes a critical performance bottleneck in the ANALYSIS phase:
- Analysis runs per-service, but analyzers query ALL modules globally
- O(services × plugins × all_modules) complexity
- 745 services × 15 plugins = 11,175 plugin executions
- JSASTAnalyzer queries all modules per service (69k nodes × 5 times even on Grafema itself)
- Projected ~4 hours for full analysis on user's project

Three proposed fixes in the issue:
- Fix A: Run ANALYSIS globally, not per-service (biggest win)
- Fix B: Cache module list in plugin context
- Fix C: Plugin applicability filter

## Special Instructions

User specifically requested Donald Knuth to analyze cyclomatic complexity hot spots before proceeding with Full MLA planning.
