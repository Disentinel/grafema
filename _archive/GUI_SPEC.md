# GUI Technical Specification

Техническая спецификация для визуализации графа. См. [GUI_ROADMAP.md](./GUI_ROADMAP.md) для требований и плана.

---

## Архитектура

```
┌─────────────┐         ┌─────────────────────────────────────┐
│   Browser   │  HTTP/  │           MCP Server                │
│    GUI      │◄───────►│  ┌─────────────┐ ┌──────────────┐  │
│   (D3.js)   │   WS    │  │ stdio       │ │ HTTP API     │  │
└──────┬──────┘         │  │ (Claude)    │ │ (GUI)        │  │
       │                │  └─────────────┘ └──────────────┘  │
       │ vscode://      │  ┌────────────────────┐            │
       ▼                │  │  Orchestrator+RFDB │            │
┌─────────────┐         │  └────────────────────┘            │
│   VS Code   │         └─────────────────────────────────────┘
└─────────────┘
```

### HTTP API

```
GET /api/services          // список сервисов
GET /api/graph/:serviceId  // граф сервиса
GET /api/nodes?type=...    // фильтрация
GET /api/stats             // статистика
POST /api/layout           // запрос layout (async)
```

---

## View State

```typescript
interface ViewState {
  view: 'service-map' | 'data-flow' | 'call-graph';
  level: 'galaxy' | 'constellation' | 'service' | 'module' | 'function';
  lens: 'type' | 'complexity' | 'taint' | 'ownership' | 'recency';
  filter: ServiceMapFilter | DataFlowFilter | CallGraphFilter;
  expanded: Set<string>;
  transform: { x: number; y: number; k: number };
}

interface ServiceMapFilter {
  anchorFilter?: 'db' | 'file' | 'api' | 'saas' | 'event' | 'sys';
  constellationFilter?: string;
  showEdgeTypes: Set<string>;
}

interface DataFlowFilter {
  sourceTypes: Set<string>;
  sinkTypes: Set<string>;
  highlightPath?: string;
}

interface CallGraphFilter {
  maxDepth: number;
  showLeaves: boolean;
  collapseRecursive: boolean;
}
```

---

## Hexagon Anchor Positions

```javascript
const HEXAGON_ANCHORS = {
  'db:*':    { edge: 'top-left',     order: 'left-to-right' },
  'file:*':  { edge: 'top-right',    order: 'left-to-right' },
  'event:*': { edge: 'left',         order: 'top-to-bottom' },
  'saas:*':  { edge: 'right',        order: 'top-to-bottom' },
  'api:*':   { edge: 'bottom-left',  order: 'left-to-right' },
  'sys:*':   { edge: 'bottom-right', order: 'left-to-right' },
};

const HEXAGON_EDGES = {
  'top-left':     { x: [0.15, 0.40], y: 0.05 },
  'top-right':    { x: [0.60, 0.85], y: 0.05 },
  'left':         { x: 0.05, y: [0.25, 0.75] },
  'right':        { x: 0.95, y: [0.25, 0.75] },
  'bottom-left':  { x: [0.15, 0.40], y: 0.95 },
  'bottom-right': { x: [0.60, 0.85], y: 0.95 },
};
```

---

## Gravity Positioning Algorithm

```javascript
const ANCHOR_POSITIONS = {
  db:    { x: 0.25, y: 0.05 },
  file:  { x: 0.75, y: 0.05 },
  event: { x: 0.05, y: 0.50 },
  saas:  { x: 0.95, y: 0.50 },
  api:   { x: 0.25, y: 0.95 },
  sys:   { x: 0.75, y: 0.95 },
};

function calculateGravityPosition(service, canvasSize) {
  const pulls = {
    db:    countEdges(service, 'db:*'),
    file:  countEdges(service, 'file:*'),
    event: countEdges(service, 'event:*'),
    saas:  countEdges(service, 'saas:*'),
    api:   countEdges(service, 'api:*'),
    sys:   countEdges(service, 'sys:*'),
  };

  const total = Object.values(pulls).reduce((a, b) => a + b, 0);
  if (total === 0) return { x: 0.5, y: 0.5 };

  let x = 0, y = 0;
  for (const [key, val] of Object.entries(pulls)) {
    const weight = val / total;
    x += ANCHOR_POSITIONS[key].x * weight;
    y += ANCHOR_POSITIONS[key].y * weight;
  }

  return { x: x * canvasSize, y: y * canvasSize };
}
```

---

## Constellation Detection

### File Path Mode (stable)

```javascript
function getConstellationByPath(servicePath) {
  const parts = servicePath.split('/');
  const svcIndex = parts.indexOf('svc');
  if (svcIndex >= 0 && parts[svcIndex + 1]) {
    return parts[svcIndex + 1];
  }
  return parts.slice(0, 2).join('/');
}
```

### Semantic Clustering Mode

```javascript
const CLUSTERING_WEIGHTS = {
  'CALLS_SERVICE': 1.0,
  'SHARES_DB': 0.9,
  'SHARES_QUEUE': 0.7,
  'SHARES_SAAS': 0.5,
};

const clusters = detectCommunities(serviceGraph, CLUSTERING_WEIGHTS);
```

---

## Layout Persistence

