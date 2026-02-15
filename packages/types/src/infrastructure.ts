/**
 * Infrastructure Types — abstract resource taxonomy and cross-layer mapping.
 *
 * USG (Universal System Graph) extends Grafema from code-only to multi-layer:
 * Code → Abstract Resources → Concrete Infrastructure
 *
 * This module defines:
 * - Abstract resource types (tool-agnostic: compute:service, storage:database:sql)
 * - InfraResourceMap interface (like RoutingMap but for infra identity resolution)
 * - Supporting types for analyzers and cross-layer linking
 */

import type { Resource } from './resources.js';
import type { EdgeType } from './edges.js';

// ============================================================
// ABSTRACT RESOURCE TYPE TAXONOMY
// ============================================================

/**
 * Known abstract resource types, organized by category.
 * These are tool-agnostic — K8s Deployment, Docker service, EC2 all map
 * to the same abstract type (compute:service).
 *
 * Convention: category:subcategory[:detail]
 */
type KnownResourceType =
  // --- Compute ---
  | 'compute:service'                    // Long-running process (K8s Deployment, ECS Service, Docker service)
  | 'compute:serverless'                 // FaaS (AWS Lambda, GCP Cloud Function, Azure Function)
  | 'compute:container'                  // Container instance (ECS, Cloud Run, Container Instances)
  | 'compute:container:orchestration'    // K8s cluster (EKS, GKE, AKS)
  | 'compute:job'                        // Batch/scheduled (K8s CronJob, AWS Batch, Cloud Scheduler)
  | 'compute:vm'                         // Virtual machine (EC2, Compute Engine, Azure VM)
  // --- Networking ---
  | 'networking:ingress'                 // Load balancer / entry point (ALB, Cloud LB, App Gateway)
  | 'networking:service'                 // Internal service (K8s Service, ELB, internal LB)
  | 'networking:gateway'                 // API Gateway (API GW, Apigee, Azure API Management)
  | 'networking:vpc'                     // Virtual network (VPC, VNet)
  | 'networking:dns'                     // DNS (Route53, Cloud DNS, Azure DNS)
  | 'networking:cdn'                     // CDN (CloudFront, Cloud CDN, Azure CDN)
  | 'networking:firewall'               // Firewall / security group (SG, Cloud Armor, NSG)
  | 'networking:vpn'                     // VPN (VPN Gateway, Cloud VPN)
  // --- Storage ---
  | 'storage:object'                     // Object/blob (S3, GCS, Blob Storage)
  | 'storage:volume'                     // Block storage (EBS, Persistent Disk, Managed Disks)
  | 'storage:file'                       // File system (EFS, Filestore, Azure Files)
  | 'storage:cache'                      // Cache (ElastiCache, Memorystore, Azure Cache)
  | 'storage:database:sql'              // Relational DB (RDS, Cloud SQL, Azure SQL)
  | 'storage:database:nosql'            // NoSQL (DynamoDB, Firestore, Cosmos DB)
  | 'storage:database:graph'            // Graph DB (Neptune, Cosmos DB Gremlin)
  | 'storage:database:timeseries'       // Time-series (Timestream, Azure Data Explorer)
  | 'storage:database:warehouse'        // Data warehouse (Redshift, BigQuery, Synapse)
  // --- Messaging ---
  | 'messaging:queue'                    // Message queue (SQS, Cloud Tasks, Service Bus)
  | 'messaging:stream'                   // Event stream (Kinesis, Pub/Sub streaming, Event Hubs)
  | 'messaging:topic'                    // Pub/sub topic (SNS, Pub/Sub, Service Bus Topics)
  | 'messaging:event_bus'               // Event bus (EventBridge, Eventarc, Event Grid)
  | 'messaging:workflow'                 // Workflow orchestration (Step Functions, Workflows, Logic Apps)
  // --- Config ---
  | 'config:map'                         // Configuration (K8s ConfigMap, Parameter Store, App Config)
  | 'config:secret'                      // Secrets (K8s Secret, Secrets Manager, Key Vault)
  // --- Security ---
  | 'security:iam'                       // Identity management (IAM, Cloud IAM, Entra ID)
  | 'security:certificate'              // TLS certificates (ACM, Certificate Manager)
  | 'security:dlp'                       // Data loss prevention (Macie, DLP, Purview)
  | 'security:threat_detection'          // Threat detection (GuardDuty, SCC, Defender)
  // --- Observability ---
  | 'observability:alert'               // Alert rules (CloudWatch Alarm, Prometheus, Monitor Alerts)
  | 'observability:dashboard'           // Dashboards (Grafana, CloudWatch Dashboard)
  | 'observability:slo'                  // SLO definitions
  | 'observability:log_target'          // Log destination (CloudWatch Logs, Cloud Logging)
  | 'observability:tracing'             // Distributed tracing (X-Ray, Cloud Trace, App Insights)
  | 'observability:apm'                  // APM (CloudWatch App Insights, Cloud Profiler)
  // --- DevOps ---
  | 'devops:pipeline'                    // CI/CD pipeline (CodePipeline, Cloud Build, Azure Pipelines)
  | 'devops:registry:container'         // Container registry (ECR, Artifact Registry, ACR)
  | 'devops:iac'                         // IaC templates (CloudFormation, Deployment Manager, Bicep)
  // --- AI ---
  | 'ai:platform'                        // ML platform (SageMaker, Vertex AI, Azure ML)
  | 'ai:vision'                          // Computer vision (Rekognition, Vision AI, Computer Vision)
  | 'ai:nlp'                             // NLP (Comprehend, Natural Language AI, Text Analytics)
  | 'ai:speech'                          // Speech (Polly/Transcribe, Speech-to-Text, Azure Speech)
  // --- Communication ---
  | 'communication:email'               // Email service (SES, SendGrid)
  | 'communication:sms'                  // SMS (SNS SMS, Communication Services)
  | 'communication:push'                 // Push notifications (SNS Mobile, FCM, Notification Hubs)
  // --- IoT ---
  | 'iot:platform'                       // IoT platform (IoT Core, IoT Hub)
  | 'iot:edge';                          // Edge computing (Greengrass, IoT Edge)

