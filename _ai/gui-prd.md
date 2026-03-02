# Grafema GUI — Product Requirements Document

**Status:** Draft v1.0
**Date:** 2026-03-02
**Branch:** `gui`

## 1. Vision

Interactive 3D visualization of Grafema's code graph. The GUI renders graph data from RFDB as a navigable spatial map — a "Google Maps for codebases" where structure is visible at a glance and details emerge on zoom.

**Target user:** Developer or AI agent exploring an unfamiliar or large codebase. The map answers "what's here and how is it connected?" faster than reading files.

## 2. Architecture Overview

### 2.1 System Components

```
┌─────────────┐     HTTP/Binary      ┌──────────────┐    Unix Socket    ┌──────────┐
│  Browser     │ ◄──────────────────► │  GUI Server   │ ◄──────────────► │  RFDB    │
│  (Three.js)  │   /api/* endpoints   │  (server.js)  │   RFDBClient     │  Server  │
└─────────────┘                       └──────────────┘                   └──────────┘
```

- **GUI Server** (`packages/gui/server.js`): Node.js HTTP server, connects to RFDB via unix socket, serves static files + binary API endpoints
- **Client** (`packages/gui/public/`): Single-page Three.js apps, one per visualization mode
- **Shared library** (`packages/gui/public/shared.js`): Binary parsers, color palettes, HUD utilities
- **RFDB**: Source of truth for graph nodes/edges. Server never caches raw graph data beyond current request lifecycle (except hex cache)

### 2.2 Binary Protocol

All graph endpoints use a compact binary wire format to minimize transfer size and parsing overhead:

```
[headerLen:u32LE][headerJSON][nodeData][edgeData]
```

- **Header** (JSON): type table, edge type table, metadata (counts, bounding box, etc.)
- **Node data**: fixed-size records (format varies by endpoint)
- **Edge data**: 9 bytes per edge `[srcIdx:u32LE][dstIdx:u32LE][typeIdx:u8]`

### 2.3 Configuration

| Env variable | Default | Purpose |
|---|---|---|
| `GUI_PORT` | `3333` | HTTP server port |
| `RFDB_SOCKET` | `/tmp/rfdb.sock` | Path to RFDB unix socket |

## 3. Visualization Modes

Seven views accessible from the landing page (`index.html`):

| View | File | Layout | Description |
|---|---|---|---|
| **Hex Map** | `geographic-hex.html` | Hex-tile grid | Primary view. Connectivity-based placement on hex grid with organic borders. Progressive loading. |
| **Geographic (WebGPU)** | `geographic-webgpu.html` | GPU physics | Nodes stream in batches, GPU compute shader positions them. Requires WebGPU. |
| **Geographic** | `geographic.html` | File-path based | Directory hierarchy → spatial position. WebGL fallback. |
| **Module Dependencies** | `modules.html` | Force-directed | MODULE nodes + IMPORTS_FROM edges. Architecture overview. |
| **Call Graph** | `calls.html` | Force-directed | FUNCTION nodes + CALLS edges. |
| **Data Flow** | `dataflow.html` | Force-directed | VARIABLE nodes + ASSIGNED_FROM/FLOWS_INTO edges. |
| **Full Graph** | `fullgraph.html` | Force-directed | All node types, clustered by directory. |

## 4. Hex Map — Primary View (Detailed Requirements)

The Hex Map is the most developed view and the primary focus of GUI work.

### 4.1 Layout Algorithm

1. **Node fetching**: Query RFDB for nodes by type, respecting `limit` param
2. **Type prioritization**: Nodes sorted by type priority: MODULE > FUNCTION > CLASS > METHOD > SERVICE > VARIABLE > CALL > IMPORT > EXPORT > EXTERNAL_MODULE
3. **Hex tile placement** (`placeNodesInTiles`):
   - First node placed at origin `(0,0)`
   - Each subsequent node placed adjacent to its most-connected existing neighbor (maximizes edge locality)
   - BFS over adjacency to find best seed tile near the neighbor
   - Cube coordinates `(q, r)` with flat-top hex orientation
4. **Border detection** (`computeBorders`): Extract boundary segments between occupied and empty tiles for organic region outlines
5. **Coordinate conversion**: `cubeToWorld(q, r)` → `(x, z)` world coordinates. Hex size = 1.0, spacing configurable.

### 4.2 Progressive Loading (Two-Phase)

**Problem:** Loading all nodes upfront is O(n) RFDB queries for edges, making large graphs (2000+ nodes) take 12+ seconds.

