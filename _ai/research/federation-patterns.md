# Federation Patterns for Graph/Data Systems

Research on concrete architectural patterns used by distributed computing networks and peer-to-peer federations for graph/data federation. Focus: mechanisms, formats, trade-offs -- not high-level overviews.

Date: 2026-03-15

---

## 1. Federated Graph Systems

### 1.1 Neo4j Fabric / Composite Databases

**Core abstraction:** A "composite database" acts as a virtual graph that federates queries across multiple constituent databases. The query router parses Cypher, identifies which sub-queries target which databases, dispatches them, and aggregates results.

**Query routing mechanism:**
- Client sends Cypher to the composite database endpoint
- The Fabric layer parses and plans the query
- `USE fabric.graphA` / `USE fabric.graphB` clauses explicitly direct sub-queries
- Sub-queries execute on individual databases
- Results stream back and get joined at the Fabric layer

**Cross-shard joins -- the proxy node pattern:**
Since relationships cannot span across constituent graphs, Neo4j uses **proxy nodes**: a node with a specific label exists in both graphs, but one graph holds the full data while the other holds only the node ID as a "pointer." Cross-graph joins happen at the Fabric layer by matching on these proxy IDs.

```cypher
// Federated query across two graphs
USE fabric.customers
MATCH (c:Customer {id: $id})
RETURN c.id AS customerId, c.name
UNION
USE fabric.orders
MATCH (o:Order)-[:PLACED_BY]->(proxy:Customer {id: $id})
RETURN proxy.id AS customerId, o.total
```

**Neo4j Infinigraph (2025):** Property sharding -- keeps the graph structure (topology) in a single shard, but distributes node/relationship properties across multiple shards. This avoids the cross-shard traversal problem entirely for topology queries.

**Trade-offs:**
- Proxy nodes require manual data modeling -- not automatic
- Cross-graph joins are expensive (network round-trips per matched ID)
- No transparent cross-graph relationships -- application must model federation explicitly
- Infinigraph's property sharding only works when queries are topology-first

**Relevance to code analysis federation:**
The proxy node pattern maps directly to "stub nodes" in a federated code graph. When repo A imports from repo B, repo A's graph contains a stub IMPORT node pointing to repo B's exported symbol. The federation layer resolves the stub by querying repo B's graph.

### 1.2 Dgraph

**Core abstraction:** Predicate-based sharding. The graph is split not by subgraph or vertex, but by predicate (edge type / property name). All edges of type `CALLS` live on one group of Alpha nodes; all edges of type `IMPORTS_FROM` on another.

**Architecture:**
- **Dgraph Zero:** Cluster orchestrator. Assigns predicates to groups, manages membership, handles shard moves.
- **Dgraph Alpha (groups):** Store and serve predicates. Each group replicates internally via RAFT.
- **Client query:** Sent to any Alpha. That Alpha acts as coordinator, fans out sub-queries to the groups owning relevant predicates, merges results.

**Query execution:**
```
Client -> Alpha(coordinator)
  -> Alpha Group 1 (owns "name", "type" predicates)
  -> Alpha Group 2 (owns "CALLS", "IMPORTS_FROM" predicates)
  -> Alpha Group 3 (owns "file", "line" predicates)
Coordinator merges results by node UID
```

**Cross-shard joins:** Since predicates are distributed, a single node's attributes may be spread across multiple groups. Multi-hop queries require the coordinator to fetch UIDs from one group, then fan out to other groups for the next hop's predicates. The coordinator handles this transparently.

**Trade-offs:**
- Predicate sharding is excellent when queries touch few predicate types (common in code analysis: "give me all CALLS edges")
- Poor when queries need many predicates per node (full node reconstruction requires hitting many groups)
- RAFT replication per group adds write latency
- Shard rebalancing (moving predicates between groups) is operationally complex

**Relevance to code analysis federation:**
Predicate-based sharding is interesting for Enox: all `outperforms` edges could live on one shard, all `requires` on another. Queries like "what outperforms X?" hit exactly one shard. But code graphs typically need multiple edge types per query ("show me all relationships of function F"), making this less ideal.

### 1.3 TigerGraph

**Core abstraction:** Hash-based vertex partitioning with an execution hub model. Vertices are distributed across machines via hash of vertex ID. One machine is selected as "execution hub" for each query.

**Architecture:**
- **GSE (Graph Storage Engine):** C++ engine for physical storage and compression
- **GPE (Graph Processing Engine):** C++ parallel processing engine
- **Apache Kafka:** Message passing between GSE and GPE instances
- **Apache Zookeeper:** Coordination and consistency

**Query execution -- the hub model:**
One machine is the execution hub for a query. It coordinates parallel execution across all partitions. The hub broadcasts the query plan; each partition executes locally and sends results back to the hub for aggregation.

**Cross-partition traversal:**
When a traversal hits a vertex that's on another partition, Kafka carries the message. The GPE on the target partition processes the hop and sends the result back. Multi-hop traversals are executed as a series of message rounds (similar to BSP supersteps).

**Trade-offs:**
- Hub model creates a potential bottleneck at the coordinator
- Hash-based partitioning gives even distribution but no locality (related vertices may be on different machines)
- Kafka adds latency for cross-partition hops but provides durability and ordering
- Excellent for GSQL queries that compile to C++ for native speed

### 1.4 SPARQL Federation (W3C Standard)

