# REG-398: RFDB Secondary Indexes + Declared Schema for Metadata

## Summary

RFDB stores node metadata as opaque JSON string. This causes:
1. O(n) linear scan on every `get_node(id)`
2. O(n) full scan on `find_by_attr()`
3. JSON parsing on every metadata query
4. No server-side metadata field filtering
5. Dead sled FileIndex code

## Solution: Two directions

### Part 1: Secondary Indexes (in-memory, rebuild on flush)
- ID index: HashMap<u128, usize> — O(n)→O(1) for get_node()
- Type index: HashMap<String, Vec<usize>> — O(n)→O(K) for find_by_type()
- File index: HashMap<String, Vec<usize>> — O(n)→O(K) for find_by_attr(file=X)
- Remove dead sled FileIndex

### Part 2: Declared Schema
- Plugins declare metadata fields they create
- RFDB creates typed columns for declared fields
- Server-side filtering by declared fields
- Segment format v2 with dynamic columns

## Phases
1. ID Hash Index
2. Type + File Indexes
3. Declared Schema API
4. Dynamic columns in segments
5. Plugin field promotion

Full details in Linear issue REG-398.
