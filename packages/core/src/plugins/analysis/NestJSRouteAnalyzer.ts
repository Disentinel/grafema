/**
 * NestJSRouteAnalyzer - detects HTTP routes from NestJS decorators
 *
 * Graph-based: queries DECORATOR nodes created by JSASTAnalyzer.
 * No file I/O or AST parsing - pure graph queries.
 *
 * Algorithm:
 * 1. Single query: collect ALL DECORATOR nodes
 * 2. Partition: separate Controller decorators from HTTP method decorators
 * 3. For each Controller: find its class children, match HTTP method decorators
 * 4. Create http:route nodes
 *
 * Complexity: O(d) where d = total DECORATOR count (single pass),
 * then O(c * m) for matching where c = controllers, m = methods per class.
 *
 * Patterns:
 * - @Controller('path') class UserController { @Get() findAll() {} }
 * - @Controller(['a', 'b']) - array base paths
 * - @Controller({ path: 'users' }) - object form
 * - @Get(), @Post(), @Put(), @Patch(), @Delete(), @Options(), @Head()
 */

import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeFilter } from '@grafema/types';
import { NodeFactory } from '../../core/NodeFactory.js';

const HTTP_DECORATOR_METHODS: Record<string, string> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Options: 'OPTIONS',
  Head: 'HEAD',
};

const RELEVANT_DECORATORS = new Set([
  'Controller',
  ...Object.keys(HTTP_DECORATOR_METHODS),
]);

/**
 * Extract path(s) from decorator arguments.
 *
 * @Controller('users')           → ['/users']
 * @Controller(['a', 'b'])        → ['/a', '/b']
 * @Controller({ path: 'users' }) → ['/users']
 * @Controller()                  → ['/']
 */
function parseDecoratorPaths(args: unknown[], defaultPath: string = '/'): string[] {
  if (!args || args.length === 0) return [defaultPath];

  const first = args[0];

  if (typeof first === 'string') {
    return [normalizePath(first)];
  }

  if (Array.isArray(first)) {
    const paths = first.filter(v => typeof v === 'string').map(normalizePath);
    return paths.length > 0 ? paths : [defaultPath];
  }

  if (typeof first === 'object' && first !== null) {
    const obj = first as Record<string, unknown>;
    const path = obj.path;
    if (typeof path === 'string') return [normalizePath(path)];
    if (Array.isArray(path)) {
      const paths = path.filter(v => typeof v === 'string').map(normalizePath);
      return paths.length > 0 ? paths : [defaultPath];
    }
    return [defaultPath];
  }

  return [defaultPath];
}

function normalizePath(p: string): string {
  const cleaned = p.replace(/^\/+|\/+$/g, '');
  return cleaned ? `/${cleaned}` : '/';
}

function joinRoutePath(base: string, sub: string): string {
  if (base === '/' && !sub) return '/';
  if (base === '/' && sub) return sub.startsWith('/') ? sub : `/${sub}`;
  if (!sub) return base;
  const subNorm = sub.startsWith('/') ? sub : `/${sub}`;
  return `${base}${subNorm}`;
}

interface ControllerInfo {
  file: string;
  line: number;
  basePaths: string[];
  targetId: string;
}

interface HttpMethodInfo {
  httpMethod: string;
  line: number;
  methodPaths: string[];
  targetId: string;
}

export class NestJSRouteAnalyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'NestJSRouteAnalyzer',
      phase: 'ANALYSIS',
      creates: {
        nodes: ['http:route'],
        edges: ['CONTAINS']
      },
      dependencies: ['JSASTAnalyzer']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const logger = this.log(context);

    try {
      const { graph } = context;
      // Single pass: collect all DECORATOR nodes, partition by relevance
      const controllers: ControllerInfo[] = [];
      const httpMethods: HttpMethodInfo[] = [];

      const filter: NodeFilter = { type: 'DECORATOR' };
      for await (const node of graph.queryNodes(filter)) {
        const name = node.name;
        if (!name || !RELEVANT_DECORATORS.has(name)) continue;

        const args = node.arguments as unknown[] || [];

        if (name === 'Controller') {
          controllers.push({
            file: node.file!,
            line: node.line!,
            basePaths: parseDecoratorPaths(args),
            targetId: node.targetId as string,
          });
        } else {
          httpMethods.push({
            httpMethod: HTTP_DECORATOR_METHODS[name],
            line: node.line!,
            methodPaths: parseDecoratorPaths(args, ''),
            targetId: node.targetId as string,
          });
        }
      }

      logger.info('Decorator scan complete', {
        controllers: controllers.length,
        httpMethods: httpMethods.length,
      });

      if (controllers.length === 0) {
        return createSuccessResult({ nodes: 0, edges: 0 });
      }

      // Build module lookup cache: file → moduleId
      const moduleCache = new Map<string, string>();
      const modules = await this.getModules(graph);
      for (const mod of modules) {
        if (mod.file) moduleCache.set(mod.file, mod.id);
      }

      let nodesCreated = 0;
      let edgesCreated = 0;

      for (const controller of controllers) {
        // Get class node to find its children
        const classNode = await graph.getNode(controller.targetId);
        if (!classNode) {
          logger.debug('Controller target class not found', { targetId: controller.targetId });
          continue;
        }

        // Get class children (methods) via CONTAINS edges
        const classChildren = await graph.getOutgoingEdges(classNode.id, ['CONTAINS']);
        const childIds = new Set(classChildren.map(e => e.dst));

        // Match HTTP method decorators targeting children of this class
        const matching = httpMethods.filter(md => childIds.has(md.targetId));

        const moduleId = moduleCache.get(controller.file);
        const className = classNode.name || 'UnknownController';

        for (const method of matching) {
          const methodNode = await graph.getNode(method.targetId);
          const methodName = methodNode?.name || 'unknown';

          for (const basePath of controller.basePaths) {
            for (const methodPath of method.methodPaths) {
              const fullPath = joinRoutePath(basePath, methodPath);
              const routeNode = NodeFactory.createHttpRoute(
                method.httpMethod,
                fullPath,
                controller.file,
                method.line,
                {
                  name: `${method.httpMethod} ${fullPath}`,
                  framework: 'nestjs',
                  handlerName: `${className}.${methodName}`,
                }
              );
              await graph.addNode(routeNode);
              nodesCreated++;

              if (moduleId) {
                await graph.addEdge({
                  type: 'CONTAINS',
                  src: moduleId,
                  dst: routeNode.id,
                });
                edgesCreated++;
              }
            }
          }
        }
      }

      logger.info('NestJS route analysis complete', {
        controllers: controllers.length,
        httpMethods: httpMethods.length,
        routesCreated: nodesCreated,
      });

      return createSuccessResult(
        { nodes: nodesCreated, edges: edgesCreated },
        {
          controllers: controllers.length,
          httpMethods: httpMethods.length,
        }
      );
    } catch (error) {
      logger.error('NestJS route analysis failed', { error });
      return createErrorResult(error as Error);
    }
  }
}
