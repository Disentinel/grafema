/**
 * ServiceLayerAnalyzer - детектит Service Layer Pattern
 *
 * Паттерны:
 * - class XxxService { ... } - Service classes
 * - new XxxService() - Service instantiation
 * - app.set('service', instance) - DI registration
 * - req.app.get('service') - Service usage
 * - export class XxxService - Service exports
 */

import { readFileSync } from 'fs';
import type { ParserPlugin } from '@babel/parser';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type {
  CallExpression,
  ClassDeclaration,
  NewExpression,
  Identifier,
  MemberExpression,
  Node
} from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord, AnyBrandedNode } from '@grafema/types';
import { getLine } from './ast/utils/location.js';
import { resolveNodeFile } from '../../utils/resolveNodeFile.js';
import { NodeFactory } from '../../core/NodeFactory.js';

const traverse = (traverseModule as any).default || traverseModule;

/**
 * Service class node
 */
interface ServiceClassNode {
  id: string;
  type: 'SERVICE_CLASS';
  name: string;
  methods: string[];
  file: string;
  line: number;
}

/**
 * Service instance node
 */
interface ServiceInstanceNode {
  id: string;
  type: 'SERVICE_INSTANCE';
  serviceClass: string;
  file: string;
  line: number;
}

/**
 * Service registration node
 */
interface ServiceRegistrationNode {
  id: string;
  type: 'SERVICE_REGISTRATION';
  serviceName: string;
  objectName: string;
  file: string;
  line: number;
}

/**
 * Service usage node
 */
interface ServiceUsageNode {
  id: string;
  type: 'SERVICE_USAGE';
  serviceName: string;
  file: string;
  line: number;
}

/**
 * Analysis result
 */
interface AnalysisResult {
  classes: number;
  instances: number;
  registrations: number;
  usages: number;
}

