# Cloud Product Mapping: AWS, GCP, Azure

Comprehensive mapping of cloud provider products organized by functional category. This mapping is based on official cloud provider documentation and comparison resources as of February 2026.

## Compute Services

### Virtual Machines
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| EC2 (Elastic Compute Cloud) | Compute Engine | Virtual Machines | `compute:vm` |
| EC2 Spot Instances | Preemptible VMs / Spot VMs | Azure Spot VMs | `compute:vm:spot` |
| - | Cloud GPUs | GPU VMs | `compute:vm:gpu` |
| - | Cloud TPU | - | `compute:vm:tpu` |

### Serverless Compute
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Lambda | Cloud Functions | Azure Functions | `compute:serverless` |
| Lambda@Edge | Cloud Functions (edge) | Azure Functions (edge) | `compute:serverless:edge` |
| CloudFront Functions | - | - | `compute:serverless:edge` |

### Platform as a Service
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Elastic Beanstalk | App Engine | App Service | `compute:service` |
| - | Firebase Hosting | - | `compute:service` |

### Container Services
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| ECS (Elastic Container Service) | Cloud Run | Container Instances | `compute:container` |
| EKS (Elastic Kubernetes Service) | GKE (Google Kubernetes Engine) | AKS (Azure Kubernetes Service) | `compute:container:orchestration` |
| Fargate | Cloud Run (fully managed) | Container Instances | `compute:serverless:container` |
| - | GKE Autopilot | - | `compute:container:managed` |

### Batch Computing
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| AWS Batch | Cloud Batch | Azure Batch | `compute:job` |
| - | Dataflow | Azure Data Factory | `compute:job:pipeline` |

### Hybrid/Multi-Cloud
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Outposts | Anthos | Azure Arc | `compute:hybrid` |
| - | GKE Enterprise (formerly Anthos) | - | `compute:multi_cloud` |

### VMware Integration
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| VMware Cloud on AWS | Google Cloud VMware Engine | Azure VMware Solution | `compute:vmware` |

### Specialized Workloads
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| - | SAP on Google Cloud | SAP on Azure | `compute:sap` |
| ParallelCluster | - | CycleCloud | `compute:hpc` |

## Storage Services

### Object Storage
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| S3 (Simple Storage Service) | Cloud Storage | Blob Storage | `storage:object` |
| S3 Glacier | Cloud Storage (Archive class) | Archive Storage | `storage:object:archive` |
| S3 Glacier Deep Archive | Cloud Storage (Coldline/Archive) | Cool/Archive Blob Storage | `storage:object:cold` |

### Block Storage
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| EBS (Elastic Block Store) | Persistent Disk | Managed Disks | `storage:volume` |
| - | Local SSD | Local SSD (temporary) | `storage:volume:ephemeral` |
| - | Google Cloud Hyperdisk | Premium SSD v2 | `storage:volume:high_performance` |

### File Storage
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| EFS (Elastic File System) | Filestore | Azure Files | `storage:file` |
| FSx for Windows File Server | - | Azure Files (SMB) | `storage:file:windows` |
| FSx for Lustre | - | - | `storage:file:hpc` |
| - | Google Cloud NetApp Volumes | Azure NetApp Files | `storage:file:enterprise` |
| - | Parallelstore | - | `storage:file:parallel` |

### Data Transfer
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| DataSync | Storage Transfer Service | Azure Data Box | `storage:transfer` |
| Snow Family (Snowball, Snowmobile) | Transfer Appliance | Data Box (offline) | `storage:transfer:offline` |

## Database Services

### Relational Databases (Managed)
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| RDS (Relational Database Service) | Cloud SQL | Azure SQL Database | `storage:database:sql` |
| Aurora | Cloud Spanner (global) | - | `storage:database:sql:distributed` |
| - | AlloyDB | - | `storage:database:sql:postgres` |

### Relational Databases (Specific Engines)
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| RDS for PostgreSQL | Cloud SQL for PostgreSQL | Azure Database for PostgreSQL | `storage:database:postgres` |
| RDS for MySQL | Cloud SQL for MySQL | Azure Database for MySQL | `storage:database:mysql` |
| RDS for MariaDB | Cloud SQL for MySQL | Azure Database for MariaDB | `storage:database:mysql` |
| RDS for SQL Server | Cloud SQL for SQL Server | Azure SQL Managed Instance | `storage:database:sqlserver` |
| RDS for Oracle | - | - | `storage:database:oracle` |

