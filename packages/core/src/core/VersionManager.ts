/**
 * VersionManager - управление версиями нод для incremental analysis
 *
 * КОНЦЕПЦИЯ:
 * - Храним несколько версий кода одновременно (main, __local, branch names)
 * - Используем stable IDs для сравнения версий
 * - Поддерживаем fine-grained merge (только изменённые ноды)
 *
 * ВЕРСИИ:
 * - "main" - committed код из git HEAD
 * - "__local" - uncommitted изменения (working directory)
 * - "branch-name" - другие ветки (будущее)
 */

import { createHash } from 'crypto';

/**
 * Version constants
 */
export interface VersionConstants {
  MAIN: 'main';
  LOCAL: '__local';
}

/**
 * Node types for stable ID generation
 */
export type StableIdNodeType =
  | 'FUNCTION'
  | 'CLASS'
  | 'INTERFACE'
  | 'TYPE_ALIAS'
  | 'VARIABLE_DECLARATION'
  | 'MODULE'
  | 'SERVICE'
  | 'CALL_SITE'
  | 'SCOPE'
  | 'EXPRESSION'
  | 'STATEMENT'
  | 'DATABASE_QUERY'
  | 'HTTP_REQUEST'
  | 'FILESYSTEM'
  | 'NETWORK'
  | 'ENDPOINT';

/**
 * Node for stable ID generation
 */
export interface VersionedNode {
  type: string;
  name?: string;
  file?: string;
  line?: number;
  column?: number;
  // Content fields for external nodes
  query?: string;
  url?: string;
  path?: string;
  endpoint?: string;
  // Additional fields for structural comparison
  params?: unknown[];
  returnType?: string;
  async?: boolean;
  exported?: boolean;
  bodyHash?: string;
  methods?: unknown[];
  properties?: unknown[];
  extends?: string;
  implements?: string[];
  kind?: string;
  value?: unknown;
  contentHash?: string;
  imports?: unknown[];
  exports?: unknown[];
  arguments?: unknown[];
  callee?: string;
  operation?: string;
  collection?: string;
  method?: string;
  handler?: string;
  // Version-aware fields
  id?: string;
  version?: string;
  _stableId?: string;
  _replaces?: string;
  updatedAt?: number;
}

/**
 * REPLACES edge structure
 */
export interface ReplacesEdge {
  type: 'REPLACES';
  fromId: string;
  toId: string;
  version: string;
}

/**
 * Enrichment options
 */
export interface EnrichOptions {
  replacesId?: string;
}

/**
 * Modified node info
 */
export interface ModifiedNodeInfo {
  old: VersionedNode;
  new: VersionedNode;
  stableId: string;
}

/**
 * Changes summary
 */
export interface ChangesSummary {
  addedCount: number;
  modifiedCount: number;
  unchangedCount: number;
  deletedCount: number;
  totalChanges: number;
}

/**
 * Classification result
 */
export interface ClassifyChangesResult {
  added: VersionedNode[];
  modified: ModifiedNodeInfo[];
  unchanged: VersionedNode[];
  deleted: VersionedNode[];
  summary: ChangesSummary;
}

/**
 * Type-specific comparison keys
 */
interface TypeSpecificKeys {
  [nodeType: string]: string[];
}

export class VersionManager {
  readonly versions: VersionConstants;

  constructor() {
    this.versions = {
      MAIN: 'main',
      LOCAL: '__local'
    };
  }

  /**
   * Генерировать stable ID для ноды (без версии)
   *
   * Stable ID остаётся одинаковым для одной и той же сущности
   * в разных версиях кода
   */
  generateStableId(node: VersionedNode): string {
    const { type, name, file, line, column } = node;

    // Для FUNCTION, CLASS - используем type:name:file
    if (['FUNCTION', 'CLASS', 'INTERFACE', 'TYPE_ALIAS'].includes(type)) {
      return `${type}:${name}:${file}`;
    }

    // Для VARIABLE_DECLARATION - добавляем line для различения локальных переменных
    if (type === 'VARIABLE_DECLARATION') {
      return `${type}:${name}:${file}:${line || 0}`;
    }

    // Для MODULE - только file
    if (type === 'MODULE') {
      return `MODULE:${file}`;
    }

    // Для SERVICE - используем имя или file
    if (type === 'SERVICE') {
      return `SERVICE:${name || file}`;
    }

    // Для вложенных нод (CALL_SITE, SCOPE, EXPRESSION) - используем file:line:column
    if (['CALL_SITE', 'SCOPE', 'EXPRESSION', 'STATEMENT'].includes(type)) {
      return `${type}:${file}:${line || 0}:${column || 0}`;
    }

    // Для EXTERNAL нод (DATABASE_QUERY, HTTP_REQUEST) - используем содержимое
    if (['DATABASE_QUERY', 'HTTP_REQUEST', 'FILESYSTEM', 'NETWORK'].includes(type)) {
      // Используем хеш содержимого для уникальности
      const content = node.query || node.url || node.path || node.endpoint || '';
      const hash = createHash('sha256').update(content).digest('hex').substring(0, 16);
      return `${type}:${hash}`;
    }

    // По умолчанию - используем все доступные поля
    const parts = [type, name, file, line, column].filter(p => p !== undefined && p !== null);
    return parts.join(':');
  }

  /**
   * Генерировать versioned ID для ноды
   */
  generateVersionedId(node: VersionedNode, version: string): string {
    const stableId = this.generateStableId(node);
    return `${stableId}:${version}`;
  }

  /**
   * Извлечь stable ID из versioned ID
   */
  extractStableId(versionedId: string): string {
    const lastColonIndex = versionedId.lastIndexOf(':');
    return versionedId.substring(0, lastColonIndex);
  }