**Core abstraction:** The `SERVICE` clause lets a SPARQL query delegate sub-patterns to remote endpoints. Each endpoint is a fully autonomous graph store.

```sparql
SELECT ?name ?paper WHERE {
  # Local graph
  ?person foaf:name ?name .

  # Remote endpoint
  SERVICE <http://dbpedia.org/sparql> {
    ?person dbo:author ?paper .
  }
}
```

**Query routing:**
- Parser identifies SERVICE clauses
- For each SERVICE, the sub-pattern is sent as a standalone SPARQL query to the remote endpoint
- Results are joined locally using shared variable bindings
- Optimization: VALUES clause pushes bindings from local results into the remote query to reduce result sets

**FedX (RDF4J) -- automatic federation:**
FedX removes the need for explicit SERVICE clauses. It maintains a catalog of endpoints and their capabilities (which predicates/types they serve). The query planner automatically routes sub-patterns to the appropriate endpoints based on source selection algorithms.

**Trade-offs:**
- SERVICE clause is explicit but verbose -- query author must know endpoint topology
- FedX auto-federation requires metadata about each endpoint's content
- No transactional guarantees across endpoints
- Performance depends on remote endpoint response times (weakest link)
- Cross-endpoint joins are nested-loop by default (bad for large result sets)

**Relevance to code analysis federation:**
The SERVICE/FedX model is the closest analogue to what Enox needs. Each Enox node (knowledge domain) exposes a query endpoint. The federation layer (like FedX) knows what each node contains via a manifest, and routes Datalog sub-queries automatically.

---

## 2. P2P Federation Protocols

### 2.1 ActivityPub

**Core abstraction:** Actor-based federation. Every entity (person, bot, service) is an Actor with an `inbox` and `outbox`. Actors push activities to each other's inboxes via HTTP POST.

**Discovery -- WebFinger:**
```
GET https://mastodon.social/.well-known/webfinger?resource=acct:user@mastodon.social

{
  "subject": "acct:user@mastodon.social",
  "links": [
    {
      "rel": "self",
      "type": "application/activity+json",
      "href": "https://mastodon.social/users/user"
    }
  ]
}
```

**Actor document (capability advertisement):**
```json
{
  "@context": "https://www.w3.org/ns/activitystreams",
  "type": "Person",
  "id": "https://social.example/alyssa/",
  "preferredUsername": "alyssa",
  "inbox": "https://social.example/alyssa/inbox/",
  "outbox": "https://social.example/alyssa/outbox/",
  "followers": "https://social.example/alyssa/followers/",
  "following": "https://social.example/alyssa/following/",
  "publicKey": {
    "id": "https://social.example/alyssa/#main-key",
    "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n..."
  }
}
```

**Message routing:**
1. Actor A creates an activity (Create, Like, Follow, etc.)
2. Activity is published to A's outbox
3. Server reads `to`, `cc`, `bcc` fields to determine recipient inboxes
4. Server POSTs the activity JSON-LD to each recipient's inbox URL
5. Recipient server validates HTTP Signature, processes the activity

**Partial availability:**
- If a remote inbox is unreachable, the sender retries with exponential backoff
- No global consistency -- each server has its own view of the social graph
- Deleted content requires sending a `Delete` activity -- servers that miss it retain the content

**Trade-offs:**
- Simple push model -- no complex routing or consensus
- No query federation -- you can only push/pull activities, not query remote data
- No capability negotiation beyond the actor document
- JSON-LD is complex to parse correctly but widely adopted
- Spam and trust are unsolved problems (anyone can POST to your inbox)

**Relevance to code analysis federation:**
The actor model maps well to Enox nodes: each knowledge domain is an "actor" with an inbox (receives queries/updates) and an outbox (publishes new edges). WebFinger-style discovery (.well-known/enox) could advertise what domains a node covers. But ActivityPub is push-only -- Enox needs pull (query) semantics too.

### 2.2 AT Protocol (Bluesky)

**Core abstraction:** Account portability via content-addressed data repositories. Each user owns a signed data repository (like a personal git repo). Infrastructure services (Relays, AppViews) consume and index these repos.

**Architecture layers:**
```
User <-> PDS (Personal Data Server)  -- hosts user's data repo
           |
        Relay (Firehose)             -- aggregates all PDS updates into a stream
           |
        AppView                      -- consumes firehose, builds indexes, serves queries
```

**Identity -- DID:PLC:**
```json
{
  "@context": ["https://www.w3.org/ns/did/v1"],
  "id": "did:plc:ewvi7nxzyoun6zhxrhs64oiz",
  "alsoKnownAs": ["at://alice.bsky.social"],
  "verificationMethod": [{"publicKeyMultibase": "z..."}],
  "service": [
    {"id": "#atproto_pds", "type": "AtprotoPersonalDataServer",
     "serviceEndpoint": "https://pds.example.com"}
  ]
}
```

**Lexicon -- capability/schema advertisement:**
```json
{
  "lexicon": 1,
  "id": "com.atproto.repo.getRecord",
  "defs": {
    "main": {
      "type": "query",
      "parameters": {
        "type": "params",
        "required": ["repo", "collection", "rkey"],
        "properties": {
          "repo": {"type": "string", "format": "at-identifier"},
          "collection": {"type": "string", "format": "nsid"},
          "rkey": {"type": "string"}
        }
      },
      "output": {
        "encoding": "application/json",
        "schema": {"type": "ref", "ref": "#recordResponse"}
      }
    }
  }
}
```

