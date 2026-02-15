# Graph Algorithms for Change Hint Generation

**Author:** Robert Tarjan (Research Consultant)
**Date:** 2026-02-15
**Context:** REG-413 — Graph-based hints for AI reasoning about multi-location changes

## Executive Summary

This analysis examines graph algorithms applicable to two specific change hint directions:
1. **Co-change pattern hints** — surfacing related nodes when agent modifies node X
2. **Graph-derived impact hints** — fan-out, symmetry, dataflow boundary detection

**Key findings:**

- **Co-change prediction** is well-studied in software engineering research. CodeScene's temporal coupling analysis mines git history (O(commits × files)) but can be approximated using structural coupling metrics (O(edges)) for real-time hints.

- **Symmetry detection** via full subgraph isomorphism is NP-complete and intractable for real-time use. However, approximate methods exist: Weisfeiler-Lehman graph hashing runs in O(h × E) where h is iteration depth (typically 3-5), making it tractable for 1K-100K node graphs.

- **Fan-out analysis** extends beyond simple degree counting. Betweenness centrality identifies critical nodes on shortest paths (O(V × E) via Brandes' algorithm), while PageRank-style propagation (O(iterations × E)) captures transitive importance.

- **Community detection** using Louvain modularity is O(E) and reveals "functions that belong together" without requiring git history.

**Recommended stack for Grafema:**
1. Pre-compute phase: Community detection (Louvain), centrality metrics (betweenness, PageRank)
2. On-demand phase: WL hashing for symmetry, local fan-out/fan-in with context
3. Optional integration: Temporal coupling from git history (batch process, not real-time)

All recommended algorithms scale to 100K nodes on modern hardware.

---

## 1. Co-Change Pattern Detection

### 1.1 Temporal Coupling (Git History-Based)

**Description:** Mines version control history to identify files that frequently change together as part of the same commits.

**Algorithm (CodeScene approach):**
1. Parse git log, group commits into changesets
2. For each pair of files (A, B), count co-occurrences in same commit
3. Filter: ignore commits with >50 files (mass refactorings)
4. Calculate "Sum of Coupling" for each file: total count of co-changes with any other file
5. Rank files by coupling strength

**Complexity:**
- Preprocessing: O(commits × files per commit × file pairs)
- For typical repos: ~10K commits × ~50 files = 500K operations (one-time)
- Incremental update: O(files in new commit)

**Applicability to Grafema:**
- **Pros:** Reveals logical dependencies invisible in code structure (e.g., microservices communicating via message bus)
- **Cons:** Requires git history (not available for all codebases), batch process not real-time
- **Recommendation:** Offer as optional enrichment, pre-computed during graph build

**Sources:**
- [CodeScene Temporal Coupling](https://docs.enterprise.codescene.io/versions/3.4.0/guides/technical/temporal-coupling.html)
- [CodeScene Change Coupling Visualization](https://codescene.com/engineering-blog/change-coupling-visualize-the-cost-of-change)

### 1.2 Structural Coupling (Graph-Based Approximation)

**Description:** Approximate co-change likelihood using static graph metrics without git history.

**Candidate metrics:**
1. **Shared dependencies:** Files that IMPORT the same modules likely change together when shared dependency changes
2. **Call graph proximity:** Functions within 2-3 hops in call graph
3. **Data flow coupling:** Functions connected via ASSIGNED_FROM edges (shared data structures)

**Algorithm:**
```
For node X being modified:
  1. Find all nodes within distance d=2 on CALLS/DEPENDS_ON edges
  2. Weight by edge type (CALLS > DEPENDS_ON)
  3. Boost nodes that share many common neighbors with X
  4. Return top-k candidates
```

**Complexity:**
- Per-query: O(degree(X) × avg_neighbor_degree) — typically <1000 operations
- Pre-computation: Build adjacency lists O(E), index by node type O(V)

**Applicability to Grafema:**
- **Pros:** Works without git history, real-time computation, aligns with existing graph structure
- **Cons:** Less accurate than temporal coupling (structural ≠ logical dependencies)
- **Recommendation:** Use as default fallback when git history unavailable

**Sources:**
- [Software Dependency Graphs](https://www.puppygraph.com/blog/software-dependency-graph)
- [Fan-in/Fan-out Metrics](https://www.aivosto.com/project/help/pm-sf.html)

---

## 2. Symmetry Detection (Structurally Similar Code)

### 2.1 Full Subgraph Isomorphism (VF2/VF3)

**Description:** Find exact structural matches — "these 3 functions have identical CALLS/DEPENDS_ON patterns."

**Algorithm (VF3 state-of-the-art):**
- State-space search with cutting rules
- Matches subgraph topology exactly

**Complexity:**
- Worst-case: NP-complete
- Practical: Exponential in subgraph size, but optimized for sparse graphs

**Applicability to Grafema:**
- **Pros:** Exact matches, high precision
- **Cons:** Too slow for real-time hints on large codebases
- **Tractability:** OK for small subgraphs (5-10 nodes), infeasible for 50+ node patterns
- **Recommendation:** **DO NOT USE** for real-time hints. Consider for offline analysis only.

**Sources:**
- [VF2++ Algorithm](https://www.sciencedirect.com/science/article/pii/S0166218X18300829)
- [VF3 Library (fastest implementation)](https://github.com/MiviaLab/vf3lib)
- [Subgraph Isomorphism Wikipedia](https://en.wikipedia.org/wiki/Subgraph_isomorphism_problem)

### 2.2 Weisfeiler-Lehman Graph Hashing (Approximate Similarity)

**Description:** Iteratively hash node neighborhoods to create structural fingerprints. Graphs with similar WL hashes have similar local topology.

**Algorithm:**
```
For each node v:
  1. Initialize label: hash(node_type, attributes)
  2. For h iterations (typically h=3-5):
       - Collect neighbor labels
       - Concatenate: new_label = hash(v.label + sorted(neighbor_labels))
  3. Graph signature = multiset of all node labels after h iterations
```

**Comparison:**
- If WL_hash(subgraph_A) == WL_hash(subgraph_B) → likely isomorphic (not guaranteed)
- Cosine similarity on WL label distributions → structural similarity score

**Complexity:**
- Per node: O(h × degree(v)) where h is iteration depth
- Total: O(h × E) for whole graph
- Typical: h=3, E=100K edges → 300K operations (milliseconds)

**Applicability to Grafema:**
- **Pros:** Fast, scalable to 100K+ nodes, good approximation for "similar structure"
- **Cons:** False positives possible (non-isomorphic graphs may have same hash), requires tuning h
- **Recommendation:** **USE THIS** for real-time symmetry hints. Pre-compute WL hashes during graph build, query on-demand.

**Sources:**
- [Weisfeiler-Lehman Graph Kernels (JMLR paper)](https://www.jmlr.org/papers/volume12/shervashidze11a/shervashidze11a.pdf)
- [NetworkX WL Graph Hash](https://networkx.org/documentation/stable/reference/algorithms/generated/networkx.algorithms.graph_hashing.weisfeiler_lehman_graph_hash.html)
- [WL Kernel for Binary Function Analysis](https://blog.quarkslab.com/weisfeiler-lehman-graph-kernel-for-binary-function-analysis.html)

### 2.3 Graph Motif Detection

**Description:** Find recurring small subgraph patterns (motifs) like "fan-in to single node then fan-out" or "mutual recursion pair."

**Algorithm:**
- Enumerate all k-node subgraphs (k=3-5 typical)
- Count isomorphism classes
- Identify over-represented patterns vs random graph baseline

**Complexity:**
- Exact enumeration: O(V^k) — exponential in motif size
- Sampling methods (e.g., FANMOD): polynomial approximation
- Tractable for k ≤ 5 on graphs <10K nodes

**Applicability to Grafema:**
- **Pros:** Detects domain-specific patterns (e.g., "decorator pattern" in code graphs)
- **Cons:** Expensive for k>5, requires domain knowledge to interpret motifs
- **Recommendation:** Research opportunity, not critical path. Investigate after basic hints working.

**Sources:**
- [Network Motif Wikipedia](https://en.wikipedia.org/wiki/Network_motif)
- [Review of Motif Discovery Tools](https://pmc.ncbi.nlm.nih.gov/articles/PMC8687426/)

---

## 3. Fan-Out Impact Analysis

### 3.1 Simple Degree Centrality

**Description:** Count outgoing edges (fan-out) or incoming edges (fan-in).

**Algorithm:**
```
fan_out(v) = |{u : (v → u) ∈ E}|
fan_in(v) = |{u : (u → v) ∈ E}|
```

**Complexity:** O(1) with adjacency list representation (precomputed)

**Applicability to Grafema:**
- **Pros:** Trivial to compute, interpretable ("this function is called from 47 locations")
- **Cons:** Doesn't capture transitive impact (indirect callers)
- **Recommendation:** **USE** as baseline metric, always show in hints.

**Sources:**
- [Fan-in/Fan-out Metrics](https://www.aivosto.com/project/help/pm-sf.html)
- [Dynamic Fan-in/Fan-out for Program Comprehension](https://link.springer.com/article/10.1007/s11741-007-0507-2)

### 3.2 Betweenness Centrality (Bridge Detection)

**Description:** Measures how often a node lies on shortest paths between other nodes. High betweenness = critical bottleneck.

**Algorithm (Brandes' algorithm):**
1. For each source node s, run BFS to find shortest paths to all targets
2. Accumulate pair-dependencies bottom-up
3. Running time: O(V × E) for unweighted graphs

**Complexity:**
- Exact: O(V × E) — tractable for 100K nodes, 500K edges (~50M operations)
- Approximate: Random sampling of source nodes reduces to O(k × E) where k << V

**Applicability to Grafema:**
- **Pros:** Identifies "architectural choke points" — functions that mediate between many components
- **Cons:** Expensive to recompute after each graph update
- **Recommendation:** **Pre-compute** during graph build, store as node metadata. Update incrementally if possible.

**Sources:**
- [Betweenness Centrality Explanation](https://memgraph.com/blog/betweenness-centrality-and-other-centrality-measures-network-analysis)
- [Centrality Measures Survey](https://arxiv.org/pdf/2011.07190)

### 3.3 PageRank (Transitive Importance)

**Description:** Iterative algorithm that propagates importance through edges. A function called by many important functions becomes important itself.

**Algorithm:**
```
Initialize: PR(v) = 1/V for all nodes
Iterate until convergence:
  PR(v) = (1-d)/V + d × Σ(PR(u) / out_degree(u)) for all u → v
```
where d ≈ 0.85 is damping factor.

**Complexity:**
- Per iteration: O(E)
- Convergence: Typically 10-50 iterations
- Total: O(iterations × E) — tractable for 100K nodes

**Applicability to Grafema:**
- **Pros:** Captures transitive fan-out (changing high-PageRank function has cascading impact)
- **Cons:** Requires many iterations, not obvious how to interpret for code changes
- **Recommendation:** Experimental. Try as "impact score" for functions, compare to simpler metrics.

**Sources:**
- [PageRank Centrality Overview](https://cambridge-intelligence.com/eigencentrality-pagerank/)
- [PageRank for Weighted Directed Networks](https://www.sciencedirect.com/science/article/abs/pii/S0378437121007111)

---

## 4. Community Detection (Functions That Belong Together)

### 4.1 Louvain Modularity Optimization

**Description:** Partitions graph into communities (clusters) that have dense internal connections and sparse external connections.

**Algorithm:**
1. **Local moving phase:** Iteratively move each node to the community that maximizes modularity gain
2. **Aggregation phase:** Collapse each community into a super-node
3. Repeat until no modularity improvement

**Modularity formula:**
```
Q = (1/2m) × Σ[A_ij - (k_i × k_j)/2m] × δ(c_i, c_j)
```
where A_ij = adjacency matrix, k_i = degree of node i, m = total edges, δ(c_i, c_j) = 1 if nodes in same community.

**Complexity:**
- O(E) per iteration (linear in edges)
- Typically converges in 3-10 iterations
- Total: O(E) — extremely fast, scales to millions of edges

**Applicability to Grafema:**
- **Pros:** Reveals modules/subsystems without prior knowledge, fast enough to run on every graph update
- **Cons:** Non-deterministic (different runs may give different partitions), may split logically cohesive code
- **Recommendation:** **USE** to pre-cluster graph. When modifying node in community C, prioritize hints from same community.

**Sources:**
- [Louvain Method Wikipedia](https://en.wikipedia.org/wiki/Louvain_method)
- [Louvain in Neo4j](https://neo4j.com/blog/knowledge-graph/graph-algorithms-neo4j-louvain-modularity/)
- [Improved Louvain Algorithm](https://onlinelibrary.wiley.com/doi/10.1155/2021/1485592)

### 4.2 Leiden Algorithm (Improved Louvain)

**Description:** Addresses Louvain's weakness of sometimes producing poorly connected communities.

**Algorithm:** Similar to Louvain but adds a refinement phase that splits disconnected subcommunities.

**Complexity:** O(E) like Louvain, slightly higher constant factor

**Applicability to Grafema:**
- **Pros:** Better quality partitions than Louvain
- **Cons:** More complex to implement
- **Recommendation:** Evaluate after Louvain — only switch if community quality issues arise.

**Sources:**
- [From Louvain to Leiden (Nature paper)](https://www.nature.com/articles/s41598-019-41695-z)

---

## 5. Dataflow Boundary Crossing Detection

### 5.1 Strongly Connected Components (SCC)

**Description:** Partitions directed graph into maximal subgraphs where every node is reachable from every other node. In dataflow graphs, SCCs indicate cyclic dependencies.

**Algorithm (Tarjan's SCC):**
1. Single DFS traversal with stack
2. Track discovery time and low-link value for each node
3. When low-link(v) == discovery(v), pop stack to form SCC

**Complexity:** O(V + E) — linear time, single pass

**Applicability to Grafema:**
- **Pros:** Ultra-fast, identifies cyclic dependencies (often architectural smells)
- **Cons:** Doesn't directly answer "what to change together" — more diagnostic
- **Recommendation:** **USE** for graph health metrics. Surface hint like "Warning: Modifying node in 47-node cyclic dependency cluster."

**Sources:**
- [Tarjan's SCC Algorithm Wikipedia](https://en.wikipedia.org/wiki/Tarjan's_strongly_connected_components_algorithm)
- [Tarjan's Algorithm Tutorial](https://www.baeldung.com/cs/scc-tarjans-algorithm)

### 5.2 Cut Vertices and Bridge Detection

**Description:** Find nodes (cut vertices) or edges (bridges) whose removal disconnects the graph. These are architectural boundaries.

**Algorithm:** Variation of Tarjan's SCC algorithm, also O(V + E)

**Applicability to Grafema:**
- **Pros:** Identifies critical integration points — changing a cut vertex affects multiple disconnected components
- **Cons:** Undirected graph concept, less applicable to directed call graphs
- **Recommendation:** Investigate for undirected "co-change" graphs, skip for directed dependency graphs.

---

## 6. Machine Learning Approaches (Advanced)

### 6.1 Graph Neural Networks for Change Prediction

**Description:** Train GNN on historical changes to predict which nodes should change together.

**Approach:**
1. Represent code graph as input to GNN
2. Train on pairs (changed_node, should_also_change_node) from git history
3. At inference: given changed node X, GNN outputs probability distribution over all other nodes

**Complexity:**
- Training: O(epochs × E × GNN_depth) — requires GPU, hours to days
- Inference: O(E × GNN_depth) — fast once trained

**Applicability to Grafema:**
- **Pros:** Can learn complex non-linear patterns classical algorithms miss
- **Cons:** Requires large training dataset (thousands of commits), model maintenance burden, explainability issues
- **Recommendation:** **DEFER** to future research. Classical algorithms likely sufficient for v0.2-v0.3.

**Sources:**
- [Graph-based ML for Defect Prediction](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0284077)
- [Node2vec for Software Defect Prediction](https://pmc.ncbi.nlm.nih.gov/articles/PMC10101485/)

### 6.2 Graph Embedding (Node2Vec)

**Description:** Map nodes to vector space preserving graph structure. Similar nodes → similar vectors.

**Algorithm:**
1. Generate random walks from each node (biased BFS/DFS mix)
2. Treat walks as "sentences", apply Word2Vec to learn embeddings
3. Measure node similarity via cosine distance in embedding space

**Complexity:**
- O(walks × walk_length × embedding_dim) — moderate, can run in minutes for 100K nodes

**Applicability to Grafema:**
- **Pros:** Flexible similarity metric, can combine with other features
- **Cons:** Embeddings must be recomputed after graph changes (not incremental)
- **Recommendation:** Promising for "suggest similar functions" feature, lower priority than structural hints.

**Sources:**
- [Node2Vec for Software Analysis](https://pmc.ncbi.nlm.nih.gov/articles/PMC10101485/)
- [Graph Embedding Techniques](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0284077)

---

## Recommended Algorithm Stack for Grafema

### Phase 1: Pre-Computation (during graph build)

| Algorithm | Metric Computed | Complexity | Storage per Node |
|-----------|-----------------|------------|------------------|
| **Louvain** | Community ID | O(E) | 4 bytes |
| **Betweenness** | Centrality score | O(V×E) | 8 bytes |
| **Simple degree** | Fan-in, Fan-out | O(E) | 8 bytes |
| **WL hashing** | Structural fingerprint (h=3) | O(3×E) | 32 bytes (4 hashes) |
| **Tarjan SCC** | SCC ID, SCC size | O(V+E) | 8 bytes |

**Total:** ~60 bytes metadata per node. For 100K nodes = 6 MB overhead.

**Build time estimate:** O(V×E) dominated by betweenness = 100K × 500K = 50M ops ≈ 1-5 seconds on modern CPU.

### Phase 2: On-Demand Hints (when agent modifies node X)

```
1. Baseline hints (near-instant):
   - "This function has fan-in={N}, fan-out={M}"
   - "Betweenness centrality: {score} (top 5% of codebase)" if high
   - "Part of {community_size}-node community {community_id}"

2. Structural coupling hints (<100ms):
   - Find nodes within 2 hops on CALLS/DEPENDS_ON
   - Filter to same community (Louvain ID)
   - Rank by shared neighbors
   - Return top 5: "Often changed with: func_A, func_B, ..."

3. Symmetry hints (<200ms):
   - Query nodes with similar WL hash (cosine similarity > 0.8)
   - Return: "Structurally similar functions: func_C, func_D (same call pattern)"

4. SCC warning (instant, pre-computed):
   - If X in SCC of size > 10: "Warning: Part of {size}-node cyclic dependency"
```

### Phase 3: Optional Git History Integration (batch, nightly)

- Run CodeScene-style temporal coupling analysis
- Store co-change counts in edge weights
- Merge with structural hints: "Frequently co-change: func_E (8/20 commits) [structural + temporal]"

---

## Computational Tractability Summary

| Graph Size | Nodes | Edges | Louvain | Betweenness | WL (h=3) | VF3 (10-node subgraph) |
|------------|-------|-------|---------|-------------|----------|------------------------|
| **Small** | 1K | 5K | <10ms | ~50ms | ~15ms | ~100ms per query |
| **Medium** | 10K | 50K | ~50ms | ~5s | ~150ms | Minutes per query |
| **Large** | 100K | 500K | ~500ms | ~50s | ~1.5s | Infeasible |

**Verdict:**
- All recommended algorithms (Louvain, Betweenness, WL, Tarjan SCC) scale to 100K nodes
- Pre-computation overhead acceptable (1-5 minutes during graph build)
- On-demand hints remain fast (<200ms) even for large codebases
- **DO NOT use VF2/VF3 for real-time queries** — reserve for offline analysis only

---

## Open Questions

1. **Incremental updates:** When code changes, can we update Louvain communities / betweenness centrality incrementally instead of full recompute?
   - **Research:** [Recent Advances in Fully Dynamic Graph Algorithms](https://arxiv.org/pdf/2102.11169) shows incremental betweenness is open problem
   - **Grafema approach:** For v0.2, full recompute acceptable (1-5s). For v0.3+, investigate dynamic graph algorithms.

2. **WL hash sensitivity:** How robust are WL fingerprints to small code changes (e.g., adding one function call)?
   - **Requires:** Empirical evaluation on real codebases
   - **Mitigation:** Use cosine similarity threshold (not exact match) to tolerate minor differences

3. **Community stability:** Do Louvain communities remain stable across minor code changes, or do they shuffle randomly?
   - **Known issue:** Louvain is non-deterministic, communities may shift
   - **Mitigation:** Use Leiden algorithm (deterministic) or track community evolution over time

4. **Hint prioritization:** When multiple hint types conflict (structural says change A, temporal says change B), how to rank?
   - **Requires:** User studies with AI agents to measure which hints actually improve resolve rate
   - **Grafema approach:** Start with simple heuristic (temporal > structural if available), refine based on data

5. **Cross-language hints:** Do these algorithms generalize to multi-language codebases (e.g., TypeScript + Python microservices)?
   - **Challenge:** Different call graph semantics, cross-language edges rare
   - **Grafema approach:** Treat as separate graphs initially, explore inter-language edges later

---

## Sources

### Change Coupling & Temporal Analysis
- [CodeScene: Temporal Coupling](https://docs.enterprise.codescene.io/versions/3.4.0/guides/technical/temporal-coupling.html)
- [CodeScene: Change Coupling Visualization](https://codescene.com/engineering-blog/change-coupling-visualize-the-cost-of-change)
- [CodeScene: Change Coupling Guide](https://codescene.io/docs/guides/technical/change-coupling.html)

### Subgraph Isomorphism
- [VF2++ Algorithm](https://www.sciencedirect.com/science/article/pii/S0166218X18300829)
- [VF3 Library](https://github.com/MiviaLab/vf3lib)
- [Subgraph Isomorphism Wikipedia](https://en.wikipedia.org/wiki/Subgraph_isomorphism_problem)
- [NetworkX VF2 Documentation](https://networkx.org/documentation/stable/reference/algorithms/isomorphism.vf2.html)

### Community Detection
- [Louvain Method Wikipedia](https://en.wikipedia.org/wiki/Louvain_method)
- [Louvain in Neo4j](https://neo4j.com/blog/knowledge-graph/graph-algorithms-neo4j-louvain-modularity/)
- [Improved Louvain Algorithm](https://onlinelibrary.wiley.com/doi/10.1155/2021/1485592)
- [From Louvain to Leiden](https://www.nature.com/articles/s41598-019-41695-z)

### Fan-Out & Centrality Metrics
- [Fan-in/Fan-out Metrics](https://www.aivosto.com/project/help/pm-sf.html)
- [Dynamic Fan-in/Fan-out](https://link.springer.com/article/10.1007/s11741-007-0507-2)
- [Betweenness Centrality](https://memgraph.com/blog/betweenness-centrality-and-other-centrality-measures-network-analysis)
- [Centrality Measures Survey](https://arxiv.org/pdf/2011.07190)
- [PageRank Centrality](https://cambridge-intelligence.com/eigencentrality-pagerank/)

### Graph Hashing & Similarity
- [Weisfeiler-Lehman Graph Kernels (JMLR)](https://www.jmlr.org/papers/volume12/shervashidze11a/shervashidze11a.pdf)
- [NetworkX WL Graph Hash](https://networkx.org/documentation/stable/reference/algorithms/generated/networkx.algorithms.graph_hashing.weisfeiler_lehman_graph_hash.html)
- [WL Kernel for Binary Function Analysis](https://blog.quarkslab.com/weisfeiler-lehman-graph-kernel-for-binary-function-analysis.html)

### Code Clone Detection
- [Systematic Literature Review on Code Similarity](https://arxiv.org/pdf/2306.16171)
- [Graph-based Code Clone Detection](https://www.sciencedirect.com/science/article/abs/pii/S0950584922002397)
- [Detecting Code Clones with GNN](https://arxiv.org/pdf/2002.08653)

### Strongly Connected Components
- [Tarjan's SCC Algorithm Wikipedia](https://en.wikipedia.org/wiki/Tarjan's_strongly_connected_components_algorithm)
- [Tarjan's Algorithm Tutorial](https://www.baeldung.com/cs/scc-tarjans-algorithm)
- [Tarjan's Algorithm for SCC](https://www.geeksforgeeks.org/dsa/tarjan-algorithm-find-strongly-connected-components/)

### Network Motifs
- [Network Motif Wikipedia](https://en.wikipedia.org/wiki/Network_motif)
- [Review of Motif Discovery Tools](https://pmc.ncbi.nlm.nih.gov/articles/PMC8687426/)

### Machine Learning & Graph Embeddings
- [Graph-based ML for Defect Prediction](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0284077)
- [Node2Vec for Software Analysis](https://pmc.ncbi.nlm.nih.gov/articles/PMC10101485/)

### Dynamic & Incremental Algorithms
- [Recent Advances in Fully Dynamic Graph Algorithms](https://arxiv.org/pdf/2102.11169)
- [Incrementalizing Graph Algorithms](https://dl.acm.org/doi/10.1145/3448016.3452796)
- [GraphIn: Incremental Graph Processing](https://link.springer.com/chapter/10.1007/978-3-319-43659-3_24)

### Software Dependency Analysis
- [Software Dependency Graphs](https://www.puppygraph.com/blog/software-dependency-graph)
- [Dependency Graph Wikipedia](https://en.wikipedia.org/wiki/Dependency_graph)
- [Predicting Defects Using Network Analysis](https://dl.acm.org/doi/10.1145/1368088.1368161)
