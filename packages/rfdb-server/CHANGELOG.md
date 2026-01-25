# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-01-19

### Added

- Initial release of RFDB (ReginaFlowDB)
- High-performance disk-backed graph engine for semantic code analysis
- Columnar storage format (nodes.bin, edges.bin, strings.bin)
- Deterministic node IDs using BLAKE3 hashing
- Zero-copy memory-mapped file access via memmap2
- Delta log for fast in-memory writes
- Version-aware queries (main / __local versions for incremental analysis)
- BFS/DFS graph traversal algorithms
- Secondary indexes via sled KV store
- Node.js bindings via napi-rs
- TypeScript type definitions
- Datalog query support
- Support for namespaced node/edge types (e.g., "http:route", "db:query")

### Supported operations

- Batch node/edge operations
- Attribute-based filtering
- Variable-length path queries
- Soft deletes (tombstones)
- Graph compaction
- Flush to disk

### Platforms

- macOS (x86_64, aarch64)
- Linux (x86_64, aarch64, musl variants)
