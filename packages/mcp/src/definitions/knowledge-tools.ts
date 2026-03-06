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
];
