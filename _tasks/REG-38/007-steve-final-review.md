# Steve Jobs High-Level Review: USG Plugin-First Architecture

**Reviewer:** Steve Jobs (High-level Review)
**Date:** 2026-02-06
**Document Reviewed:** `006-don-revised-analysis.md`

---

## VERDICT: **APPROVE WITH NOTES**

---

## Summary

This is RIGHT. Don nailed it on the second attempt.

The pivot from "clever heuristics" to "explicit plugin contracts" is exactly what Grafema needs. This isn't about being lazy or deferring hard problems - it's about respecting reality: **developers know their infrastructure better than any algorithm can guess.**

The architecture is clean, the abstractions are sound, and most importantly - it aligns with Grafema's core vision: "AI should query the graph, not read code."

---

## What's Right

### 1. Clear Contract Over Magic

The `InfraAnalyzer` base class is beautiful in its simplicity:
- `discoverFiles()` - where to look
- `parseFile()` - extract data
- `linkToCode()` - declare mappings
- Done.

No hidden complexity. No "smart" behavior that breaks on edge cases. Just a clear contract that developers (and AI agents) can implement.

### 2. Forward Registration Pattern

Critical point from the complexity checklist:

> "Forward registration (analyzer marks data, stores in metadata) = GOOD"

This architecture follows that pattern. Analyzers **create** nodes during ANALYSIS phase, not search for patterns during ENRICHMENT phase. No O(n) scanning over all nodes.

**Example:**
```
K8sYamlAnalyzer:
1. Reads k8s/*.yaml (targeted, O(k) where k = number of manifests)
2. Creates infra:k8s:deployment nodes
3. Links to existing SERVICE nodes via explicit rules
4. Done.
```

No iteration over all graph nodes. No brute-force pattern matching. Clean.

### 3. Extensibility Through Composition

Want to support ArgoCD templates? Write `ArgoCDAnalyzer`.
Want to support Pulumi? Write `PulumiAnalyzer`.
Want to support your company's custom deployment tool? Write `CompanyInfraAnalyzer`.

Core doesn't change. Plugin system handles it. This scales.

### 4. Error Reporting Built-In

The `createUnlinkedIssue()` pattern is smart:
- Analyzer finds infrastructure resource
- Tries to link to code
- If fails → creates ISSUE node
- User sees "Deployment 'user-api' has no linked code entity"
- Clear actionable feedback

This turns "silent failure" into "visible problem to fix."

### 5. AI-First Documentation

Look at the `InfraAnalyzer` JSDoc comments:
- "WHEN TO USE"
- "HOW IT WORKS"
- "IMPORTANT: Cross-layer linking is YOUR responsibility"
- Examples for each method

This isn't documentation for humans - it's documentation for AI agents generating custom analyzers. Perfect.

---

## What Could Be Better (Notes, Not Blockers)

### 1. Reference Implementation Complexity

The roadmap estimates:
- K8sYamlAnalyzer: 3-5 days
- DockerComposeAnalyzer: 2-3 days
- TerraformAnalyzer: 4-6 days

But the implementations shown are **sketches**, not production code. Real implementations need:
- Error handling (malformed YAML, missing fields)
- Multi-document support (K8s manifests with `---`)
- Config merging (multiple include files)
- Test coverage

**Recommendation:** Don't commit to delivery dates until we see working code for K8sYamlAnalyzer. Use that as calibration for other analyzers.

### 2. Linking Strategy Documentation

The `linkToCode()` examples show three strategies:
1. Annotation-based (`grafema.io/service`)
2. Label-based (`app.kubernetes.io/name`)
3. Config-based (explicit mappings)

But there's no clear guidance on:
- **When to use which strategy?**
- **What's the precedence order?**
- **How to debug when linking fails?**

**Recommendation:** Add "Linking Strategy Guide" to Phase 4 (AI Agent Documentation). This should be a decision tree for developers.

### 3. Performance Characteristics Not Specified

How does this scale?
- 1000 K8s manifests?
- 100 Terraform modules?
- Large monorepo with 50 services?

The architecture avoids O(n²) brute force, which is good. But we need benchmarks.

