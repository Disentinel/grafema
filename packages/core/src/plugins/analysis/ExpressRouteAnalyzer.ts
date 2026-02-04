/**
 * ExpressRouteAnalyzer - детектит Express/Router endpoints с middleware chains
 *
 * Паттерны:
 * - router.get('/path', handler)
 * - router.post('/path', middleware1, middleware2, handler)
 * - app.use('/prefix', middleware)
 * - router.get('/path', asyncHandler(async (req, res) => {...}))
 */

import { readFileSync } from 'fs';
import { parse, ParserPlugin } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { CallExpression, Identifier, MemberExpression, Node } from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord } from '@grafema/types';
import { getLine, getColumn } from './ast/utils/location.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const traverse = (traverseModule as any).default || traverseModule;

/**
 * Endpoint node
 */
interface EndpointNode {
  id: string;
  type: 'http:route';
  method: string;
  path: string;
  file: string;
  line: number;
  routerName: string;
  handlerLine: number;
  handlerColumn: number;
}

/**
 * Middleware node
 */
interface MiddlewareNode {
  id: string;
  type: 'express:middleware';
  name: string;
  file: string;
  line: number;
  endpointId?: string;
  order?: number;
  mountPath?: string;
  isGlobal?: boolean;
}

/**
 * Analysis result
 */
