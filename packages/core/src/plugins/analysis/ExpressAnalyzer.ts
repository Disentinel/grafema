/**
 * ExpressAnalyzer - анализ Express.js patterns
 * Детектирует HTTP routes и mount points через AST парсинг
 */

import { readFileSync } from 'fs';
import { parse, ParserPlugin } from '@babel/parser';
import traverseModule from '@babel/traverse';
import { dirname, resolve, relative } from 'path';
import type { CallExpression, ImportDeclaration, StringLiteral, TemplateLiteral, Identifier, MemberExpression } from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord } from '@grafema/types';
import { NetworkRequestNode } from '../../core/nodes/NetworkRequestNode.js';

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
  localPath: string;
  file: string;
  line: number;
  mountedOn: string;
}

/**
 * Mount point node
 */
interface MountPointNode {
  id: string;
  type: 'express:mount';
  prefix: string;
  targetFunction: string | null;
  targetVariable: string | null;
  file: string;
  line: number;
  mountedOn: string;
}

/**
 * Import info
 */
interface ImportInfo {
  source: string;
  specifiers: Array<{ local: string; imported: string }>;
  line: number;
}

/**
 * Analysis result
 */
interface AnalysisResult {
  endpoints: number;
  mountPoints: number;
  edges: number;
}

