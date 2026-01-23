/**
 * PathValidator - проверяет безопасность рефакторинга через path equivalence
 *
 * КОНЦЕПЦИЯ:
 * 1. Трассируем пути от main версии функции до endpoints (DATABASE, HTTP, EXTERNAL)
 * 2. Трассируем пути от __local версии до тех же endpoints
 * 3. Сравниваем: если все пути сохранились → safe, если нет → breaking change
 *
 * ENDPOINTS (критические точки):
 * - DATABASE_QUERY: запросы к БД
 * - HTTP_REQUEST: HTTP запросы
 * - EXTERNAL: внешние сервисы
 * - FILESYSTEM: операции с файлами
 * - MODULE_BOUNDARY: exported functions
 * - SIDE_EFFECTS: console.log, process.exit и т.д.
 */

import type { GraphBackend } from '@grafema/types';
import type { BaseNodeRecord } from '@grafema/types';

/**
 * Edge record from backend
 */
interface EdgeRecord {
  src: string;
  dst: string | number;
  type: string;
}

/**
 * Node with optional version field for version tracking
 */
interface VersionedNode extends BaseNodeRecord {
  version?: string;
}

/**
 * Validation result
 */
export interface PathValidationResult {
  safe: boolean;
  severity: 'info' | 'warning' | 'error';
  message: string;
  deleted?: boolean;
  missing?: EndpointDiff[];
  added?: EndpointDiff[];
  endpointsChecked: number;
}

/**
 * Endpoint diff info
 */
export interface EndpointDiff {
  type: string;
  name: string;
  reason: string;
}

/**
 * Endpoint node from graph
 */
interface EndpointNode extends VersionedNode {
  query?: string;
  service?: string;
  exported?: boolean;
}

export class PathValidator {
  private backend: GraphBackend;

  constructor(backend: GraphBackend) {
    this.backend = backend;
  }

  /**
   * Проверить эквивалентность путей между main и __local версиями функции
   *
   * @param functionName - Имя функции
   * @param file - Путь к файлу
   * @returns Результат валидации
   */
  async checkPathEquivalence(functionName: string, file: string): Promise<PathValidationResult> {
    // 1. Найти все версии функции (main и __local) по имени
    const allVersions: VersionedNode[] = [];
    for await (const node of this.backend.queryNodes({ type: 'FUNCTION', name: functionName })) {
      // Дополнительно фильтруем по file если он указан
      if (node.file === file || node.file === undefined) {
        allVersions.push(node as VersionedNode);
      }
    }

    const mainFunction = allVersions.find(n => n.version === 'main');
    const localFunction = allVersions.find(n => n.version === '__local');

    // 3. Обработать случаи: deleted, added, exists
    if (!mainFunction && localFunction) {
      // Новая функция
      return {
        safe: true,
        severity: 'info',
        message: `New function added: ${functionName}`,
        endpointsChecked: 0
      };
    }

    if (mainFunction && !localFunction) {
      // Функция удалена
      return {
        safe: false,
        severity: 'error',
        deleted: true,
        message: `Function deleted: ${functionName}`,
        endpointsChecked: 0
      };
    }

    if (!mainFunction && !localFunction) {
      // Функция не найдена вообще
      return {
        safe: false,
        severity: 'error',
        message: `Function not found: ${functionName}`,
        endpointsChecked: 0
      };
    }

    // 4. Получить все endpoints для main версии
    const mainEndpoints = await this._getReachableEndpoints(mainFunction!.id);

    // 5. Получить все endpoints для local версии
    const localEndpoints = await this._getReachableEndpoints(localFunction!.id);

    // 6. Сравнить endpoints
    const comparison = this._compareEndpoints(mainEndpoints, localEndpoints);

    // 7. Определить результат
    if (comparison.missing.length > 0) {
      // Breaking change - критические endpoints удалены
      return {
        safe: false,
        severity: 'error',
        message: `Breaking change detected: ${comparison.missing.length} endpoint(s) no longer reachable`,
        missing: comparison.missing,
        endpointsChecked: mainEndpoints.length
      };
    }

    if (comparison.added.length > 0) {
      // Warning - новые endpoints добавлены
      return {
        safe: true,
        severity: 'warning',
        message: `New behavior added: ${comparison.added.length} new endpoint(s) reachable`,
        added: comparison.added,
        endpointsChecked: mainEndpoints.length
      };
    }

    // Safe refactoring - все endpoints сохранены
    return {
      safe: true,
      severity: 'info',
      message: `Safe refactoring: all endpoints preserved`,
      endpointsChecked: mainEndpoints.length
    };
  }

  /**
   * Получить все достижимые endpoints из данной ноды
   *
   * @param nodeId - ID начальной ноды
   * @returns Массив endpoint нод
   */
  private async _getReachableEndpoints(nodeId: string): Promise<EndpointNode[]> {
    // Трассируем пути через CALLS рёбра (BFS до глубины 10)
    // Endpoints - это ноды типа: DATABASE_QUERY, HTTP_REQUEST, EXTERNAL, FILESYSTEM, SIDE_EFFECT
    // Или exported FUNCTION (MODULE_BOUNDARY)

    const CALLS_EDGE_TYPE = 'CALLS';
    const MAX_DEPTH = 10;

    // BFS для поиска всех достижимых нод
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];
    const endpoints: EndpointNode[] = [];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;