interface AnalysisResult {
  endpoints: number;
  middleware: number;
  edges: number;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

export class ExpressRouteAnalyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'ExpressRouteAnalyzer',
      phase: 'ANALYSIS',
      priority: 75, // После JSASTAnalyzer (80) - меньший приоритет = позже
      creates: {
        nodes: ['http:route', 'express:middleware'],
        edges: ['CONTAINS', 'USES_MIDDLEWARE', 'HANDLED_BY']
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
      logger.info('Processing modules', { count: modules.length });

      let endpointsCreated = 0;
      let middlewareCreated = 0;
      let edgesCreated = 0;
      const startTime = Date.now();

      // Анализируем каждый модуль
      for (let i = 0; i < modules.length; i++) {
        const module = modules[i];
        const result = await this.analyzeModule(module, graph);
        endpointsCreated += result.endpoints;
        middlewareCreated += result.middleware;
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

      logger.info('Analysis complete', { endpointsCreated, middlewareCreated });

      return createSuccessResult(
        {
          nodes: endpointsCreated + middlewareCreated,
          edges: edgesCreated
        },
        { modulesAnalyzed: modules.length }
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
    let endpointsCreated = 0;
    let middlewareCreated = 0;
    let edgesCreated = 0;

    try {
      // Читаем файл
      const code = readFileSync(module.file!, 'utf-8');

      // Парсим AST
      const ast = parse(code, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript'] as ParserPlugin[]
      });

      const endpoints: EndpointNode[] = [];
      const middlewares: MiddlewareNode[] = [];

      // Находим все переменные созданные от express() или express.Router()
      const expressVars = new Set(['app', 'router']);

      traverse(ast, {
        VariableDeclarator: (path: NodePath) => {
          const node = path.node as { id: Identifier; init: Node | null };
          const { id, init } = node;
          if (!init || id.type !== 'Identifier') return;

          // const app = express()
          if (init.type === 'CallExpression') {
            const callExpr = init as CallExpression;
            if (callExpr.callee.type === 'Identifier' && (callExpr.callee as Identifier).name === 'express') {
              expressVars.add(id.name);
            }
            // const router = express.Router()
            else if (
              callExpr.callee.type === 'MemberExpression' &&
              (callExpr.callee.object as Identifier).type === 'Identifier' &&
              (callExpr.callee.object as Identifier).name === 'express' &&
              ((callExpr.callee as MemberExpression).property as Identifier).name === 'Router'
            ) {
              expressVars.add(id.name);
            }
            // const router = Router() (если Router импортирован из express)
            else if (callExpr.callee.type === 'Identifier' && (callExpr.callee as Identifier).name === 'Router') {
              expressVars.add(id.name);
            }
          }
        },

        CallExpression: (path: NodePath<CallExpression>) => {
          const node = path.node;
          const callee = node.callee;

          // Паттерн: expressVar.METHOD() где expressVar - известная переменная
          if (
            callee.type === 'MemberExpression' &&
            (callee.object as Identifier).type === 'Identifier' &&
            expressVars.has((callee.object as Identifier).name) &&
            (callee.property as Identifier).type === 'Identifier'
          ) {
            const method = (callee.property as Identifier).name;
            const objectName = (callee.object as Identifier).name;

            // router.get('/path', handler) или router.post('/path', middleware, handler)
            if (HTTP_METHODS.includes(method)) {
              const args = node.arguments;

              if (args.length >= 2) {
                const pathArg = args[0];
                let routePath: string | null = null;

                // Извлекаем path
                if (pathArg.type === 'StringLiteral') {
                  routePath = (pathArg as { value: string }).value;
                } else if (pathArg.type === 'TemplateLiteral') {
                  // Template literal path: `/${prefix}/users`
                  const tl = pathArg as { quasis: Array<{ value: { raw: string } }> };
                  routePath = tl.quasis.map(q => q.value.raw).join('${...}');
                }

                if (routePath) {
                  // Все аргументы кроме первого - это handlers/middleware
                  const handlers = args.slice(1);

                  // Последний handler - это route handler
                  const mainHandler = handlers[handlers.length - 1];

                  // Unwrap wrapper functions (asyncHandler, catchAsync, etc.)
                  // Pattern: wrapper(async (req, res) => {...}) -> extract inner function
                  // Also handles nested wrappers: outer(inner(handler))
                  let actualHandler = mainHandler as Node;
                  while (actualHandler.type === 'CallExpression') {
                    const callExpr = actualHandler as CallExpression;
                    const firstArg = callExpr.arguments[0] as Node | undefined;
                    if (!firstArg) {
                      // No arguments - not a wrapper pattern
                      break;
                    }
                    if (
                      firstArg.type === 'ArrowFunctionExpression' ||
                      firstArg.type === 'FunctionExpression'
                    ) {
                      // Found the actual handler function
                      actualHandler = firstArg;
                      break;
                    } else if (firstArg.type === 'CallExpression') {
                      // Nested wrapper: outer(inner(...)) - continue unwrapping
                      actualHandler = firstArg;
                    } else {
                      // First arg is not a function or CallExpression - not a wrapper pattern
                      break;
                    }
                  }

                  // Все предыдущие - middleware
                  const middlewareHandlers = handlers.slice(0, -1);

                  // Создаём http:route
                  const endpointId = `http:route#${method.toUpperCase()}:${routePath}#${module.file}#${getLine(node)}`;

                  endpoints.push({
                    id: endpointId,
                    type: 'http:route',
                    method: method.toUpperCase(),
                    path: routePath,
                    file: module.file!,
                    line: getLine(node),
                    routerName: objectName,
                    handlerLine: actualHandler.loc
                      ? getLine(actualHandler)
                      : getLine(node),
                    handlerColumn: actualHandler.loc
                      ? getColumn(actualHandler)
                      : getColumn(node)
                  });

                  // Обрабатываем middleware
                  middlewareHandlers.forEach((mw, index) => {
                    let middlewareName: string | null = null;
                    const mwNode = mw as Node;

                    // Извлекаем имя middleware
                    if (mwNode.type === 'Identifier') {
                      middlewareName = (mwNode as Identifier).name;
                    } else if (
                      mwNode.type === 'CallExpression' &&
                      (mwNode as CallExpression).callee.type === 'Identifier'
                    ) {
                      // asyncHandler(fn) или validation(rules)
                      middlewareName = ((mwNode as CallExpression).callee as Identifier).name;
                    } else if (
                      mwNode.type === 'ArrowFunctionExpression' ||
                      mwNode.type === 'FunctionExpression'
                    ) {
                      middlewareName = `inline:${getLine(mwNode)}`;
                    }

                    if (middlewareName) {
                      const middlewareId = `express:middleware#${middlewareName}#${module.file}#${getLine(mwNode)}`;

                      middlewares.push({
                        id: middlewareId,
                        type: 'express:middleware',
                        name: middlewareName,
                        file: module.file!,
                        line: mwNode.loc ? getLine(mwNode) : getLine(node),
                        endpointId: endpointId,
                        order: index // Порядок в цепочке
                      });
                    }
                  });
                }
              }
            }
            // app.use() или router.use() - middleware mounting
            else if (method === 'use') {
              const args = node.arguments;

              if (args.length >= 1) {
                // Может быть app.use(middleware) или app.use('/path', middleware)
                let mountPath = '/'; // Default
                let middlewareArg = args[0] as Node;

                // Если первый аргумент - строка, это mount path
                if ((args[0] as Node).type === 'StringLiteral') {
                  mountPath = (args[0] as { value: string }).value;
                  middlewareArg = args[1] as Node;
                }

                if (middlewareArg) {
                  let middlewareName: string | null = null;

                  if (middlewareArg.type === 'Identifier') {
                    middlewareName = (middlewareArg as Identifier).name;
                  } else if (
                    middlewareArg.type === 'CallExpression' &&
                    (middlewareArg as CallExpression).callee.type === 'Identifier'
                  ) {
                    middlewareName = ((middlewareArg as CallExpression).callee as Identifier).name;
                  }

                  if (middlewareName) {
                    const middlewareId = `express:middleware#${middlewareName}#${module.file}#${getLine(node)}`;

                    middlewares.push({
                      id: middlewareId,
                      type: 'express:middleware',
                      name: middlewareName,
                      file: module.file!,
                      line: getLine(node),
                      mountPath: mountPath,
                      isGlobal: mountPath === '/' // Global middleware если нет path
                    });
                  }
                }
              }
            }
          }
        }
      });

      // Создаём ENDPOINT ноды
      for (const endpoint of endpoints) {
        // Сохраняем handler location ПЕРЕД destructuring
        const handlerLine = endpoint.handlerLine;
        const handlerColumn = endpoint.handlerColumn;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { handlerLine: _hl, handlerColumn: _hc, routerName, ...endpointData } = endpoint;

        await graph.addNode(endpointData as unknown as NodeRecord);
        endpointsCreated++;

        // MODULE -> CONTAINS -> ENDPOINT
        await graph.addEdge({
          type: 'CONTAINS',
          src: module.id,
          dst: endpoint.id
        });
        edgesCreated++;

        // Ищем FUNCTION ноду для handler по line+column
        // NOTE: queryNodes не поддерживает line/column фильтрацию, поэтому фильтруем вручную
        if (handlerLine) {
          for await (const fn of graph.queryNodes({
            type: 'FUNCTION',
            file: module.file
          })) {
            // Проверяем точное совпадение line и column
            if (fn.line === handlerLine && fn.column === handlerColumn) {
              // ENDPOINT -> HANDLED_BY -> FUNCTION
              await graph.addEdge({
                type: 'HANDLED_BY',
                src: endpoint.id,
                dst: fn.id
              });
              edgesCreated++;
              break;
            }
          }
        }
      }

      // Создаём MIDDLEWARE ноды и связи
      for (const middleware of middlewares) {
        const { endpointId, order, ...middlewareData } = middleware;

        await graph.addNode(middlewareData as unknown as NodeRecord);
        middlewareCreated++;

        // MODULE -> CONTAINS -> MIDDLEWARE
        await graph.addEdge({
          type: 'CONTAINS',
          src: module.id,
          dst: middleware.id
        });
        edgesCreated++;

        // Если есть связанный endpoint
        if (endpointId) {
          // ENDPOINT -> USES_MIDDLEWARE -> MIDDLEWARE
          await graph.addEdge({
            type: 'USES_MIDDLEWARE',
            src: endpointId,
            dst: middleware.id
          });
          edgesCreated++;
        }

        // Ищем FUNCTION ноду для middleware (если это именованная функция)
        if (!middleware.name.startsWith('inline:')) {
          for await (const fn of graph.queryNodes({
            type: 'FUNCTION',
            file: module.file,
            name: middleware.name
          })) {
            // MIDDLEWARE -> HANDLED_BY -> FUNCTION
            await graph.addEdge({
              type: 'HANDLED_BY',
              src: middleware.id,
              dst: fn.id
            });
            edgesCreated++;
            break; // Берём только первую найденную функцию
          }
        }
      }
    } catch (error) {
      // Silent - per-module errors shouldn't spam logs
    }

    return {
      endpoints: endpointsCreated,
      middleware: middlewareCreated,
      edges: edgesCreated
    };
  }
}
