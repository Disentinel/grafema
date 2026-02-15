/**
 * DatabaseFactory - factory methods for database-related graph nodes
 *
 * Handles: DATABASE_QUERY, db:connection, db:query, db:table
 */

import {
  DatabaseQueryNode,
  DatabaseNode,
} from '../nodes/index.js';

import { brandNodeInternal } from '../brandNodeInternal.js';

interface DatabaseQueryOptions {
  parentScopeId?: string;
}

export class DatabaseFactory {
  static createDatabaseQuery(query: string | undefined, operation: string | undefined, file: string, line: number, column: number, options: DatabaseQueryOptions = {}) {
    return brandNodeInternal(DatabaseQueryNode.create(query, operation, file, line, column, options));
  }

  static createDbConnection(name: string) {
    return brandNodeInternal(DatabaseNode.createConnection(name));
  }

  static createDbQuery(
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
  ) {
    return brandNodeInternal(DatabaseNode.createQuery(file, queryCounter, sql, operation, options));
  }

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
  ) {
    return brandNodeInternal(DatabaseNode.createSQLiteQuery(file, method, line, query, operationType, options));
  }

  static createDbTable(tableName: string) {
    return brandNodeInternal(DatabaseNode.createTable(tableName));
  }
}
