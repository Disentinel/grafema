/**
 * DatabaseAnalyzer - анализ database access patterns
 * Детектирует db.query(), connection.query() и другие SQL вызовы
 */

import { readFileSync } from 'fs';
import { parse, ParserPlugin } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { CallExpression, Identifier } from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord } from '@grafema/types';
import { getLine } from './ast/utils/location.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const traverse = (traverseModule as any).default || traverseModule;

/**
 * Database query node
 */
interface DatabaseQueryNode {
  id: string;
  type: 'db:query';
  sql: string;
  sqlSnippet: string;
  operation: string;
  tableName: string | null;
  object: string;
  method: string;
  file: string;
  line: number;
}

/**
 * Analysis result
 */
interface AnalysisResult {
  queries: number;
  tables: number;
  edges: number;
}

export class DatabaseAnalyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'DatabaseAnalyzer',
      phase: 'ANALYSIS',
      priority: 75, // После JSASTAnalyzer (80)
      creates: {
        nodes: ['db:query', 'db:table', 'db:connection'],
        edges: ['MAKES_QUERY', 'TARGETS', 'READS_FROM', 'WRITES_TO']
      },
      dependencies: ['JSASTAnalyzer'] // Требует MODULE и FUNCTION ноды
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const logger = this.log(context);

    try {
      const { graph } = context;

      // Получаем все MODULE ноды
      const modules = await this.getModules(graph);
      logger.info('Processing modules', { count: modules.length });

      // Получаем все FUNCTION ноды для связывания
      const functions = await this.getFunctions(graph);

      let queriesCreated = 0;
      let tablesCreated = 0;
      let edgesCreated = 0;
      const startTime = Date.now();

      // Анализируем каждый модуль
      for (let i = 0; i < modules.length; i++) {
        const module = modules[i];
        const result = await this.analyzeModule(module, functions, graph);
        queriesCreated += result.queries;
        tablesCreated += result.tables;
        edgesCreated += result.edges;

        // Progress every 20 modules
        if ((i + 1) % 20 === 0 || i === modules.length - 1) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const avgTime = ((Date.now() - startTime) / (i + 1)).toFixed(0);
          logger.debug('Progress', {
            current: i + 1,
            total: modules.length,
            elapsed: `${elapsed}s`,
            avgTime: `${avgTime}ms/module`
          });
        }
      }

      logger.info('Analysis complete', { queriesCreated, tablesCreated });

      return createSuccessResult(
        {
          nodes: queriesCreated + tablesCreated,
          edges: edgesCreated
        },
        {
          queriesCreated,
          tablesCreated
        }
      );
    } catch (error) {
      logger.error('Analysis failed', { error });
      return createErrorResult(error as Error);
    }
  }

  /**
   * Получить все FUNCTION ноды из графа
   */
  private async getFunctions(graph: PluginContext['graph']): Promise<NodeRecord[]> {
    const functions: NodeRecord[] = [];
    for await (const node of graph.queryNodes({ type: 'FUNCTION' })) {
      functions.push(node);
    }
    return functions;
  }

  /**
   * Анализировать один модуль на database patterns
   */
  private async analyzeModule(
    module: NodeRecord,
    functions: NodeRecord[],
    graph: PluginContext['graph']
  ): Promise<AnalysisResult> {
    let queriesCreated = 0;
    let tablesCreated = 0;
    let edgesCreated = 0;

    try {
      // Читаем и парсим файл
      const code = readFileSync(module.file!, 'utf-8');
      const ast = parse(code, {
        sourceType: 'module',
        plugins: ['jsx'] as ParserPlugin[]
      });

      const databaseQueries: DatabaseQueryNode[] = [];
      const createdTables = new Set<string>();
      let queryCounter = 0;

      // Ищем db.query() паттерны
      traverse(ast, {
        CallExpression: (path: NodePath<CallExpression>) => {
          const node = path.node;

          // Проверяем что это MemberExpression: db.query(), connection.execute()
          if (node.callee.type === 'MemberExpression') {
            const methodName = (node.callee.property as Identifier).name;
            const objectName = (node.callee.object as Identifier).name;

            // Детектируем database queries
            const isDatabaseQuery =
              (methodName === 'query' || methodName === 'execute') &&
              (objectName === 'db' || objectName === 'connection' || objectName === 'pool') &&
              node.arguments.length >= 1;

            if (isDatabaseQuery) {
              const sqlArg = node.arguments[0];
              let sql: string | null = null;
              let operation = 'UNKNOWN';

              // Извлекаем SQL строку
              if (sqlArg.type === 'StringLiteral') {
                sql = sqlArg.value;
              } else if (sqlArg.type === 'TemplateLiteral') {
                // Template literal - собираем строку с placeholders
                sql = sqlArg.quasis.map(q => q.value.raw).join('${...}');
              }

              // Определяем тип операции и таблицу из SQL
              if (sql) {
                const sqlUpper = sql.trim().toUpperCase();
                let tableName: string | null = null;

                if (sqlUpper.startsWith('SELECT')) {
                  operation = 'SELECT';
                  const fromMatch = sqlUpper.match(/FROM\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
                  if (fromMatch) tableName = fromMatch[1].toLowerCase();
                } else if (sqlUpper.startsWith('INSERT')) {
                  operation = 'INSERT';
                  const intoMatch = sqlUpper.match(/INTO\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
                  if (intoMatch) tableName = intoMatch[1].toLowerCase();
                } else if (sqlUpper.startsWith('UPDATE')) {
                  operation = 'UPDATE';
                  const updateMatch = sqlUpper.match(/UPDATE\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
                  if (updateMatch) tableName = updateMatch[1].toLowerCase();
                } else if (sqlUpper.startsWith('DELETE')) {
                  operation = 'DELETE';
                  const deleteMatch = sqlUpper.match(/FROM\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
                  if (deleteMatch) tableName = deleteMatch[1].toLowerCase();
                } else if (sqlUpper.startsWith('CREATE')) {
                  operation = 'CREATE';
                  const createMatch = sqlUpper.match(/TABLE\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
                  if (createMatch) tableName = createMatch[1].toLowerCase();
                } else if (sqlUpper.startsWith('DROP')) {
                  operation = 'DROP';
                  const dropMatch = sqlUpper.match(/TABLE\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
                  if (dropMatch) tableName = dropMatch[1].toLowerCase();
                } else if (sqlUpper.startsWith('ALTER')) {
                  operation = 'ALTER';
                  const alterMatch = sqlUpper.match(/TABLE\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
                  if (alterMatch) tableName = alterMatch[1].toLowerCase();
                }

                const queryId = queryCounter++;
                const sqlSnippet = sql.length > 50 ? sql.substring(0, 50) + '...' : sql;

                databaseQueries.push({
                  id: `${module.file}:DATABASE_QUERY:${queryId}`,
                  type: 'db:query',
                  sql: sql,
                  sqlSnippet: sqlSnippet,
                  operation: operation,
                  tableName: tableName,
                  object: objectName,
                  method: methodName,
                  file: module.file!,
                  line: getLine(node)
                });
              }
            }
          }
        }
      });

      // Создаём EXTERNAL_DATABASE ноду если есть хотя бы один query
      if (databaseQueries.length > 0) {
        const databaseId = 'EXTERNAL_DATABASE:__database__';

        const existingDb = await graph.getNode(databaseId);
        if (!existingDb) {
          await graph.addNode({
            id: databaseId,
            type: 'db:connection',
            name: '__database__'
          } as NodeRecord);
        }

        // Создаём DATABASE_QUERY ноды
        for (const query of databaseQueries) {
          await graph.addNode(query as unknown as NodeRecord);
          queriesCreated++;

          // Создаём TABLE ноду если есть tableName
          if (query.tableName) {
            const tableId = `TABLE:${query.tableName}`;

            if (!createdTables.has(tableId)) {
              await graph.addNode({
                id: tableId,
                type: 'db:table',
                name: query.tableName
              } as NodeRecord);
              tablesCreated++;
              createdTables.add(tableId);
            }

            // DATABASE_QUERY -> TARGETS -> TABLE
            await graph.addEdge({
              type: 'TARGETS',
              src: query.id,
              dst: tableId
            });
            edgesCreated++;
          }

          // DATABASE_QUERY -> (READS_FROM | WRITES_TO) -> __database__
          const isReadOperation = query.operation === 'SELECT';
          const edgeType = isReadOperation ? 'READS_FROM' : 'WRITES_TO';

          await graph.addEdge({
            type: edgeType,
            src: query.id,
            dst: databaseId
          });
          edgesCreated++;

          // Находим родительскую функцию для MAKES_QUERY ребра
          const parentFunction = this.findParentFunction(query, functions);

          if (parentFunction) {
            await graph.addEdge({
              type: 'MAKES_QUERY',
              src: parentFunction.id,
              dst: query.id
            });
            edgesCreated++;
          }
        }
      }
    } catch (error) {
      // Silent - per-module errors shouldn't spam logs
    }

    return {
      queries: queriesCreated,
      tables: tablesCreated,
      edges: edgesCreated
    };
  }

  /**
   * Найти родительскую функцию для database query
   */
  private findParentFunction(query: DatabaseQueryNode, functions: NodeRecord[]): NodeRecord | null {
    // Ищем функцию в том же файле, которая содержит эту строку
    const candidates = functions.filter(
      f => f.file === query.file && (f.line ?? 0) < query.line // Функция должна начинаться раньше query
    );

    // Берём ближайшую (с максимальным line number меньше query.line)
    if (candidates.length > 0) {
      candidates.sort((a, b) => (b.line ?? 0) - (a.line ?? 0));
      return candidates[0];
    }

    return null;
  }
}
