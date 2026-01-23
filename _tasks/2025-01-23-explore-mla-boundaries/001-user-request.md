Read the skill at `_skills/explore.md` and execute it fully.

## Topic

Multi-Lens Analysis (MLA) — a decision-making methodology where:

1. A complex question is examined through multiple fundamentally different "lenses" (different values, different criteria of correctness)
2. These perspectives work **independently** and don't negotiate with each other — each honestly finds its own problems and limitations
3. You synthesize the result yourself: if all converge — strong decision; if not — you consciously choose the trade-off and understand its cost

Current implementation: "Zoo Development" with expert personas (Knuth, Jobs, Beck, Torvalds, etc.)

## What to explore

1. **Boundaries of applicability**
   - Where does MLA work well? (complex decisions, architectural choices, strategy)
   - Where does it NOT work? (simple tasks, time-critical, well-defined problems)
   - At what scale does it become overhead vs value?

2. **Theoretical foundations**
   - What existing methodologies is this related to? (dialectics, Six Hats, Red Team, Delphi)
   - What's actually novel here, if anything?
   - Is there research on adversarial/multi-perspective reasoning?

3. **Push to extremes — reductio ad absurdum**
   - What if we use 20 lenses instead of 5? Diminishing returns? Noise?
   - What if lenses are too similar? Too different?
   - What if we apply MLA to trivial decisions? ("Should I use tabs or spaces?" analyzed by 5 experts)
   - What if we apply MLA recursively? (MLA to decide which lenses to use for MLA)
   - What if lenses genuinely cannot converge? Paralysis?

4. **Failure modes**
   - When does independence break down?
   - Can personas "hallucinate" problems that don't exist?
   - Authority bias — do we trust Feynman more than Sheldon regardless of content?
   - What if the synthesis step introduces bias that negates the independence?

5. **Optimal conditions**
   - Minimum viable team (2 lenses? 3?)
   - Maximum useful team (after N lenses, noise > signal?)
   - How to select lenses for a given problem type?
   - When to stop exploring and start deciding?

## Output

Full explore process with all 5 expert reports + synthesis + conclusions about MLA's boundaries.

Be ruthless. If MLA is bullshit dressed up in fancy methodology, say so. If it's genuinely useful but only in narrow conditions, define those conditions precisely.
