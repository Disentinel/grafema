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
import type { ParserPlugin } from '@babel/parser';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { CallExpression, Identifier, MemberExpression, Node } from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord } from '@grafema/types';
import type { AnyBrandedNode } from '@grafema/types';
import { NodeFactory } from '../../core/NodeFactory.js';
import { getLine, getColumn } from './ast/utils/location.js';
import { resolveNodeFile } from '../../utils/resolveNodeFile.js';

const traverse = (traverseModule as any).default || traverseModule;

/**
 * Collected endpoint info (before creating branded nodes)
 */
interface EndpointInfo {
  method: string;
  path: string;
  file: string;
  line: number;
  column: number;
  routerName: string;
  handlerStart?: number;  // Byte offset for inline handlers
  handlerName?: string;   // Function name for named handler references
}

/**
 * Collected middleware info (before creating branded nodes)
 */
interface MiddlewareInfo {
  name: string;
  file: string;
  line: number;
  column: number;
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
      covers: ['express'],
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
      const { graph, onProgress } = context;
      const factory = this.getFactory(context);
      const projectPath = (context.manifest as { projectPath?: string })?.projectPath ?? '';

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
        const result = await this.analyzeModule(module, graph, projectPath, factory);
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
          onProgress?.({
            phase: 'analysis',
            currentPlugin: 'ExpressRouteAnalyzer',
            message: `Processing modules ${i + 1}/${modules.length}`,
            totalFiles: modules.length,
            processedFiles: i + 1,
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
    graph: PluginContext['graph'],
    projectPath: string,
    factory: PluginContext['factory'],
  ): Promise<AnalysisResult> {
    let endpointsCreated = 0;
    let middlewareCreated = 0;
    let edgesCreated = 0;

    try {
      // Читаем файл
      const code = readFileSync(resolveNodeFile(module.file!, projectPath), 'utf-8');

      // Парсим AST
      const ast = parse(code, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript'] as ParserPlugin[]
      });

      const endpoints: EndpointInfo[] = [];
      const middlewares: MiddlewareInfo[] = [];

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

                  // Determine handler identification for HANDLED_BY linking:
                  // - Inline functions (arrow/function expressions): use byte offset (start)
                  // - Named references (Identifier): use function name
                  let handlerStart: number | undefined;
                  let handlerName: string | undefined;
                  if (actualHandler.type === 'ArrowFunctionExpression' ||
                      actualHandler.type === 'FunctionExpression') {
                    handlerStart = (actualHandler as { start?: number }).start;
                  } else if (actualHandler.type === 'Identifier') {
                    handlerName = (actualHandler as Identifier).name;
                  }

                  endpoints.push({
                    method: method.toUpperCase(),
                    path: routePath,
                    file: module.file!,
                    line: getLine(node),
                    column: getColumn(node),
                    routerName: objectName,
                    handlerStart,
                    handlerName
                  });

                  // Compute endpoint ID (matches factory output) for middleware linking
                  const endpointId = `http:route#${method.toUpperCase()}:${routePath}#${module.file}#${getLine(node)}`;

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
                      middlewares.push({
                        name: middlewareName,
                        file: module.file!,
                        line: mwNode.loc ? getLine(mwNode) : getLine(node),
                        column: mwNode.loc ? getColumn(mwNode) : getColumn(node),
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
                    middlewares.push({
                      name: middlewareName,
                      file: module.file!,
                      line: getLine(node),
                      column: getColumn(node),
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

      // Collect all nodes and edges for batch operations
      const nodes: AnyBrandedNode[] = [];
      const edges: Array<{ type: string; src: string; dst: string }> = [];

      // Prepare ENDPOINT nodes
      for (const endpoint of endpoints) {
        // Store handler identification in metadata for ExpressHandlerLinker enricher
        const metadata: Record<string, unknown> = {};
        if (endpoint.handlerStart !== undefined) metadata.handlerStart = endpoint.handlerStart;
        if (endpoint.handlerName !== undefined) metadata.handlerName = endpoint.handlerName;

        const brandedNode = NodeFactory.createHttpRoute(
          endpoint.method,
          endpoint.path,
          endpoint.file,
          endpoint.line,
          {
            column: endpoint.column,
            routerName: endpoint.routerName,
            metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
          }
        );
        nodes.push(brandedNode);
        endpointsCreated++;

        // MODULE -> CONTAINS -> ENDPOINT
        edges.push({
          type: 'CONTAINS',
          src: module.id,
          dst: brandedNode.id
        });
        edgesCreated++;

        // NOTE: HANDLED_BY edges are created by ExpressHandlerLinker enricher
        // using handlerStart (byte offset) or handlerName stored in node metadata
      }

      // Prepare MIDDLEWARE nodes - track branded IDs for edge creation
      const middlewareNodeIds: string[] = [];
      for (const middleware of middlewares) {
        const brandedNode = NodeFactory.createExpressMiddleware(
          middleware.name,
          middleware.file,
          middleware.line,
          middleware.column,
          {
            mountPath: middleware.mountPath,
            isGlobal: middleware.isGlobal,
          }
        );
        nodes.push(brandedNode);
        middlewareNodeIds.push(brandedNode.id);
        middlewareCreated++;

        // MODULE -> CONTAINS -> MIDDLEWARE
        edges.push({
          type: 'CONTAINS',
          src: module.id,
          dst: brandedNode.id
        });
        edgesCreated++;

        // Если есть связанный endpoint
        if (middleware.endpointId) {
          // ENDPOINT -> USES_MIDDLEWARE -> MIDDLEWARE
          edges.push({
            type: 'USES_MIDDLEWARE',
            src: middleware.endpointId,
            dst: brandedNode.id
          });
          edgesCreated++;
        }
      }

      // Flush nodes first so they exist for edge queries
      await factory!.storeMany(nodes);

      // Query for HANDLED_BY edges (needs nodes to exist first)
      for (let i = 0; i < middlewares.length; i++) {
        const middleware = middlewares[i];
        const middlewareId = middlewareNodeIds[i];
        // Ищем FUNCTION ноду для middleware (если это именованная функция)
        if (!middleware.name.startsWith('inline:')) {
          for await (const fn of graph.queryNodes({
            type: 'FUNCTION',
            file: module.file,
            name: middleware.name
          })) {
            // MIDDLEWARE -> HANDLED_BY -> FUNCTION
            edges.push({
              type: 'HANDLED_BY',
              src: middlewareId,
              dst: fn.id
            });
            edgesCreated++;
            break; // Берём только первую найденную функцию
          }
        }
      }

      // Flush all edges
      await factory!.linkMany(edges);
    } catch {
      // Silent - per-module errors shouldn't spam logs
    }

    return {
      endpoints: endpointsCreated,
      middleware: middlewareCreated,
      edges: edgesCreated
    };
  }
}
