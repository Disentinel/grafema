# Demo Video Checklist

Target: Product Hunt / Twitter launch video.
Story: DSL → Trace → Map — three modalities, one graph.
Subject: Grafema analyzing itself (JS → Rust → Haskell, 3 languages).

## Scene 1: Interactive DSL (File Overview)

### Prerequisites
- [ ] `describe()` / `get_file_overview` returns DSL with node IDs per line
- [ ] VS Code extension: "Grafema: File Overview" command registered
- [ ] DSL renders as virtual document (or webview) with clickable ranges
- [ ] Each DSL line maps to a node ID in the graph

### Interactions
- [ ] Click on DSL symbol → jump to source code (go-to-definition)
- [ ] Right-click DSL symbol → context menu: "Trace Dataflow", "Show on Map"
- [ ] Hover on DSL symbol → tooltip with node type, file, line

### Polish
- [ ] Syntax highlighting for DSL operators (`>`, `o-`, `=>`, `?|`, `{}`)
- [ ] Consistent operator vocabulary (matches `describe()` output)

---

## Scene 2: "WTF?" — Dataflow Trace (Side Panel)

"Ever stared at a variable wondering WTF is going on? Now there's a command for that."

### Prerequisites
- [ ] `trace_dataflow` backward trace works end-to-end via extension
- [ ] CLI: `grafema wtf <symbol>` — backward trace with arrow output
- [ ] VS Code: right-click → "Grafema: WTF?" → treeview trace
- [ ] Treeview provider registered in VS Code sidebar
- [ ] Trace results render as expandable tree (node → edge → node → ...)

### Interactions
- [ ] Click node in treeview → jump to source code
- [ ] Click node in treeview → highlight in DSL view (if open)
- [ ] "Show on Map" button at top of treeview

### Content for demo
- [ ] Pick a handler where `req.body` / node value arrives
- [ ] Backward trace shows 8-15 steps through 3-5 files
- [ ] Path crosses package boundaries (visible in file paths)

### Polish
- [ ] Operator icons in treeview match DSL operators
- [ ] File grouping in treeview (collapsible by file)
- [ ] Node count badge ("12 nodes, 4 files")

---

## Scene 3: Map Visualization

### Prerequisites
- [ ] Map renderer works (already exists)
- [ ] Camera fly-through works (already exists)
- [ ] LOD levels: directory → file → function (zoom semantic)
- [ ] Package/directory names render as "country names" at top LOD

### Route Highlighting
- [ ] Accept trace result (list of node IDs) as route input
- [ ] Highlight route edges on map (glow, color, animation)
- [ ] Route can branch (fan-out visualization)
- [ ] Unhighlighted nodes dim/fade for contrast

### Camera
- [ ] "Show on Map" opens map tab, camera at top LOD
- [ ] Auto-zoom to fit entire route
- [ ] Fly-through animation: from click origin → along route → to source
- [ ] Smooth interpolation between LOD levels during fly-through

### Cross-language (for demo)
- [ ] JS modules visible as one "region" on map
- [ ] Rust packages (rfdb-server, orchestrator) as another region
- [ ] Haskell packages (analyzer, resolve) as third region
- [ ] MODULE→DEPENDS_ON edges visible between regions
- [ ] Route crosses region boundaries visually

### Polish
- [ ] Color coding by language (JS=yellow, Rust=orange, Haskell=purple)
- [ ] Edge bundling to reduce visual clutter
- [ ] Minimap or breadcrumb showing current LOD position

---

## Integration Wiring (connects scenes)

- [ ] DSL click → triggers trace → result appears in treeview
- [ ] Treeview "Show on Map" → sends node IDs to map tab
- [ ] Map node click → jumps back to source code
- [ ] All three views stay in sync (highlight same node)

---

## Video Production

### Script
- [ ] Voiceover script written (30-60 seconds per scene, ~2 min total)
- [ ] Key phrases: "code → graph → graphemes", "GZIP for understanding"

### Recording
- [ ] Clean VS Code theme (dark, minimal UI)
- [ ] Font size large enough for 1080p
- [ ] Real codebase (Grafema itself), not toy example
- [ ] No terminal visible (everything in VS Code)

### Post-production
- [ ] Smooth transitions between scenes
- [ ] Subtle zoom on UI interactions
- [ ] Text overlays for key concepts
- [ ] Background music (subtle, tech-y)

---

## Priority Order

1. **Interactive DSL** — clickable `describe()` output in VS Code
2. **Treeview trace** — dataflow results in sidebar
3. **Map route highlight** — trace path on visualization
4. **Cross-language regions** — LOD with language coloring
5. **Camera fly-through with route** — cinematic animation
6. **Integration wiring** — all three views synced
7. **Polish + record**
