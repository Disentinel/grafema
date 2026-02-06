/**
 * SystemDbAnalyzer - специализированный плагин для анализа system_db API
 *
 * Понимает семантику system_db и добавляет ноды для сайд-эффектов:
 * - system_db.use(view, server) -> регистрирует VIEW через get_view()
 * - system_db.subscribe(servers) -> проверяет все зарегистрированные VIEW'ы
 * - local.use(view) -> регистрирует VIEW в get_hosts()
 *
 * Добавляет специальные ноды:
 * - SYSTEM_DB_VIEW_REGISTRATION - регистрация VIEW'а
 * - SYSTEM_DB_SUBSCRIPTION - подписка на сервер
 */

import { readFileSync } from 'fs';
import { parse, ParserPlugin } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { CallExpression, Identifier, MemberExpression, Node } from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord } from '@grafema/types';
import { brandNode } from '@grafema/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const traverse = (traverseModule as any).default || traverseModule;

/**
 * View registration info
 */
interface ViewRegistration {
  type: 'system_db.use' | 'local.use' | 'get_view';
  viewName: string;
  serverName: string;
  line: number;
  column: number;
}

/**
 * Subscription info
 */
interface Subscription {
  type: 'system_db.subscribe';
  servers: string[];
  line: number;
  column: number;
}

