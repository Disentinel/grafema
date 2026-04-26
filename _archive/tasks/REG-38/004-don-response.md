# REG-38: Don Melton Response to Steve Jobs Review

**Author:** Don Melton (Tech Lead)
**Date:** 2026-02-06
**Status:** Response to REJECT

---

## 1. Acknowledgment

Steve is right. Identity resolution IS the core problem, and I punted on it.

Looking back at my analysis, I identified it as an "open question" when it's actually THE question. Everything else I wrote - the plugin architecture, the namespace conventions, the cross-layer edges - is meaningless if we can't reliably link code to infrastructure.

I wrote: "Container image name matching service name" as if that's a strategy. It's not. It's hand-waving. Steve called it correctly.

---

## 2. Research: How Others Solve Identity Resolution

### 2.1 Backstage: Explicit Annotations (Catalog-First)

Backstage solves identity resolution by **requiring explicit annotations**. Their approach:

1. Code repository must contain `catalog-info.yaml` with:
   ```yaml
   metadata:
     annotations:
       backstage.io/kubernetes-id: my-service
   ```

2. Kubernetes resources must have matching label:
   ```yaml
   metadata:
     labels:
       backstage.io/kubernetes-id: my-service
   ```

3. Matching is **exact string equality** - no fuzzy matching, no heuristics.

**Key insight:** Backstage doesn't solve automatic discovery. They punt to explicit configuration. This works for Backstage because they're a catalog (users define entities). It doesn't work for Grafema because we're an analysis tool (we discover entities).

**Failure mode:** If annotations are missing or mismatched, Backstage shows nothing. Users must manually configure.

