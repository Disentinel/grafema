# Onboarding Target State

What "fully onboarded" means. Each aspect has a metric the agent can compute.

## Coverage Metrics

| Aspect | Metric | How to compute | 0% | 100% |
|--------|--------|----------------|-----|------|
| **Config** | analyzed_files / total_source_files | get_coverage | No files analyzed | All source files in graph |
| **Features** | named_features / total_entry_points | find_nodes(type=FEATURE) vs entry points | 0 features | Every entry point → named FEATURE |
| **Components** | assigned_modules / total_domain_modules | modules with COMPONENT parent / total | No clusters | All domain modules in COMPONENTs |
| **Capabilities** | mapped_features / total_features | features with CAPABILITY parent | No mapping | FEATURE → CAPABILITY → PRODUCT |
| **Ownership** | owned_components / total_components | components with DOMAIN + OWNS edge | No teams | Every component has team |
| **Custom patterns** | resolved_calls / total_calls | unresolved external calls ratio | Many unresolved | Custom ORM/DSL/bus handled by plugins |
| **Intent** | decisions_count / high_cogload_functions | KB DECISION nodes for CogLoad > p75 | No decisions | Key functions have captured rationale |
| **Guarantees** | guarantee_count | .grafema/guarantees.yaml rules | 0 rules | Key invariants codified |
| **Effects** | annotated_functions / total_functions | functions with effect != UNKNOWN | Auto-only | Project-specific libs annotated |
| **Bus factor** | computed_components / total_components | components with git contributor analysis | Unknown | All components have bus factor score |

## Onboarding Score

```
OnboardingScore = weighted_avg(aspect_coverages)

Weights (default):
  config: 0.20       — without this, nothing works
  features: 0.15     — core structural understanding
  components: 0.10   — grouping
  custom_patterns: 0.15 — graph accuracy
  intent: 0.10       — knowledge preservation
  guarantees: 0.10   — automated safety
  ownership: 0.05    — team context (0 for solo)
  capabilities: 0.05 — product mapping
  effects: 0.05      — effect accuracy
  bus_factor: 0.05   — risk awareness (0 for solo)
```

Solo dev: ownership + bus_factor weights redistribute to features + custom_patterns.

## Phase Completion Thresholds

| Phase | Aspect | Threshold to proceed |
|-------|--------|---------------------|
| 1. Config | config coverage | > 80% files analyzed |
| 2. Discovery | features | > 0 features detected |
| 3. Validation | features named | > 60% features validated |
| 4. Plugins | custom patterns | unresolved < 30% |
| 5. Ownership | ownership | > 50% components owned |
| 6. Intent | intent | > 30% high-CogLoad covered |
| 7. Guarantees | guarantees | >= 3 rules defined |
| 8. Verify | overall score | report generated |

Thresholds are "good enough to move on", not "done forever." Each phase can be revisited.

## State Persistence

Progress stored in `.grafema/onboarding-state.yaml`:

```yaml
version: 1
started: "2026-04-04"
last_session: "2026-04-04"
project_type: team  # solo | team | unknown
user_goal: "new team members take 3 months to onboard"
phases:
  config: { status: complete, coverage: 0.94 }
  discovery: { status: complete, features: 17, components: 4 }
  validation: { status: in_progress, validated: 12, total: 17 }
  plugins: { status: pending, written: 0 }
  ownership: { status: pending }
  intent: { status: pending }
  guarantees: { status: pending }
  verify: { status: pending }
pending_tasks:
  - "Ask Alice about payments↔orders coupling history (REG-XXX)"
  - "Investigate dead code in workers/legacy-sync.ts"
```

Agent reads this on `--continue` and resumes exactly where it left off.
