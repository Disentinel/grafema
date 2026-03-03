# Projection 2: Operational

**Question:** How does code *execute*?
**Soundness:** Real runtime interaction exists → graph shows it.

## Lenses

### 2.1 Topology (what connects to what at runtime)

**service** — long-running process that listens for requests (REST API, gRPC server, WebSocket server)
- × Semantic: "This service runs code from modules A, B, C." Code-to-runtime mapping.
- × Financial: "This service costs $12k/month." Cost attribution.
- × Organizational: "This service is owned by Team X." Operational ownership.

**job** — process that starts, does work, and terminates (cron, batch, scheduled task, migration)
- × Temporal: "This job runs every hour." Cadence.
- × Causal: "This nightly job failed and data wasn't synced — downstream services stale." Invisible dependency.
- × Financial: "This batch job uses a GPU instance for 2 hours/day = $180/month."

**gateway** — routing/proxying component (API gateway, load balancer, reverse proxy, ingress controller)
- × Security: "This gateway terminates TLS and enforces rate limiting." Security boundary.
- × Behavioral: "This gateway routes 80% of traffic to v2, 20% to v1." Canary/blue-green.
- × Risk: "All traffic goes through one gateway — SPOF."

**datastore** — any persistent or semi-persistent storage (relational DB, document DB, key-value store, object storage, search index, cache)
- × Security: "This datastore contains PII — who can access it?" Access control anchor.
- × Contractual: "This datastore has backup SLO: RPO < 1 hour."
- × Semantic: "This datastore is written to by function Y." Code-to-storage tracing.

**queue** — async communication channel (message queue, task queue)
- × Causal: "Message stuck in this queue caused cascade failure." Incident topology.
- × Behavioral: "This queue processes 100k events/day from user actions." Usage pipeline.

**external_dependency** — third-party service, SaaS, or API the system relies on
- × Risk: "If this dependency goes down, features X, Y, Z break." Blast radius of vendor failure.
- × Financial: "This dependency charges per call — $3k/month at current traffic."
- × Contractual: "This dependency promises 99.9% uptime in its SLA."

### 2.2 Communication (how services talk to each other)

**request** — synchronous interaction (HTTP call, gRPC call, DB query)
- × Causal: "This request failed with 500 — start of the incident chain." Incident entry point.
- × Contractual: "This request took 800ms — violates p99 SLO of 500ms."
- × Semantic: "This request maps to function `processPayment`." Runtime-to-code linking.

**event** — asynchronous message (queue message, domain event, webhook)
- × Causal: "This event was published but never consumed — silent data loss." Invisible failure.
- × Behavioral: "1M events/day from user actions flow through this channel." Usage scale.
- × Temporal: "This event was emitted at 14:32, consumed at 14:35 — 3 min lag."

**stream** — continuous data flow (Kafka topic, WebSocket connection, SSE, ETL pipeline)
- × Risk: "Consumer lag on this stream growing — backpressure building." Operational risk.
- × Financial: "This Kafka topic: 500GB/day throughput = $X/month." Data volume cost.
- × Behavioral: "Real-time user activity stream feeds the recommendation engine."

**endpoint** — addressable entry point of a service (URL, gRPC method, GraphQL field)
- × Intentional: "This endpoint implements feature 'password reset'." Feature-to-infra mapping.
- × Security: "This endpoint is publicly accessible — is it authenticated?"
- × Behavioral: "This endpoint receives 50k requests/day." Traffic volume.

### 2.3 Resource (what is consumed)

**compute** — CPU/memory allocation
- × Financial: "This pod uses 4 vCPU at $0.05/hour = $146/month." Direct cost.
- × Contractual: "Memory usage approaches limit — OOM risk violates availability SLO."

**storage** — disk/blob/database volume
- × Financial: "S3 bucket: 2TB at $0.023/GB = $46/month." Storage cost.
- × Compliance: "This storage is in EU region — satisfies data residency requirement."

