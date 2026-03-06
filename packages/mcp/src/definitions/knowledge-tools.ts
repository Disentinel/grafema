/**
 * Knowledge Tools — managing the persistent knowledge layer
 *
 * Knowledge nodes (decisions, facts, sessions) are stored as git-tracked
 * markdown files with YAML frontmatter. These tools provide CRUD operations
 * on the in-memory KnowledgeBase index.
 */

import type { ToolDefinition } from './types.js';

export const KNOWLEDGE_TOOLS: ToolDefinition[] = [
  {
    name: 'add_knowledge',
    description: `Add a new knowledge node (decision, fact, session, etc.) to the knowledge base.

Use this when you:
- Make an architectural decision during a session → type: DECISION
- Discover a fact about the codebase → type: FACT
- Want to record a design session → type: SESSION
- Need to track a commit, ticket, incident, or author → type: COMMIT/TICKET/INCIDENT/AUTHOR

The node is persisted as a markdown file in the knowledge/ directory and tracked by git.
ID format: kb:<type>:<slug> — generated from type + slug. Slug collision = error (likely a duplicate; use supersede_fact instead).

Example: add_knowledge(type="DECISION", content="Use file-based storage for KB", slug="kb-file-based-storage", status="active", projections=["epistemic"])`,
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Node type',
          enum: ['DECISION', 'FACT', 'SESSION', 'COMMIT', 'FILE_CHANGE', 'AUTHOR', 'TICKET', 'INCIDENT'],
        },
        content: {
          type: 'string',
          description: 'Markdown body content for the knowledge node',
        },
        slug: {
          type: 'string',
          description: 'URL-safe slug for the ID (auto-generated from content if omitted). Format: lowercase, hyphens, digits.',
        },
        subtype: {
          type: 'string',
          description: 'Subtype within the node type. FACT: domain, error, preference. DECISION: adr, runbook. Extensible — not restricted to these values.',
        },
        scope: {
          type: 'string',
          description: 'Scope of applicability for this knowledge node',
          enum: ['global', 'project', 'module'],
        },
        relates_to: {
          type: 'array',
          items: { type: 'string' },
          description: 'Semantic IDs of related nodes. Creates edges in edges.yaml.',
        },
        projections: {
          type: 'array',
          items: { type: 'string' },
          description: 'Projections this node belongs to (e.g., "epistemic", "temporal", "organizational")',
        },
        status: {
          type: 'string',
          description: 'Decision status (only for DECISION type)',
          enum: ['active', 'superseded', 'deprecated', 'proposed'],
        },
        confidence: {
          type: 'string',
          description: 'Confidence level (only for FACT type)',
          enum: ['high', 'medium', 'low'],
        },
        effective_from: {
          type: 'string',
          description: 'Date when decision took effect (YYYY-MM-DD, only for DECISION)',
        },
        applies_to: {
          type: 'array',
          items: { type: 'string' },
          description: 'Semantic addresses of code this applies to (only for DECISION)',
        },
        task_id: {
          type: 'string',
          description: 'Associated Linear task ID (only for SESSION)',
        },
      },
      required: ['type', 'content'],
    },
  },
  {
    name: 'query_knowledge',
    description: `Query knowledge nodes with filters.

Use this to:
- Find all decisions: query_knowledge(type="DECISION")
- Search by keyword: query_knowledge(text="RFDB")
- Find nodes in a projection: query_knowledge(projection="epistemic")
- Find related nodes: query_knowledge(relates_to="kb:session:2026-03-06-design")
- Combine filters: query_knowledge(type="FACT", text="auth")
- Find facts about code that no longer exists: query_knowledge(include_dangling_only=true)

Returns matching nodes with their full content, metadata, and code reference resolution status.
Code references (relates_to, applies_to) are resolved against the current code graph — each ref shows [OK] or [DANGLING] status.`,
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Filter by node type',
          enum: ['DECISION', 'FACT', 'SESSION', 'COMMIT', 'FILE_CHANGE', 'AUTHOR', 'TICKET', 'INCIDENT'],
        },
        projection: {
          type: 'string',
          description: 'Filter by projection (e.g., "epistemic", "temporal")',
        },
        relates_to: {
          type: 'string',
          description: 'Filter by relates_to containing this semantic ID',
        },
        text: {
          type: 'string',
          description: 'Case-insensitive text search in body content',
        },
        include_dangling_only: {
          type: 'boolean',
          description: 'When true, return only nodes with code references that no longer resolve (dangling). Requires code graph to be analyzed.',
        },
      },
    },
  },
  {
    name: 'query_decisions',
    description: `Query architectural decisions, optionally filtered by module or status.

Use this to:
- Find decisions affecting a module: query_decisions(module="packages/cli:CLI:MODULE")
- Find all active decisions: query_decisions(status="active")
- Find all decisions: query_decisions()

Returns decisions with status, applies_to, and full content.
Decisions are the core artifact type — they record WHY code is the way it is.`,
    inputSchema: {
      type: 'object',
      properties: {
        module: {
          type: 'string',
          description: 'Semantic address to match against applies_to (string includes matching)',
        },
        status: {
          type: 'string',
          description: 'Filter by decision status',
          enum: ['active', 'superseded', 'deprecated', 'proposed'],
        },
      },
    },
  },
  {
    name: 'supersede_fact',
    description: `Supersede an existing fact with a new version.

Use this when:
- A fact becomes outdated (e.g., library was upgraded, architecture changed)
- You discover new information that replaces an existing fact
- Correcting a previously recorded fact

This creates a NEW fact and marks the OLD fact with superseded_by pointing to the new one.
The old fact remains in the knowledge base for history.

Example: supersede_fact(old_id="kb:fact:auth-uses-bcrypt", new_content="Auth now uses argon2 after migration in REG-500")`,
    inputSchema: {
      type: 'object',
      properties: {
        old_id: {
          type: 'string',
          description: 'Semantic ID of the fact to supersede (e.g., "kb:fact:auth-uses-bcrypt")',
        },
        new_content: {
          type: 'string',
          description: 'Markdown content for the new fact',
        },
        new_slug: {
          type: 'string',
          description: 'Optional slug for the new fact (auto-generated if omitted)',
        },
      },
      required: ['old_id', 'new_content'],
    },
  },
  {
    name: 'get_knowledge_stats',
    description: `Get statistics about the knowledge base.

Use this to:
- Check if knowledge base is loaded and has content
- See counts by node type (DECISION, FACT, SESSION, etc.)
- See counts by lifecycle (declared, derived, synced)
- Identify dangling references in edges
- See dangling code references (KB nodes pointing at code that no longer exists in the graph)

Returns: total nodes, by-type counts, by-lifecycle counts, edge counts, dangling KB refs, dangling code refs.
Code reference resolution requires the code graph to be analyzed — without it, danglingCodeRefs will be empty.`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'git_churn',
    description: `Identify hot spots — files ranked by change frequency.

Use this to:
- Find which files change most often (high churn = high risk or high activity)
- Prioritize code review effort based on change frequency
- Identify files that may need refactoring (too many changes = unstable)

Returns files sorted by change count, with total lines added/removed.
Requires git history to be ingested first (grafema git-ingest).`,
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 20)',
        },
        since: {
          type: 'string',
          description: 'Only count changes after this date (ISO format, e.g., "2025-01-01")',
        },
      },
    },
  },
  {
    name: 'git_cochange',
    description: `Find files that frequently change together with a given file.

Use this to:
- Discover hidden coupling between files (change A → usually change B too)
- Understand the blast radius of modifying a file
- Identify candidates for refactoring into a single module

Returns files ranked by co-change frequency, with support metric (0-1).
Requires git history to be ingested first (grafema git-ingest).`,
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'File path to find co-changes for',
        },
        min_support: {
          type: 'number',
          description: 'Minimum support threshold (0-1, default: 0.1 = 10% of commits)',
        },
      },
      required: ['file'],
    },
  },
  {
    name: 'git_ownership',
    description: `Find who knows a file best — authors ranked by contribution.

Use this to:
- Identify domain experts for a specific file or module
- Find the right person to review changes to a file
- Understand team ownership distribution

Returns authors sorted by commit count, with lines added/removed.
Requires git history to be ingested first (grafema git-ingest).`,
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'File path to check ownership for',
        },
      },
      required: ['file'],
    },
  },
  {
    name: 'git_archaeology',
    description: `Get temporal context for a file — when it was first created and last modified.

Use this to:
- Find when a file was last touched (and by whom)
- Discover the original author of a file
- Assess staleness (old files may need review)
- Understand the timeline of a module's evolution

Returns first/last commit date, hash, and author.
Requires git history to be ingested first (grafema git-ingest).`,
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'File path to investigate',
        },
      },
      required: ['file'],
    },
  },
];