Lexicon schemas use reverse-DNS namespacing (NSIDs). XRPC endpoints follow `/xrpc/<nsid>` pattern. Three method types: queries (GET), procedures (POST), subscriptions (WebSocket).

**Firehose / Relay:**
- Relay continuously crawls all known PDSes for repository updates
- Aggregates into a single event stream (the "firehose")
- Non-archival by default (last 24-36h buffer)
- AppViews subscribe to the firehose, build domain-specific indexes
- As of 2025, ~2000 third-party PDS servers exist

**Trade-offs:**
- Excellent data sovereignty -- users own their repos
- Relay is a centralization point (even if replaceable)
- Lexicon schema system provides strong contracts but requires coordination
- The firehose model assumes all data is public (no per-record ACLs at the relay level)
- Operational cost of running a relay has dropped significantly (non-archival mode)

**Relevance to code analysis federation:**
AT Protocol's architecture is highly relevant to Enox:
- PDS = Enox node (each domain expert hosts their knowledge repo)
- Relay = Enox aggregator (consumes updates from all nodes, builds global index)
- Lexicon = Enox schema contract (defines edge types, query formats)
- Firehose = edge update stream for incremental graph updates
- DID = node identity (cryptographic proof of authorship)

The key insight: AT Protocol separates data hosting (PDS) from indexing (Relay/AppView). Enox could do the same -- each knowledge domain hosts its edges, a relay aggregates them, AppViews build domain-specific query interfaces.

### 2.3 Matrix Protocol

**Core abstraction:** Federated event DAG. Each "room" is a Directed Acyclic Graph of events replicated across all participating homeservers. State resolution algorithms deterministically converge to the same state regardless of event ordering.

**Server discovery:**
```
GET https://example.com/.well-known/matrix/server
{"m.server": "matrix.example.com:8448"}
```
Then SRV DNS records or direct connection to the discovered host.

**Event DAG:**
- Every event references its parent events (creating a DAG)
- PDUs (Persistent Data Units) are signed, append-only
- Each homeserver has a partial view of the DAG
- State Resolution v2 algorithm deterministically merges conflicting states

**State Resolution v2:**
When two homeservers have divergent event histories (split-brain), the algorithm:
1. Identifies conflicting state events
2. Separates auth events (power levels, membership) from content events
3. Orders events by considering the auth DAG (who had authority to make the change)
4. Applies events in auth-chain order, deterministically resolving conflicts
5. All servers converge to the same result regardless of which events they saw first

**Trade-offs:**
- Eventually consistent -- no strong consistency guarantees
- State resolution is complex (formally verified to be correct but hard to implement)
- DAG grows indefinitely -- storage cost scales with room history
- Federation requires all participating servers to stay online for real-time, but tolerates temporary unavailability
- Auth chain traversal can be expensive for rooms with long histories

**Relevance to code analysis federation:**
The event DAG model is interesting for tracking edge provenance. Each edge addition/modification is an event in a DAG. If two Enox nodes independently add conflicting edges about the same entities, a state resolution algorithm could deterministically pick the winner based on authority chain (who has expertise/evidence). But the complexity cost is high.

### 2.4 IPFS / libp2p

**Core abstraction:** Content-addressed storage + Kademlia DHT for peer discovery and content routing.

**Peer discovery -- DHT operations:**
```
FIND_NODE(key)      -> closest peers to key
PUT_VALUE(key, val) -> store key-value pair
GET_VALUE(key)      -> retrieve value for key
ADD_PROVIDER(CID)   -> announce "I have this content"
GET_PROVIDERS(CID)  -> find who has this content
```

**Provider records:**
- CID (Content Identifier) = hash of the content
- Provider record = mapping from CID to peer IDs that have the content
- Default TTL: 48 hours (must be republished)
- Provider records stored on the K closest peers to the CID in the DHT

**Peer routing flow:**
```
1. Node wants content with CID X
2. Hash(X) -> DHT address space
3. FIND_NODE(Hash(X)) -> get closest peers
4. GET_PROVIDERS(X) from those peers -> list of provider peer IDs
5. Connect to provider, request content via Bitswap protocol
```

**Amino DHT:** The public IPFS DHT, mounted at `/ipfs/kad/1.0.0` protocol. Nodes can participate in multiple DHT swarms simultaneously.

**Trade-offs:**
- Content addressing means immutable by default -- mutable data requires IPNS (adds latency)
- DHT lookups are O(log n) hops but still ~1-5 seconds in practice
- Provider record TTL means content "disappears" if no one re-announces
- No query semantics -- only key-value lookups and content retrieval
- Works well for static content, poorly for dynamic/queryable data

**Relevance to code analysis federation:**
Content addressing could work for immutable analysis snapshots: CID of "repo X at commit Y analyzed with Grafema" = content-addressed artifact. Other nodes could request the analysis graph by CID. But the lack of query semantics means IPFS is a transport/storage layer, not a federation layer. Enox would need a query layer on top.

---

## 3. Distributed Query Execution

### 3.1 Pregel / BSP (Bulk Synchronous Parallel)

**Core abstraction:** Vertex-centric computation in synchronized rounds (supersteps). Each vertex is a processing unit that receives messages, computes, and sends messages. A barrier synchronization between supersteps eliminates race conditions.

