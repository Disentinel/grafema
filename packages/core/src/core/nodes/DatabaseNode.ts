/**
 * DatabaseNode - contracts for database domain-specific nodes
 *
 * Types: db:connection, db:query, db:table
 *
 * Used by DatabaseAnalyzer and SQLiteAnalyzer for database access patterns.
 * NOT the same as DatabaseQueryNode which handles legacy DATABASE_QUERY type.
 *
 * ID formats:
 * - db:connection: EXTERNAL_DATABASE:<name>
 * - db:query (DatabaseAnalyzer): <file>:DATABASE_QUERY:<counter>
 * - db:query (SQLiteAnalyzer): <file>:DATABASE_QUERY:<method>:<line>
 * - db:table: TABLE:<tableName>
 */

import type { BaseNodeRecord } from '@grafema/types';

// --- db:connection ---

export interface DbConnectionNodeRecord extends BaseNodeRecord {
  type: 'db:connection';
  name: string;
}

// --- db:query (DatabaseAnalyzer variant) ---

export interface DbQueryNodeRecord extends BaseNodeRecord {
  type: 'db:query';
  file: string;
  line: number;
  column: number;
}

// --- db:table ---

export interface DbTableNodeRecord extends BaseNodeRecord {
  type: 'db:table';
  name: string;
}

export class DatabaseNode {
  /**
   * Create a db:connection node (singleton per database name).
   *
   * @param name - Database name (e.g., '__database__')
   */
  static createConnection(name: string): DbConnectionNodeRecord {
    if (!name) throw new Error('DatabaseNode.createConnection: name is required');

    return {
      id: `EXTERNAL_DATABASE:${name}`,
      type: 'db:connection',
      name,
    };
  }

  /**
   * Create a db:query node for DatabaseAnalyzer.
   *
   * @param file - File path
   * @param queryCounter - Sequential query counter within the file
   * @param sql - Raw SQL string
   * @param operation - SQL operation type (SELECT, INSERT, UPDATE, DELETE, etc.)
   * @param options - Additional query metadata
   */
  static createQuery(
    file: string,
    queryCounter: number,
    sql: string,
    operation: string,
    options: {
      sqlSnippet?: string;
      tableName?: string | null;
      object?: string;
      method?: string;
      line?: number;
      column?: number;
    } = {}
  ): DbQueryNodeRecord {
    if (!file) throw new Error('DatabaseNode.createQuery: file is required');

    return {
      id: `${file}:DATABASE_QUERY:${queryCounter}`,
      type: 'db:query',
      name: sql,
      sql,
      sqlSnippet: options.sqlSnippet ?? (sql.length > 50 ? sql.substring(0, 50) + '...' : sql),
      operation,
      tableName: options.tableName ?? null,
      object: options.object,
      method: options.method,
      file,
      line: options.line ?? 0,
      column: options.column ?? 0,
    };
  }

  /**
   * Create a db:query node for SQLiteAnalyzer.
   *
   * @param file - File path
   * @param method - SQLite method name (e.g., 'all', 'get', 'run')
   * @param line - Line number
   * @param query - Raw SQL string
   * @param operationType - SQL operation type
   * @param options - Additional query metadata
   */
  static createSQLiteQuery(
    file: string,
    method: string,
    line: number,
    query: string,
    operationType: string,
    options: {
      params?: string | null;
      tableName?: string | null;
      column?: number;
      promiseWrapped?: boolean;
    } = {}
  ): DbQueryNodeRecord {
    if (!file) throw new Error('DatabaseNode.createSQLiteQuery: file is required');

    return {
      id: `${file}:DATABASE_QUERY:${method}:${line}`,
      type: 'db:query',
      name: query,
      method: method.toUpperCase(),
      query,
      params: options.params ?? null,
      operationType,
      tableName: options.tableName ?? null,
      file,
      line,
      column: options.column ?? 0,
      promiseWrapped: options.promiseWrapped,
    };
  }

  /**
   * Create a db:table node (singleton per table name).
   *
   * @param tableName - Table name
   */
  static createTable(tableName: string): DbTableNodeRecord {
    if (!tableName) throw new Error('DatabaseNode.createTable: tableName is required');

    return {
      id: `TABLE:${tableName}`,
      type: 'db:table',
      name: tableName,
    };
  }

  /**
   * Check if a type belongs to the database domain.
   */
  static isDatabaseType(type: string): boolean {
    return type === 'db:connection' || type === 'db:query' || type === 'db:table';
  }

  /**
   * Validate a database domain node.
   */
  static validate(node: BaseNodeRecord): string[] {
    const errors: string[] = [];

    if (!DatabaseNode.isDatabaseType(node.type)) {
      errors.push(`Expected db:* type, got ${node.type}`);
    }

    if (!node.id) errors.push('Missing required field: id');

    return errors;
  }
}
