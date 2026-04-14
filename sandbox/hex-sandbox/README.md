# hex-sandbox

2D hex-grid playground for trying out layout algorithms without the
weight of the full GUI stack. Vanilla JS + Canvas2D + ES modules —
**no bundler, no install**.

## Run

```bash
cd sandbox/hex-sandbox
python3 -m http.server 8765
# open http://localhost:8765/
```

Any static file server will work; the only requirement is that the
server serves `*.js` files with a MIME type the browser treats as
modules. Python's http.server does this out of the box.

## Files

```
src/
  hex.js      — axial ↔ pixel math, HEX_DIRS, hexDistance
  node.js     — Node { id, coord, regionId, data }
  link.js     — Link { source, target, weight }, length()
  route.js    — Route { id, segments[][], color }
  region.js   — Region { id, nodes Set }
  map.js      — HexMap: the single source of truth
  render.js   — Canvas2D renderer
  demo.js     — bootstrap + keyboard controls
```

## HexMap API

Mutation (all O(1) unless noted):

- `addNode(node)` / `removeNode(node)`
- `addLink(link)` / `addRegion(region)` / `addRoute(route)`
- `moveNode(node, q, r)` — throws if destination occupied
- `swap(a, b)` — exchange two nodes' coords atomically

Query:

- `nodeAt(q, r)` — spatial index lookup, O(1)
- `nodesAdjacent(a, b)` — O(6), offset check
- `regionsAdjacent(a, b)` — O(1) after first call following a
  mutation; full rebuild is O(|nodes|×6) on the lazy path
- `adjacentRegions(r)` — Set of neighbour region IDs
- `totalLinkLength()` / `totalWeightedLinkLength()` — O(|links|)

## Keyboard

| Key | Action |
|---|---|
| `S` | Swap two random nodes from different regions |
| `L` | Toggle link rendering |
| `T` | Toggle node labels |
| `R` | Reset sample data |

## Design notes

- `HexMap` owns the spatial index (`coordKey → node`). Node coords
  must only be mutated via `moveNode` / `swap` or the index
  desynchronises.
- Region adjacency is **lazy**: the dirty flag is set on every
  mutation, the graph is rebuilt the first time it's queried after a
  dirty, then cached until the next mutation.
- No async, no animation, no interaction beyond keyboard. Re-render
  is triggered explicitly by the caller.

## What to extend

- Drop in a new layout algorithm: construct a HexMap, call
  `totalLinkLength()` to measure, `swap` to mutate, re-render to
  inspect. No Three.js, no React, no network.
- Replace `Region` with something fancier (e.g. nested parents) by
  extending the class and overriding `add` / `remove`.
- Add a custom `nodeLabels` function in `demo.js` to probe which
  tile is which.