**The superstep cycle:**
```
Superstep S:
  1. Each vertex V receives messages sent to it in superstep S-1
  2. V executes its Compute() function:
     - Reads incoming messages
     - Updates its own value
     - Sends messages to neighboring vertices
     - May vote to halt (become inactive)
  3. BARRIER -- all vertices must complete before S+1 begins

Termination: all vertices have voted to halt AND no messages are in transit
```

**Example -- PageRank in Pregel pseudocode:**
```
Compute(messages):
  if superstep == 0:
    value = 1.0 / numVertices
  else:
    sum = sum(messages)
    value = 0.15 / numVertices + 0.85 * sum

  for each outEdge:
    sendMessage(outEdge.target, value / numOutEdges)

  if superstep > 30:
    voteToHalt()
```

**Cross-partition message passing:**
- Messages to local vertices: in-memory, zero-copy
- Messages to remote vertices: serialized, sent over network
- Combiners can reduce message volume (e.g., sum all PageRank contributions before sending)
- The framework handles routing transparently -- vertex programs don't know about partitions

**Trade-offs:**
- Simple programming model -- hide distribution complexity
- Barrier synchronization means the slowest partition determines superstep duration (straggler problem)
- Poor for algorithms where different parts of the graph converge at different rates
- Memory-intensive: all messages buffered between supersteps
- Not suitable for interactive/ad-hoc queries -- designed for batch analytics

**Relevance to code analysis federation:**
BSP could power cross-node graph algorithms in Enox. Example: "find all transitive dependencies of library X" where the dependency chain crosses multiple Enox nodes. Each node runs a superstep locally, sends "I depend on Y (which is on node Z)" messages. After a few supersteps, the full transitive closure is computed. But BSP is batch-oriented -- not suitable for interactive MCP queries.

### 3.2 GraphX (Apache Spark)

**Core abstraction:** Graphs as pairs of RDDs (Resilient Distributed Datasets) -- a vertex RDD and an edge RDD. Graph operations compile to Spark's dataflow operations.

**Partition strategy -- 2D edge partitioning:**
```
PartitionStrategy.EdgePartition2D:
  - Sparse edge adjacency matrix is divided into sqrt(P) x sqrt(P) blocks
  - Each block assigned to one partition
  - Guarantees: vertex replication factor <= 2 * sqrt(numPartitions)
  - Optimal for power-law graphs where high-degree vertices would cause imbalance
```

**Cross-partition handling -- routing table:**
```
GraphX internal structure:
  EdgePartition[P1]: [(v1,v3,CALLS), (v2,v3,IMPORTS)]
  EdgePartition[P2]: [(v3,v5,READS_FROM), (v4,v5,CALLS)]

  RoutingTable:
    v1 -> [P1]
    v2 -> [P1]
    v3 -> [P1, P2]  // replicated -- appears in both partitions
    v4 -> [P2]
    v5 -> [P2]
```

Vertices adjacent to edges in multiple partitions are replicated. The routing table tracks which partitions need which vertex attributes. When a vertex property changes, the framework broadcasts it to all partitions in the routing table.

**Message passing -- aggregateMessages:**
```scala
graph.aggregateMessages[Int](
  // sendMsg: for each edge triplet, emit messages
  triplet => {
    if (triplet.srcAttr > triplet.dstAttr)
      triplet.sendToDst(triplet.srcAttr)
  },
  // mergeMsg: combine messages at destination vertex
  (a, b) => math.max(a, b)
)
```

**Trade-offs:**
- Built on Spark -- benefits from Spark ecosystem (fault tolerance, scheduling, integration)
- RDD-based: entire graph must fit in cluster memory
- Iterative algorithms cause repeated serialization/deserialization (mitigated by GraphFrames)
- 2D partitioning works well for power-law graphs, poorly for grid/mesh graphs
- No incremental updates -- modifying the graph creates a new RDD

### 3.3 Ghost/Mirror Vertices Pattern

**Core abstraction used across all distributed graph systems:** When a graph is partitioned, edges that cross partitions require special handling. Two approaches:

**Edge-cut (vertex partitioning):**
```
Partition A: [v1, v2, v3]
Partition B: [v4, v5, v6]

Edge (v3 -> v4) crosses the partition boundary.

Solution: Create a "ghost" of v4 on Partition A.
- Ghost v4 has read-only copies of v4's attributes
- When v3 needs to traverse to v4, it reads the ghost locally
- Periodically, ghost attributes are synchronized from Partition B

Communication cost: proportional to number of boundary vertices
```

**Vertex-cut (edge partitioning):**
```
Partition A: edges [(v1,v3), (v2,v3)]
Partition B: edges [(v3,v5), (v4,v5)]

Vertex v3 appears in both partitions.

Solution: One copy is "master", others are "mirrors".
- Master v3 on Partition A manages state
- Mirror v3 on Partition B receives state updates
- Edge computations run locally on whichever partition owns the edge

Communication cost: proportional to number of replicated vertices
```

**Power-law graph consideration:**
Real-world graphs (including code dependency graphs) follow power-law distributions. A few "hub" vertices (popular libraries, framework base classes) have thousands of edges. Edge-cut partitioning creates massive communication overhead for hubs. Vertex-cut (or hybrid-cut from PowerLyra) handles hubs better by distributing their edges across partitions.