export class SystemDbAnalyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'SystemDbAnalyzer',
      phase: 'ANALYSIS',
      priority: 85, // Run after JSASTAnalyzer
      creates: {
        nodes: ['SYSTEM_DB_VIEW_REGISTRATION', 'SYSTEM_DB_SUBSCRIPTION'],
        edges: ['REGISTERS_VIEW', 'CHECKS_VIEWS']
      }
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const logger = this.log(context);

    try {
      const { graph } = context;

      let nodesCreated = 0;
      let edgesCreated = 0;

      // Get all MODULE nodes
      const modules = await this.getModules(graph);

      logger.info('Analyzing modules for system_db patterns', { count: modules.length });

      for (const module of modules) {
        if (!module.file) continue;

        try {
          const code = readFileSync(module.file, 'utf-8');
          const ast = parse(code, {
            sourceType: 'module',
            plugins: ['jsx', 'typescript'] as ParserPlugin[],
            errorRecovery: true
          });

          const registrations: ViewRegistration[] = [];
          const subscriptions: Subscription[] = [];

          traverse(ast, {
            CallExpression: (path: NodePath<CallExpression>) => {
              const { node } = path;

              // system_db.use(...)
              if (
                node.callee.type === 'MemberExpression' &&
                (node.callee.object as Identifier).name === 'system_db' &&
                (node.callee.property as Identifier).name === 'use'
              ) {
                const viewName = this.extractLiteral(node.arguments[0]);
                const serverName = this.extractLiteral(node.arguments[1]);

                if (viewName) {
                  registrations.push({
                    type: 'system_db.use',
                    viewName,
                    serverName: serverName || 'default',
                    line: node.loc?.start.line || 0,
                    column: node.loc?.start.column || 0
                  });
                }
              }

              // system_db.subscribe(...)
              if (
                node.callee.type === 'MemberExpression' &&
                (node.callee.object as Identifier).name === 'system_db' &&
                (node.callee.property as Identifier).name === 'subscribe'
              ) {
                const servers = this.extractServerList(node.arguments[0]);

                subscriptions.push({
                  type: 'system_db.subscribe',
                  servers,
                  line: node.loc?.start.line || 0,
                  column: node.loc?.start.column || 0
                });
              }

              // local.use('view_name') - косвенная регистрация через get_hosts()
              if (
                node.callee.type === 'MemberExpression' &&
                (node.callee.object as Identifier).name === 'local' &&
                (node.callee.property as Identifier).name === 'use'
              ) {
                const viewName = this.extractLiteral(node.arguments[0]);

                if (viewName) {
                  registrations.push({
                    type: 'local.use',
                    viewName,
                    serverName: 'inferred_from_hosts',
                    line: node.loc?.start.line || 0,
                    column: node.loc?.start.column || 0
                  });
                }
              }

              // get_view(name, server) - внутренний API
              if (
                node.callee.type === 'Identifier' &&
                (node.callee as Identifier).name === 'get_view'
              ) {
                const viewName = this.extractLiteral(node.arguments[0]);
                const serverName = this.extractLiteral(node.arguments[1]);

                if (viewName) {
                  registrations.push({
                    type: 'get_view',
                    viewName,
                    serverName: serverName || 'default',
                    line: node.loc?.start.line || 0,
                    column: node.loc?.start.column || 0
                  });
                }
              }
            }
          });

          // Create SYSTEM_DB_VIEW_REGISTRATION nodes
          for (const reg of registrations) {
            const nodeId = `${module.file}:SYSTEM_DB_VIEW_REGISTRATION:${reg.viewName}:${reg.line}`;

            logger.debug('Found registration', {
              type: reg.type,
              viewName: reg.viewName,
              serverName: reg.serverName,
              file: module.file!.split('/').pop(),
              line: reg.line
            });

            await graph.addNode(brandNode({
              id: nodeId,
              type: 'SYSTEM_DB_VIEW_REGISTRATION' as const,
              name: `${reg.type}('${reg.viewName}', '${reg.serverName}')`,
              file: module.file,
              line: reg.line,
              column: reg.column,
              viewName: reg.viewName,
              serverName: reg.serverName,
              callType: reg.type
            }));
            nodesCreated++;

            // Link MODULE -> REGISTERS_VIEW -> REGISTRATION
            await graph.addEdge({
              type: 'REGISTERS_VIEW',
              src: module.id,
              dst: nodeId
            });
            edgesCreated++;
          }

          // Create SYSTEM_DB_SUBSCRIPTION nodes
          for (const sub of subscriptions) {
            const nodeId = `${module.file}:SYSTEM_DB_SUBSCRIPTION:${sub.line}`;

            await graph.addNode(brandNode({
              id: nodeId,
              type: 'SYSTEM_DB_SUBSCRIPTION' as const,
              name: `subscribe([${sub.servers.join(', ')}])`,
              file: module.file,
              line: sub.line,
              column: sub.column,
              servers: sub.servers
            }));
            nodesCreated++;

            // Link MODULE -> CHECKS_VIEWS -> SUBSCRIPTION
            await graph.addEdge({
              type: 'CHECKS_VIEWS',
              src: module.id,
              dst: nodeId
            });
            edgesCreated++;
          }
        } catch (err) {
          // Skip files that can't be parsed
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.warn('Failed to analyze module', {
              file: module.file,
              error: (err as Error).message
            });
          }
        }
      }

      logger.info('Analysis complete', { nodesCreated, edgesCreated });

      return createSuccessResult(
        { nodes: nodesCreated, edges: edgesCreated },
        { modulesAnalyzed: modules.length }
      );
    } catch (error) {
      logger.error('Analysis failed', { error });
      return createErrorResult(error as Error);
    }
  }

  /**
   * Extract literal value from AST node
   */
  private extractLiteral(node: Node | undefined): string | null {
    if (!node) return null;

    if (node.type === 'StringLiteral') {
      return (node as { value: string }).value;
    }

    if (node.type === 'TemplateLiteral') {
      const tl = node as { quasis: Array<{ value: { cooked: string | null } }> };
      if (tl.quasis.length === 1) {
        return tl.quasis[0].value.cooked;
      }
    }

    return null;
  }

  /**
   * Extract server list from subscribe() argument
   */
  private extractServerList(node: Node | undefined): string[] {
    if (!node) return ['default'];

    // String literal: subscribe('lum-unblocker')
    if (node.type === 'StringLiteral') {
      return [(node as { value: string }).value];
    }

    // Array: subscribe(['lum', 'lum-views'])
    if (node.type === 'ArrayExpression') {
      const arr = node as { elements: Array<Node | null> };
      return arr.elements
        .map(el => (el ? this.extractLiteral(el) : null))
        .filter((s): s is string => s !== null);
    }

    return ['unknown'];
  }
}
