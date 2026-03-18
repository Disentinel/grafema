You are fixing a bug in a JavaScript/TypeScript codebase at /testbed.

## Bug Report

{{problem_statement}}

## Available Analysis Tools

This codebase has been analyzed with Grafema (code graph). You have MCP tools available:

- `find_nodes` — find functions, classes, variables by name or type
- `find_calls` — find all callers of a function
- `get_file_overview` — file structure with all exports, classes, functions
- `describe` — compact DSL notation (10-20x smaller than reading source)
- `trace_dataflow` — forward/backward data flow tracing
- `get_context` — detailed view of a node with code snippet and relationships
- `query_graph` — Datalog queries for complex pattern matching

## Instructions

- Explore the codebase to understand the issue
- Identify the root cause
- Implement a minimal fix
- Do NOT modify test files
- Do NOT install new dependencies