**Relevance to code analysis federation:**
In a federated code graph, popular packages (React, lodash, Express) are "hub vertices" referenced by thousands of downstream repos. A federation design must handle these gracefully:
- Option A: Each node has a full ghost copy of popular package graphs (wasteful but fast)
- Option B: A shared "commons" partition hosts popular packages (centralization)
- Option C: Vertex-cut on popular packages -- each node holds only the edges it cares about, queries fan out to get the full picture

---

## 4. Federation in Package Ecosystems

### 4.1 npm Registry

**Core abstraction:** "Packument" -- a JSON document containing all metadata for all versions of a package. Two response levels based on Accept header.

**Full packument** (Accept: application/json):
```json
{
  "name": "express",
  "dist-tags": {"latest": "4.18.2"},
  "versions": {
    "4.18.2": {
      "name": "express",
      "version": "4.18.2",
      "dependencies": {
        "accepts": "~1.3.8",
        "body-parser": "1.20.1",
        "cookie": "0.5.0"
      },
      "devDependencies": {...},
      "dist": {
        "tarball": "https://registry.npmjs.org/express/-/express-4.18.2.tgz",
        "integrity": "sha512-...",
        "fileCount": 214,
        "unpackedSize": 218890
      }
    }
  },
  "time": {
    "4.18.2": "2022-10-08T22:11:52.336Z"
  }
}
```

**Abbreviated packument** (Accept: application/vnd.npm.install-v1+json):
Returns only the fields needed for `npm install` -- version numbers, dependency trees, dist info. Significantly smaller payload. This is what npm CLI uses by default.

**Key insight -- dependency resolution without download:**
The `dependencies`, `peerDependencies`, `optionalDependencies` fields in the packument provide enough information to build a complete dependency tree without downloading any tarballs. The tarball is only fetched after resolution is complete and only for the versions that will actually be installed.

**Registry API pattern:**
```
GET /express                          -> full packument
GET /express (with install-v1 header) -> abbreviated packument
GET /express/4.18.2                   -> single version manifest
GET /express/-/express-4.18.2.tgz     -> tarball download
```

### 4.2 Cargo (Rust) Registry

**Core abstraction:** A line-delimited index where each line is a JSON object describing one published version of a crate. The index is either a git repository (cloned locally) or served via sparse HTTP protocol.

**Index entry format (one line per version):**
```json
{
  "name": "serde",
  "vers": "1.0.193",
  "deps": [
    {
      "name": "serde_derive",
      "req": "=1.0.193",
      "features": [],
      "optional": true,
      "default_features": true,
      "target": null,
      "kind": "normal"
    }
  ],
  "cksum": "25dd9975e68d0cb5aa1120c288333fc98731bd1dd12f561e468ea5c6c71b1e9b",
  "features": {
    "default": ["std"],
    "derive": ["serde_derive"],
    "std": []
  },
  "features2": {
    "derive": ["dep:serde_derive"]
  },
  "yanked": false,
  "v": 2
}
```

**Sparse protocol (RFC 2789):**
```
GET https://index.crates.io/se/rd/serde
  -> Returns all lines for all versions of "serde"

Headers used for caching:
  If-None-Match: "etag-value"
  If-Modified-Since: "date"
  -> 304 Not Modified if cache is valid
```

The file path in the index is determined by the crate name:
- 1-char names: `1/<name>`
- 2-char names: `2/<name>`
- 3-char names: `3/<first-char>/<name>`
- 4+ chars: `<first-two>/<next-two>/<name>`

**Key insight -- minimal metadata for resolution:**
The index contains only what's needed for dependency resolution: name, version, dependency specs (name + version requirement + features + kind), features, and yanked status. No description, no README, no source code. This makes the entire crate index (100K+ crates) manageable as a single git repo or via sparse HTTP.

### 4.3 Maven

**Core abstraction:** POM (Project Object Model) -- an XML file that describes a project's dependencies, build configuration, and metadata. The POM is the unit of dependency resolution.

**POM dependency declaration:**
```xml
<project>
  <groupId>com.example</groupId>
  <artifactId>my-app</artifactId>
  <version>1.0.0</version>

  <dependencies>
    <dependency>
      <groupId>org.apache.commons</groupId>
      <artifactId>commons-lang3</artifactId>
      <version>3.12.0</version>
    </dependency>
  </dependencies>
</project>
```

**Repository metadata (maven-metadata.xml):**
```xml
<metadata>
  <groupId>org.apache.commons</groupId>
  <artifactId>commons-lang3</artifactId>
  <versioning>
    <latest>3.14.0</latest>
    <release>3.14.0</release>
    <versions>
      <version>3.12.0</version>
      <version>3.13.0</version>
      <version>3.14.0</version>
    </versions>
    <lastUpdated>20240101120000</lastUpdated>
  </versioning>
</metadata>
```

**Resolution flow:**
1. Parse local POM for dependencies
2. For each dependency, fetch `maven-metadata.xml` from repository to determine available versions
3. Resolve version ranges/LATEST/RELEASE against metadata
4. Fetch the dependency's POM to get its transitive dependencies
5. Recursively resolve until full tree is built
6. Only then download JARs

**Key insight:** Maven's resolution is POM-to-POM -- each step fetches one XML file. No index download required. But this creates an N+1 query problem for deep dependency trees.

### 4.4 Common Patterns Across Package Registries

