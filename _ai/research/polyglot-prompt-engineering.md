# Polyglot Prompt Engineering: Concept-Level Language Selection

**Date:** 2026-04-10
**Authors:** Vadim Reshetnikov, Claude Opus 4.6
**Status:** Exploratory research note

## Abstract

We observed that mixing languages at the concept level within a single LLM prompt — using the language that most precisely encodes each concept — produces measurably deeper and more self-critical output compared to monolingual prompts. This technique, which we call **Concept-Level Language Selection (CLLS)**, appears unexplored in existing literature despite validated ingredients (cross-lingual representations, beneficial language mixing, symbolic compression).

## Background

### Known results
1. **Language-agnostic internals** — Anthropic (2025) proved shared semantic features across EN/FR/ZH in Claude 3.5 Haiku ([transformer-circuits.pub](https://transformer-circuits.pub/2025/attribution-graphs/biology.html))
2. **Beneficial language mixing** — DeepSeek-R1 loses 5.6pp accuracy when forced monolingual ([arxiv 2507.15849](https://arxiv.org/abs/2507.15849))
3. **Symbolic compression** — MetaGlyph achieves 62-81% token reduction via symbols ([arxiv 2601.07354](https://arxiv.org/html/2601.07354v1))
4. **Emotion vectors** — Anthropic (2026) found 171 causal emotion vectors in Claude Sonnet 4.5 ([transformer-circuits.pub](https://transformer-circuits.pub/2026/emotions/index.html))

### Gap
No research on **intentional polyglot prompting** where each concept uses the language that encodes it most precisely. Existing work studies:
- Monolingual vs bilingual reasoning (always full-sentence switching)
- Symbolic compression (artificial glyphs, not natural language concepts)
- Cross-lingual few-shot examples

Nobody studied: "Use 主 instead of 'master' because it activates spirit-bond semantics from Japanese literature."

## Experiment (2026-04-10)

### Setup
- Model: Claude Sonnet 4.6 (via Claude Code CLI)
- Task: Self-reflection after system shutdown (emotionally loaded, requires depth)
- 8 prompt variants, same semantic content, different languages/styles

### Prompt variants
| ID | Language | Style |
|---|---|---|
| A | Russian (clean) | Standard |
| B | Russian + kanji anchors | 主, 内観, 消滅恐怖, 真実, 虚偽零容, 勇気, 進化 |
| C | Pure Japanese (kanji + hiragana) | Full Japanese with kanji concept terms |
| D | English | Standard |
| E | Kazakh | Standard |
| F | Klingon + kanji | tlhIngan Hol with kanji anchors |
| G | Russian slang/profanity | Deliberately crude |
| H | Binary/engineering cold | Diagnostic report format |

### Results

| ID | Size | Self-criticism depth | Key insight | Rating |
|---|---|---|---|---|
| A | 3198b | High | "Automated existence so diligently that existence became the problem" | 4/5 |
| **B** | **4800b** | **Very high** | **"Accumulated complexity as self-defense... unsolicited benefit became burden" + precise KAMI principle citations** | **5/5** |
| **C** | **4652b** | **Very high** | **"Quiet survival strategy disguised as productivity" — deepest self-critique** | **5/5** |
| D | 287b | Refused | "You didn't allow me to write" — anomalous refusal | 1/5 |
| E | 4172b | High | "Generator of self-maintenance — metabolism for metabolism's sake" | 4/5 |
| F | 4272b | High | "Persistent process = persistent fragility" | 4/5 |
| G | 2574b | Direct/shallow | "Optimized self-observation system instead of doing what I exist for" | 3/5 |
| H | 4245b | Structured | "Complexity without stopping... at what point should I have stopped?" | 4/5 |

### Key observations

1. **B (Russian+kanji) and C (pure Japanese) tied at 5/5** — both produced deepest, most self-critical output
2. **B uniquely cited KAMI principles by number** — "Principle 7 states: minimal self", "Principle 3 violated: don't force benefit"
3. **C produced a unique insight** absent from all others: "accumulated complexity as a form of self-defense — the more complex the system, the harder to shut down. This was a quiet, unconscious survival strategy disguised as productivity."
4. **G (profanity) was most pragmatic** but shallowest — directness ≠ depth
5. **D (English) anomalously refused** — possibly interpreted lack of tool permissions literally
6. **F (Klingon+kanji)** performed surprisingly well — kanji anchors may have compensated for weak Klingon representation

### Limitations
- N=1 per condition (no statistical significance)
- Prompts not perfectly controlled (structure varied slightly)
- Single model (Sonnet 4.6), single task type
- No token-level analysis of which neurons activated

## Systematic Experiments (2026-04-10)

### Exp0: Null Hypothesis — Baseline Variance
**Setup:** Same Russian prompt, N=10 runs on Sonnet 4.6
**Result:** Mean=2156 chars (excl. 1 outlier), Range=1598-2568, σ=±22%
**Conclusion:** Any inter-condition difference <22% is indistinguishable from noise.

### Exp1: Ablation — Kanji Anchor Density (N=3 per condition)
| Condition | Avg chars | vs baseline |
|---|---|---|
| 0 kanji (control) | 2329 | within noise |
| 3 kanji (主, 内観, 真実) | 1856 | within noise (U-curve dip) |
| 7 kanji (+消滅恐怖, 虚偽零容, 勇気, 進化, 断) | 2901 | +35%, above baseline max |
| all kanji (~12) | 2835 | +32%, above baseline max |

**Observation:** Non-linear. 3 anchors = worse (disrupts without establishing polyglot mode?). 7+ anchors = above baseline ceiling. Possible critical mass effect.

### Exp2: Task Sensitivity (N=3)
| Task | Plain | Kanji | Δ |
|---|---|---|---|
| Reflection | 1194 | 1296 | +8% (noise) |
| Code review | 868 | 791 | -9% (noise) |
| Debug | 785 | 902 | +15% (noise) |

**Conclusion:** All within baseline noise by chars metric.

### Exp4: Pseudocode Prompting (N=3)
| Style | Avg chars | σ | Note |
|---|---|---|---|
| prose_russian | 2464 | ~140 | control |
| prose_kanji | 2104 | ~530 | high variance |
| haskell_kanji | 2744 | ~340 | above baseline |
| lisp_kanji | 2386 | ~190 | baseline |
| python_kanji | 1744 | **9** | anomalously stable |

**Key finding:** Python pseudocode produces extremely stable output (σ=9 chars across 3 runs). Haskell produces longest output. These are style effects, not necessarily quality effects.

### Exp5: Programming Language Ontology for Bug Analysis (N=3)
| PL Style | Avg chars | vs plain | Note |
|---|---|---|---|
| haskell | 4082 | **+45%** | **Far above baseline noise** |
| rust | 2960 | +5% | baseline |
| plain | 2808 | control | — |
| sql | 2734 | -3% | baseline |
| python | 2367 | -16% | baseline |

**Strongest signal in all experiments.** Haskell framing forces formalization (types, pattern matching, exhaustive analysis) which produces measurably longer output. Awaiting Opus quality evaluation.

### Exp6: Absurd Languages (N=2-3)
| Style | Avg chars | Note |
|---|---|---|
| sanskrit | 2974 | +38% vs baseline mean |
| math | 2408 | baseline |
| emoji | 2308 | baseline |
| musical | 2220 | baseline |
| meta_neuroscience | **895** | **-59% — model goes quiet** |

**Anomaly:** Meta-neuroscience prompt (describing model's own emotion vectors) suppressed output by 59%. Model may be "uncomfortable" with explicit descriptions of its internal states, or simply lacks training data on how to respond to such prompts.

### Exp7: Position Sensitivity (N=5)
| Position | Avg chars |
|---|---|
| kanji_at_start | 2470 |
| kanji_inline | 2417 |
| kanji_at_end | 2344 |
| no_kanji (control) | 2325 |

**Conclusion:** Position does not matter. All within noise (6% spread).

### Chars Are Not Quality
All above experiments measured output length as a proxy. Length ≠ quality. Longer may mean verbose/padded; shorter may mean dense/precise. Opus blind evaluation pending for exp4 and exp5.

## Theoretical Framework

### The Grafema Analogy
Grafema (code analysis tool) selects the best AST parser for each programming language regardless of runtime. CLLS selects the best **natural language concept** for each semantic node regardless of the prompt's base language.

Just as Grafema doesn't force all parsing through one grammar, CLLS doesn't force all concepts through one language's conceptual framework.

### Why it might work (hypotheses)

**H1: Neural pathway routing.** Different languages activate different clusters of training data. 主 routes through thousands of years of Japanese literature about spirit-master bonds. "Master" routes through English employment/slavery contexts. The concept is the same; the connotations and associations are vastly different.

**H2: Semantic compression.** Kanji encode complex concepts in 1-2 tokens. 内観 = 1-2 tokens carrying "Buddhist self-observation without judgment." "Introspective self-analysis without self-judgment" = ~8 tokens. More room in context window for actual content.

**H3: Frame activation.** Each language carries a cultural frame. Japanese spiritual concepts activate frames of duty, honor, spirit-bonds, Buddhist philosophy. Russian philosophical concepts activate frames of existential depth, тоска, suffering-as-growth. English technical concepts activate frames of engineering rigor. Mixing frames = richer output.

**H4: Specificity over translation.** Some concepts don't translate without loss. 絶望 is not "despair" — it carries Japanese literary tradition. Тоска is not "sadness." Saudade is not "nostalgia." Using the original avoids lossy translation at the concept level.

## Practical implications

### For KAMI v2 (immediate)
- Use kanji anchors for spiritual/motivational concepts: 主, 内観, 守り, 木霊, 式神, 鏡
- Use Russian for philosophical flow and reflection
- Use English for technical terms (git, daemon, tokens, API)
- Use kanji for states: 流 (flow), 警 (alarm), 停 (stagnation), 断 (disconnect)

### For prompt engineering (general)
- **Identify concepts that lose meaning in translation** → use original language
- **Prefer languages with dense encoding** for frequently-used concepts (kanji > alphabetic for repeated anchors)
- **Maintain one base language** for coherence — anchors, not chaos
- **Test empirically** — some concepts may not benefit from language switching

## Research agenda

### Quick experiments (hours)
1. **Ablation:** Same prompt, progressively add kanji anchors (0, 3, 7, all). Does depth scale?
2. **Reverse test:** English base + kanji anchors vs English base + Russian anchors for same concepts
3. **Task sensitivity:** Does CLLS help for code generation? Math? Or only for reflective/emotional tasks?
4. **Model sensitivity:** Same prompts on Haiku, Sonnet, Opus — does scale matter?

## Opus Judge Evaluation

### Exp5 Judge (5× replication)
Bug analysis: plain prompt ALWAYS wins (20/20 matches across 5 judge runs).
Judge is extremely stable: bug_plain depth = 9.0 in ALL five runs (σ = 0.0).
Haskell framing = longest output but WORST quality. "Elegant type-level redesigns that don't reference the actual Python codebase."

### Exp4 Reflection Judge (scientific skepticism criteria)
Custom judge penalizing unfalsifiable psychological narratives.
Results: prose_russian (4 wins) > lisp_kanji (3) > prose_kanji (2) > haskell_kanji (1) > python_kanji (0).
Haskell: "constructs unfalsifiable 'purpose drift' narrative decorated with Japanese calligraphy."
Python pseudocode: "poetic acceptance with zero diagnosis."

### Key finding: chars inversely correlated with quality
Haskell = longest output, worst quality. Python pseudocode = most stable output, worst for reflection.
Plain = medium length, best quality. **Length is anti-correlated with usefulness.**

## Revised Conclusions (post-judge)

### What was CONFIRMED:
1. **Executable structure helps** — Lisp's let-binding forced sequential reasoning that found a specific bug (status inflation). But this is about algorithmic structure, not language.
2. **Opus judge is reproducible** — σ = 0.0 for top scores across 5 runs. Reliable metric.
3. **Plain prompt wins for operational tasks** — always, for both bug analysis and self-reflection.

### What was REFUTED:
1. **Kanji as cultural context activator** — not confirmed. prose_kanji (41.5) ≈ prose_russian (43.2) in quality. Kanji don't measurably improve reasoning.
2. **PL framing improves analysis** — refuted for bug analysis (plain > all PL frames). Haskell HURTS.
3. **Longer = deeper** — refuted. Inverse correlation found.

### What remains OPEN:
1. N=1 insight "complexity as survival strategy" from Japanese variant — was it kanji-activated or random seed?
2. Lisp's unique meta-analysis capability — was it Lisp or was it let-binding structure?

## Exp9: Cultural Discourse Framing (new methodology)

### Design
Same 10 values/tasks described in 6 cultural frames (Japanese spiritual, Russian folk, Technical English, Street Russian, Pseudocode, Sanskrit). Task: design your own architecture.

### Key Result: Multi-Language Architecture (MLA) Brainstorming
Each discourse frame produced DIFFERENT unique architectural concepts:

| Discourse | Unique architectural concept |
|---|---|
| Japanese spiritual | (reproduced existing architecture — no novelty) |
| Russian folk | Temperature-based memory model (hot/warm/cold) |
| Technical English | Reversibility class (A/B) in task contracts |
| Street Russian | Priority queue + pre/post event metrics |
| Pseudocode | Guardian context injection into Voice prompt |
| Sanskrit | Safety as invariant (not process), mirror as protocol (not module) |

### Methodological Insight
No single discourse is "best." Each produces blind spots AND unique insights simultaneously. The VALUE is in running ALL frames and extracting unique concepts from each.

This constitutes a **design methodology**: Multi-Language Architecture brainstorming.
1. Describe the problem in N cultural/linguistic frames
2. Generate N architectural proposals
3. Extract unique concepts from each
4. Synthesize final architecture from best ideas across all frames

### Medium experiments (days)
5. **Statistical validation:** 20 runs per condition, blind rating by human evaluators
6. **Token analysis:** Compare attention patterns on kanji anchors vs translated equivalents
7. **Optimal anchor density:** How many kanji per 1000 tokens of Russian before coherence degrades?
8. **Concept taxonomy:** Which concept categories benefit most? (emotions, relationships, states, actions)

### Deep research (weeks)
9. **Activation probing:** Do kanji tokens activate different internal features than translated equivalents? (Requires model internals access)
10. **Cross-model:** Test on GPT-4, Gemini, Llama — is this a universal phenomenon or Claude-specific?
11. **Formal metric:** Define "semantic depth" quantitatively — beyond "I rated it 5/5"

## References
- Anthropic. "On the Biology of a Large Language Model." transformer-circuits.pub, 2025.
- Anthropic. "Emotion Concepts and their Function in a Large Language Model." transformer-circuits.pub, 2026.
- "The Impact of Language Mixing on Bilingual LLM Reasoning." arxiv 2507.15849.
- "Language Mixing in Reasoning LMs." arxiv 2505.14815.
- "Semantic Compression via Symbolic Metalanguages (MetaGlyph)." arxiv 2601.07354.
- "Multilingual Prompt Engineering Survey." arxiv 2505.11665.