### NoSQL Databases
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| DynamoDB | Firestore (Datastore mode) | Cosmos DB | `storage:database:nosql` |
| - | Bigtable | - | `storage:database:nosql:wide_column` |
| DocumentDB | Firestore (Native mode) | Cosmos DB (MongoDB API) | `storage:database:document` |

### In-Memory Databases
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| ElastiCache (Redis) | Memorystore for Redis | Azure Cache for Redis | `storage:cache:redis` |
| ElastiCache (Memcached) | Memorystore for Memcached | - | `storage:cache:memcached` |

### Graph Databases
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Neptune | - | Cosmos DB (Gremlin API) | `storage:database:graph` |

### Time-Series Databases
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Timestream | Cloud Bigtable (optimized) | Azure Data Explorer | `storage:database:timeseries` |

### Data Warehouse
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Redshift | BigQuery | Synapse Analytics | `storage:database:warehouse` |

## Networking Services

### Virtual Networks
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| VPC (Virtual Private Cloud) | VPC (Virtual Private Cloud) | Virtual Network (VNet) | `networking:vpc` |
| Subnet | Subnet | Subnet | `networking:subnet` |

### Load Balancing
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| ELB (Elastic Load Balancing) | Cloud Load Balancing | Azure Load Balancer | `networking:ingress` |
| ALB (Application Load Balancer) | HTTP(S) Load Balancing | Application Gateway | `networking:ingress:http` |
| NLB (Network Load Balancer) | Network Load Balancing | Azure Load Balancer | `networking:ingress:tcp` |
| GWLB (Gateway Load Balancer) | - | - | `networking:ingress:gateway` |

### DNS
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Route 53 | Cloud DNS | Azure DNS | `networking:dns` |

### CDN (Content Delivery Network)
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| CloudFront | Cloud CDN | Azure CDN | `networking:cdn` |
| CloudFront (with Lambda@Edge) | Cloud CDN (with Cloud Functions) | Azure CDN (with Functions) | `networking:cdn:edge` |

### VPN & Connectivity
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| VPN Gateway | Cloud VPN | VPN Gateway | `networking:vpn` |
| Direct Connect | Cloud Interconnect | ExpressRoute | `networking:interconnect` |
| Transit Gateway | Cloud Router | Virtual WAN | `networking:transit` |

### Service Discovery
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Cloud Map | Service Directory | - | `networking:service:discovery` |

### Service Mesh
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| App Mesh | Cloud Service Mesh (Anthos) | Service Fabric Mesh | `networking:service:mesh` |
| - | Traffic Director | - | `networking:service:traffic` |

### API Gateway
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| API Gateway | API Gateway / Apigee | API Management | `networking:gateway` |
| - | Apigee (full lifecycle) | - | `networking:gateway:enterprise` |

### Firewall & Security
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Security Groups | Firewall Rules | Network Security Groups | `networking:firewall` |
| WAF (Web Application Firewall) | Cloud Armor | Azure WAF | `networking:firewall:waf` |
| Shield (DDoS Protection) | Cloud Armor (DDoS) | Azure DDoS Protection | `networking:firewall:ddos` |

### Private Connectivity
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| PrivateLink | Private Service Connect | Private Link | `networking:private_link` |

## Messaging & Event Services

### Message Queues
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| SQS (Simple Queue Service) | Cloud Tasks | Queue Storage | `messaging:queue` |
| - | - | Service Bus Queues | `messaging:queue:enterprise` |

### Pub/Sub & Topics
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| SNS (Simple Notification Service) | Pub/Sub | Service Bus Topics | `messaging:topic` |

### Event Bus
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| EventBridge | Eventarc | Event Grid | `messaging:event_bus` |

### Streaming & Real-Time Data
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Kinesis Data Streams | Pub/Sub (streaming mode) | Event Hubs | `messaging:stream` |
| Kinesis Data Firehose | Dataflow | Event Hubs (capture) | `messaging:stream:ingest` |
| Kinesis Data Analytics | Dataflow | Stream Analytics | `messaging:stream:analytics` |
| MSK (Managed Streaming for Kafka) | - | Event Hubs for Kafka | `messaging:stream:kafka` |

### Workflow Orchestration
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Step Functions | Cloud Workflows | Logic Apps | `messaging:workflow` |
| - | Cloud Composer (Airflow) | Data Factory | `messaging:workflow:data` |

## Identity & Security Services