```javascript
const LAYOUT_STORAGE_KEY = 'grafema:layout';

function saveLayout(viewState) {
  const layout = {
    positions: Object.fromEntries(nodes.map(n => [n.id, { x: n.x, y: n.y }])),
    expanded: Array.from(viewState.expanded),
    transform: viewState.transform,
    savedAt: Date.now()
  };
  localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
}

function loadLayout() {
  const saved = localStorage.getItem(LAYOUT_STORAGE_KEY);
  return saved ? JSON.parse(saved) : null;
}
```

---

## Computed Complexity

```javascript
function computeComplexity(functionNode) {
  let maxLoopDepth = 0;
  let currentDepth = 0;

  function traverse(node) {
    if (['LOOP', 'FOR_STATEMENT', 'WHILE_STATEMENT', 'FOR_OF_STATEMENT'].includes(node.type)) {
      currentDepth++;
      maxLoopDepth = Math.max(maxLoopDepth, currentDepth);
    }
    for (const child of getEdges(node, 'CONTAINS')) {
      traverse(child);
    }
    if (isLoop(node)) currentDepth--;
  }

  traverse(functionNode);

  return {
    loopDepth: maxLoopDepth,
    bigO: maxLoopDepth === 0 ? 'O(1)' :
          maxLoopDepth === 1 ? 'O(n)' :
          maxLoopDepth === 2 ? 'O(n²)' : `O(n^${maxLoopDepth})`
  };
}
```

---

## Graph Diff

```javascript
interface DiffState {
  base: 'HEAD' | 'main' | string;
  compare: 'staged' | 'working' | string;
  showUnchanged: boolean;
  fadeUnchanged: number;
}

interface NodeDiff {
  id: string;
  status: 'added' | 'removed' | 'modified' | 'unchanged';
  changes?: { before: Partial<Node>; after: Partial<Node> };
}

const DIFF_PRESETS = {
  'staged':  { base: 'HEAD', compare: 'staged' },
  'working': { base: 'HEAD', compare: 'working' },
  'branch':  { base: 'main', compare: 'HEAD' },
};
```

---

## Pipeline Extraction (Data Flow)

```javascript
interface Pipeline {
  sources: Node[];      // db:read, http:route, event:consume, file:read
  sinks: Node[];        // db:write, http:response, event:emit, file:write, api:call
  transforms: Node[];
  annotations: { loopDepth: number; isAsync: boolean; hasErrorHandling: boolean };
}

function isSource(node) {
  return /^(db:read|http:route|event:consume|file:read)/.test(node.type);
}

function isSink(node) {
  return /^(db:write|http:response|event:emit|file:write|api:call)/.test(node.type);
}
```

---

## Visual Style

### Color Palette

| Category | HEX | Glow |
|----------|-----|------|
| DB | `#4ade80` | `rgba(74, 222, 128, 0.6)` |
| FILE | `#60a5fa` | `rgba(96, 165, 250, 0.6)` |
| API | `#fb923c` | `rgba(251, 146, 60, 0.6)` |
| SAAS | `#c084fc` | `rgba(192, 132, 252, 0.6)` |
| EVENT | `#22d3ee` | `rgba(34, 211, 238, 0.6)` |
| SYSTEM | `#9ca3af` | `rgba(156, 163, 175, 0.4)` |
| SERVICE | `#f97316` | `rgba(249, 115, 22, 0.6)` |

### CSS Variables

```css
:root {
  --bg-primary: #0d1117;
  --bg-secondary: #161b22;
  --bg-tertiary: #21262d;
  --border: #30363d;
  --text-primary: #f0f6fc;
  --text-secondary: #8b949e;
}
```

### Glow Effects

```css
.node-hexagon {
  filter: drop-shadow(0 0 8px currentColor);
}

.node-hexagon:hover {
  filter: drop-shadow(0 0 16px currentColor) drop-shadow(0 0 32px currentColor);
}
```

---

## VS Code Extension

### Editor ↔ Graph Sync

```typescript
// Editor → Graph
vscode.window.onDidChangeTextEditorSelection((e) => {
  const nodeId = findNodeAtPosition(document.uri, e.selections[0].active);
  webview.postMessage({ type: 'focus', nodeId });
});

// Graph → Editor
webview.onDidReceiveMessage((msg) => {
  if (msg.type === 'navigate') {
    vscode.window.showTextDocument(vscode.Uri.file(msg.file), {
      selection: new vscode.Range(msg.line, 0, msg.line, 0)
    });
  }
});
```

---

## JSDoc Integration

```javascript
function extractJSDoc(node) {
  const comment = node.leadingComments?.find(c =>
    c.type === 'CommentBlock' && c.value.startsWith('*')
  );
  return comment ? parseJSDoc(comment.value) : null;
}

// Stored as attributes
node.attrs = {
  'jsdoc:description': '...',
  'jsdoc:params': JSON.stringify([...]),
  'jsdoc:returns': '...',
};
```

### Grafema-specific Tags

| Tag | Description |
|-----|-------------|
| `@side-effect` | Explicit side effect when auto-detect fails |
| `@invariant` | Guarantee / contract |

---

## D3.js Implementation Notes

- `foreignObject` для HTML внутри SVG
- Custom force functions для anchor-based layout
- Manual region bounds calculation при expand
- Semantic zoom: разные уровни детализации при zoom
