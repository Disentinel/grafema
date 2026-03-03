# Projection 9: Security

**Question:** Who is *allowed* to do what, and where does trusted meet untrusted?
**Soundness:** Real access path, trust boundary, or vulnerability exists → graph shows it.

## Lenses

### 9.1 Identity (who is making the request)

Authentication — proving who you are — is distinct from authorization (what you're allowed to do). Without modeling identity separately, you cannot answer "who can impersonate whom?" or "which services have no authentication at all?"

**principal** — any actor that can authenticate: human user, service account, machine identity
- × Organizational: "Principal 'svc-billing' is owned by Team Payments." Service-to-team tracing.
- × Operational: "Principal 'svc-legacy' authenticates to 12 downstream services." Blast radius if compromised.
- × Risk: "Principal 'svc-legacy' has no rotation policy and credentials are 3 years old."

**credential** — secret material used to prove identity: password, API key, token, certificate, private key
- × Temporal: "This TLS certificate expires in 14 days — no auto-rotation configured." Expiry risk.
- × Operational: "This API key is used by 4 services — rotation requires coordinated deploy."
- × Semantic: "This credential is hardcoded in module X." Supply chain / code smell detection.

**identity_provider** — system that issues and validates identity: OAuth IdP, SAML provider, SSO, internal CA
- × Organizational: "All employee access flows through Okta — single point of authentication."
- × Risk: "This internal CA has no revocation mechanism (no CRL/OCSP)." Revocation gap.
- × Operational: "Service X uses a deprecated auth method not connected to central IdP." Shadow identity.

### 9.2 Access Control (who can do what)

**role** — named set of permissions assigned to principals
- × Organizational: "Developers have role X, SREs have role Y." Org-to-access mapping.
- × Risk: "Role 'admin' has 47 permissions — likely over-privileged by least-privilege standard."

**permission** — specific allowed action on a specific resource
- × Semantic: "Permission to call function X requires role Y." Code-level access control audit.
- × Operational: "Permission to access database X is restricted to service Y."

**policy** — rule that governs access decisions, separate from a role (e.g., ABAC policy, time-based restriction)
- × Contractual: "Policy 'no production access without change ticket' — is it enforced in code?" Policy-as-invariant.
- × Temporal: "This policy was last reviewed 2 years ago — may not reflect current threat model."

### 9.3 Trust Boundaries (where trusted meets untrusted)

The most structurally important lens. A trust boundary is the point where data or control crosses from one trust domain to another. Without modeling these explicitly, you cannot answer "does untrusted input reach a privileged operation without validation?" This enables the highest-value cross-projection queries.

**trust_boundary** — interface between two zones of different trust: internet→internal, user→kernel, tenant→tenant
- × Semantic: "This HTTP handler is on the trust boundary — does it sanitize input before passing to SQL layer?" Data flow across boundary.
- × Operational: "This internal API is exposed to the DMZ without a WAF." Boundary misconfiguration.
- × Risk: "Trust boundary between tenant A and tenant B relies on a single middleware check."

**data_classification** — sensitivity label on data: PII, PHI, PCI, internal, confidential, public
- × Semantic: "This function processes PII — does it log it? Does it pass it to third-party SDKs?" Data leakage.
- × Operational: "PII is stored in a database in region X — GDPR requires EU residency." Residency violation.
- × Contractual: "PCI-DSS requires encryption of cardholder data at rest — is this field encrypted?" Compliance binding.

**encryption** — mechanism protecting data confidentiality: at-rest cipher, in-transit TLS, key management scheme
- × Operational: "Service X communicates with Service Y over plain HTTP internally." In-transit gap.
- × Temporal: "This field was encrypted with AES-128 (deprecated) — upgrade required." Algorithm staleness.
- × Semantic: "Encryption key is derived from a constant seed in module X." Implementation flaw.

### 9.4 Vulnerability (what can be attacked)

**entry_point** — concrete exposed interface that can receive untrusted input: HTTP endpoint, message queue consumer, file upload handler, CLI argument parser
- × Semantic: "This entry point calls unsanitized function X." Code-level vulnerability path.
- × Operational: "This entry point is publicly reachable on port 443 and receives 10k req/day." Active exposure.
- × Behavioral: "This entry point's error rate spiked 5× in the last hour." Possible active exploitation signal.

**CVE** — published advisory for a known vulnerability in a specific package version
- × Semantic: "CVE-2024-XXXX affects package `lodash@4.17.20` imported in module Y." Vulnerability-to-code tracing.
- × Risk: "CVSS 9.8, exploitable remotely, no authentication required." Severity.
- × Temporal: "Published 45 days ago — still unpatched in production." Exposure window duration.

**threat_model** — explicit enumeration of adversaries, assets, and attack scenarios for a component
- × Intentional: "Threat model for payment service assumes external attacker, not malicious insider — does access control reflect this?" Design alignment.
- × Epistemic: "No threat model exists for module X handling PII." Modeling gap.
- × Organizational: "Threat model was created by Team A — Team B (who now owns it) has never reviewed it."

### 9.5 Supply Chain (what we depend on and whether it's safe)

Software dependencies are an attack vector — not just CVEs in known packages, but malicious packages, typosquatting, and license violations that create legal exposure. This is distinct from the Vulnerability lens, which covers runtime exploitation.

**dependency_audit** — point-in-time security review of a dependency: license, maintainer health, known issues, publish anomalies
- × Semantic: "Package X is imported in 12 modules — if it is malicious, blast radius is 12 modules."
- × Temporal: "Package X has not had a release in 3 years — abandoned, no security patches expected."
- × Risk: "Package X changed maintainer 6 months ago — supply chain integrity risk."

**SBOM** — Software Bill of Materials: complete inventory of all direct and transitive dependencies with versions
- × Contractual: "This SBOM is the deliverable for customer audit — must be complete and current." SBOM-as-contract.
- × Operational: "SBOM generated at deploy time — is the production build reproducible from this SBOM?"
- × Risk: "SBOM shows 3 packages with GPL license in a proprietary product." License exposure.

### 9.6 Compliance and Audit (what is required and what was done)

**regulation** — external legal or industry requirement that imposes obligations: GDPR, HIPAA, SOC2, PCI-DSS, ISO 27001
- × Semantic: "This function processes PHI — HIPAA requires access logging and encryption." Regulation-to-code binding.
- × Financial: "GDPR non-compliance penalty: up to 4% of global annual revenue." Cost of non-compliance.
- × Organizational: "GDPR obligations fall on Team Data — are they aware and resourced?"

**audit_trail** — runtime record of security-relevant events: who accessed what, when, from where; login/logout, privilege escalation, data export
- × Behavioral: "Audit trail shows user X exported 50k records at 2am — anomalous." Forensic signal.
- × Contractual: "SOC2 requires audit trail retention for 12 months — current retention is 30 days." Compliance gap.
- × Temporal: "Audit trail has a 6-hour gap on the day of the suspected breach." Forensic hole.

**compliance_audit** — formal periodic review by internal or external auditor to verify controls
- × Temporal: "Last compliance audit: 8 months ago. Next: in 1 month. 3 open findings." Audit timeline.
- × Contractual: "Audit finding #4: MFA not enforced for production access." Gap-as-contractual-obligation.
- × Organizational: "Finding #4 is owned by Team Platform — is it tracked in their backlog?"

**certification** — achieved and maintained compliance status (SOC2 Type II, ISO 27001, PCI-DSS Level 1)
- × Intentional: "SOC2 Type II certification is a sales prerequisite for enterprise deals." Compliance-to-revenue link.
- × Risk: "Certification expires in 90 days — renewal blocked by 2 unresolved audit findings."
- × Temporal: "Certification scope changed last year — are all new services in scope now covered?"

**security_incident** — confirmed or suspected breach, exploit, or unauthorized access event
- × Temporal: "Incident started at T=0, detected at T+6h, contained at T+18h." Detection and response timeline.
- × Organizational: "Incident response requires Legal, Security, and Exec — is the runbook current and rehearsed?"
- × Financial: "Estimated cost: $1.2M in response + mandatory breach notification to 40k users." Breach impact.
- × Contractual: "GDPR requires breach notification within 72 hours — was this met?" Regulatory obligation on incident.

## Entity Count: 21