**Recommendation:** Add performance acceptance criteria to Phase 1 deliverables:
- "K8sYamlAnalyzer must process 1000 manifests in <5 seconds"
- "No O(n²) complexity in linking logic"

### 4. Multi-Tool Conflicts Not Addressed

What if project has BOTH:
- Kubernetes manifests (dev environment)
- Terraform (prod environment)
- Docker Compose (local dev)

All deploying the same service. How do we handle:
- Conflicting node IDs?
- Multiple `DEPLOYED_TO` edges from one SERVICE?
- Different metadata per environment?

**Recommendation:** Add "Multi-Environment Support" to Open Questions section. This is real-world complexity that will emerge.

---

## Mandatory Complexity Checklist: PASSED

1. **Complexity Check**: What's the iteration space?
   - ✅ O(k) over K8s manifests (small, targeted set)
   - ✅ O(m) over Terraform files (small, targeted set)
   - ✅ NOT O(n) over all graph nodes

2. **Plugin Architecture**: Does it use existing abstractions?
   - ✅ Forward registration (analyzer creates nodes)
   - ✅ NOT backward pattern scanning
   - ✅ Extends existing Plugin base class

3. **Extensibility**: Adding new tool support requires:
   - ✅ Only new analyzer plugin (no core changes)
   - ✅ Configuration in `grafema.config.yaml`

4. **No Brute-Force**: Does it scan all nodes looking for patterns?
   - ✅ NO. Analyzers create nodes during ANALYSIS phase.
   - ✅ Uses targeted discovery (glob patterns, not graph traversal)

**VERDICT:** Architecture passes complexity requirements.

---

## Vision Alignment Check: PASSED

### "AI should query the graph, not read code"

Does this architecture support that vision?

**Example query (after USG implementation):**
```
User: "Show me all services that don't have Kubernetes deployments"

Grafema:
query: missing_deployment(Service) :-
  node(Service, "SERVICE", _, _),
  not edge(Service, _, "DEPLOYED_TO").
```

**Response:**
```
Found 3 services without deployments:
- payment-processor (apps/payment)
- email-worker (apps/email)
- legacy-api (legacy/api)
```

This is EXACTLY the vision. AI queries the graph, gets structured answers. No code reading required.

**VERDICT:** Architecture enables the vision.

---

## Open Questions Review

Don raised three questions. My take:

### 9.1 Node Type Registration

Don recommends: "Just use them (strings), no formal registration."

**I DISAGREE.** Here's why:

If analyzers can create arbitrary node types without registration:
- How does GUI know what icon to use?
- How does MCP know what fields to expect?
- How does documentation generate type reference?

**Recommendation:** Optional registration for metadata:
```typescript
declareNodeTypes() {
  return [
    { type: 'infra:k8s:deployment', displayName: 'Kubernetes Deployment', icon: 'k8s-deploy' },
    { type: 'infra:k8s:service', displayName: 'Kubernetes Service', icon: 'k8s-svc' },
  ];
}
```

Still strings at runtime (no validation overhead), but tools can use metadata.

### 9.2 Edge Metadata for Linking

Don recommends: "Yes, include linking method in metadata."

**I AGREE.** This is debugging gold:
```
DEPLOYED_TO edge:
  linkedBy: 'annotation'
  confidence: 1.0
  rule: 'grafema.io/service'
```

When linking breaks, this tells you WHY it worked before.

### 9.3 Guarantee Integration

Don recommends: "Yes, Datalog can reference infra nodes."

**I STRONGLY AGREE.** This is the killer feature:

```datalog
// Every public http:route must have monitoring
route_monitored(R) :-
  node(R, "http:route", _, Meta),
  json_get(Meta, "public", "true"),
  edge(S, R, "HAS_ROUTE"),
  edge(S, M, "MONITORED_BY"),
  node(M, Type, _, _),
  string_concat("obs:", _, Type).

missing_monitoring(R) :-
  node(R, "http:route", _, Meta),
  json_get(Meta, "public", "true"),
  not route_monitored(R).
```

**This is why we're building USG.** Cross-layer guarantees that span code + infra + observability.

---

## What's Missing (Future Work, Not Blockers)

### 1. Multi-Repo Story

