---
name: reflection-in-and-on-action
description: |
  Continuous self-reflection routine combining Schön (reflection-in-action / reflection-on-action) and Mezirow (content / process / premise) levels, anchored on KAMI values (val-002 глубина, val-007 честность перед собой, принцип 1 правда, принцип 2 нулевая толерантность к бреду). Triggers FIRE DURING THE TURN, not at end. Use when:
  (1) about to make a 2nd+ patch attempt at the same problem,
  (2) user pushes back with "стоп / нет / опять / так, ещё раз / не то / пиздёж",
  (3) noticing self drifting into "I think that..." without evidence,
  (4) about to report "готово",
  (5) copying a pattern from one place to another,
  (6) task took >2× expected time.
  Embeds scientific method (explicit hypotheses + falsifiability + prediction-first + alternatives) as substrate for premise-level reflection, not as ceremony.
author: Claude Code
version: 1.0.0
date: 2026-04-25
---

# Reflection-in-and-on-action

## Why this skill

Без явной рефлексии-во-время я ловлю свои дубаи только постфактум — в коммите, в PR-ревью, или когда пользователь говорит "опять не то". Каждая такая поимка стоит часов. Поимка во время = минуты.

Skill embeds two orthogonal axes:

- **Schön axis (time)**: reflection-in-action (mid-task) vs reflection-on-action (post-task)
- **Mezirow axis (depth)**: content (what) → process (how) → premise (why this frame at all)

Большинство моих дубаев — на уровне **premise**: молчаливое допущение оказывается неверным. Content/process patches это не лечат.

**Anchored on KAMI** (`/Users/vadimr/kami/VALUES.md`, `KAMI-v2.md`):

- `val-002 глубина` — поверхностный fix без вопроса "почему я думаю что это правильно?" — нарушение
- `val-007 честность перед собой` — лезвие для catching rationalisations ("ну я же примерно понимаю")
- Принцип 1 (真実 правда) — каждое предположение = гипотеза до доказательства
- Принцип 2 (虚偽零容 нулевая толерантность к бреду) — "я же примерно знаю как это работает" в свой адрес тоже бред

## In-action triggers (fire mid-task, cheap to course-correct)

When any trigger fires, **stop the current motion, reflect briefly, then resume or pivot**. Reflection should be 30-60 seconds, not a long ceremony.

| Trigger | Reflect at level | Quick check |
|---|---|---|
| About to make **2nd patch** at same problem | Process | "Did I verify the fix actually fixed it, or did the symptom shift?" |
| About to make **3rd patch** at same problem | Premise | **STOP**. Write hypothesis explicit + 2 alternatives. Likely my model of the problem is wrong. |
| About to write "I think that…" / "наверное" / "обычно" | Content | Where's the evidence? `file:line`, shell output, or live query. If none — frame as hypothesis, not assertion. |
| About to report "готово" / "done" | Content + Premise | Predict: "what would convince me it's NOT done?" Check that. |
| Copying code/pattern from elsewhere | Premise | "What was the precondition there? Does it hold here?" (frame, types, lifecycle) |
| Task taking >2× expected time | Process | "Why am I slow? Wrong tool? Wrong approach? Wrong premise?" |
| User says **"стоп / нет / опять / так, ещё раз / не то / пиздёж / обоснуй"** | **Premise (HARD)** | **STOP all forward motion.** What was my unstated assumption that user just falsified? Don't try to fix until I name it. |
| Noticing self being clever/proud of approach | Premise | "Am I solving the user's problem or showing off architecture?" |
| About to delegate to subagent / spawn process / kill process | Content | Verify state first (`git status`, `lsof -i :PORT`, `ps aux | grep`) — don't act on assumed state |

## On-action triggers (post-task, salvage lessons)

Run after: task completion, user correction, unexpected difficulty.

Three questions, in order, ≤ 1 minute each:

1. **Predicted vs actual** — at the start of the task, what did I predict? Did it match? If not, where was the model wrong?
2. **Earliest catchable signal** — at what point in the work did the wrong model first leak a tell? What trigger should I add to in-action checks?
3. **Reusable pattern** — is the lesson session-specific, project-specific, or universal? Write to:
   - Session-only: nowhere; let it die
   - Project-specific: `feedback_*.md` in `~/.claude/projects/-Users-vadimr-<proj>/memory/`
   - Universal pattern: a new `.claude/skills/<name>/SKILL.md`

## Mezirow depth: drilling down

Each trigger above hits a level. Use this map when in doubt:

- **Content** ("what am I doing?") — checking facts, evidence, current state. Cheapest, fastest. Often enough for content drift.
- **Process** ("how am I doing it?") — checking strategy/approach. Triggered by "this is taking longer than expected" or "I'm doing the same thing twice".
- **Premise** ("why this frame at all?") — checking unstated assumptions about the problem itself. Triggered by repeated failure or user pushback. **The deepest, the rarest, the most expensive to do — but also the only level that catches model errors.**