### Identity & Access Management
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| IAM (Identity and Access Management) | Cloud IAM | Azure Active Directory (Entra ID) | `security:iam` |
| Cognito | Identity Platform | Azure AD B2C | `security:iam:consumer` |
| Organizations | Resource Manager | Management Groups | `security:iam:org` |

### Key Management
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| KMS (Key Management Service) | Cloud KMS | Azure Key Vault | `config:secret:kms` |
| CloudHSM | Cloud HSM | Dedicated HSM | `config:secret:hsm` |

### Secrets Management
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Secrets Manager | Secret Manager | Key Vault (secrets) | `config:secret` |
| Systems Manager Parameter Store | - | App Configuration | `config:map` |

### Certificate Management
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| ACM (Certificate Manager) | Certificate Manager | App Service Certificates | `security:certificate` |

### Data Protection
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Macie | DLP (Data Loss Prevention) | Purview | `security:dlp` |
| GuardDuty | Security Command Center | Defender for Cloud | `security:threat_detection` |

### Compliance & Audit
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| CloudTrail | Cloud Audit Logs | Activity Log | `observability:audit` |
| Config | Config Connector | Policy | `security:compliance` |

## Observability Services

### Monitoring
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| CloudWatch | Cloud Monitoring (Operations Suite) | Azure Monitor | `observability:monitoring` |
| CloudWatch Metrics | Cloud Monitoring Metrics | Azure Monitor Metrics | `observability:metrics` |

### Logging
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| CloudWatch Logs | Cloud Logging | Azure Monitor Logs | `observability:log_target` |
| - | - | Log Analytics | `observability:log_analytics` |

### Distributed Tracing
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| X-Ray | Cloud Trace | Application Insights | `observability:tracing` |

### Application Performance Monitoring
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| CloudWatch Application Insights | Cloud Profiler | Application Insights | `observability:apm` |

### Alerting
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| CloudWatch Alarms | Cloud Monitoring Alerts | Azure Monitor Alerts | `observability:alert` |
| SNS (for notifications) | Pub/Sub / Cloud Alerting | Action Groups | `observability:notification` |

### Dashboards
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| CloudWatch Dashboards | Cloud Monitoring Dashboards | Azure Dashboards | `observability:dashboard` |

## AI & Machine Learning Services

### ML Platform (End-to-End)
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| SageMaker | Vertex AI | Azure Machine Learning | `ai:platform` |

### Pre-Trained Models & APIs

#### Vision
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Rekognition | Vision AI | Computer Vision | `ai:vision` |
| - | Vision AI (OCR) | Computer Vision (OCR) | `ai:vision:ocr` |

#### Natural Language
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Comprehend | Natural Language AI | Text Analytics | `ai:nlp` |
| Translate | Translation AI | Translator | `ai:nlp:translation` |

#### Speech
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Polly (text-to-speech) | Text-to-Speech | Speech (TTS) | `ai:speech:tts` |
| Transcribe (speech-to-text) | Speech-to-Text | Speech (STT) | `ai:speech:stt` |

#### Document Processing
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Textract | Document AI | Form Recognizer | `ai:document` |

#### Conversational AI
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Lex | Dialogflow | Bot Service | `ai:chatbot` |

### Specialized AI
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Forecast | - | - | `ai:forecasting` |
| Personalize | Recommendations AI | Personalizer | `ai:recommendation` |
| Fraud Detector | - | - | `ai:fraud_detection` |

### AutoML
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| SageMaker Autopilot | Vertex AI AutoML | Automated ML | `ai:automl` |

### Model Training Infrastructure
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| SageMaker Training | Vertex AI Training | ML Compute | `ai:training` |
| - | TPU (Tensor Processing Units) | - | `ai:training:tpu` |

## Data Analytics Services

### Business Intelligence
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| QuickSight | Looker / Looker Studio | Power BI | `analytics:bi` |

### Data Processing
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| EMR (Elastic MapReduce) | Dataproc | HDInsight | `analytics:processing:hadoop` |
| Glue | Dataflow | Data Factory | `analytics:processing:etl` |
| Athena | BigQuery | Synapse Analytics (serverless) | `analytics:processing:query` |

### Data Catalog
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Glue Data Catalog | Data Catalog | Purview | `analytics:catalog` |

### Search
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| OpenSearch Service | - | Azure Cognitive Search | `analytics:search` |
| CloudSearch | - | - | `analytics:search:managed` |

## Developer Tools & DevOps