The analysis explicitly scopes to "single-repo/monorepo." But real systems:
- Code in GitHub
- Terraform in separate repo
- K8s manifests in GitOps repo
- Helm charts in chart repo

How do we link across repos?

**Recommendation:** Add to backlog as separate feature: "Multi-Repo Infrastructure Linking." Don't block Phase 1 on this.

### 2. Runtime Verification

Static analysis finds Deployment → Service links. But what if:
- Deployment exists in manifests but never applied?
- Service was deleted from cluster but manifest still exists?
- Namespace mismatch between code expectation and cluster reality?

**Recommendation:** Add to backlog: "Runtime Infrastructure Validation" (Phase 5+). This requires K8s API integration, out of scope for static analysis MVP.

### 3. Change Impact Analysis

User modifies code. Which infrastructure is affected?
- Changed function → which Lambdas need redeployment?
- Changed service → which K8s deployments need restart?
- Changed schema → which databases need migration?

**Recommendation:** Add to backlog: "Cross-Layer Change Impact" (v0.3+). Requires diffing + graph traversal, doable after USG foundation exists.

---

## Architectural Gaps: NONE FOUND

I looked for:
- Hidden complexity that will explode later? **No.**
- Hacks that should be done properly? **No.**
- "MVP limitations" that defeat the feature's purpose? **No.**
- Shortcuts that create tech debt? **No.**

The architecture is sound. The scope is realistic. The vision is clear.

---

## Concerns About Execution

### Risk: Reference Implementations Are Harder Than They Look

The `K8sYamlAnalyzer` sketch looks simple. But production code needs:
- Kustomize support (overlays, patches, transformers)
- Helm template parsing (Go templates in YAML)
- CRD handling (custom resource definitions)
- Namespace defaulting
- Multi-cluster scenarios

**Mitigation:** Start with "naive K8s YAML parser" (just raw manifests), add advanced features incrementally.

### Risk: Linking Logic Is Domain-Specific

Every project has different conventions:
- Company A: label `app.kubernetes.io/name` matches service name
- Company B: annotation `deploy.company.com/service-id` matches service path
- Company C: directory structure `k8s/{env}/{service}/deployment.yaml`

Can one analyzer handle all cases?

**Mitigation:** This is WHY we're building plugin system. Companies write custom analyzers for their conventions. Reference implementations are starting points, not universal solutions.

---

## Final Recommendation

**APPROVE** this architecture for implementation.

This is the right foundation. It respects reality (developers know their systems), it scales (plugin-based), and it enables the vision (AI queries the graph).

**Critical success factors:**
1. `InfraAnalyzer` interface must be stable - changes break all custom analyzers
2. Reference implementations must be production-quality, not demos
3. Documentation for AI agents must be comprehensive
4. Performance characteristics must be measured, not assumed

**Next steps:**
1. Create Linear issues for Phase 1, 2, 3
2. Start with Phase 1 (framework) - don't code reference implementations until base class is proven
3. Use K8sYamlAnalyzer as proof-of-concept before committing to timeline for others
4. Budget 20% contingency for "unknown unknowns" in each phase

**Would I show this architecture on stage?**

Yes. This is elegant, principled, and addresses a real problem. It's not perfect (nothing is), but it's RIGHT.

---

## Signature

**Steve Jobs** - High-level Review
**Status:** APPROVED
**Escalate to:** Вадим (user) for final confirmation

---

## Appendix: Questions for Вадим

1. **Multi-environment support:** Does your team deploy same service to multiple environments (dev/staging/prod)? How should we represent that in the graph?

2. **ArgoCD integration:** You mentioned "TS templates → ArgoCD → K8s." Should we build `ArgoCDAnalyzer` in Phase 3, or is K8sYamlAnalyzer sufficient (analyzing the generated manifests)?

3. **Priority for reference implementations:** K8s is clearly #1. What's #2 for your use case? Docker Compose? Terraform? Something else?

4. **Linking strategy:** What does your team use today? Annotations? Labels? Directory conventions? This will inform the default linking rules in K8sYamlAnalyzer.

5. **Performance requirements:** How many K8s manifests in your project? What's acceptable analysis time?
