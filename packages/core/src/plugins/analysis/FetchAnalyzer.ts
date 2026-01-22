/**
 * FetchAnalyzer - детектит HTTP requests (fetch, axios, custom wrappers)
 *
 * Паттерны:
 * - fetch(url, options) - Native Fetch API
 * - await fetch(url) - Async fetch
 * - axios.get(url) - Axios GET
 * - axios.post(url, data) - Axios POST
 * - customFetch(url, options) - Custom wrappers (authFetch, apiFetch, etc.)
 */

import { readFileSync } from 'fs';
import { parse, ParserPlugin } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { CallExpression, Identifier, MemberExpression, ObjectExpression, Node } from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord } from '@grafema/types';
import { NetworkRequestNode } from '../../core/nodes/NetworkRequestNode.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const traverse = (traverseModule as any).default || traverseModule;

/**
 * HTTP request node
 */
interface HttpRequestNode {
  id: string;
  type: 'http:request';
  method: string;
  url: string;
  library: string;
  file: string;
  line: number;
  staticUrl: 'yes' | 'no';
}

/**
 * Analysis result
 */
interface AnalysisResult {
  requests: number;
  apis: number;
}

export class FetchAnalyzer extends Plugin {
  private networkNodeCreated = false;

  get metadata(): PluginMetadata {
    return {
      name: 'FetchAnalyzer',
      phase: 'ANALYSIS',
      priority: 75, // После JSASTAnalyzer (80)
      creates: {
        nodes: ['http:request', 'EXTERNAL'],
        edges: ['CONTAINS', 'MAKES_REQUEST', 'CALLS_API']
      },
      dependencies: ['JSModuleIndexer', 'JSASTAnalyzer']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    try {
      const { graph } = context;

      // Create net:request singleton (GraphBackend handles deduplication)
      const networkNode = NetworkRequestNode.create();
      await graph.addNode(networkNode);
      this.networkNodeCreated = true;

      // Получаем все модули
      const modules = await this.getModules(graph);
      console.log(`[FetchAnalyzer] Processing ${modules.length} modules...`);

      let requestsCount = 0;
      let apisCount = 0;
      const startTime = Date.now();

      for (let i = 0; i < modules.length; i++) {
        const module = modules[i];
        const result = await this.analyzeModule(module, graph, networkNode.id);
        requestsCount += result.requests;
        apisCount += result.apis;

        // Progress every 20 modules
        if ((i + 1) % 20 === 0 || i === modules.length - 1) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const avgTime = ((Date.now() - startTime) / (i + 1)).toFixed(0);
          console.log(
            `[FetchAnalyzer] Progress: ${i + 1}/${modules.length} (${elapsed}s, avg ${avgTime}ms/module)`
          );
        }
      }

      console.log(`[FetchAnalyzer] Found ${requestsCount} HTTP requests, ${apisCount} external APIs`);

      return createSuccessResult(
        {
          nodes: requestsCount + apisCount + (this.networkNodeCreated ? 1 : 0),
          edges: requestsCount  // CALLS edges from http:request to net:request
        },
        {
          requestsCount,
          apisCount,
          networkSingletonCreated: this.networkNodeCreated
        }
      );
    } catch (error) {
      console.error('[FetchAnalyzer] Error:', error);
      return createErrorResult(error as Error);
    }
  }