| Aspect | npm | Cargo | Maven |
|--------|-----|-------|-------|
| Manifest format | JSON (packument) | JSON lines (index) | XML (POM) |
| Resolution unit | Per-package (all versions at once) | Per-crate (all versions at once) | Per-artifact-version (one POM at a time) |
| Index strategy | On-demand per package | Git clone (full) or sparse HTTP | On-demand per artifact |
| Dependency info | In manifest | In index | In POM |
| Can resolve without download | Yes (via packument) | Yes (via index) | Yes (via POM chain) |
| Caching | HTTP ETags | HTTP ETags / git | updatePolicy (daily/always/never) |

**Relevance to code analysis federation:**
An Enox node manifest should follow the Cargo sparse index pattern:
- Each node publishes a manifest listing its domains, entity count, edge count, last-updated timestamp
- The manifest contains enough metadata for query routing (which entity types/domains are covered)
- Full graph data is fetched only when a query needs it
- HTTP caching (ETags) avoids redundant re-fetching

**Proposed Enox node manifest (inspired by Cargo + npm):**
```json
{
  "node_id": "did:enox:cs-ml-transformers",
  "name": "CS/ML Transformers Research",
  "version": "2026.03.15",
  "domains": ["machine-learning", "transformers", "attention-mechanisms"],
  "stats": {
    "entities": 1200,
    "edges": 3400,
    "edge_types": ["outperforms", "extends", "requires", "fails_on"]
  },
  "endpoints": {
    "query": "https://node.example.com/xrpc/enox.graph.query",
    "firehose": "wss://node.example.com/xrpc/enox.graph.subscribe"
  },
  "lexicon": ["enox.graph.query", "enox.graph.search", "enox.graph.explore"],
  "last_updated": "2026-03-15T10:30:00Z",
  "cksum": "sha256:abc123..."
}
```

---

## 5. Lazy/On-Demand Activation

### 5.1 Knative Scale-to-Zero

**Core abstraction:** When no traffic is flowing to a service, scale it to zero pods. When a request arrives, intercept it, buffer it, spin up pods, and forward the request once ready.

**Architecture:**
```
Request -> Istio/Envoy -> Activator (when 0 replicas)
                            |
                            v
                         Autoscaler -> Deployment (scale to N)
                            |
                            v
                         Activator waits for Ready endpoints
                            |
                            v
                         Forward buffered request to pod
```

**Activation flow (scale from zero):**
1. Request hits the Activator (which is always running)
2. Activator increments request count, reports to Autoscaler
3. Autoscaler runs scaling cycle: desired = ceil(concurrency / target)
4. Autoscaler patches the Deployment: replicas = N
5. Activator watches for endpoint readiness
6. Once endpoint is Ready, Activator proxies the buffered request
7. Subsequent requests go directly to pods (Activator steps out of data path)

**Scale-down flow:**
- KPA (Knative Pod Autoscaler) tracks request rate over a stable window (default 60s)
- If rate = 0 for the grace period (default 30s), scale to zero
- Activator re-enters the data path to catch the next request

**Cold start latency:** 1-2 seconds typically (pod startup + container init + readiness probe). Mitigations:
- **Container pre-warming:** Keep a pool of pre-initialized containers
- **Init container optimization:** Minimal base images, lazy-load heavy dependencies
- **Concurrency-based scaling:** Scale before hitting zero by maintaining minimum replicas

### 5.2 Serverless Snapshot/Restore (Firecracker/CRIU)

**Core abstraction:** Instead of cold-starting a function runtime, restore from a memory snapshot taken after initialization.

**AWS Lambda SnapStart flow:**
```
Publish Lambda version
  -> Lambda initializes the function (runs init code)
  -> Firecracker snapshots memory + runtime state
  -> Snapshot cached in S3/block storage

On invocation (cold start):
  -> Restore from snapshot (~200ms vs 2-10s full cold start)
  -> Function resumes execution post-init
  -> First request handled immediately
```

**CRIU (Checkpoint/Restore In Userspace):**
```bash
# Checkpoint a running process
criu dump --tree $PID --images-dir /snapshots/myprocess/

# Restore from checkpoint
criu restore --images-dir /snapshots/myprocess/
```

Performance improvement: 127% to 1932% reduction in startup time, effectively eliminating JVM/CLR/Python interpreter initialization overhead.