export class ExpressAnalyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'ExpressAnalyzer',
      phase: 'ANALYSIS',
      priority: 75, // После JSASTAnalyzer (80)
      creates: {
        nodes: ['http:route', 'express:mount'],
        edges: ['EXPOSES', 'MOUNTS', 'DEFINES']
      },
      dependencies: ['JSASTAnalyzer'] // Требует MODULE ноды
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const logger = this.log(context);

    try {
      const { graph } = context;

      // Create net:request singleton (GraphBackend handles deduplication)
      const networkNode = NetworkRequestNode.create();
      await graph.addNode(networkNode);

      // Получаем все MODULE ноды
      const modules = await this.getModules(graph);

      let endpointsCreated = 0;
      let mountPointsCreated = 0;
      let edgesCreated = 0;

      // Анализируем каждый модуль
      for (const module of modules) {
        const result = await this.analyzeModule(module, graph, networkNode.id);
        endpointsCreated += result.endpoints;
        mountPointsCreated += result.mountPoints;
        edgesCreated += result.edges;
      }

      logger.info('Analysis complete', { endpointsCreated, mountPointsCreated });

      return createSuccessResult(
        {
          nodes: endpointsCreated + mountPointsCreated + 1, // +1 для EXTERNAL_NETWORK
          edges: edgesCreated
        },
        {
          endpointsCreated,
          mountPointsCreated
        }
      );
    } catch (error) {
      logger.error('Analysis failed', { error });
      return createErrorResult(error as Error);
    }
  }

  /**
   * Анализировать один модуль на Express patterns
   */
  private async analyzeModule(
    module: NodeRecord,
    graph: PluginContext['graph'],
    networkId: string
  ): Promise<AnalysisResult> {
    let endpointsCreated = 0;
    let mountPointsCreated = 0;
    let edgesCreated = 0;

    try {
      // Читаем и парсим файл
      const code = readFileSync(module.file!, 'utf-8');
      const ast = parse(code, {
        sourceType: 'module',
        plugins: ['jsx'] as ParserPlugin[]
      });

      const endpoints: EndpointNode[] = [];
      const mountPoints: MountPointNode[] = [];
      const imports: ImportInfo[] = [];

      // Собираем импорты для резолвинга mount points
      traverse(ast, {
        ImportDeclaration: (path: NodePath<ImportDeclaration>) => {
          const importNode = path.node;
          const source = importNode.source.value;

          // Собираем specifiers
          const specifiers = importNode.specifiers
            .map(spec => {
              if (spec.type === 'ImportDefaultSpecifier') {
                return { local: spec.local.name, imported: 'default' };
              } else if (spec.type === 'ImportSpecifier') {
                const imported =
                  spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value;
                return { local: spec.local.name, imported };
              }
              return null;
            })
            .filter((s): s is { local: string; imported: string } => s !== null);

          imports.push({
            source,
            specifiers,
            line: importNode.loc!.start.line
          });
        }
      });

      // Ищем Express patterns
      traverse(ast, {
        CallExpression: (path: NodePath<CallExpression>) => {
          const node = path.node;

          // Проверяем что это MemberExpression: app.get(), router.use(), и т.д.
          if (node.callee.type === 'MemberExpression') {
            const methodName = (node.callee.property as Identifier).name;
            const objectName = (node.callee.object as Identifier).name;

            // Детектируем routes
            const httpMethods = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'];
            const isRouteDefinition =
              httpMethods.includes(methodName?.toLowerCase()) &&
              (objectName === 'app' || objectName === 'router') &&
              node.arguments.length >= 2;

            if (isRouteDefinition) {
              const pathArg = node.arguments[0];
              let routePath: string | null = null;

              if (pathArg.type === 'StringLiteral') {
                routePath = pathArg.value;
              } else if (pathArg.type === 'TemplateLiteral' && pathArg.quasis.length === 1) {
                routePath = pathArg.quasis[0].value.raw;
              }

              if (routePath) {
                const method = methodName.toUpperCase();
                endpoints.push({
                  id: `http:route#${method}:${routePath}#${module.file}#${node.loc!.start.line}`,
                  type: 'http:route',
                  method: method,
                  path: routePath,
                  localPath: routePath,
                  file: module.file!,
                  line: node.loc!.start.line,
                  mountedOn: objectName
                });
              }
            }

            // Детектируем mount points
            const isMountPoint =
              methodName === 'use' &&
              (objectName === 'app' || objectName === 'router') &&
              node.arguments.length >= 1;

            if (isMountPoint) {
              let prefix: string | null = null;
              let targetFunction: string | null = null;
              let targetVariable: string | null = null;
              let targetArg = null;

              // Определяем структуру аргументов
              if (node.arguments.length === 1) {
                // app.use(middleware) - без префикса
                targetArg = node.arguments[0];
                prefix = '/';
              } else if (node.arguments.length >= 2) {
                // app.use('/prefix', router) - с префиксом
                const firstArg = node.arguments[0];
                targetArg = node.arguments[1];

                // Извлекаем префикс
                if (firstArg.type === 'StringLiteral') {
                  prefix = firstArg.value;
                } else if (firstArg.type === 'TemplateLiteral') {
                  if (firstArg.quasis.length === 1 && firstArg.expressions.length === 0) {
                    prefix = firstArg.quasis[0].value.raw;
                  } else {
                    prefix = '${template}';
                  }
                } else if (firstArg.type === 'BinaryExpression') {
                  prefix = '${binary}';
                } else if (firstArg.type === 'Identifier') {
                  prefix = '${variable}';
                } else if (firstArg.type === 'CallExpression') {
                  prefix = '${call}';
                } else if (firstArg.type === 'MemberExpression') {
                  prefix = '${member}';
                } else if (firstArg.type === 'ConditionalExpression') {
                  prefix = '${conditional}';
                } else {
                  prefix = '${expression}';
                }
              }

              // Извлекаем target
              if (targetArg) {
                if (targetArg.type === 'CallExpression') {
                  if ((targetArg.callee as Identifier).type === 'Identifier') {
                    targetFunction = (targetArg.callee as Identifier).name;
                  } else if (
                    (targetArg.callee as MemberExpression).type === 'MemberExpression' &&
                    ((targetArg.callee as MemberExpression).object as Identifier).type === 'Identifier'
                  ) {
                    targetVariable = ((targetArg.callee as MemberExpression).object as Identifier).name;
                  }
                } else if (targetArg.type === 'Identifier') {
                  targetVariable = (targetArg as Identifier).name;
                }
              }

              // Создаём mount point
              if ((targetFunction || targetVariable) && prefix) {
                mountPoints.push({
                  id: `express:mount#${prefix}#${module.file}#${node.loc!.start.line}`,
                  type: 'express:mount',
                  prefix: prefix,
                  targetFunction: targetFunction,
                  targetVariable: targetVariable,
                  file: module.file!,
                  line: node.loc!.start.line,
                  mountedOn: objectName
                });
              }
            }
          }
        }
      });

      // Создаём ENDPOINT ноды
      for (const endpoint of endpoints) {
        await graph.addNode(endpoint as unknown as NodeRecord);
        endpointsCreated++;

        // MODULE --EXPOSES--> ENDPOINT
        await graph.addEdge({
          type: 'EXPOSES',
          src: module.id,
          dst: endpoint.id
        });
        edgesCreated++;

        // ENDPOINT --INTERACTS_WITH--> EXTERNAL_NETWORK
        await graph.addEdge({
          type: 'INTERACTS_WITH',
          src: endpoint.id,
          dst: networkId
        });
        edgesCreated++;
      }

      // Создаём MOUNT_POINT ноды
      for (const mountPoint of mountPoints) {
        await graph.addNode(mountPoint as unknown as NodeRecord);
        mountPointsCreated++;

        // MODULE --DEFINES--> MOUNT_POINT
        await graph.addEdge({
          type: 'DEFINES',
          src: module.id,
          dst: mountPoint.id
        });
        edgesCreated++;

        // Создаём MOUNTS рёбра
        const mountEdges = await this.createMountEdges(mountPoint, module, imports, graph);
        edgesCreated += mountEdges;
      }
    } catch (error) {
      // Silent - per-module errors shouldn't spam logs
    }

    return {
      endpoints: endpointsCreated,
      mountPoints: mountPointsCreated,
      edges: edgesCreated
    };
  }

  /**
   * Создать MOUNTS рёбра для mount point
   */
  private async createMountEdges(
    mountPoint: MountPointNode,
    module: NodeRecord,
    imports: ImportInfo[],
    graph: PluginContext['graph']
  ): Promise<number> {
    let edgesCreated = 0;

    // Резолвим через импорты: какой модуль экспортирует targetFunction или targetVariable?
    let targetModulePath: string | null = null;
    const targetName = mountPoint.targetFunction || mountPoint.targetVariable;

    if (targetName) {
      for (const imp of imports) {
        const isRelative = imp.source.startsWith('./') || imp.source.startsWith('../');
        if (!isRelative) continue;

        // Проверяем есть ли targetName среди specifiers
        const hasTarget =
          imp.specifiers &&
          imp.specifiers.some(spec => spec.local === targetName || spec.imported === targetName);

        if (hasTarget) {
          // Резолвим путь к модулю
          const currentDir = dirname(module.file!);
          targetModulePath = resolve(currentDir, imp.source);
          break;
        }
      }
    }

    // Если нашли целевой модуль, создаем MOUNTS ребро
    if (targetModulePath) {
      // Derive project root from module's absolute and relative paths
      // module.file is absolute path, module.name is relative path
      const moduleAbsPath = module.file!;
      const moduleRelPath = module.name!;
      // projectRoot = absolute path minus relative path suffix
      const projectRoot = moduleAbsPath.endsWith(moduleRelPath)
        ? moduleAbsPath.slice(0, moduleAbsPath.length - moduleRelPath.length)
        : dirname(moduleAbsPath); // fallback

      // Convert target absolute path to relative path for semantic ID
      const targetRelativePath = relative(projectRoot, targetModulePath);
      const targetModuleId = `${targetRelativePath}->global->MODULE->module`;

      // Проверяем что модуль существует в графе
      const targetModule = await graph.getNode(targetModuleId);
      if (targetModule) {
        await graph.addEdge({
          type: 'MOUNTS',
          src: mountPoint.id,
          dst: targetModuleId
        });
        edgesCreated++;
      }
    }

    return edgesCreated;
  }
}