/**
 * Abstract resource type — known types for autocomplete + extensible via string.
 * Any 'category:subcategory' string is valid.
 */
export type AbstractResourceType = KnownResourceType | `${string}:${string}`;

// ============================================================
// INFRA RESOURCE MAP
// ============================================================

/** Well-known Resource ID for InfraResourceMap */
export const INFRA_RESOURCE_MAP_ID = 'infra:resource:map' as const;

/**
 * Parsed infrastructure resource from a concrete analyzer.
 * Generic representation before graph node creation.
 */
export interface InfraResource {
  /** Unique resource ID (e.g., 'infra:k8s:deployment:user-api') */
  id: string;
  /** Concrete tool-specific type (e.g., 'infra:k8s:deployment') */
  type: string;
  /** Human-readable name */
  name: string;
  /** Source file where resource is defined */
  file: string;
  /** Line number in file (if available) */
  line?: number;
  /** Environment(s) this resource belongs to (undefined = all) */
  env?: string | string[];
  /** Tool that created this resource (e.g., 'kubernetes', 'terraform') */
  tool: string;
  /** Raw resource data */
  metadata?: Record<string, unknown>;
}

/**
 * Mapping from concrete resource to abstract type.
 * Created by InfraAnalyzer.mapToAbstract(), stored in InfraResourceMap.
 */
export interface ResourceMapping {
  /** Concrete graph node ID */
  concreteId: string;
  /** Concrete type (e.g., 'infra:k8s:deployment') */
  concreteType: string;
  /** Abstract type this maps to */
  abstractType: AbstractResourceType;
  /** Abstract resource ID (e.g., 'compute:service:user-api') */
  abstractId: string;
  /** Human-readable name */
  name: string;
  /** Normalized tool-agnostic metadata */
  metadata: Record<string, unknown>;
  /** Environment */
  env?: string | string[];
  /** Source file */
  sourceFile: string;
  /** Tool name */
  sourceTool: string;
}

/**
 * Cross-layer link between code and infrastructure.
 */
export interface CrossLayerLink {
  type: EdgeType;
  src: string;
  dst: string;
  metadata?: Record<string, unknown>;
}

/**
 * Abstract resource — tool-agnostic representation.
 * Created from one or more concrete resources via InfraResourceMap.
 */
export interface AbstractResource {
  /** Abstract ID (e.g., 'compute:service:user-api') */
  id: string;
  /** Abstract type */
  type: AbstractResourceType;
  /** Human-readable name */
  name: string;
  /** Environment */
  env?: string | string[];
  /** Normalized metadata */
  metadata: Record<string, unknown>;
  /** Concrete resources that provide this abstract resource */
  providers: ConcreteResourceRef[];
}

/**
 * Reference to a concrete resource that provides an abstract resource.
 */
export interface ConcreteResourceRef {
  /** Concrete graph node ID */
  id: string;
  /** Tool-specific type */
  type: string;
  /** Tool name */
  tool: string;
  /** Source file */
  file: string;
}

/**
 * InfraResourceMap — maps concrete infrastructure to abstract types.
 * Like RoutingMap but for infrastructure identity resolution.
 *
 * Resource ID: 'infra:resource:map'
 *
 * Lifecycle:
 * 1. Concrete analyzers (K8s, Terraform) call register() during ANALYSIS
 * 2. Enrichers call find*() during ENRICHMENT to create abstract nodes + edges
 */
export interface InfraResourceMap extends Resource {
  readonly id: typeof INFRA_RESOURCE_MAP_ID;

  /** Register a concrete->abstract mapping. Called by analyzers. */
  register(mapping: ResourceMapping): void;

  /** Find abstract resource by name and type. Returns null if not registered. */
  findAbstract(name: string, type: AbstractResourceType): AbstractResource | null;

  /** Find all concrete resources for an abstract resource ID. */
  findConcrete(abstractId: string): ConcreteResourceRef[];

  /** Get all abstract resources of a given type. */
  findByType(type: AbstractResourceType): AbstractResource[];

  /** Filter abstract resources by environment. */
  findByEnv(env: string): AbstractResource[];

  /** Get all registered abstract resources. */
  getAll(): AbstractResource[];

  /** Get count of abstract resources (for metrics). */
  get resourceCount(): number;
}

// ============================================================
// CONFIGURATION SCHEMA
// ============================================================

/**
 * Infrastructure configuration section in grafema.config.yaml.
 *
 * ```yaml
 * infrastructure:
 *   enabled: true
 *   kubernetes:
 *     enabled: true
 *     paths: ['k8s/**.yaml']
 * ```
 */
export interface InfrastructureConfig {
  enabled: boolean;
  kubernetes?: InfraToolConfig;
  terraform?: InfraToolConfig;
  dockerCompose?: InfraToolConfig;
  custom?: CustomAnalyzerConfig;
}

export interface InfraToolConfig {
  enabled: boolean;
  paths: string[];
  mappings?: Record<string, string>;
}

export interface CustomAnalyzerConfig {
  analyzerPath: string;
}
