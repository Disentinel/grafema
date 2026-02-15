/**
 * Утилита для проверки графов в тестах
 * Позволяет задавать assertions в текстовом виде
 *
 * Работает напрямую с backend через запросы (NO export() needed!)
 */

// Legacy type mapping for backward compatibility in tests
const LEGACY_TYPE_MAP = {
  'VARIABLE_DECLARATION': 'VARIABLE',
  'CALL_SITE': 'CALL',
  'METHOD_CALL': 'CALL',
  'EXTERNAL_STDIO': 'net:stdio',
  'EXTERNAL_NETWORK': 'net:request',
  'DATABASE_QUERY': 'db:query',
  'HTTP_REQUEST': 'http:request',
  'ROUTE': 'http:route',
  'ENDPOINT': 'http:route',
  'FILESYSTEM': 'fs:operation',
  'EVENT_LISTENER': 'event:listener',
  'MOUNT_POINT': 'express:mount',
};

function resolveType(type) {
  return LEGACY_TYPE_MAP[type] || type;
}

export class GraphAsserter {
  constructor(backend) {
    this.backend = backend;
    this._nodeCache = null; // Lazy cache for test assertions only
    this._edgeCache = null;
  }

  // Initialize caches (MUST be called before using assertions!)
  async init() {
    if (!this._nodeCache) {
      this._nodeCache = [];
      // Query all nodes (test graphs are small)
      for await (const node of this.backend.queryNodes({})) {
        this._nodeCache.push(node);
      }
    }
    if (!this._edgeCache) {
      // Initialize edges cache too
      // Use async version if available (RFDBServerBackend), fallback to sync
      if (typeof this.backend.getAllEdgesAsync === 'function') {
        this._edgeCache = await this.backend.getAllEdgesAsync();
      } else {
        this._edgeCache = await this.backend.getAllEdges();
      }
    }
    return this;
  }

  // Get cached nodes (synchronous, throws if not initialized)
  _getNodes() {
    if (!this._nodeCache) {
      throw new Error('GraphAsserter not initialized! Call await asserter.init() first');
    }
    return this._nodeCache;
  }

  // Get cached edges (synchronous, throws if not initialized)
  _getEdges() {
    if (!this._edgeCache) {
      throw new Error('GraphAsserter not initialized! Call await asserter.init() first');
    }
    return this._edgeCache;
  }

  /**
   * Проверяет что нода существует
   */
  hasNode(type, name) {
    const node = this.findNode(type, name);
    if (!node) {
      throw new Error(`Expected node not found: ${type}:${name}`);
    }
    this.lastNode = node; // Сохраняем для chain calls
    return this;
  }

  /**
   * Проверяет что нода имеет определенные свойства
   * Можно вызывать после hasNode() для проверки свойств последней найденной ноды
   * Или передать полный набор props для поиска с фильтрацией
   */
  hasNodeWithProps(props) {
    // Если передан полный объект с type и name, ищем ноду с ВСЕМИ свойствами
    if (props.type && props.name) {
      // Используем findNodeWithProps для точного поиска
      const node = this.findNodeWithProps(props);
      if (!node) {
        // Ищем хотя бы по type/name для лучшего сообщения об ошибке
        const anyNode = this.findNode(props.type, props.name);
        if (anyNode) {
          // Нода есть, но свойства не совпадают
          for (const [key, value] of Object.entries(props)) {
            if (anyNode[key] !== value) {
              throw new Error(`Node ${props.type}:${props.name} property ${key} expected ${value}, got ${anyNode[key]}`);
            }
          }
        }
        throw new Error(`Node not found with props: ${JSON.stringify(props)}`);
      }
      this.lastNode = node;
    }
    // Иначе используем lastNode из предыдущего hasNode()
    else if (this.lastNode) {
      for (const [key, value] of Object.entries(props)) {
        if (this.lastNode[key] !== value) {
          throw new Error(`Node ${this.lastNode.type}:${this.lastNode.name} property ${key} expected ${value}, got ${this.lastNode[key]}`);
        }
      }
    } else {
      throw new Error('hasNodeWithProps called without prior hasNode() or without type/name in props');
    }
    return this;
  }