### CI/CD
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| CodePipeline | Cloud Build | Azure Pipelines | `devops:pipeline` |
| CodeBuild | Cloud Build | Azure Pipelines (build) | `devops:build` |
| CodeDeploy | Cloud Deploy | Azure Pipelines (release) | `devops:deploy` |

### Source Control
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| CodeCommit | Cloud Source Repositories | Azure Repos | `devops:source` |

### Container Registry
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| ECR (Elastic Container Registry) | Artifact Registry / Container Registry | Azure Container Registry | `devops:registry:container` |

### Artifact Management
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| CodeArtifact | Artifact Registry | Azure Artifacts | `devops:registry:artifact` |

### Infrastructure as Code
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| CloudFormation | Deployment Manager | ARM Templates / Bicep | `devops:iac` |
| - | - | Azure Resource Manager | `devops:iac:manager` |

### Configuration Management
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Systems Manager | - | Automation | `devops:config` |
| OpsWorks (Chef/Puppet) | - | - | `devops:config:chef` |

## Communication Services

### Email
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| SES (Simple Email Service) | - (use SendGrid partner) | Communication Services | `communication:email` |

### SMS & Phone
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| SNS (SMS) | - | Communication Services | `communication:sms` |
| - | - | Communication Services (telephony) | `communication:telephony` |

### Notifications (Push)
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| SNS (mobile push) | Firebase Cloud Messaging | Notification Hubs | `communication:push` |

## IoT Services

### IoT Core Platform
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| IoT Core | Cloud IoT Core | IoT Hub | `iot:platform` |

### IoT Device Management
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| IoT Device Management | Cloud IoT Device Manager | IoT Hub Device Provisioning | `iot:device_management` |

### IoT Analytics
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| IoT Analytics | - | Stream Analytics (IoT) | `iot:analytics` |

### IoT Edge
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| IoT Greengrass | Edge TPU / IoT Edge | IoT Edge | `iot:edge` |

## Blockchain & Ledger Services

### Blockchain
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Managed Blockchain | - | Azure Blockchain Service (deprecated) | `blockchain:platform` |

### Ledger
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| QLDB (Quantum Ledger Database) | - | - | `blockchain:ledger` |

## Media Services

### Media Processing
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Elastic Transcoder | Transcoder API | Media Services | `media:transcoding` |

### Live Streaming
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| MediaLive | Live Stream API | Media Services Live | `media:streaming:live` |

### Video on Demand
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| MediaConvert | Transcoder API | Media Services | `media:streaming:vod` |

## Migration & Transfer Services

### Database Migration
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| DMS (Database Migration Service) | Database Migration Service | Database Migration Service | `migration:database` |

### Application Migration
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Application Migration Service | Migrate for Compute Engine | Azure Migrate | `migration:application` |

### Server Migration
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| SMS (Server Migration Service) | Migrate for Compute Engine | Azure Migrate | `migration:server` |

## Cost Management

### Cost Tracking & Optimization
| AWS | GCP | Azure | Abstract Type |
|-----|-----|-------|---------------|
| Cost Explorer | Cost Management | Cost Management + Billing | `cost:tracking` |
| Budgets | Budgets & Alerts | Budgets | `cost:budget` |
| Compute Optimizer | Recommender | Advisor | `cost:optimization` |

## Gap Analysis: Current Taxonomy vs Cloud Provider Coverage

### Current Taxonomy (20 types in 6 categories)

**Compute (4 types):**
- `compute:service` ✓ (PaaS)
- `compute:serverless` ✓ (FaaS/Lambda)
- `compute:job` ✓ (Batch)
- `compute:vm` ✓ (Virtual Machines)

**Networking (3 types):**
- `networking:ingress` ✓ (Load Balancers)
- `networking:service` ✓ (Service Discovery/Mesh)
- `networking:gateway` ✓ (API Gateway)

**Storage (4 types):**
- `storage:database` ✓ (All database types)
- `storage:object` ✓ (S3/GCS/Blob)
- `storage:volume` ✓ (EBS/Persistent Disk)
- `storage:cache` ✓ (Redis/Memcached)

**Messaging (3 types):**
- `messaging:queue` ✓ (SQS/Cloud Tasks)
- `messaging:stream` ✓ (Kinesis/Pub/Sub)
- `messaging:topic` ✓ (SNS/Pub/Sub)

**Config (2 types):**
- `config:map` ✓ (ConfigMaps/Parameter Store)
- `config:secret` ✓ (Secrets Manager)