  /**
   * Извлечь версию из versioned ID
   */
  extractVersion(versionedId: string): string {
    const lastColonIndex = versionedId.lastIndexOf(':');
    return versionedId.substring(lastColonIndex + 1);
  }

  /**
   * Проверить, имеет ли нода структурные изменения
   */
  hasStructuralChanges(oldNode: VersionedNode, newNode: VersionedNode): boolean {
    // Список ключевых полей для сравнения (зависит от типа ноды)
    const keysToCompare = this._getComparisonKeys(oldNode.type);

    for (const key of keysToCompare) {
      const oldValue = (oldNode as unknown as Record<string, unknown>)[key];
      const newValue = (newNode as unknown as Record<string, unknown>)[key];

      // Глубокое сравнение для массивов и объектов
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Получить ключи для сравнения в зависимости от типа ноды
   */
  private _getComparisonKeys(nodeType: string): string[] {
    const commonKeys = ['name', 'line', 'column'];

    const typeSpecificKeys: TypeSpecificKeys = {
      FUNCTION: ['params', 'returnType', 'async', 'exported', 'bodyHash'],
      CLASS: ['methods', 'properties', 'extends', 'implements', 'exported'],
      VARIABLE_DECLARATION: ['kind', 'value', 'exported'],
      MODULE: ['contentHash', 'imports', 'exports'],
      CALL_SITE: ['arguments', 'callee'],
      DATABASE_QUERY: ['query', 'operation', 'collection'],
      HTTP_REQUEST: ['method', 'url', 'endpoint'],
      ENDPOINT: ['path', 'method', 'handler']
    };

    return [...commonKeys, ...(typeSpecificKeys[nodeType] || [])];
  }

  /**
   * Вычислить хеш тела функции для сравнения
   */
  calculateBodyHash(bodySource: string | null | undefined): string | null {
    if (!bodySource) return null;

    // Нормализуем код: убираем пробелы и комментарии для сравнения
    const normalized = bodySource
      .replace(/\/\*[\s\S]*?\*\//g, '') // Блочные комментарии
      .replace(/\/\/.*/g, '') // Строчные комментарии
      .replace(/\s+/g, ' ') // Множественные пробелы -> один пробел
      .trim();

    return createHash('sha256').update(normalized, 'utf-8').digest('hex');
  }

  /**
   * Создать REPLACES ребро между версиями
   */
  createReplacesEdge(localNodeId: string, mainNodeId: string): ReplacesEdge {
    return {
      type: 'REPLACES',
      fromId: localNodeId,
      toId: mainNodeId,
      version: '__local' // Edge тоже имеет версию
    };
  }

  /**
   * Дополнить ноду полями для version-aware анализа
   */
  enrichNodeWithVersion(
    node: VersionedNode,
    version: string,
    options: EnrichOptions = {}
  ): VersionedNode {
    const stableId = this.generateStableId(node);
    const versionedId = this.generateVersionedId(node, version);

    const enriched: VersionedNode = {
      ...node,
      id: versionedId,
      version: version,
      _stableId: stableId
    };

    // Добавляем _replaces если это замена main версии
    if (options.replacesId) {
      enriched._replaces = options.replacesId;
    }

    // Добавляем timestamp
    if (!enriched.updatedAt) {
      enriched.updatedAt = Date.now();
    }

    return enriched;
  }

  /**
   * Классифицировать изменения между версиями
   */
  classifyChanges(mainNodes: VersionedNode[], localNodes: VersionedNode[]): ClassifyChangesResult {
    // Создаём Map по stable ID
    const mainMap = new Map<string, VersionedNode>();
    for (const node of mainNodes) {
      const stableId = this.generateStableId(node);
      mainMap.set(stableId, node);
    }

    const localMap = new Map<string, VersionedNode>();
    for (const node of localNodes) {
      const stableId = this.generateStableId(node);
      localMap.set(stableId, node);
    }

    // Классификация
    const added: VersionedNode[] = [];
    const modified: ModifiedNodeInfo[] = [];
    const unchanged: VersionedNode[] = [];
    const deleted: VersionedNode[] = [];

    // Проверяем локальные ноды
    for (const [stableId, localNode] of localMap) {
      if (!mainMap.has(stableId)) {
        // Нода добавлена
        added.push(localNode);
      } else {
        const mainNode = mainMap.get(stableId)!;
        if (this.hasStructuralChanges(mainNode, localNode)) {
          // Нода изменена
          modified.push({ old: mainNode, new: localNode, stableId });
        } else {
          // Нода не изменилась
          unchanged.push(localNode);
        }
      }
    }

    // Проверяем удалённые ноды (есть в main, нет в local)
    for (const [stableId, mainNode] of mainMap) {
      if (!localMap.has(stableId)) {
        deleted.push(mainNode);
      }
    }

    return {
      added, // Новые ноды
      modified, // Изменённые ноды
      unchanged, // Неизменённые ноды
      deleted, // Удалённые ноды
      summary: {
        addedCount: added.length,
        modifiedCount: modified.length,
        unchangedCount: unchanged.length,
        deletedCount: deleted.length,
        totalChanges: added.length + modified.length + deleted.length
      }
    };
  }

  /**
   * Проверить, является ли версия локальной (uncommitted)
   */
  isLocalVersion(version: string): boolean {
    return version === this.versions.LOCAL;
  }

  /**
   * Проверить, является ли версия основной (committed)
   */
  isMainVersion(version: string): boolean {
    return version === this.versions.MAIN;
  }
}

/**
 * Singleton instance
 */
export const versionManager = new VersionManager();