**Solution:** Two-phase progressive loading:

#### Phase 1: Structural Load (`structureOnly=true`)

- Fetch only structural types: `MODULE`, `CLASS`, `SERVICE`, `INTERFACE`, `EXTERNAL_MODULE`
- Typically 50-200 nodes instead of 2000+ → fast initial render
- While fetching edges, track CONTAINS children per container (don't resolve, just count + collect IDs)
- After tile placement, **reserve tiles** adjacent to each container for future child expansion
- Store expansion metadata in server-side `expandCache`: `Map<containerIdx, { childNodeIds, reservedTiles }>`
- Response header includes `containers: [{ nodeIdx, childCount }]` and `totalReserved`

#### Phase 2: Expand on Zoom (`/api/graph-hex-expand`)

- Client detects camera proximity to container tiles (distance-based trigger)
- Fetches children of that container from expand cache
- Children placed at pre-reserved tile positions
- Children fade in (opacity 0 → 1), parent container fades to ghost (opacity → 0.15)
- Collapse on zoom-out: children fade to 0, parent restores. Data stays in memory (re-expand is instant)

**Hysteresis:** `EXPAND_DIST = 30`, `COLLAPSE_DIST = 60` world units to prevent flicker.

### 4.3 Rendering

- **Three.js InstancedMesh** for hex tiles (single draw call for all tiles)
- **Over-allocation**: `MAX_INSTANCES = N + totalReserved` to accommodate future expansions without re-creating the mesh
- **Per-instance opacity** via custom shader attribute (`instanceOpacity`)
- **Opacity lerp**: Smooth animation between target and current opacity each frame
- **DynamicDrawUsage** on instance matrices for frequent updates
- **Colors**: Type-based palette from `NODE_COLORS` map in shared.js

### 4.4 LOD (Level of Detail) Edges

- Edges rendered as Three.js Lines with per-vertex colors
- **Distance-based LOD**: Only render edges connected to nodes within camera frustum
- **Frustum culling**: Each frame, build `visibleNodes` set from projected screen coordinates
- **Edge filtering**: Show edge if either endpoint is visible
- **Hover highlight**: On mouseover, highlight all edges connected to hovered node, dim others

### 4.5 Interaction

- **OrbitControls**: Pan, zoom, rotate
- **Raycasting hover**: GPU-based instanceId detection on InstancedMesh
- **Tooltip on hover**: Fetch node details from `/api/node?index=N` (lazy, on-demand)
- **HUD**: Stats overlay (node count, edge count, FPS)
- **Expand/collapse**: Automatic on zoom proximity to containers

### 4.6 Known Issues (from Code Review)

Priority bugs to fix before next iteration:

| Priority | Issue | Description |
|---|---|---|
| P0 | TDZ for hoveredIdx | `updateLODEdges()` called before `hoveredIdx` declared — throws ReferenceError when containers present |
| P1 | Expand not idempotent | Multiple expand calls push duplicate IDs to `currentNodeIds` |
| P1 | Frustum culling misses children | Visibility loop uses `N` (structural count) instead of `currentCount` |
| P1 | Expansion edges not rendered | LOD system only knows structural edges, expansion edges invisible |
| P1 | Hover edges for children | `hoverEdges` array only collects structural edges |
| P2 | Shared mutable `currentNodeIds` | Singleton state — concurrent requests corrupt index mapping |
| P2 | `hexCache`/`expandCache` not synced | Cache can become stale if graph changes |
| P3 | `findSeedNear` is O(n) | Linear scan of all tiles per placement — quadratic total |
| P3 | `borderSegments.indexOf` is O(n²) | Dedup via indexOf on array of arrays |

## 5. API Endpoints

### 5.1 `/api/stats` (GET)

Returns graph statistics. Used by landing page.

**Response:** `{ nodeCount, edgeCount, nodesByType, edgesByType }`

### 5.2 `/api/graph-binary` (GET)

Compact binary graph with geographic (file-path) layout.

**Params:** `types` (comma-separated), `edgeTypes` (comma-separated), `limit`

**Wire format:** 20 bytes/node `[x:f32][y:f32][z:f32][typeIdx:u8][nameLen:u8][name:<=6bytes]` + 9 bytes/edge

### 5.3 `/api/graph-binary-full` (GET)

Full graph dump with directory-based clustering.

**Params:** `limit`

### 5.4 `/api/hex-layout` (GET)

JSON hex layout (deprecated in favor of `/api/graph-hex`).

**Params:** `types`, `edgeTypes`, `limit`

### 5.5 `/api/graph-hex` (GET)

Binary hex-tile layout. Primary endpoint for Hex Map view.

**Params:**
- `types` — comma-separated node types to include
- `edgeTypes` — comma-separated edge types
- `limit` — max nodes (default: unlimited)
- `structureOnly` — if `true`, only fetch structural types, compute tile reservations

**Wire format:** 8 bytes/node `[typeIdx:u8][q:i16LE][r:i16LE][degree:u16LE][flags:u8]` + 9 bytes/edge

**Header extras (when `structureOnly=true`):**
- `containers: [{ nodeIdx, childCount }]`
- `totalReserved: number`
- `nodeRegions`, `nodeParents` (container relationship metadata)

### 5.6 `/api/graph-hex-expand` (GET)

Fetch children of a container for progressive expansion.

**Params:** `container` — nodeIdx of the container to expand

**Response:** Same binary format as `/api/graph-hex` with subset of nodes/edges. Header includes `containerIdx`, `startIndex`, `nodeCount`, `edgeCount`.

**Side effect:** Appends child node IDs to server-side `currentNodeIds` array.

### 5.7 `/api/node` (GET)

Fetch detail for a single node by index.

**Params:** `index` — position in `currentNodeIds` array

**Response:** Full node object from RFDB (id, type, name, file, line, metadata, etc.)

## 6. Shared Library (`shared.js`)

### 6.1 Binary Parsers

- `fetchGraphBinary(opts)` — parse `/api/graph-binary` response
- `fetchGraphHex(opts)` — parse `/api/graph-hex` response, supports `structureOnly` param
- `fetchHexExpand(containerIdx)` — parse `/api/graph-hex-expand` response

### 6.2 Color Palette

Type-based color map (`NODE_COLORS`):

| Type | Color |
|---|---|
| MODULE | `#00d4ff` (cyan) |
| FUNCTION | `#7b2ff7` (purple) |
| CLASS | `#ff6b35` (orange) |
| METHOD | `#c77dff` (light purple) |
| VARIABLE | `#4ecdc4` (teal) |
| CALL | `#ffe66d` (yellow) |
| SERVICE | `#ff006e` (pink) |
| INTERFACE | `#06d6a0` (green) |
| IMPORT/EXPORT | `#adb5bd` (grey) |
| EXTERNAL_MODULE | `#ffd166` (gold) |

Edge colors: `CALLS → #ff6b35`, `CONTAINS → #2d6a4f`, etc.

### 6.3 Utilities

- `cubeToWorld(q, r)` — hex cube coords → world (x, z)
- `createHUD(container)` — stats/FPS overlay
- `showLoading(message)` — loading spinner
- `colorToVec3(hex)` — hex color string → `{r, g, b}` normalized

## 7. Non-Functional Requirements

### 7.1 Performance Targets

- **Initial load (structural):** < 3 seconds for graphs up to 10k nodes
- **Expand container:** < 500ms perceived (fetch + fade animation)
- **Frame rate:** 60 FPS with up to 5000 visible tiles
- **Memory:** Over-allocated InstancedMesh stays within WebGL limits (< 100k instances)

### 7.2 Browser Support

- Chrome/Edge 90+ (WebGL2 required for InstancedMesh)
- WebGPU view requires Chrome 113+ with WebGPU enabled
- No build step — vanilla ES modules loaded via importmap from CDN

### 7.3 Dependencies

- Three.js r0.171.0 (CDN, no bundling)
- No other client-side dependencies
- Server: Node.js, `@grafema/rfdb-client`

## 8. Future Work

### 8.1 Short Term (Bug Fixes)

- Fix all P0-P1 issues from Section 4.6
- Add expansion edges to LOD rendering pipeline
- Make `currentNodeIds` per-request or session-scoped

### 8.2 Medium Term

- **Cross-container edges**: Aggregate edges between unexpanded containers as weighted container-level links
- **Nested expansion**: MODULE → CLASS → METHOD (multi-level progressive reveal)
- **Search**: Text search → camera flies to matching node
- **Minimap**: Overview inset showing full graph with viewport indicator
- **Spatial audio**: Subtle directional audio cues on hover/expand for spatial awareness

### 8.3 Long Term

- **WebGPU hex renderer**: Port InstancedMesh to WebGPU compute shader for 100k+ tiles
- **Collaborative viewing**: Multiple users exploring same graph (cursor sharing)
- **Time dimension**: Animate graph evolution over git history
- **AI integration**: Grafema MCP queries from within the GUI ("explain this cluster")