  /**
   * Общий assertion с кастомным сообщением
   */
  assert(condition, message) {
    if (!condition) {
      throw new Error(message || 'Assertion failed');
    }
    return this;
  }

  /**
   * Проверяет что нода НЕ существует
   */
  doesNotHaveNode(type, name) {
    const node = this.findNode(type, name);
    if (node) {
      throw new Error(`Unexpected node found: ${type}:${name}`);
    }
    return this;
  }

  /**
   * Проверяет что ребро существует
   */
  hasEdge(fromType, fromName, edgeType, toType, toName) {
    const from = this.findNode(fromType, fromName);
    const to = this.findNode(toType, toName);

    if (!from) {
      throw new Error(`Source node not found: ${fromType}:${fromName}`);
    }
    if (!to) {
      throw new Error(`Target node not found: ${toType}:${toName}`);
    }

    const edge = this.findEdge(from.id, edgeType, to.id);
    if (!edge) {
      throw new Error(`Expected edge not found: ${fromType}:${fromName} -[${edgeType}]-> ${toType}:${toName}`);
    }
    return this;
  }

  /**
   * Проверяет что ребро НЕ существует
   */
  doesNotHaveEdge(fromType, fromName, edgeType, toType, toName) {
    const from = this.findNode(fromType, fromName);
    const to = this.findNode(toType, toName);

    if (!from || !to) {
      return this; // Если нет нод, то и ребра нет
    }

    const edge = this.findEdge(from.id, edgeType, to.id);
    if (edge) {
      throw new Error(`Unexpected edge found: ${fromType}:${fromName} -[${edgeType}]-> ${toType}:${toName}`);
    }
    return this;
  }

  /**
   * Проверяет количество нод типа
   */
  hasNodeCount(type, expectedCount) {
    const resolvedType = resolveType(type);
    const nodes = this._getNodes().filter(n => n.type === resolvedType);
    if (nodes.length !== expectedCount) {
      throw new Error(`Expected ${expectedCount} nodes of type ${resolvedType} (was: ${type}), found ${nodes.length}`);
    }
    return this;
  }

  /**
   * Проверяет количество рёбер типа
   */
  hasEdgeCount(type, expectedCount) {
    const edges = this._getEdges().filter(e => e.type === type);
    if (edges.length !== expectedCount) {
      throw new Error(`Expected ${expectedCount} edges of type ${type}, found ${edges.length}`);
    }
    return this;
  }

  /**
   * Проверяет путь в графе
   * Пример: hasPath('FUNCTION:main', 'CALLS', 'FUNCTION:greet', 'WRITES_TO', 'net:stdio:__stdio__')
   * Note: Uses lastIndexOf(':') to support namespaced types like 'net:stdio'
   */
  hasPath(...path) {
    if (path.length < 3 || path.length % 2 === 0) {
      throw new Error('Path must be: node, edge, node, edge, ..., node');
    }

    // Find starting node - use lastIndexOf to support namespaced types
    const colonIndex = path[0].lastIndexOf(':');
    const startType = path[0].substring(0, colonIndex);
    const startName = path[0].substring(colonIndex + 1);
    let currentNode = this.findNode(startType, startName);

    if (!currentNode) {
      throw new Error(`Start node not found: ${startType}:${startName}`);
    }

    // Follow edges to find path
    for (let i = 1; i < path.length; i += 2) {
      const edgeType = path[i];
      const nextColonIndex = path[i + 1].lastIndexOf(':');
      const nextType = path[i + 1].substring(0, nextColonIndex);
      const nextName = path[i + 1].substring(nextColonIndex + 1);
      const resolvedNextType = resolveType(nextType);

      // Find edges from current node with the right type
      const outgoingEdges = this._getEdges().filter(e => {
        const srcId = e.fromId || e.src;
        return srcId === currentNode.id && e.type === edgeType;
      });

      // Find a destination node matching the expected type/name
      let foundNext = null;
      for (const edge of outgoingEdges) {
        const dstId = edge.toId || edge.dst;
        const targetNode = this._findNodeByEdgeId(dstId);
        if (targetNode && targetNode.type === resolvedNextType && targetNode.name === nextName) {
          foundNext = targetNode;
          break;
        }
      }

      if (!foundNext) {
        throw new Error(`Edge not found in path: ${currentNode.type}:${currentNode.name} -[${edgeType}]-> ${resolvedNextType}:${nextName}`);
      }

      currentNode = foundNext;
    }

    return this;
  }