**Observability (4 types):**
- `observability:alert` ✓ (CloudWatch Alarms)
- `observability:dashboard` ✓ (Dashboards)
- `observability:slo` ✓ (Custom, not native in all clouds)
- `observability:log_target` ✓ (CloudWatch Logs/Cloud Logging)

### Missing Categories & Types

#### 1. Container Orchestration (CRITICAL GAP)
**Why missing:** Current taxonomy has `compute:vm` and `compute:serverless` but lacks distinction for containerized workloads.

**Proposed additions:**
- `compute:container` — Container instances (ECS/Cloud Run/Container Instances)
- `compute:container:orchestration` — Kubernetes (EKS/GKE/AKS)
- `compute:serverless:container` — Serverless containers (Fargate/Cloud Run)

**Impact:** High — containers are fundamental in modern cloud infrastructure.

#### 2. File Storage (SIGNIFICANT GAP)
**Why missing:** `storage:volume` covers block storage, but file systems (NFS/SMB) are distinct.

**Proposed additions:**
- `storage:file` — Managed file systems (EFS/Filestore/Azure Files)
- `storage:file:enterprise` — Enterprise file systems (NetApp/FSx)

**Impact:** Medium — common for shared storage in multi-instance workloads.

#### 3. Networking Infrastructure (MODERATE GAP)
**Why missing:** `networking:ingress` exists but doesn't cover foundational networking.

**Proposed additions:**
- `networking:vpc` — Virtual private networks
- `networking:dns` — DNS services
- `networking:cdn` — Content delivery networks
- `networking:vpn` — VPN gateways
- `networking:firewall` — Security groups / firewalls
- `networking:firewall:waf` — Web application firewalls

**Impact:** Medium-High — VPC and DNS are foundational, CDN/WAF common for production apps.

#### 4. Database Specialization (MODERATE GAP)
**Why missing:** `storage:database` is too broad — doesn't distinguish SQL/NoSQL/Graph/etc.

**Proposed refinements:**
- `storage:database:sql` — Relational databases (RDS/Cloud SQL)
- `storage:database:nosql` — NoSQL databases (DynamoDB/Firestore)
- `storage:database:graph` — Graph databases (Neptune/Cosmos DB)
- `storage:database:timeseries` — Time-series databases (Timestream)
- `storage:database:warehouse` — Data warehouses (Redshift/BigQuery)

**Impact:** Medium — important for data modeling and architecture decisions.

#### 5. Observability Extensions (LOW-MODERATE GAP)
**Why missing:** Current types cover basics but miss tracing and metrics.

**Proposed additions:**
- `observability:tracing` — Distributed tracing (X-Ray/Cloud Trace)
- `observability:metrics` — Metrics collection (CloudWatch Metrics)
- `observability:apm` — Application performance monitoring

**Impact:** Low-Medium — valuable for complex distributed systems.

#### 6. AI/ML Services (SIGNIFICANT GAP for modern apps)
**Why missing:** Not infrastructure in traditional sense, but increasingly common.

**Proposed additions:**
- `ai:platform` — End-to-end ML platforms (SageMaker/Vertex AI)
- `ai:vision` — Computer vision APIs
- `ai:nlp` — Natural language processing
- `ai:speech` — Speech services

**Impact:** Medium — growing usage, especially in data-heavy applications.

#### 7. Security & Identity (CRITICAL for compliance)
**Why missing:** `config:secret` exists but doesn't cover broader IAM/security.

**Proposed additions:**
- `security:iam` — Identity and access management
- `security:certificate` — Certificate management
- `security:dlp` — Data loss prevention
- `security:threat_detection` — Threat detection services

**Impact:** High — essential for enterprise/regulated environments.

#### 8. Event & Workflow (MODERATE GAP)
**Why missing:** `messaging:*` types exist but don't cover event-driven patterns.

**Proposed additions:**
- `messaging:event_bus` — Event buses (EventBridge/Event Grid)
- `messaging:workflow` — Workflow orchestration (Step Functions/Logic Apps)

**Impact:** Medium — common in serverless and event-driven architectures.

#### 9. DevOps & CI/CD (MODERATE GAP)
**Why missing:** Not runtime infrastructure, but critical for deployment pipelines.

**Proposed additions:**
- `devops:pipeline` — CI/CD pipelines
- `devops:registry:container` — Container registries (ECR/Artifact Registry)
- `devops:iac` — Infrastructure as Code (CloudFormation/Terraform)

**Impact:** Medium — essential for deployment automation.

#### 10. Communication Services (LOW GAP)
**Why missing:** Niche but present in all clouds.