**Trade-offs:**
- Snapshot size can be large (hundreds of MB for JVM apps)
- Snapshot must not contain secrets/credentials (they'd be stale or leaked)
- File descriptors, network connections, timers must be re-established after restore
- Not all runtimes are snapshot-safe (random seeds, connection pools)

### 5.3 Microsoft Orleans -- Virtual Actor (Grain) Model

**Core abstraction:** Grains (actors) always "exist" conceptually but are only instantiated in memory when messaged. The runtime manages activation/deactivation transparently.

**Lifecycle:**
```
1. Client sends message to Grain("order-12345")
2. Orleans runtime checks: is this grain activated anywhere in the cluster?
   - No -> pick a silo, instantiate the grain, call OnActivateAsync()
   - Yes -> route message to the silo hosting the active grain
3. Grain processes message, may modify state
4. After idle timeout (configurable, e.g., 20 minutes):
   - Runtime calls OnDeactivateAsync()
   - State is persisted to storage
   - Grain is removed from memory
5. Next message re-activates the grain (step 2)
```

**Virtual vs Physical mapping:**
```
Virtual space:     Grain("order-1"), Grain("order-2"), ..., Grain("order-1M")
Physical reality:  Silo A has 3 active grains, Silo B has 5 active grains
                   Remaining 999,992 grains exist only as IDs + persisted state
```

**Key property -- single activation guarantee:**
At any point in time, at most one instance of a grain exists in the cluster. The runtime uses a distributed directory to track which silo hosts which grain. If a silo crashes, grains it hosted are re-activated on other silos on next message.

**Comparison with Erlang/OTP:**
| Aspect | Erlang/OTP | Orleans |
|--------|-----------|---------|
| Lifecycle | Explicit spawn/stop | Implicit activation/deactivation |
| Location | Must know process ID or register name | Runtime manages location transparently |
| Persistence | Manual (ETS/Mnesia/external) | Automatic state persistence |
| Supervision | Supervisor trees with restart strategies | Runtime re-activates on demand |
| Scaling | Manual process distribution | Automatic cluster-wide placement |

### 5.4 Erlang/OTP Supervision Trees

**Core abstraction:** Hierarchical process management. Supervisors start, monitor, and restart worker processes according to configurable strategies.

**Supervision strategies:**
```erlang
%% one_for_one: children are independent
{one_for_one, MaxRestarts, MaxTime}
%% If child A crashes, only A is restarted

%% one_for_all: all or nothing
{one_for_all, MaxRestarts, MaxTime}
%% If child A crashes, all children are restarted

%% rest_for_one: linear dependency
{rest_for_one, MaxRestarts, MaxTime}
%% If child B crashes, B and all children started after B are restarted

%% simple_one_for_one: dynamic worker pool
{simple_one_for_one, MaxRestarts, MaxTime}
%% All children are the same type, added dynamically
```

**Dynamic child spawning:**
```erlang
%% Start a new worker on demand
supervisor:start_child(PoolSupervisor, [WorkerArgs]).

%% The supervisor tracks it and will restart it if it crashes
```

**Key insight for federation:**
simple_one_for_one supervisors are the closest Erlang analogue to Orleans grains. Workers are spawned on-demand and supervised. But unlike Orleans, Erlang doesn't automatically deactivate idle processes -- that's application logic.

### 5.5 Patterns Summary for On-Demand Activation

| Pattern | Activation trigger | Deactivation | State persistence | Cold start |
|---------|-------------------|--------------|-------------------|------------|
| Knative | HTTP request | Idle timeout (30s+60s) | External (DB/cache) | 1-2s |
| SnapStart | Function invocation | Platform-managed | Snapshot restore | ~200ms |
| Orleans Grains | Any message | Idle timeout (configurable) | Automatic to storage | ~50-200ms |
| Erlang processes | Explicit spawn | Crash or explicit stop | Manual | Microseconds |
| CRIU | Process restore | Checkpoint on demand | Memory snapshot | ~100ms |

**Relevance to code analysis federation:**
For Enox nodes that should "sleep" when unused:
- **Orleans grain model is the best fit.** Each Enox node is a virtual actor. When queried, the runtime activates it (loads graph data from storage). After idle timeout, it deactivates (frees memory). The "single activation guarantee" prevents duplicate computation.
- **Knative for HTTP-based nodes.** If Enox nodes are HTTP services, Knative scale-to-zero works out of the box. Cold start of 1-2s is acceptable for an MCP query.
- **Snapshot/restore for heavy nodes.** If loading a large knowledge graph takes 10+ seconds, taking a snapshot after first load and restoring from it on subsequent activations could reduce cold start to <500ms.

---

## 6. Synthesis: Architecture for Code Analysis Graph Federation

Based on the research above, here are the concrete patterns most relevant to Enox/Grafema federation:

### 6.1 Recommended Architecture: AT Protocol-Inspired + SPARQL Federation Semantics

```
Enox Node A (ML)     Enox Node B (Systems)     Enox Node C (SE)
     |                      |                        |
     v                      v                        v
[PDS: hosts edges]   [PDS: hosts edges]      [PDS: hosts edges]
     |                      |                        |
     +----------+-----------+------------------------+
                |
          Relay / Aggregator
          (Firehose of edge updates)
                |
          AppView / Query Router
          (Receives MCP queries, routes to relevant nodes)
```

### 6.2 Key Design Decisions

| Decision | Pattern | Source |
|----------|---------|--------|
| Node identity | DID (cryptographic, portable) | AT Protocol |
| Schema contracts | Lexicon-style NSID schemas | AT Protocol |
| Discovery | .well-known/enox + DHT for P2P | WebFinger + IPFS |
| Query routing | FedX-style automatic source selection | SPARQL Federation |
| Cross-node joins | Proxy/stub nodes with lazy resolution | Neo4j Fabric |
| Node manifest | Cargo sparse index format (minimal metadata) | Cargo Registry |
| On-demand activation | Virtual actor model | Orleans |
| Edge updates | Firehose subscription (WebSocket) | AT Protocol |
| State resolution | Auth-chain precedence (for conflicting edges) | Matrix Protocol |
| Partitioning | Predicate-based (by edge type) for analytics, full-graph per node for queries | Dgraph |

### 6.3 Critical Failure Modes to Handle

1. **Partial availability:** Node B is down during a cross-node query. Response must degrade gracefully -- return partial results with a "Node B unavailable" annotation, not fail entirely. (ActivityPub retry model.)

2. **Stale data:** Node A has a cached manifest for Node B that says "covers transformers." Node B has since added/removed domains. ETags + TTL (Cargo sparse protocol) handle this.

3. **Hub vertex problem:** "React" appears in 10,000 nodes' edges. Cross-node queries about React fan out to all 10,000 nodes. Solution: designate "canonical" nodes for popular entities (like Dgraph Zero assigning predicates to groups).

4. **Conflicting edges:** Node A says "X outperforms Y" with evidence from paper P1. Node B says "Y outperforms X" with evidence from paper P2. Resolution: don't resolve -- expose both with provenance. The consumer (AI agent) decides.

5. **Cold start cascade:** A query touches 5 sleeping nodes. All 5 cold-start simultaneously. Solution: parallel activation + request buffering at the query router (Knative Activator pattern).

---

## Sources

### Federated Graph Systems
- [Neo4j Fabric Sharding](https://neo4j.com/developer/neo4j-fabric-sharding/)
- [Neo4j Composite Database Concepts](https://neo4j.com/docs/operations-manual/current/database-administration/composite-databases/concepts/)
- [Neo4j Infinigraph Scalability](https://neo4j.com/product/neo4j-graph-database/scalability/)
- [Dgraph Overview](https://docs.dgraph.io/dgraph-overview/)
- [Dgraph Cluster Setup](https://dgraph.io/docs/deploy/cluster-setup/)
- [TigerGraph Internal Architecture](https://docs.tigergraph.com/tigergraph-server/current/intro/internal-architecture)
- [TigerGraph Distributed Query Mode](https://docs.tigergraph.com/gsql-ref/4.2/querying/distributed-query-mode)
- [TigerGraph: A Native MPP Graph Database (arXiv)](https://arxiv.org/pdf/1901.08248)
- [SPARQL 1.1 Federated Query (W3C)](https://www.w3.org/TR/sparql11-federated-query/)
- [GraphDB FedX Federation](https://graphdb.ontotext.com/documentation/11.2/fedx-federation.html)

### P2P Federation Protocols
- [ActivityPub W3C Specification](https://www.w3.org/TR/activitypub/)
- [ActivityPub and WebFinger (W3C Community Report)](https://www.w3.org/community/reports/socialcg/CG-FINAL-apwf-20240608/)
- [AT Protocol Federation Architecture](https://docs.bsky.app/docs/advanced-guides/federation-architecture)
- [AT Protocol Lexicon Specification](https://atproto.com/specs/lexicon)
- [AT Protocol 2025 Roadmap](https://docs.bsky.app/blog/2025-protocol-roadmap-spring)
- [Introduction to AT Protocol (mackuba.eu)](https://mackuba.eu/2025/08/20/introduction-to-atproto/)
- [Matrix Server-Server API Specification](https://spec.matrix.org/v1.11/server-server-api/)
- [Matrix State Resolution v2](https://matrix.org/docs/older/stateres-v2/)
- [IPFS Kademlia DHT Specification](https://specs.ipfs.tech/routing/kad-dht/)
- [IPFS DHT Documentation](https://docs.ipfs.tech/concepts/dht/)

### Distributed Query Execution
- [Pregel: A System for Large-Scale Graph Processing (original paper)](https://15799.courses.cs.cmu.edu/fall2013/static/papers/p135-malewicz.pdf)
- [GraphX Spark Programming Guide](https://spark.apache.org/docs/latest/graphx-programming-guide.html)
- [GraphX: Graph Processing in a Distributed Dataflow Framework (paper)](https://amplab.cs.berkeley.edu/wp-content/uploads/2014/09/graphx.pdf)
- [Spark GraphX PartitionStrategy source](https://github.com/apache/spark/blob/master/graphx/src/main/scala/org/apache/spark/graphx/PartitionStrategy.scala)
- [Survey of Distributed Graph Algorithms on Massive Graphs](https://arxiv.org/html/2404.06037v1)
- [PowerLyra: Differentiated Partitioning on Skewed Graphs](https://github.com/realstolz/powerlyra)

### Package Ecosystem Federation
- [npm Registry Package Metadata](https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md)
- [npm Registry API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md)
- [Cargo Registry Index (The Cargo Book)](https://doc.rust-lang.org/cargo/reference/registry-index.html)
- [Cargo Sparse Index RFC 2789](https://rust-lang.github.io/rfcs/2789-sparse-index.html)
- [Maven Repository Metadata](https://maven.apache.org/repositories/metadata.html)
- [Maven POM Reference](https://maven.apache.org/pom.html)

### Lazy/On-Demand Activation
- [Knative Autoscaling Documentation](https://knative.dev/docs/serving/autoscaling/)
- [Knative Scale-to-Zero Configuration](https://knative.dev/docs/serving/autoscaling/scale-to-zero/)
- [Knative Scaling System Design](https://github.com/knative/serving/blob/main/docs/scaling/SYSTEM.md)
- [AWS Lambda SnapStart with Firecracker](https://elasticscale.com/blog/aws-lambda-snapstart-reducing-cold-start-times-with-firecracker/)
- [Prebaking Runtime Environments (ScienceDirect)](https://www.sciencedirect.com/science/article/abs/pii/S0167739X24000190)
- [Orleans Virtual Actors in Practice](https://developersvoice.com/blog/dotnet/orleans-virtual-actors-in-practice/)
- [Akka vs Orleans Comparison](https://github.com/akka/akka-meta/blob/master/ComparisonWithOrleans.md)
- [Erlang OTP Supervisor Behaviour](https://www.erlang.org/doc/system/sup_princ.html)