  private async analyzeModule(
    module: NodeRecord,
    graph: PluginContext['graph'],
    networkId: string
  ): Promise<AnalysisResult> {
    try {
      const code = readFileSync(module.file!, 'utf-8');

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

      const httpRequests: HttpRequestNode[] = [];
      const externalAPIs = new Set<string>();

      // Детект HTTP request паттернов
      traverse(ast, {
        CallExpression: (path: NodePath<CallExpression>) => {
          const node = path.node;
          const callee = node.callee;

          // Pattern 1: fetch(url, options)
          if (callee.type === 'Identifier' && (callee as Identifier).name === 'fetch') {
            const urlArg = node.arguments[0];
            const url = this.extractURL(urlArg);
            const method = this.extractMethod(node.arguments[1]) || 'GET';
            const line = node.loc!.start.line;

            const request: HttpRequestNode = {
              id: `http:request#${method}:${url}#${module.file}#${line}`,
              type: 'http:request',
              method: method,
              url: url,
              library: 'fetch',
              file: module.file!,
              line: line,
              staticUrl: url !== 'dynamic' && url !== 'unknown' ? 'yes' : 'no'
            };

            httpRequests.push(request);

            // Определяем внешний ли это API
            if (this.isExternalAPI(url)) {
              externalAPIs.add(this.extractDomain(url));
            }
          }

          // Pattern 2: axios.get(url), axios.post(url, data), etc.
          if (
            callee.type === 'MemberExpression' &&
            (callee as MemberExpression).object.type === 'Identifier' &&
            ((callee as MemberExpression).object as Identifier).name === 'axios' &&
            (callee as MemberExpression).property.type === 'Identifier'
          ) {
            const method = ((callee as MemberExpression).property as Identifier).name.toUpperCase();
            const urlArg = node.arguments[0];
            const url = this.extractURL(urlArg);
            const line = node.loc!.start.line;

            const request: HttpRequestNode = {
              id: `http:request#${method}:${url}#${module.file}#${line}`,
              type: 'http:request',
              method: method,
              url: url,
              library: 'axios',
              file: module.file!,
              line: line,
              staticUrl: url !== 'dynamic' && url !== 'unknown' ? 'yes' : 'no'
            };

            httpRequests.push(request);

            if (this.isExternalAPI(url)) {
              externalAPIs.add(this.extractDomain(url));
            }
          }

          // Pattern 3: axios(config) - generic
          if (callee.type === 'Identifier' && (callee as Identifier).name === 'axios') {
            const config = node.arguments[0];
            if (config && config.type === 'ObjectExpression') {
              const objExpr = config as ObjectExpression;
              const urlProp = objExpr.properties.find(
                p =>
                  p.type === 'ObjectProperty' &&
                  (p.key as Identifier).type === 'Identifier' &&
                  (p.key as Identifier).name === 'url'
              );
              const methodProp = objExpr.properties.find(
                p =>
                  p.type === 'ObjectProperty' &&
                  (p.key as Identifier).type === 'Identifier' &&
                  (p.key as Identifier).name === 'method'
              );

              const url = urlProp
                ? this.extractURL((urlProp as { value: Node }).value)
                : 'unknown';
              const method = methodProp
                ? this.extractString((methodProp as { value: Node }).value) || 'GET'
                : 'GET';
              const line = node.loc!.start.line;

              const request: HttpRequestNode = {
                id: `http:request#${method.toUpperCase()}:${url}#${module.file}#${line}`,
                type: 'http:request',
                method: method.toUpperCase(),
                url: url,
                library: 'axios',
                file: module.file!,
                line: line,
                staticUrl: url !== 'dynamic' && url !== 'unknown' ? 'yes' : 'no'
              };

              httpRequests.push(request);

              if (this.isExternalAPI(url)) {
                externalAPIs.add(this.extractDomain(url));
              }
            }
          }

          // Pattern 4: Custom fetch wrappers (authFetch, apiFetch, etc.)
          if (callee.type === 'Identifier') {
            const calleeName = (callee as Identifier).name;
            if (
              calleeName !== 'fetch' &&
              (calleeName.toLowerCase().includes('fetch') ||
                calleeName.toLowerCase().includes('request'))
            ) {
              const urlArg = node.arguments[0];
              const url = this.extractURL(urlArg);
              const method = this.extractMethod(node.arguments[1]) || 'GET';
              const line = node.loc!.start.line;

              const request: HttpRequestNode = {
                id: `http:request#${method}:${url}#${module.file}#${line}`,
                type: 'http:request',
                method: method,
                url: url,
                library: calleeName,
                file: module.file!,
                line: line,
                staticUrl: url !== 'dynamic' && url !== 'unknown' ? 'yes' : 'no'
              };

              httpRequests.push(request);

              if (this.isExternalAPI(url)) {
                externalAPIs.add(this.extractDomain(url));
              }
            }
          }
        }
      });

      // Создаём HTTP_REQUEST ноды
      for (const request of httpRequests) {
        await graph.addNode(request as unknown as NodeRecord);

        // Создаём ребро от модуля к request
        await graph.addEdge({
          type: 'CONTAINS',
          src: module.id,
          dst: request.id
        });

        // http:request --CALLS--> net:request singleton
        await graph.addEdge({
          type: 'CALLS',
          src: request.id,
          dst: networkId
        });

        // Ищем FUNCTION node которая делает запрос
        const functions: NodeRecord[] = [];
        for await (const fn of graph.queryNodes({ type: 'FUNCTION' })) {
          if (
            fn.file === request.file &&
            (fn.line ?? 0) <= request.line &&
            (fn.line ?? 0) + 50 >= request.line
          ) {
            functions.push(fn);
          }
        }

        if (functions.length > 0) {
          // Берём ближайшую функцию
          const closestFunction = functions.reduce((closest, func) => {
            const currentDistance = Math.abs((func.line ?? 0) - request.line);
            const closestDistance = Math.abs((closest.line ?? 0) - request.line);
            return currentDistance < closestDistance ? func : closest;
          });

          await graph.addEdge({
            type: 'MAKES_REQUEST',
            src: closestFunction.id,
            dst: request.id
          });
        }
      }

      // Создаём EXTERNAL ноды для внешних API
      for (const apiDomain of externalAPIs) {
        const apiId = `EXTERNAL#${apiDomain}`;

        // Проверяем что нода ещё не создана
        const existingApi = await graph.getNode(apiId);
        if (!existingApi) {
          await graph.addNode({
            id: apiId,
            type: 'EXTERNAL',
            domain: apiDomain,
            name: apiDomain
          } as unknown as NodeRecord);
        }

        // Создаём рёбра от http:request к EXTERNAL
        const apiRequests = httpRequests.filter(r => r.url.includes(apiDomain));

        for (const request of apiRequests) {
          await graph.addEdge({
            type: 'CALLS_API',
            src: request.id,
            dst: apiId
          });
        }
      }

      return {
        requests: httpRequests.length,
        apis: externalAPIs.size
      };
    } catch (error) {
      console.error(`[FetchAnalyzer] Error analyzing ${module.file}:`, (error as Error).message);
      return { requests: 0, apis: 0 };
    }
  }