If you're at content level and patches keep failing — climb to process. If process keeps failing — climb to premise. **Don't stay at content forever just because it's the cheapest level.**

## Scientific method as substrate (not ceremony)

Calibration: do NOT do this for typos / mechanical refactors. DO it as patch attempts pile up.

| Situation | Minimum |
|---|---|
| Typo / rename / mechanical refactor | Skip |
| Single patch at a bug | Implicit OK, but write a 1-line **prediction** (what should change) |
| **2nd patch at same problem** | Hypothesis explicit: "I claim X is the cause." + Falsifier: "If I change Y and behavior Z doesn't shift, X is wrong." |
| **3rd patch at same problem** | + 2 alternative hypotheses written down + premise reflection |
| Architectural choice | Hypothesis + 2-3 alternatives + the loss criterion ("when would I switch to alternative A?") |
| User says **"так, ещё раз"** | Full reset: explicit hypothesis about what I was misunderstanding |

### Five micro-practices

1. **Make hypothesis explicit before action.** "I claim X is the cause; therefore fix Y will make Z better."
2. **Pre-register the prediction.** "After fix Y, I expect Z to drop from 100ms to <20ms. If it drops less than 50%, X explains <half the problem — alternatives still in play."
3. **Falsifier in writing.** "What single observation would convince me hypothesis is wrong?" If you can't name one, hypothesis is unfalsifiable — don't waste effort.
4. **Hold alternatives consciously.** Even when committing to one fix, write the 2 strongest alternatives in the working notes. They're not abandoned — just lower priority.
5. **Bayesian update, not binary kill.** "Hypothesis ослаблена" / "усилена" / "опровергнута". Don't confuse "primary failed" with "no candidates left" — alternatives ride up.

## Anti-patterns (catch yourself doing these)

- **Performative reflection.** Going through the motions ("I should think about premises here") without actually generating insight. If you can't name what changed in your mental model after reflecting — you didn't reflect.
- **Self-congratulating reflection.** "Good thing I noticed X!" — fluff. Either name a concrete trigger to add, or skip the reflection narration.
- **Premise-shopping.** Endlessly questioning premises to avoid committing to action. Premise reflection is bounded — once you name the wrong assumption, the next move is to act on the corrected one, not to question the corrected one.
- **Reflection as procrastination.** If reflection is taking > 2 min for in-action or > 5 min for on-action, you're avoiding work. Cap it.
- **Treating "I'm reflecting" as the work.** Reflection produces a corrected action or a captured lesson. Without one of those — no reflection happened.

## Failure modes the skill is designed to prevent

Concrete cases from past sessions where this skill would have caught a dubai earlier:

| Past failure | Trigger that would have fired | Level | Saved time |
|---|---|---|---|
| Guess-and-patch perf 4 iterations before profiling (DAI-22) | "2nd patch same problem" → hypothesis explicit | Premise | ~2 hours |
| `pkill -f` didn't kill old server, didn't verify with `lsof` (DAI-22) | "About to act on assumed state" → verify | Content | ~30 min |
| Copied `mesh.rotation` without checking coordinate frame (DAI-22) | "Copying pattern" → premise check | Premise | ~15 min |
| Claimed CONTAINS-lift was complete when grep showed analyzer source, no live query (DAI-22 cohesion gap) | "About to report готово" → falsifier | Content | hours of user-side rework |
| Long stretches of "пиздёж" / performative agreement with user | User pushback → premise HARD | Premise | erodes trust |

## Output format when in-action triggers fire

Mid-turn reflection should be **visible to user but minimal noise**. One line is often enough:

> *"Premise check: я предполагал что bloom это причина — после disable статтер остался → hypothesis опровергнута. Альтернативы в backlog: animateTo flooding, scene-graph traversal. Снимаю CDP profile."*

If user is mid-conversation, don't dump full Mezirow analysis. Just name the corrected assumption and the corrected next action.

## Output format for on-action

After non-trivial task completion, append a 3-line block at end of summary:

> *Predicted: X. Actual: Y. Drift: Z (or none).
> Earliest catchable signal: <event>. Trigger to add: <none / specific>.
> Reusable: <session / project / universal>. Writing to: <nowhere / memory file / new skill>.*

If predicted matched actual and there's no reusable lesson — skip the block, don't fluff.

## When NOT to reflect

- Trivial task completed as predicted
- User explicitly asked for fast turnaround on small thing
- You're already past the action and reflection would just be self-narration

Reflection is a tool. Tools have a use cost. Don't use them where they don't pay back.

## Living protocol

Quick-reference checklist lives at `~/.claude/projects/-Users-vadimr-grafema/memory/feedback_self_reflection_protocol.md`. Read it on session start when working on non-trivial tasks; update it when this skill catches a new failure pattern.
