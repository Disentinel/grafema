/**
 * SQLiteAnalyzer - детектит SQLite database operations
 *
 * Паттерны:
 * - database.getDb().all(query, params, callback)
 * - database.getDb().get(query, params, callback)
 * - database.getDb().run(query, params, callback)
 * - Promise-wrapped: new Promise((resolve, reject) => { db.all(...) })
 */

import { readFileSync } from 'fs';
import { parse, ParserPlugin } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { CallExpression, Identifier, MemberExpression, Node } from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord } from '@grafema/types';
import { getLine } from './ast/utils/location.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const traverse = (traverseModule as any).default || traverseModule;

/**
 * SQLite database query node
 */
interface SQLiteQueryNode {
  id: string;
  type: 'db:query';
  method: string;
  query: string;
  params: string | null;
  operationType: string;
  tableName: string | null;
  file: string;
  line: number;
  promiseWrapped?: boolean;
}

/**
 * Analysis result
 */
interface AnalysisResult {
  queries: number;
  operations: number;
  edges: number;
}

const SQLITE_METHODS = ['all', 'get', 'run', 'exec', 'prepare', 'query', 'execute'];

export class SQLiteAnalyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'SQLiteAnalyzer',
      phase: 'ANALYSIS',
      priority: 75, // После JSASTAnalyzer (80)
      creates: {
        nodes: ['db:query'],
        edges: ['CONTAINS', 'EXECUTES_QUERY']
      },
      dependencies: ['JSModuleIndexer', 'JSASTAnalyzer']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const logger = this.log(context);

    try {
      const { graph } = context;

      // Получаем все MODULE ноды
      const modules = await this.getModules(graph);

      let queriesCreated = 0;
      let operationsCreated = 0;
      let edgesCreated = 0;

      // Анализируем каждый модуль
      for (const module of modules) {
        const result = await this.analyzeModule(module, graph);
        queriesCreated += result.queries;
        operationsCreated += result.operations;
        edgesCreated += result.edges;
      }

      logger.info('Analysis complete', { queriesCreated, operationsCreated });

      return createSuccessResult(
        { nodes: queriesCreated + operationsCreated, edges: edgesCreated },
        { modulesAnalyzed: modules.length, queries: queriesCreated, operations: operationsCreated }
      );
    } catch (error) {
      logger.error('Analysis failed', { error });
      return createErrorResult(error as Error);
    }
  }

  private async analyzeModule(
    module: NodeRecord,
    graph: PluginContext['graph']
  ): Promise<AnalysisResult> {
    let queriesCreated = 0;
    let operationsCreated = 0;
    let edgesCreated = 0;

    try {
      // Читаем файл
      const code = readFileSync(module.file!, 'utf-8');

      // Парсим AST
      const ast = parse(code, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript'] as ParserPlugin[]
      });

      const queries: SQLiteQueryNode[] = [];

      traverse(ast, {
        CallExpression: (path: NodePath<CallExpression>) => {
          const node = path.node;
          const callee = node.callee;

          // Паттерн 1: database.getDb().METHOD(query, params, callback)
          // или db.METHOD(query, params, callback)
          if (
            callee.type === 'MemberExpression' &&
            callee.property.type === 'Identifier' &&
            SQLITE_METHODS.includes((callee.property as Identifier).name)
          ) {
            const method = (callee.property as Identifier).name;
            const args = node.arguments;

            // Проверяем что это database/db объект, а не router/app
            const objectName = this.getObjectName(callee.object);
            if (objectName === 'router' || objectName === 'app') {
              // Это Express router, а не database
              return;
            }

            if (args.length >= 1) {
              let query: string | null = null;
              let params: string | null = null;

              // Первый аргумент - SQL query
              const queryArg = args[0];
              if (queryArg.type === 'StringLiteral') {
                query = queryArg.value;
              } else if (queryArg.type === 'TemplateLiteral') {
                // Template literal SQL: `SELECT * FROM ${table}`
                query = this.extractTemplateLiteral(queryArg);
              }

              // Второй аргумент - параметры (если есть)
              if (args.length >= 2 && args[1].type === 'ArrayExpression') {
                params = args[1].elements
                  .map(el => {
                    if (!el) return '?';
                    if (el.type === 'StringLiteral' || el.type === 'NumericLiteral') {
                      return String(el.value);
                    } else if (el.type === 'Identifier') {
                      return `$${(el as Identifier).name}`;
                    }
                    return '?';
                  })
                  .join(', ');
              }

              if (query) {
                // Определяем тип операции из SQL
                const operationType = this.detectOperationType(query);
                const tableName = this.extractTableName(query, operationType);

                const queryId = `${module.file}:DATABASE_QUERY:${method}:${getLine(node)}`;

                queries.push({
                  id: queryId,
                  type: 'db:query',
                  method: method.toUpperCase(),
                  query: query,
                  params: params,
                  operationType: operationType,
                  tableName: tableName,
                  file: module.file!,
                  line: getLine(node)
                });
              }
            }
          }

          // Паттерн 2: Promise-wrapped pattern
          // new Promise((resolve, reject) => { db.all(...) })
          if (callee.type === 'Identifier' && callee.name === 'Promise') {
            // Ищем внутри Promise executor function
            const executorArg = node.arguments[0];
            if (
              executorArg &&
              (executorArg.type === 'ArrowFunctionExpression' ||
                executorArg.type === 'FunctionExpression')
            ) {
              // Обходим тело executor function для поиска db calls
              const executorPath = path.get('arguments.0');

              (executorPath as NodePath).traverse({
                CallExpression: (innerPath: NodePath<CallExpression>) => {
                  const innerNode = innerPath.node;
                  const innerCallee = innerNode.callee;

                  if (
                    innerCallee.type === 'MemberExpression' &&
                    innerCallee.property.type === 'Identifier' &&
                    SQLITE_METHODS.includes((innerCallee.property as Identifier).name)
                  ) {
                    const method = (innerCallee.property as Identifier).name;
                    const innerArgs = innerNode.arguments;

                    if (innerArgs.length >= 1) {
                      let query: string | null = null;
                      let params: string | null = null;

                      const queryArg = innerArgs[0];
                      if (queryArg.type === 'StringLiteral') {
                        query = queryArg.value;
                      } else if (queryArg.type === 'TemplateLiteral') {
                        query = this.extractTemplateLiteral(queryArg);
                      }

                      if (innerArgs.length >= 2 && innerArgs[1].type === 'ArrayExpression') {
                        params = innerArgs[1].elements
                          .map(el => {
                            if (!el) return '?';
                            if (el.type === 'StringLiteral' || el.type === 'NumericLiteral') {
                              return String(el.value);
                            } else if (el.type === 'Identifier') {
                              return `$${(el as Identifier).name}`;
                            }
                            return '?';
                          })
                          .join(', ');
                      }

                      if (query) {
                        const operationType = this.detectOperationType(query);
                        const tableName = this.extractTableName(query, operationType);

                        const queryId = `${module.file}:DATABASE_QUERY:${method}:${getLine(innerNode)}`;

                        queries.push({
                          id: queryId,
                          type: 'db:query',
                          method: method.toUpperCase(),
                          query: query,
                          params: params,
                          operationType: operationType,
                          tableName: tableName,
                          file: module.file!,
                          line: getLine(innerNode),
                          promiseWrapped: true
                        });
                      }
                    }
                  }
                }
              });
            }
          }
        }
      });

      // Создаём DATABASE_QUERY ноды
      for (const query of queries) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { promiseWrapped, ...queryData } = query;

        await graph.addNode(queryData as unknown as NodeRecord);
        queriesCreated++;

        // MODULE -> CONTAINS -> DATABASE_QUERY
        await graph.addEdge({
          type: 'CONTAINS',
          src: module.id,
          dst: query.id
        });
        edgesCreated++;

        // Ищем FUNCTION ноду которая содержит этот query
        const containingFunctions: NodeRecord[] = [];
        for await (const n of graph.queryNodes({ type: 'FUNCTION' })) {
          if (
            n.file === module.file &&
            (n.line ?? 0) <= query.line &&
            query.line - (n.line ?? 0) < 100
          ) {
            containingFunctions.push(n);
          }
        }

        if (containingFunctions.length > 0) {
          // Берём ближайшую функцию
          const closestFunction = containingFunctions.reduce((prev, curr) =>
            query.line - (curr.line ?? 0) < query.line - (prev.line ?? 0) ? curr : prev
          );

          // FUNCTION -> EXECUTES_QUERY -> DATABASE_QUERY
          await graph.addEdge({
            type: 'EXECUTES_QUERY',
            src: closestFunction.id,
            dst: query.id
          });
          edgesCreated++;
        }
      }
    } catch (error) {
      // Silent - per-module errors shouldn't spam logs
    }

    return {
      queries: queriesCreated,
      operations: operationsCreated,
      edges: edgesCreated
    };
  }

  private getObjectName(node: Node): string | null {
    // Извлекаем имя объекта из call expression
    if (node.type === 'Identifier') {
      return (node as Identifier).name;
    } else if (node.type === 'MemberExpression') {
      // database.getDb() → 'database'
      return this.getObjectName((node as MemberExpression).object);
    }
    return null;
  }

  private extractTemplateLiteral(node: { quasis: Array<{ value: { raw: string } }>; expressions: unknown[] }): string {
    // Извлекаем SQL из template literal
    const parts: string[] = [];
    for (let i = 0; i < node.quasis.length; i++) {
      parts.push(node.quasis[i].value.raw);
      if (i < node.expressions.length) {
        parts.push('${...}');
      }
    }
    return parts.join('');
  }

  private detectOperationType(query: string): string {
    const upperQuery = query.toUpperCase().trim();
    if (upperQuery.startsWith('SELECT')) return 'SELECT';
    if (upperQuery.startsWith('INSERT')) return 'INSERT';
    if (upperQuery.startsWith('UPDATE')) return 'UPDATE';
    if (upperQuery.startsWith('DELETE')) return 'DELETE';
    if (upperQuery.startsWith('CREATE')) return 'CREATE';
    if (upperQuery.startsWith('DROP')) return 'DROP';
    if (upperQuery.startsWith('ALTER')) return 'ALTER';
    return 'UNKNOWN';
  }

  private extractTableName(query: string, operationType: string): string | null {
    const upperQuery = query.toUpperCase();

    try {
      if (operationType === 'SELECT') {
        // SELECT ... FROM table_name
        const match = upperQuery.match(/FROM\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
        return match ? match[1].toLowerCase() : null;
      } else if (operationType === 'INSERT') {
        // INSERT INTO table_name
        const match = upperQuery.match(/INSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
        return match ? match[1].toLowerCase() : null;
      } else if (operationType === 'UPDATE') {
        // UPDATE table_name
        const match = upperQuery.match(/UPDATE\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
        return match ? match[1].toLowerCase() : null;
      } else if (operationType === 'DELETE') {
        // DELETE FROM table_name
        const match = upperQuery.match(/DELETE\s+FROM\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
        return match ? match[1].toLowerCase() : null;
      } else if (operationType === 'CREATE') {
        // CREATE TABLE table_name
        const match = upperQuery.match(
          /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/
        );
        return match ? match[1].toLowerCase() : null;
      }
    } catch {
      return null;
    }

    return null;
  }
}
