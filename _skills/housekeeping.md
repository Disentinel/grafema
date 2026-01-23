# Skill: Housekeeping

Repository maintenance: structure, documentation, consistency.

## When to use

- Preparing for release / Early Access
- Contributor onboarding is difficult
- "Can't find where things are"
- Technical clutter has accumulated

## Team

| Role | Persona | Lens |
|------|---------|------|
| Declutter | **Marie Kondo** | What to remove? Does this spark joy / serve a purpose? If not — remove |
| Systems | **David Allen** | Where should this live? Every file in its proper place, inbox zero |
| Structure | **Edward Tufte** | How to show structure clearly? Maximum meaning, minimum noise |
| Newcomer | **Steve Krug** | Opened repo for first time — clear where to go within 5 minutes? |

## Process

### 1. Audit (all in parallel)

Each expert analyzes current repo state and writes a report:

**Kondo** looks at:
- Files that aren't used
- Duplication
- "Might be useful someday" that never was
- Empty or near-empty directories

**Allen** looks at:
- Files not in their proper place
- Missing clear structure (where are docs? scripts? config?)
- Naming conventions (consistency)
- README in each significant directory

**Tufte** looks at:
- Can you understand project structure in 30 seconds?
- Visual hierarchy in README
- Redundancy vs insufficiency of information

**Krug** looks at:
- Scenario: "Want to understand what this project is" — path clear?
- Scenario: "Want to run locally" — path clear?
- Scenario: "Want to contribute" — path clear?
- What raises "what's this?" questions

### 2. Synthesis

Collect findings from all experts:
- What everyone agrees to delete → delete
- What everyone agrees to move → move
- Contradictions → discuss with user

### 3. Execution

- Atomic commits (one logical change = one commit)
- Don't mix deletion, moving, and creation
- After each step — verify nothing broke

### 4. Verification (Krug)

Final pass through newcomer eyes:
- Open repo as if for the first time
- Walk through main scenarios
- If something unclear — iterate

## Artifacts

```
_tasks/YYYY-MM-DD-housekeeping-name/
├── 001-user-request.md
├── 002-kondo-audit.md
├── 003-allen-audit.md
├── 004-tufte-audit.md
├── 005-krug-audit.md
├── 006-synthesis.md
├── 007-execution-log.md
└── 008-krug-final-review.md
```

## Principles

- **Deletion > moving > adding** — remove clutter first
- **Consistency over perfection** — uniformly "good" beats sporadically "excellent"
- **README is directory UI** — no README means directory is "mute"
- **Don't optimize prematurely** — order is for humans, not abstract beauty