export class ServiceLayerAnalyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'ServiceLayerAnalyzer',
      phase: 'ANALYSIS',
      creates: {
        nodes: ['SERVICE_CLASS', 'SERVICE_INSTANCE', 'SERVICE_REGISTRATION', 'SERVICE_USAGE'],
        edges: ['CONTAINS', 'INSTANTIATES', 'REGISTERS', 'USES_SERVICE']
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

      // Получаем все модули
      const modules = await this.getModules(graph);
      logger.info('Processing modules', { count: modules.length });

      let classesCount = 0;
      let instancesCount = 0;
      let registrationsCount = 0;
      let usagesCount = 0;
      const startTime = Date.now();

      for (let i = 0; i < modules.length; i++) {
        const module = modules[i];
        const result = await this.analyzeModule(module, graph, projectPath, factory);
        classesCount += result.classes;
        instancesCount += result.instances;
        registrationsCount += result.registrations;
        usagesCount += result.usages;

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
            currentPlugin: 'ServiceLayerAnalyzer',
            message: `Processing modules ${i + 1}/${modules.length}`,
            totalFiles: modules.length,
            processedFiles: i + 1,
          });
        }
      }

      logger.info('Analysis complete', {
        classesCount,
        instancesCount,
        registrationsCount,
        usagesCount
      });

      return createSuccessResult(
        {
          nodes: classesCount + instancesCount + registrationsCount + usagesCount,
          edges: 0
        },
        {
          classesCount,
          instancesCount,
          registrationsCount,
          usagesCount
        }
      );
    } catch (error) {
      logger.error('Analysis failed', { error });
      const err = error instanceof Error ? error : new Error(String(error));
      return createErrorResult(err);
    }
  }

  private async analyzeModule(
    module: NodeRecord,
    graph: PluginContext['graph'],
    projectPath: string,
    factory: PluginContext['factory'],
  ): Promise<AnalysisResult> {
    try {
      const code = readFileSync(resolveNodeFile(module.file!, projectPath), 'utf-8');

      const ast = parse(code, {
        sourceType: 'module',
        plugins: [
          'jsx',
          'typescript',
          'classProperties',
          'decorators-legacy',
          'asyncGenerators',
          'dynamicImport',
          'optionalChaining',
          'nullishCoalescingOperator'
        ] as ParserPlugin[]
      });

      const serviceClasses: ServiceClassNode[] = [];
      const serviceInstances: ServiceInstanceNode[] = [];
      const serviceRegistrations: ServiceRegistrationNode[] = [];
      const serviceUsages: ServiceUsageNode[] = [];

      // Детект Service паттернов
      traverse(ast, {
        // Pattern 1: class XxxService { ... }
        ClassDeclaration: (path: NodePath<ClassDeclaration>) => {
          const node = path.node;
          const className = node.id?.name;

          if (className && this.isServiceClass(className)) {
            const line = getLine(node);

            // Извлекаем методы сервиса
            const methods = node.body.body
              .filter(m => m.type === 'ClassMethod' && (m as { kind: string }).kind === 'method')
              .map(m => ((m as { key: Identifier }).key as Identifier).name);

            serviceClasses.push({
              id: `${module.file}:SERVICE_CLASS:${className}:${line}`,
              type: 'SERVICE_CLASS',
              name: className,
              methods: methods,
              file: module.file!,
              line: line
            });
          }
        },

        // Pattern 2: new XxxService()
        NewExpression: (path: NodePath<NewExpression>) => {
          const node = path.node;
          const callee = node.callee;

          if (callee.type === 'Identifier') {
            const className = (callee as Identifier).name;

            if (this.isServiceClass(className)) {
              const line = getLine(node);

              serviceInstances.push({
                id: `${module.file}:SERVICE_INSTANCE:${className}:${line}`,
                type: 'SERVICE_INSTANCE',
                serviceClass: className,
                file: module.file!,
                line: line
              });
            }
          }
        },

        // Pattern 3: app.set('serviceName', serviceInstance)
        CallExpression: (path: NodePath<CallExpression>) => {
          const node = path.node;
          const callee = node.callee;

          // app.set('service', instance)
          if (
            callee.type === 'MemberExpression' &&
            callee.property.type === 'Identifier' &&
            (callee.property as Identifier).name === 'set'
          ) {
            const objectName = this.getObjectName(callee.object);
            if (objectName === 'app' && node.arguments.length >= 2) {
              const serviceName = this.extractStringArg(node.arguments[0]);
              const line = getLine(node);

              // Проверяем что это похоже на service (имя содержит 'service' или '*Service')
              if (
                serviceName.toLowerCase().includes('service') ||
                this.isServiceClass(serviceName)
              ) {
                serviceRegistrations.push({
                  id: `${module.file}:SERVICE_REGISTRATION:${serviceName}:${line}`,
                  type: 'SERVICE_REGISTRATION',
                  serviceName: serviceName,
                  objectName: objectName,
                  file: module.file!,
                  line: line
                });
              }
            }
          }

          // req.app.get('service') - service usage
          if (
            callee.type === 'MemberExpression' &&
            callee.property.type === 'Identifier' &&
            (callee.property as Identifier).name === 'get'
          ) {
            // Проверяем что это req.app.get или app.get
            const objectChain = this.getObjectChain(callee.object);
            if (
              (objectChain.includes('req') && objectChain.includes('app')) ||
              objectChain.includes('app')
            ) {
              if (node.arguments.length >= 1) {
                const serviceName = this.extractStringArg(node.arguments[0]);
                const line = getLine(node);

                // Проверяем что это похоже на service
                if (
                  serviceName.toLowerCase().includes('service') ||
                  this.isServiceClass(serviceName)
                ) {
                  serviceUsages.push({
                    id: `${module.file}:SERVICE_USAGE:${serviceName}:${line}`,
                    type: 'SERVICE_USAGE',
                    serviceName: serviceName,
                    file: module.file!,
                    line: line
                  });
                }
              }
            }
          }
        }
      });

      // Batch nodes and edges for IPC optimization
      const nodes: AnyBrandedNode[] = [];
      const edges: Array<{ type: string; src: string; dst: string }> = [];

      // Collect all nodes
      for (const serviceClass of serviceClasses) {
        nodes.push(NodeFactory.createServiceClass(
          serviceClass.name,
          serviceClass.file,
          serviceClass.line,
          serviceClass.methods
        ));
        edges.push({
          type: 'CONTAINS',
          src: module.id,
          dst: serviceClass.id
        });
      }

      for (const instance of serviceInstances) {
        nodes.push(NodeFactory.createServiceInstance(
          instance.serviceClass,
          instance.file,
          instance.line
        ));
        edges.push({
          type: 'CONTAINS',
          src: module.id,
          dst: instance.id
        });
      }

      for (const registration of serviceRegistrations) {
        nodes.push(NodeFactory.createServiceRegistration(
          registration.serviceName,
          registration.objectName,
          registration.file,
          registration.line
        ));
        edges.push({
          type: 'CONTAINS',
          src: module.id,
          dst: registration.id
        });
      }

      for (const usage of serviceUsages) {
        nodes.push(NodeFactory.createServiceUsage(
          usage.serviceName,
          usage.file,
          usage.line
        ));
        edges.push({
          type: 'CONTAINS',
          src: module.id,
          dst: usage.id
        });
      }

      // First flush: add all nodes to graph
      await factory!.storeMany(nodes);

      // Create INSTANTIATES edges (requires querying graph)
      for (const instance of serviceInstances) {
        for await (const n of graph.queryNodes({ type: 'SERVICE_CLASS', name: instance.serviceClass })) {
          edges.push({
            type: 'INSTANTIATES',
            src: instance.id,
            dst: n.id
          });
          break;
        }
      }

      // Second flush: add all edges to graph
      await factory!.linkMany(edges);

      return {
        classes: serviceClasses.length,
        instances: serviceInstances.length,
        registrations: serviceRegistrations.length,
        usages: serviceUsages.length
      };
    } catch {
      // Silent - per-module errors shouldn't spam logs
      return { classes: 0, instances: 0, registrations: 0, usages: 0 };
    }
  }

  /**
   * Проверяет является ли класс Service классом
   * (заканчивается на Service или содержит Service в имени)
   */
  private isServiceClass(className: string): boolean {
    if (!className) return false;
    return (
      className.endsWith('Service') ||
      className.includes('Service') ||
      /Service[A-Z]/.test(className)
    );
  }

  /**
   * Извлекает имя объекта из MemberExpression
   */
  private getObjectName(node: Node): string {
    if (node.type === 'Identifier') {
      return (node as Identifier).name;
    } else if (node.type === 'MemberExpression') {
      return this.getObjectName((node as MemberExpression).object);
    } else if (node.type === 'CallExpression') {
      return this.getObjectName((node as CallExpression).callee);
    }
    return 'unknown';
  }

  /**
   * Извлекает цепочку объектов (для req.app.get)
   */
  private getObjectChain(node: Node, chain: string[] = []): string[] {
    if (node.type === 'Identifier') {
      chain.unshift((node as Identifier).name);
    } else if (node.type === 'MemberExpression') {
      const memberExpr = node as MemberExpression;
      if (memberExpr.property.type === 'Identifier') {
        chain.push((memberExpr.property as Identifier).name);
      }
      this.getObjectChain(memberExpr.object, chain);
    }
    return chain;
  }

  /**
   * Извлекает строковое значение из аргумента
   */
  private extractStringArg(arg: Node): string {
    if (!arg) return 'unknown';

    if (arg.type === 'StringLiteral') {
      return (arg as { value: string }).value;
    } else if (arg.type === 'TemplateLiteral') {
      const tl = arg as { quasis: Array<{ value: { raw: string } }> };
      if (tl.quasis.length === 1) {
        return tl.quasis[0].value.raw;
      }
    }

    return 'dynamic';
  }
}