  /**
   * Проверяет что все рёбра валидны (указывают на существующие ноды)
   */
  allEdgesValid() {
    // Node IDs are BigInt now
    const nodeIdSet = new Set(this._getNodes().map(n => n.id));

    for (const edge of this._getEdges()) {
      // Support both old format (fromId/toId) and new format (src/dst)
      const srcId = edge.fromId || edge.src;
      const dstId = edge.toId || edge.dst;

      if (!nodeIdSet.has(srcId)) {
        throw new Error(`Invalid edge: src/fromId "${srcId}" does not exist`);
      }
      if (!nodeIdSet.has(dstId)) {
        throw new Error(`Invalid edge: dst/toId "${dstId}" does not exist`);
      }
    }

    return this;
  }

  /**
   * Проверяет что нет дубликатов ID
   */
  noDuplicateIds() {
    const ids = this._getNodes().map(n => n.id);
    const uniqueIds = new Set(ids);

    if (ids.length !== uniqueIds.size) {
      const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
      throw new Error(`Duplicate node IDs found: ${duplicates.join(', ')}`);
    }

    return this;
  }

  // Вспомогательные методы

  findNode(type, name) {
    const resolvedType = resolveType(type);
    return this._getNodes().find(n => n.type === resolvedType && n.name === name);
  }

  /**
   * Находит ноду с определенными свойствами
   */
  findNodeWithProps(props) {
    return this._getNodes().find(n => {
      for (const [key, value] of Object.entries(props)) {
        if (n[key] !== value) {
          return false;
        }
      }
      return true;
    });
  }

  findEdge(fromId, type, toId) {
    // All IDs are BigInt now
    return this._getEdges().find(e => {
      // Support both old format (fromId/toId) and new format (src/dst)
      const srcId = e.fromId || e.src;
      const dstId = e.toId || e.dst;
      return srcId === fromId && e.type === type && dstId === toId;
    });
  }

  /**
   * Find node by BigInt edge ID
   */
  _findNodeByEdgeId(edgeId) {
    return this._getNodes().find(n => {
      // Both node IDs and edge IDs are BigInt now
      return n.id === edgeId;
    });
  }

  /**
   * Возвращает текстовое представление графа для отладки
   */
  toString() {
    let result = '=== Graph ===\n\n';

    result += 'Nodes:\n';
    for (const node of this._getNodes()) {
      result += `  ${node.type}:${node.name} (${node.id})\n`;
    }

    result += '\nEdges:\n';
    for (const edge of this._getEdges()) {
      // Support both old format (fromId/toId) and new format (src/dst)
      const srcId = edge.fromId || edge.src;
      const dstId = edge.toId || edge.dst;
      const from = this._findNodeByEdgeId(srcId);
      const to = this._findNodeByEdgeId(dstId);
      result += `  ${from?.type}:${from?.name} -[${edge.type}]-> ${to?.type}:${to?.name}\n`;
    }

    return result;
  }