**Proposed additions:**
- `communication:email` — Email services (SES/SendGrid)
- `communication:sms` — SMS services
- `communication:push` — Push notifications

**Impact:** Low-Medium — used in customer-facing applications.

#### 11. IoT (NICHE GAP)
**Why missing:** Specialized domain but all clouds offer it.

**Proposed additions:**
- `iot:platform` — IoT device management platforms
- `iot:edge` — Edge computing for IoT

**Impact:** Low — specialized use cases only.

## Priority Recommendations

### Immediate Additions (Cover 80% of common use cases)
1. **Container types** — `compute:container`, `compute:container:orchestration`
2. **File storage** — `storage:file`
3. **VPC/DNS** — `networking:vpc`, `networking:dns`
4. **CDN/WAF** — `networking:cdn`, `networking:firewall:waf`
5. **Database refinement** — Split `storage:database` into `sql`, `nosql`, `warehouse`
6. **IAM** — `security:iam`
7. **Event bus** — `messaging:event_bus`

### Next Priority (Enhance coverage to 95%)
8. **Tracing** — `observability:tracing`
9. **AI platform** — `ai:platform`, `ai:vision`, `ai:nlp`
10. **DevOps** — `devops:pipeline`, `devops:registry:container`
11. **VPN/Interconnect** — `networking:vpn`, `networking:interconnect`

### Optional (Edge cases, <5% usage)
12. **IoT** — `iot:platform`, `iot:edge`
13. **Media** — `media:transcoding`, `media:streaming`
14. **Blockchain** — `blockchain:platform`

## Methodology Notes

This mapping was compiled from:
1. **Official Google Cloud documentation** — comprehensive AWS/Azure/GCP comparison table
2. **GitHub Cloud-Product-Mapping** — community-maintained service mappings
3. **Cloud provider comparison articles** — TechTarget, DataCamp, BMC, CloudExpat
4. **Specific category searches** — messaging, AI/ML, observability, security, IoT, batch computing, service mesh

All product names and mappings verified against 2026 sources to ensure accuracy.

## Sources

- [Google Cloud Official Service Comparison](https://docs.cloud.google.com/docs/get-started/aws-azure-gcp-service-comparison)
- [GitHub Cloud Product Mapping](https://github.com/milanm/Cloud-Product-Mapping)
- [AWS vs Azure vs GCP Comparison 2026](https://www.cloudwards.net/aws-vs-azure-vs-google/)
- [Cloud Services Cheat Sheet](https://www.techtarget.com/searchcloudcomputing/feature/A-cloud-services-cheat-sheet-for-AWS-Azure-and-Google-Cloud)
- [AWS Messaging Services Comparison](https://aws.amazon.com/blogs/compute/choosing-between-messaging-services-for-serverless-applications/)
- [Azure vs AWS Messaging Services](https://learn.microsoft.com/en-us/azure/architecture/aws-professional/messaging)
- [SageMaker vs Azure ML vs Vertex AI](https://www.cloudexpat.com/blog/sagemaker-azure-ml-gcp-ai-2024/)
- [Cloud Observability Monitoring Comparison](https://medium.com/@richard_64931/monitoring-service-comparison-aws-vs-azure-vs-gcp-part-2-7a9cd52b10f2)
- [AWS KMS vs Azure Key Vault vs GCP KMS](https://www.encryptionconsulting.com/aws-kms-vs-azure-key-vault-vs-gcp-kms/)
- [Cloud CDN Comparison](https://www.asioso.com/en/blog/amazon-cloudfront-google-cloud-cdn-and-microsoft-azure-cdn-overview-b524)
- [API Gateway Comparison](https://www.techtarget.com/searchcloudcomputing/tip/Compare-cloud-API-management-tools-from-AWS-Azure-and-Google)
- [Cloud Email Services](https://learn.microsoft.com/en-us/azure/architecture/aws-professional/messaging)
- [Cloud IoT Services Comparison](https://www.fieldtechnologiesonline.com/doc/comparison-of-iot-services-from-aws-azure-and-gcp-0001)
- [AWS Batch vs Azure Batch vs GCP Batch](https://www.cloudcomparetool.com/blog/aws-batch-vs-azure-batch-vs-google-cloud-batch-ultimate-comparison-for-scalable-job-processing)
- [Service Mesh Comparison](https://www.techtarget.com/searchcloudcomputing/opinion/How-AWS-Azure-and-Google-approach-service-mesh-technology)