  /**
   * Извлекает URL из аргумента
   */
  private extractURL(arg: Node | undefined): string {
    if (!arg) return 'unknown';

    if (arg.type === 'StringLiteral') {
      return (arg as { value: string }).value;
    } else if (arg.type === 'TemplateLiteral') {
      // Template literal - возвращаем паттерн
      const tl = arg as { quasis: Array<{ value: { raw: string } }>; expressions: unknown[] };
      const parts = tl.quasis.map(q => q.value.raw);
      const expressions = tl.expressions.map(() => '${...}');

      let result = '';
      for (let i = 0; i < parts.length; i++) {
        result += parts[i];
        if (i < expressions.length) {
          result += expressions[i];
        }
      }
      return result;
    } else if (arg.type === 'BinaryExpression') {
      const binExpr = arg as { operator: string; left: Node; right: Node };
      if (binExpr.operator === '+') {
        // String concatenation
        return this.extractURL(binExpr.left) + this.extractURL(binExpr.right);
      }
    }

    return 'dynamic';
  }

  /**
   * Извлекает HTTP method из options объекта
   */
  private extractMethod(optionsArg: Node | undefined): string | null {
    if (!optionsArg || optionsArg.type !== 'ObjectExpression') {
      return null;
    }

    const objExpr = optionsArg as ObjectExpression;
    const methodProp = objExpr.properties.find(
      p =>
        p.type === 'ObjectProperty' &&
        (p.key as Identifier).type === 'Identifier' &&
        (p.key as Identifier).name === 'method'
    );

    if (methodProp && (methodProp as { value: Node }).value) {
      return this.extractString((methodProp as { value: Node }).value);
    }

    return null;
  }

  /**
   * Извлекает строковое значение
   */
  private extractString(node: Node | undefined): string | null {
    if (!node) return null;

    if (node.type === 'StringLiteral') {
      return (node as { value: string }).value;
    }

    return null;
  }

  /**
   * Проверяет является ли URL внешним API
   */
  private isExternalAPI(url: string): boolean {
    if (!url || url === 'unknown' || url === 'dynamic') {
      return false;
    }

    // Внешний API - начинается с http:// или https://
    return url.startsWith('http://') || url.startsWith('https://');
  }

  /**
   * Извлекает домен из URL
   */
  private extractDomain(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch {
      // Если не получилось распарсить - пытаемся извлечь вручную
      const match = url.match(/https?:\/\/([^\/\?]+)/);
      return match ? match[1] : url;
    }
  }
}