  /**
   * Возвращает граф в формате для сравнения в снапшотах
   */
  toSnapshot() {
    return {
      nodes: this._getNodes().map(n => ({
        type: n.type,
        name: n.name,
        file: n.file
      })).sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`)),

      edges: this._getEdges().map(e => {
        // Support both old format (fromId/toId) and new format (src/dst)
        const srcId = e.fromId || e.src;
        const dstId = e.toId || e.dst;
        const from = this._findNodeByEdgeId(srcId);
        const to = this._findNodeByEdgeId(dstId);
        return {
          from: `${from.type}:${from.name}`,
          type: e.type,
          to: `${to.type}:${to.name}`
        };
      }).sort((a, b) => `${a.from}-${a.type}-${a.to}`.localeCompare(`${b.from}-${b.type}-${b.to}`))
    };
  }

  /**
   * Enriched snapshot for behavior-locking tests.
   * Captures all semantic properties (skips positional/internal data).
   * Use for golden file comparison in refactoring safety net tests.
   *
   * Uses a blocklist approach: skip known unstable/positional properties,
   * include everything else. New properties added to node types are
   * automatically captured.
   */
  toEnrichedSnapshot() {
    const SNAPSHOT_SKIP_PROPS = new Set([
      'id',             // internal ID, changes between runs
      'line',           // positional
      'column',         // positional
      'start',          // byte offset
      'end',            // byte offset
      'loc',            // location object
      'range',          // range array
      'parentScopeId',  // internal ID reference
      'bodyScopeId',    // internal ID reference
      'contentHash',    // changes with file content
      'analyzedAt',     // timestamp, changes between runs
      'projectPath',    // absolute path, differs per environment
      'filePath',       // absolute path, differs per environment
    ]);

    // Normalize absolute paths to relative for environment independence
    const cwd = process.cwd();
    const normalizePath = (v) => {
      if (typeof v === 'string' && v.startsWith('/') && v.includes('/test/fixtures/')) {
        return v.slice(v.indexOf('/test/fixtures/'));
      }
      return v;
    };

    const nodes = this._getNodes().map(n => {
      const entries = [];
      for (const [key, value] of Object.entries(n)) {
        if (SNAPSHOT_SKIP_PROPS.has(key)) continue;
        if (typeof value === 'bigint') continue;
        if (value === undefined) continue;
        entries.push([key, normalizePath(value)]);
      }
      // Sort keys alphabetically for deterministic JSON output
      entries.sort((a, b) => a[0].localeCompare(b[0]));
      return Object.fromEntries(entries);
    }).sort((a, b) => {
      const keyA = `${a.type}:${a.name}`;
      const keyB = `${b.type}:${b.name}`;
      const cmp = keyA.localeCompare(keyB);
      if (cmp !== 0) return cmp;
      const fileCmp = (a.file || '').localeCompare(b.file || '');
      if (fileCmp !== 0) return fileCmp;
      return JSON.stringify(a).localeCompare(JSON.stringify(b));
    });

    const edges = this._getEdges().map(e => {
      const srcId = e.fromId || e.src;
      const dstId = e.toId || e.dst;
      const from = this._findNodeByEdgeId(srcId);
      const to = this._findNodeByEdgeId(dstId);

      const entry = {
        from: from ? `${from.type}:${from.name}` : `<unresolved:${srcId}>`,
        type: e.type,
        to: to ? `${to.type}:${to.name}` : `<unresolved:${dstId}>`,
      };

      // Include metadata if present and non-empty
      if (e.metadata && typeof e.metadata === 'object' && Object.keys(e.metadata).length > 0) {
        entry.metadata = e.metadata;
      }

      return entry;
    }).sort((a, b) => {
      const keyA = `${a.from}-${a.type}-${a.to}`;
      const keyB = `${b.from}-${b.type}-${b.to}`;
      const cmp = keyA.localeCompare(keyB);
      if (cmp !== 0) return cmp;
      // Stable tiebreaker: full JSON representation
      return JSON.stringify(a).localeCompare(JSON.stringify(b));
    });

    return { nodes, edges };
  }
}

/**
 * Создать asserter из backend OR legacy graph export
 * Supports both:
 * - await assertGraph(backend) - new async way
 * - assertGraph(graph) - legacy sync way with graph.nodes
 *
 * Returns initialized GraphAsserter (async if backend, sync if graph object)
 */
export function assertGraph(backendOrGraph) {
  // Legacy: if passed { nodes: [...] } object, use synchronous mode
  if (backendOrGraph && Array.isArray(backendOrGraph.nodes)) {
    const asserter = new GraphAsserter(null);
    asserter._nodeCache = backendOrGraph.nodes;
    asserter._edgeCache = backendOrGraph.edges || [];
    return asserter;
  }

  // New way: async with backend
  const asserter = new GraphAsserter(backendOrGraph);
  return asserter.init();
}