      if (visited.has(id) || depth > MAX_DEPTH) {
        continue;
      }
      visited.add(id);

      // Получить ноду и проверить является ли она endpoint
      const node = await this.backend.getNode(id);
      if (node && id !== nodeId) {
        // Check for endpoint types (new namespaced types + legacy names for backward compat)
        const endpointTypes = [
          'db:query', 'DATABASE_QUERY',
          'http:request', 'HTTP_REQUEST',
          'EXTERNAL',
          'fs:operation', 'FILESYSTEM',
          'SIDE_EFFECT',
          'net:request', 'EXTERNAL_NETWORK',
          'net:stdio', 'EXTERNAL_STDIO'
        ];
        const isEndpoint =
          endpointTypes.includes(node.type) ||
          (node.type === 'FUNCTION' && (node as EndpointNode).exported === true);

        if (isEndpoint) {
          endpoints.push(node as EndpointNode);
        }
      }

      // Получить исходящие CALLS рёбра
      const outgoingEdges = await this.backend.getOutgoingEdges(id, [CALLS_EDGE_TYPE]);
      for (const edge of outgoingEdges) {
        const dstId = typeof edge.dst === 'string' ? edge.dst : String(edge.dst);
        if (!visited.has(dstId)) {
          queue.push({ id: dstId, depth: depth + 1 });
        }
      }
    }

    return endpoints;
  }

  /**
   * Сравнить два набора endpoints
   *
   * @param mainEndpoints - Endpoints из main версии
   * @param localEndpoints - Endpoints из __local версии
   * @returns { missing: [], added: [] }
   */
  private _compareEndpoints(mainEndpoints: EndpointNode[], localEndpoints: EndpointNode[]): { missing: EndpointDiff[]; added: EndpointDiff[] } {
    const missing: EndpointDiff[] = [];
    const added: EndpointDiff[] = [];

    // Создаём Map для быстрого поиска
    const localMap = new Map<string, EndpointNode>();
    localEndpoints.forEach(ep => {
      const key = this._getEndpointKey(ep);
      localMap.set(key, ep);
    });

    const mainMap = new Map<string, EndpointNode>();
    mainEndpoints.forEach(ep => {
      const key = this._getEndpointKey(ep);
      mainMap.set(key, ep);
    });

    // Находим missing endpoints (есть в main, но нет в local)
    for (const [key, endpoint] of mainMap.entries()) {
      if (!localMap.has(key)) {
        missing.push({
          type: endpoint.type,
          name: (endpoint.name as string) || endpoint.query || 'unknown',
          reason: this._getMissingReason(endpoint)
        });
      }
    }

    // Находим added endpoints (есть в local, но нет в main)
    for (const [key, endpoint] of localMap.entries()) {
      if (!mainMap.has(key)) {
        added.push({
          type: endpoint.type,
          name: (endpoint.name as string) || endpoint.query || 'unknown',
          reason: this._getAddedReason(endpoint)
        });
      }
    }

    return { missing, added };
  }

  /**
   * Получить уникальный ключ для endpoint
   *
   * @param endpoint - Endpoint нода
   * @returns Уникальный ключ
   */
  private _getEndpointKey(endpoint: EndpointNode): string {
    if (endpoint.type === 'DATABASE_QUERY' || endpoint.type === 'db:query') {
      // Для DB query используем query text
      return `db:query:${endpoint.query || endpoint.name}`;
    }

    if (endpoint.type === 'FUNCTION' && endpoint.exported) {
      // Для exported functions используем stable ID
      return `${endpoint.type}:${endpoint.name}:${endpoint.file}`;
    }

    if (endpoint.type === 'EXTERNAL') {
      // Для external используем service + name
      return `${endpoint.type}:${endpoint.service}:${endpoint.name}`;
    }

    // Для остальных используем type + name
    return `${endpoint.type}:${endpoint.name}`;
  }

  /**
   * Получить reason для missing endpoint
   */
  private _getMissingReason(endpoint: EndpointNode): string {
    if (endpoint.type === 'DATABASE_QUERY') {
      return `Database query no longer executed: ${endpoint.query}`;
    }

    if (endpoint.type === 'FUNCTION' && endpoint.exported) {
      return `Exported function no longer called: ${endpoint.name}`;
    }

    if (endpoint.type === 'EXTERNAL') {
      return `External service no longer called: ${endpoint.service}/${endpoint.name}`;
    }

    return `Endpoint no longer reachable: ${endpoint.name}`;
  }

  /**
   * Получить reason для added endpoint
   */
  private _getAddedReason(endpoint: EndpointNode): string {
    if (endpoint.type === 'DATABASE_QUERY') {
      return `New database query added: ${endpoint.query}`;
    }

    if (endpoint.type === 'FUNCTION' && endpoint.exported) {
      return `New call to exported function: ${endpoint.name}`;
    }

    if (endpoint.type === 'EXTERNAL') {
      return `New external service call: ${endpoint.service}/${endpoint.name}`;
    }

    return `New endpoint reachable: ${endpoint.name}`;
  }
}