**network** — bandwidth, latency, egress
- × Financial: "Cross-region traffic: 500GB/month egress = $45/month." Hidden cost.
- × Contractual: "Network latency between these services exceeds SLO."

**capacity** — maximum available resource (pod memory limit, max connections, rate limit, disk quota)
- × Risk: "Database max connections = 100, current usage = 87. One traffic spike away from pool exhaustion."
- × Contractual: "Rate limit 1000 req/s — will SLO hold if traffic doubles?"
- × Financial: "Increasing capacity from 4 to 8 vCPU doubles compute cost."

### 2.4 Config State (what changes behavior without code changes)

**feature_flag** — runtime behavior toggle
- × Causal: "Turning on flag X caused the incident." Config as root cause.
- × Behavioral: "50% of users see variant A, 50% see variant B." Experiment state.
- × Risk: "This flag has no documented rollback procedure."

**env_var** — environment-specific configuration
- × Causal: "Env var mismatch between staging and production caused the bug."
- × Operational: "This env var points to different databases per environment."

**secret** — sensitive configuration (API keys, passwords, certificates, tokens)
- × Security: "This API key has access to production database — who can read it?"
- × Temporal: "This certificate expires in 2 weeks." Rotation urgency.
- × Risk: "This secret was created 18 months ago and never rotated."

**experiment** — A/B test configuration (bridge entity: Operational × Behavioral)
- × Behavioral: "Experiment shows variant B increases conversion by 12%." Product insight.
- × Intentional: "This experiment tests hypothesis behind feature X." Purpose validation.

### 2.5 Geography (where does infrastructure physically exist)

**region** — cloud provider region (us-east-1, eu-west-1)
- × Compliance: "EU data must stay in EU region — GDPR data residency." Regulation-to-geography binding.
- × Behavioral: "Users in Asia experience 300ms latency to US-only deployment." Geography-to-UX impact.
- × Financial: "Cross-region replication adds $2k/month." Geography cost.

**availability_zone** — isolated failure domain within a region
- × Risk: "All replicas in one AZ — single AZ failure = full outage." Redundancy gap.
- × Contractual: "Multi-AZ deployment satisfies 99.99% availability SLO."

**datacenter** — physical facility (relevant for physical-world risks: natural disasters, geopolitics, power)
- × Risk: "This DC is in a region with geopolitical instability — what if it goes offline?"
- × Temporal: "This DC has maintenance window every Sunday 2-4 AM UTC."

**edge_location** — CDN/edge compute point
- × Behavioral: "Edge in São Paulo reduces latency for Brazilian users from 200ms to 30ms." User experience.
- × Financial: "Edge locations add $500/month but improve conversion by 5%."

**network_zone** — logical network isolation (VPC, subnet, security group, firewall zone)
- × Security: "This service is in public subnet — accessible from internet." Exposure surface.
- × Risk: "All services in one VPC — lateral movement possible if one is compromised."
- × Contractual: "PCI-DSS requires network segmentation between payment services and general services."

### 2.6 Environment (in what context does code run)

**environment** — logical isolation for the same system (dev, staging, production, sandbox, preview)
- × Causal: "Bug only in prod — staging doesn't have feature flag X enabled." Environment-specific failure.
- × Security: "Who has access to production vs staging?" Access differs per environment.
- × Contractual: "SLOs apply only to production." Environment-scoped guarantees.
- × Risk: "No staging environment — changes deploy directly to production."

**promotion_path** — how changes move between environments (dev → staging → prod)
- × Temporal: "This change has been in staging for 3 days — why not in prod?" Deployment velocity.
- × Risk: "Skip staging, deploy to prod = no pre-production validation."
- × Contractual: "SOC2 requires changes go through staging before production."

**parity** — degree to which environments match each other
- × Risk: "Staging has 10% of prod data — performance tests may miss issues."
- × Causal: "Bug caused by environment difference: staging Postgres 14, prod Postgres 12."
- × Contractual: "Testing is only valid if environment parity is above threshold."

## Entity Count: 25