Source: [Backstage Kubernetes Configuration](https://backstage.io/docs/features/kubernetes/configuration/)

### 2.2 ArgoCD/Flux: Git as Source of Truth

GitOps tools (ArgoCD, Flux) solve identity resolution differently:

1. User explicitly configures which Git path maps to which cluster/namespace
2. ArgoCD Application CRD specifies:
   ```yaml
   source:
     repoURL: https://github.com/org/repo
     path: k8s/my-service
   ```

3. No automatic discovery - user declares the mapping

**Key insight:** GitOps tools require user to declare relationships. They don't infer them.

Source: [ArgoCD Documentation](https://argo-cd.readthedocs.io/en/stable/)

### 2.3 Academic Research: Static Architecture Recovery

The most relevant research comes from a 2024-2025 study comparing 13 static analysis tools for microservice architecture recovery ([Springer](https://link.springer.com/article/10.1007/s10664-025-10686-2)):

**Best individual tool:** Code2DFD with F1=0.86 (precision=0.93, recall=0.80)

**What they use for service detection:**
- Folder structure (root directories = services)
- Java annotations (`@RequestMapping`, `@FeignClient`)
- Deployment files (Docker Compose, k8s manifests)
- Naming conventions

**Connection detection performance:**
| Tool | F1 | Precision | Recall |
|------|-----|-----------|--------|
| Code2DFD | 0.87 | 0.92 | 0.83 |
| MicroDepGraph | 0.67 | 0.99 | 0.59 |
| Attack Graph Generator | 0.54 | - | - |

**Critical finding:** "Inaccurate heuristics are the biggest causes of false positives" (Lesson Learned 4 from the study).

**Failure modes:**
- 5 of 8 tools detected ZERO connections despite successful execution
- Tools designed for Java Spring failed on other frameworks
- Language/framework specificity killed generalization

Source: [arXiv:2412.08352](https://arxiv.org/html/2412.08352v1)

### 2.4 Service Mesh: Runtime Discovery

Istio and Linkerd solve service identity at runtime:
- Automatic service discovery when pods are deployed
- Certificate-based identity (workload identity)
- Tracing headers propagate across service calls

**Key insight:** Service meshes have runtime information we don't. They see actual traffic. We only see code and config files.

Source: [Istio Service Discovery](https://www.glukhov.org/post/2025/10/service-mesh-with-istio-and-linkerd/)

### 2.5 AWS SAM/CDK: Co-location Convention

AWS SAM collocates code and infrastructure:
```
my-lambda/
  app.py           # Code
  template.yaml    # Infrastructure (SAM)
```

The handler property in template.yaml explicitly references code:
```yaml
Resources:
  MyFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: app.lambda_handler  # Explicit reference
```

**Key insight:** SAM works because infrastructure explicitly references code paths.

Source: [AWS SAM Documentation](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html)

---

## 3. Concrete Identity Resolution Algorithm

Based on research, here's a concrete algorithm - not heuristics, but a prioritized cascade:

### 3.1 Resolution Strategy: Explicit > Conventional > Inferred

```
IDENTITY RESOLUTION PROTOCOL

Input:
  - Code analysis (SERVICE nodes with metadata)
  - Infrastructure files (k8s, terraform, etc.)

Output:
  - Identity mappings [(code_id, infra_id, confidence, reason)]

PHASE 1: EXPLICIT RESOLUTION (Confidence: 1.0)

  For each infra resource I:
    1. Check for grafema annotation:
       metadata.annotations["grafema.io/service-id"] -> code_service_id

    2. Check for code path reference:
       spec.containers[].env[].GRAFEMA_SERVICE_PATH -> directory

    3. Check for explicit handler reference (SAM-style):
       spec.handler / spec.main / spec.entrypoint -> file:function

  If found: emit (code_id, infra_id, 1.0, "explicit_annotation")

PHASE 2: CONVENTIONAL RESOLUTION (Confidence: 0.8)

  Strategy 2a: Directory structure alignment
    Convention: services/{name}/ <-> k8s/{name}.yaml

    For each SERVICE S in code at path services/{name}/:
      Look for infra at:
        - k8s/{name}.yaml
        - k8s/{name}/*.yaml
        - kubernetes/{name}.yaml
        - deploy/{name}.yaml
        - .k8s/{name}.yaml

    If found: emit (S.id, I.id, 0.8, "directory_convention")

  Strategy 2b: Name equality
    SERVICE.name == Deployment.metadata.name

    For each SERVICE S:
      For each Deployment D:
        If normalize(S.name) == normalize(D.name):
          emit (S.id, D.id, 0.8, "name_match")

  Strategy 2c: Package.json name match
    package.json#name == Deployment.metadata.name

    Complexity: O(services * deployments) = O(s * d)
    Typically s < 50, d < 50, so O(2500) max

PHASE 3: INFERRED RESOLUTION (Confidence: 0.5-0.7)

  Strategy 3a: Image name contains service directory
    Deployment.spec.containers[].image contains SERVICE.directory.name

    Example: image "org/user-service:v1" matches services/user-service/

    Confidence: 0.7 if exact substring, 0.5 if fuzzy

  Strategy 3b: Port alignment
    SERVICE exposes http:route on port X
    Deployment.spec.containers[].ports[].containerPort == X

    Only use when single service matches single deployment by port
    Confidence: 0.6

  Strategy 3c: Environment variable correlation
    SERVICE reads env var FOO_URL
    Deployment.spec.containers[].env[].name == "FOO_URL"

    Confidence: 0.5 (weak signal, corroborative only)

PHASE 4: AMBIGUITY RESOLUTION

  If multiple candidates with same confidence:
    1. Prefer directory-adjacent (code and infra in same monorepo)
    2. Prefer same Git repository over different repos
    3. If still ambiguous: emit ALL candidates with "ambiguous" flag

  If zero candidates after all phases:
    emit (code_id, null, 0.0, "unresolved")
    Create ISSUE node: "Service {name} has no infrastructure mapping"

OUTPUT FORMAT

  For each resolution:
    {
      code_id: string,
      infra_id: string | null,
      confidence: 0.0-1.0,
      reason: "explicit_annotation" | "directory_convention" | "name_match" | ...,
      alternatives: [{infra_id, confidence, reason}],  // if ambiguous
    }
```

### 3.2 Complexity Analysis

| Phase | Complexity | Typical Scale |
|-------|------------|---------------|
| Phase 1 (Explicit) | O(i) | i = infra resources, ~50-200 |
| Phase 2 (Conventional) | O(s * d) | s = services, d = deployments, ~2500 |
| Phase 3 (Inferred) | O(s * d * e) | e = env vars per deployment, ~25000 |
| Phase 4 (Ambiguity) | O(a) | a = ambiguous results, ~10-50 |

**Total:** O(s * d * e) = O(n^2 * k) where n = max(services, deployments), k = env vars

For a 100-service monorepo with 100 deployments: ~250,000 comparisons. Acceptable.

### 3.3 Failure Handling

When resolution fails (Phase 4 produces zero candidates):

1. **Create ISSUE node:**
   ```
   type: ISSUE
   severity: warning
   code: UNRESOLVED_INFRASTRUCTURE
   message: "Service 'user-api' has no linked infrastructure"
   ```

2. **Suggest actions in metadata:**
   ```
   suggestions: [
     "Add annotation: grafema.io/service-id: user-api",
     "Create deployment at k8s/user-api.yaml",
     "Configure mapping in grafema.config.yaml"
   ]
   ```

3. **Configuration fallback:**
   ```yaml
   # grafema.config.yaml
   identity:
     mappings:
       - service: "apps/user-api"
         infrastructure: "k8s/backend-api.yaml"
   ```

---

## 4. Answers to Steve's Questions

### Q1: What's your plan for identity resolution?

**Answer:** The 4-phase cascade algorithm above. Priority:
1. Explicit annotations (user declares, Grafema trusts)
2. Conventional patterns (directory alignment, name matching)
3. Inferred signals (image names, ports, env vars)
4. Graceful failure (create ISSUE nodes, suggest fixes)

This is a concrete algorithm, not "heuristics we'll figure out later."

### Q2: Can you name 3 real-world codebases where your proposed matching strategies would work without configuration?

**Honest answer:** I can't guarantee >80% accuracy without testing.

Looking at GitHub:

1. **[microservices-demo](https://github.com/GoogleCloudPlatform/microservices-demo)** - Google's Online Boutique
   - Directory: `src/cartservice/`, `src/frontend/`
   - K8s: `kubernetes-manifests/cartservice.yaml`, `kubernetes-manifests/frontend.yaml`
   - **Strategy 2a (directory convention) would work** - names align

2. **[istio/bookinfo](https://github.com/istio/istio/tree/master/samples/bookinfo)** - Istio sample
   - Directory: `src/productpage/`, `src/reviews/`
   - K8s: `platform/kube/bookinfo.yaml` (single file, multiple deployments)
   - **Strategy 2b (name match) would work** - deployment names match service names

3. **Messy legacy codebases** - I don't have a specific example, but...
   - Image: `my-company/user-svc:v123`
   - Code: `apps/users/`
   - **Strategy 3a (image contains service) would FAIL** - "user-svc" != "users"

**Conclusion:** Strategies work for "clean" codebases with consistent naming. Legacy codebases (Grafema's target) will likely require Phase 1 (explicit annotations) or configuration.

This is why I recommend:
- Support explicit configuration from day 1
- Treat automatic resolution as convenience, not requirement
- Create ISSUE nodes when resolution fails, don't silently skip

### Q3: What happens when identity resolution fails?

**Answer:** Three-tier response:

1. **Create ISSUE node** (always)
   - Queryable: "Show all unresolved services"
   - Reportable: CI can fail on unresolved dependencies

2. **Emit warning during analysis** (configurable)
   ```
   WARNING: Service 'user-api' has no infrastructure mapping
   Suggestions:
     - Add grafema.io/service-id annotation to k8s/backend-api.yaml
     - Add explicit mapping in grafema.config.yaml
   ```

3. **Configuration override** (for teams that want to fix it)
   ```yaml
   identity:
     strict: true  # Fail analysis if any service unresolved
     mappings:
       - service: "apps/user-api"
         infrastructure: "k8s/backend-api.yaml"
   ```

**Never silently skip.** Unresolved = explicit ISSUE node.

### Q4: How do you handle multi-repo scenarios?

**Honest answer:** This is harder, and my initial analysis didn't address it.

Options:

**Option A: Multi-repo workspace (like monorepo)**
```yaml
# grafema.workspace.yaml
repositories:
  - path: ./code-repo
    role: code
  - path: ./k8s-repo
    role: infrastructure
  - path: ./terraform-repo
    role: cloud
```

Grafema analyzes all repos together, identity resolution works across them.

**Problem:** Requires user to set up workspace. Can't "just analyze one repo."

**Option B: Reference resolution via Git URL**
```yaml
# In k8s-repo/deployments/user-api.yaml
metadata:
  annotations:
    grafema.io/source: "github.com/org/code-repo//services/user-api"
```

**Problem:** Requires annotations. Back to explicit linking.

**Option C: Defer multi-repo to Phase 2**

For Phase 1, focus on monorepos and single-repo scenarios. Multi-repo is a separate feature:
- Create Linear issue: "USG: Multi-repo identity resolution"
- Document limitation: "Phase 1 supports monorepos only"
- Don't pretend we handle it when we don't

**My recommendation:** Option C. Multi-repo is a real problem but solving it now is scope creep. Better to ship something that works for monorepos than something that barely works for everything.

### Q5: Why should we build USG now instead of waiting until code layer is more mature?

**Honest answer:** Maybe we shouldn't.

Arguments for building now:
1. HTTPConnectionEnricher proves cross-layer linking pattern works
2. Phase 1 scope is limited (TypeScript + Kubernetes only)
3. Identity resolution spike will validate feasibility quickly

Arguments for waiting:
1. SERVICE detection may not be mature enough (Steve's point)
2. Entrypoint detection isn't formalized
3. Semantic identifier extraction is vague

**My revised recommendation:**

Don't build USG. Build the prerequisites first:

1. **Identity Resolution Spike** (1 week)
   - Test the 4-phase algorithm on 10 real repos
   - If <70% accuracy without config, USG is premature

2. **Code Layer Hardening** (2 weeks)
   - Formalize SERVICE detection (create guarantees)
   - Extract entrypoints (http server, cli, worker)
   - Semantic identifiers in metadata

3. **Then decide:** If spike succeeds and code layer is solid, proceed with USG Phase 1.

---

## 5. Recommendation: Identity Resolution Spike First

**Do not build USG yet.**

Instead, build a focused spike that validates identity resolution:

### Spike Scope

**Input:**
- 10 GitHub repos with code + k8s manifests
- Mix: 3 "clean" repos, 4 "typical" repos, 3 "messy" repos

**Output:**
- Table: (repo, service, deployment, matched?, confidence, strategy_used)
- Accuracy metrics: precision, recall, F1

**Success criteria:**
- F1 > 0.7 without explicit configuration
- F1 > 0.9 with explicit configuration (annotations/config)
- Clear failure modes documented

### Spike Implementation

1. **KubernetesAnalyzer** (minimal)
   - Parse k8s YAML, extract Deployment names/images/ports
   - Don't build full USG infrastructure, just raw data

2. **IdentityResolver** (core)
   - Implement 4-phase cascade algorithm
   - Output: resolution attempts with confidence and reason

3. **Validation script**
   - Compare resolver output to hand-labeled ground truth
   - Calculate precision/recall/F1

### Timeline

- Week 1: Build spike (KubernetesAnalyzer + IdentityResolver)
- Week 1: Label ground truth for 10 repos
- Week 2: Run spike, measure accuracy, document failure modes

### Decision Gate

After spike:
- F1 > 0.7 without config: **Proceed with USG Phase 1**
- F1 0.5-0.7 without config: **Proceed with explicit config emphasis**
- F1 < 0.5: **Defer USG, focus on code layer**

---

## 6. Code Layer Prerequisites

Before USG (even if spike succeeds), harden the code layer:

### 6.1 SERVICE Detection Maturity

**Current state:** SERVICE node type exists, but detection may be ad-hoc.

**Required work:**
1. Create guarantee: "Every http:route must belong to a SERVICE"
2. Test on Grafema's own codebase
3. Document: What defines a service boundary?

### 6.2 Entrypoint Formalization

**Current state:** Unknown. Does Grafema detect entrypoints?

**Required work:**
1. Create ENTRYPOINT metadata on SERVICE nodes
2. Types: http_server, cli_tool, background_worker, cron_job, lambda_handler
3. Test: Can Grafema find all entrypoints in a Express/Fastify/Nest app?

### 6.3 Semantic Identifier Extraction

**Current state:** Module names, export names, route paths exist.

**Required work:**
1. Consolidate into `metadata.serviceIdentifier`:
   - For Express: the app name or package.json name
   - For Lambda: the function name
   - For CLI: the binary name
2. This becomes the "code-side" key for identity resolution

---

## 7. Summary

| Question | Answer |
|----------|--------|
| Is Steve right? | Yes. Identity resolution is the core problem. |
| Do I have a plan? | Yes. 4-phase cascade: explicit > conventional > inferred > failure |
| Will it work? | Unknown. Need spike to validate. |
| Should we build USG now? | No. Build spike first, then decide. |
| What's the MVP? | Identity Resolution Spike (1-2 weeks) |
| What if spike fails? | Defer USG, focus on code layer hardening |

---

## 8. Proposed Next Steps

1. **Create Linear issue:** "REG-XXX: Identity Resolution Spike"
   - Scope: KubernetesAnalyzer (minimal) + IdentityResolver
   - Success metric: F1 > 0.7 on 10 test repos
   - Timeline: 1-2 weeks

2. **Create Linear issue:** "REG-XXX: SERVICE detection hardening"
   - Guarantee: every http:route belongs to SERVICE
   - Test on Grafema codebase

3. **Create Linear issue:** "REG-XXX: Entrypoint formalization"
   - ENTRYPOINT metadata on SERVICE nodes
   - Types: http_server, cli, worker, cron, lambda

4. **Defer USG Phase 1** until spike succeeds and code layer is solid

---

## Sources

- [Backstage Kubernetes Configuration](https://backstage.io/docs/features/kubernetes/configuration/)
- [Backstage Entity Model](https://backstage.io/docs/features/software-catalog/descriptor-format/)
- [ArgoCD Documentation](https://argo-cd.readthedocs.io/en/stable/)
- [Static Analysis Architecture Recovery Tools Comparison (arXiv:2412.08352)](https://arxiv.org/html/2412.08352v1)
- [Springer: Architecture Recovery Tool Comparison](https://link.springer.com/article/10.1007/s10664-025-10686-2)
- [Code2DFD GitHub](https://github.com/tuhh-softsec/code2DFD)
- [AWS SAM Documentation](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/what-is-sam.html)
- [Istio Service Discovery](https://www.glukhov.org/post/2025/10/service-mesh-with-istio-and-linkerd/)
- [Monorepo Microservices with Kubernetes](https://github.com/irahardianto/monorepo-microservices)
- [Google Microservices Demo](https://github.com/GoogleCloudPlatform/microservices-demo)
