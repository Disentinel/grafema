/**
 * Project Tools — structure, config, coverage, documentation, issue reporting
 */

import type { ToolDefinition } from './types.js';

export const PROJECT_TOOLS: ToolDefinition[] = [
  {
    name: 'read_project_structure',
    description: `Get the directory structure of the project.
Returns a tree of files and directories, useful for understanding
project layout during onboarding.

Excludes: node_modules, .git, dist, build, .grafema, coverage, .next, .nuxt

Use this tool when studying a new project to identify services,
packages, and entry points.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Subdirectory to scan (relative to project root). Default: project root.',
        },
        depth: {
          type: 'number',
          description: 'Maximum directory depth (default: 3, max: 5)',
        },
        include_files: {
          type: 'boolean',
          description: 'Include files in output, not just directories (default: true)',
        },
      },
    },
  },
  {
    name: 'write_config',
    description: `Write or update the Grafema configuration file (.grafema/config.yaml).
Validates all inputs before writing. Creates .grafema/ directory if needed.

Use this tool after studying the project to save the discovered configuration.
Only include fields you want to override — defaults are used for omitted fields.`,
    inputSchema: {
      type: 'object',
      properties: {
        services: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Service name (e.g., "backend")' },
              path: { type: 'string', description: 'Path relative to project root (e.g., "apps/backend")' },
              entryPoint: { type: 'string', description: 'Entry point file relative to service path (e.g., "src/index.ts")' },
            },
            required: ['name', 'path'],
          },
          description: 'Service definitions (leave empty to use auto-discovery)',
        },
        plugins: {
          type: 'object',
          properties: {
            indexing: { type: 'array', items: { type: 'string' }, description: 'Indexing plugins' },
            analysis: { type: 'array', items: { type: 'string' }, description: 'Analysis plugins' },
            enrichment: { type: 'array', items: { type: 'string' }, description: 'Enrichment plugins' },
            validation: { type: 'array', items: { type: 'string' }, description: 'Validation plugins' },
          },
          description: 'Plugin configuration (omit to use defaults)',
        },
        include: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns for files to include (e.g., ["src/**/*.ts"])',
        },
        exclude: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns for files to exclude (e.g., ["**/*.test.ts"])',
        },
        workspace: {
          type: 'object',
          properties: {
            roots: {
              type: 'array',
              items: { type: 'string' },
              description: 'Root directories for multi-root workspace',
            },
          },
          description: 'Multi-root workspace config (only for workspaces)',
        },
      },
    },
  },
  {
    name: 'get_coverage',
    description: `Check which files were analyzed and which were skipped.

Use this to:
- Find gaps: "Why doesn't query find this file?" — check if it was analyzed
- Verify include/exclude patterns work correctly
- Debug empty query results: file not in graph → not analyzed
- Identify unsupported file types or parse errors

Returns: analyzed/skipped file counts, coverage percentage, skip reasons.

Use AFTER analyze_project when queries return unexpected empty results.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to check coverage for',
        },
        depth: {
          type: 'number',
          description: 'Directory depth to report (default: 2)',
        },
      },
    },
  },
  {
    name: 'get_documentation',
    description: `Get documentation about Grafema usage and query syntax.

Topics available:
- queries: Datalog query syntax and examples
- types: Available node and edge types
- guarantees: How to create and manage code guarantees
- onboarding: Step-by-step guide for new projects
- overview: High-level Grafema architecture

Use this when you need to learn Datalog syntax or understand available features.`,
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Topic: queries, types, guarantees, onboarding, or overview',
        },
      },
    },
  },
  {
    name: 'report_issue',
    description: `Report a bug or issue with Grafema to GitHub.

Use this tool when you encounter:
- Unexpected errors or crashes
- Incorrect analysis results
- Missing features that should exist
- Documentation issues

The tool will create a GitHub issue automatically if GITHUB_TOKEN is configured.
If not configured, it will return a pre-formatted issue template that the user
can manually submit at https://github.com/Disentinel/grafema/issues/new

IMPORTANT: Always ask the user for permission before reporting an issue.
Include relevant context: error messages, file paths, query used, etc.`,
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Brief issue title (e.g., "Query returns empty results for FUNCTION nodes")',
        },
        description: {
          type: 'string',
          description: 'Detailed description of the issue',
        },
        context: {
          type: 'string',
          description: 'Relevant context: error messages, queries, file paths, etc.',
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Labels: bug, enhancement, documentation, question',
        },
      },
      required: ['title', 'description'],
    },
  },
];
