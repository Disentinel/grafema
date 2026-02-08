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
import type { ParserPlugin } from '@babel/parser';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import type { CallExpression, Identifier, MemberExpression, ObjectExpression, Node } from '@babel/types';
import type { NodePath } from '@babel/traverse';
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord } from '@grafema/types';
import { NetworkRequestNode } from '../../core/nodes/NetworkRequestNode.js';
import { getLine, getColumn } from './ast/utils/location.js';

const traverse = (traverseModule as any).default || traverseModule;

/**
 * HTTP request node
 */
interface HttpRequestNode {
  id: string;
  type: 'http:request';
  name: string;  // Human-readable name like "GET /api/users"
  method: string;
  methodSource: MethodSource;
  url: string;
  library: string;
  file: string;
  line: number;
  column: number;
  staticUrl: 'yes' | 'no';
  responseDataNode?: string | null;  // ID of CALL node for response.json(), response.text(), etc.
}

/**
 * Response consumption methods for fetch API
 */
const RESPONSE_CONSUMPTION_METHODS = ['json', 'text', 'blob', 'arrayBuffer', 'formData'];

/**
 * Fetch call info with response variable name (for responseDataNode tracking)
 */
interface FetchCallInfo {
  request: HttpRequestNode;
  responseVarName: string | null;
}

type MethodSource = 'explicit' | 'default' | 'unknown';

/**
 * Analysis result
 */
interface AnalysisResult {
  requests: number;
  apis: number;
}

export class FetchAnalyzer extends Plugin {
  private networkNodeCreated = false;
  private networkNodeId: string | null = null;

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
    const logger = this.log(context);

    try {
      const { graph } = context;

      // net:request singleton created lazily in analyzeModule when first request found

      // Получаем все модули
      const modules = await this.getModules(graph);
      logger.info('Processing modules', { count: modules.length });

      let requestsCount = 0;
      let apisCount = 0;
      const startTime = Date.now();

      for (let i = 0; i < modules.length; i++) {
        const module = modules[i];
        const result = await this.analyzeModule(module, graph);
        requestsCount += result.requests;
        apisCount += result.apis;

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

      logger.info('Analysis complete', { requestsCount, apisCount });

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
      logger.error('Analysis failed', { error });
      const err = error instanceof Error ? error : new Error(String(error));
      return createErrorResult(err);
    }
  }

  /**
   * Ensures net:request singleton exists, creating it if necessary.
   * Called lazily when first HTTP request is detected.
   */
  private async ensureNetworkNode(graph: PluginContext['graph']): Promise<string> {
    if (!this.networkNodeId) {
      const networkNode = NetworkRequestNode.create();
      await graph.addNode(networkNode);
      this.networkNodeCreated = true;
      this.networkNodeId = networkNode.id;
    }
    return this.networkNodeId;
  }

  private async analyzeModule(
    module: NodeRecord,
    graph: PluginContext['graph']
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

      const constStrings = new Map<string, string>();
      const constObjects = new Map<string, ObjectExpression>();

      // Collect simple const assignments for method resolution
      traverse(ast, {
        VariableDeclarator: (path: NodePath) => {
          const node = path.node as { id: Node; init?: Node | null };
          const parent = path.parentPath?.node as { type?: string; kind?: string } | undefined;
          if (!parent || parent.type !== 'VariableDeclaration' || parent.kind !== 'const') return;
          if (!node.init || node.id.type !== 'Identifier') return;

          const name = (node.id as Identifier).name;
          if (node.init.type === 'StringLiteral') {
            constStrings.set(name, (node.init as { value: string }).value);
          } else if (node.init.type === 'ObjectExpression') {
            constObjects.set(name, node.init as ObjectExpression);
          }
        }
      });

      const fetchCalls: FetchCallInfo[] = [];
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
            const methodInfo = this.extractMethodInfo(node.arguments[1], constStrings, constObjects);
            const method = methodInfo.method;
            const line = getLine(node);

            const request: HttpRequestNode = {
              id: `http:request#${method}:${url}#${module.file}#${line}`,
              type: 'http:request',
              name: `${method} ${url}`,
              method: method,
              methodSource: methodInfo.source,
              url: url,
              library: 'fetch',
              file: module.file!,
              line: line,
              column: getColumn(node),
              staticUrl: url !== 'dynamic' && url !== 'unknown' ? 'yes' : 'no'
            };

            // Extract response variable name for responseDataNode tracking
            const responseVarName = this.getResponseVariableName(path);
            fetchCalls.push({ request, responseVarName });

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
            const line = getLine(node);

            const request: HttpRequestNode = {
              id: `http:request#${method}:${url}#${module.file}#${line}`,
              type: 'http:request',
              name: `${method} ${url}`,
              method: method,
              methodSource: 'explicit',
              url: url,
              library: 'axios',
              file: module.file!,
              line: line,
              column: getColumn(node),
              staticUrl: url !== 'dynamic' && url !== 'unknown' ? 'yes' : 'no'
            };

            // Axios uses response.data, not response.json() - out of scope for v1.0
            fetchCalls.push({ request, responseVarName: null });

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

              const url = urlProp
                ? this.extractURL((urlProp as { value: Node }).value)
                : 'unknown';
              const methodInfo = this.extractMethodInfo(config, constStrings, constObjects);
              const method = methodInfo.method;
              const line = getLine(node);

              const request: HttpRequestNode = {
                id: `http:request#${method}:${url}#${module.file}#${line}`,
                type: 'http:request',
                name: `${method} ${url}`,
                method: method,
                methodSource: methodInfo.source,
                url: url,
                library: 'axios',
                file: module.file!,
                line: line,
                column: getColumn(node),
                staticUrl: url !== 'dynamic' && url !== 'unknown' ? 'yes' : 'no'
              };

              // Axios uses response.data, not response.json() - out of scope for v1.0
              fetchCalls.push({ request, responseVarName: null });

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
              const methodInfo = this.extractMethodInfo(node.arguments[1], constStrings, constObjects);
              const method = methodInfo.method;
              const line = getLine(node);

              const request: HttpRequestNode = {
                id: `http:request#${method}:${url}#${module.file}#${line}`,
                type: 'http:request',
                name: `${method} ${url}`,
                method: method,
                methodSource: methodInfo.source,
                url: url,
                library: calleeName,
                file: module.file!,
                line: line,
                column: getColumn(node),
                staticUrl: url !== 'dynamic' && url !== 'unknown' ? 'yes' : 'no'
              };

              // Custom wrappers may use fetch-like response.json() pattern
              const responseVarName = this.getResponseVariableName(path);
              fetchCalls.push({ request, responseVarName });

              if (this.isExternalAPI(url)) {
                externalAPIs.add(this.extractDomain(url));
              }
            }
          }
        }
      });

      // Extract httpRequests for external API handling
      const httpRequests = fetchCalls.map(fc => fc.request);

      // Создаём HTTP_REQUEST ноды
      for (const fetchCall of fetchCalls) {
        const request = fetchCall.request;

        // Find responseDataNode if we have a response variable name
        if (fetchCall.responseVarName) {
          const responseDataNodeId = await this.findResponseJsonCall(
            graph,
            request.file,
            fetchCall.responseVarName,
            request.line
          );
          if (responseDataNodeId) {
            request.responseDataNode = responseDataNodeId;
          }
        }

        await graph.addNode(request as unknown as NodeRecord);

        // Создаём ребро от модуля к request
        await graph.addEdge({
          type: 'CONTAINS',
          src: module.id,
          dst: request.id
        });

        // http:request --CALLS--> net:request singleton (created lazily)
        const networkId = await this.ensureNetworkNode(graph);
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

        // Find CALL node that makes this request (same file, same line)
        // Determine expected call name based on library
        const expectedCallNames = this.getExpectedCallNames(request.library, request.method);

        for await (const callNode of graph.queryNodes({ type: 'CALL' })) {
          if (
            callNode.file === request.file &&
            callNode.line === request.line &&
            expectedCallNames.includes(callNode.name as string)
          ) {
            await graph.addEdge({
              type: 'MAKES_REQUEST',
              src: callNode.id,
              dst: request.id
            });
            break; // Only link to first matching CALL node
          }
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
        requests: fetchCalls.length,
        apis: externalAPIs.size
      };
    } catch {
      // Silent - per-module errors shouldn't spam logs
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
   * Извлекает HTTP method из options объекта и источник значения
   */
  private extractMethodInfo(
    optionsArg: Node | undefined,
    constStrings: Map<string, string>,
    constObjects: Map<string, ObjectExpression>
  ): { method: string; source: MethodSource } {
    if (!optionsArg) {
      return { method: 'GET', source: 'default' };
    }

    let optionsNode: Node = optionsArg;
    if (optionsNode.type === 'Identifier') {
      const resolvedObject = constObjects.get((optionsNode as Identifier).name);
      if (resolvedObject) {
        optionsNode = resolvedObject;
      } else {
        return { method: 'UNKNOWN', source: 'unknown' };
      }
    }

    if (optionsNode.type !== 'ObjectExpression') {
      return { method: 'UNKNOWN', source: 'unknown' };
    }

    const objExpr = optionsNode as ObjectExpression;
    const methodProp = objExpr.properties.find(p => {
      if (p.type !== 'ObjectProperty') return false;
      const key = p.key;
      if (key.type === 'Identifier') return key.name === 'method';
      if (key.type === 'StringLiteral') return key.value === 'method';
      return false;
    });

    if (!methodProp || !(methodProp as { value?: Node }).value) {
      return { method: 'GET', source: 'default' };
    }

    const methodValue = (methodProp as { value: Node }).value;
    const methodString = this.extractStaticString(methodValue, constStrings);
    if (!methodString) {
      return { method: 'UNKNOWN', source: 'unknown' };
    }

    return { method: methodString.toUpperCase(), source: 'explicit' };
  }

  /**
   * Извлекает статическое строковое значение (StringLiteral, простая TemplateLiteral, или const Identifier)
   */
  private extractStaticString(
    node: Node | undefined,
    constStrings: Map<string, string>
  ): string | null {
    if (!node) return null;

    if (node.type === 'StringLiteral') {
      return (node as { value: string }).value;
    }

    if (node.type === 'TemplateLiteral') {
      const tl = node as { quasis: Array<{ value: { raw: string } }>; expressions: unknown[] };
      if (tl.expressions.length === 0) {
        return tl.quasis.map(q => q.value.raw).join('');
      }
    }

    if (node.type === 'Identifier') {
      return constStrings.get((node as Identifier).name) || null;
    }

    return null;
  }

  /**
   * Returns expected CALL node names based on library and HTTP method.
   * Used to match http:request with corresponding CALL node.
   *
   * @param library - Library name (fetch, axios, or custom wrapper name)
   * @param method - HTTP method (GET, POST, etc.)
   * @returns Array of possible call names
   */
  private getExpectedCallNames(library: string, method: string): string[] {
    if (library === 'fetch') {
      return ['fetch'];
    }

    if (library === 'axios') {
      // axios.get(), axios.post(), etc. or axios() config call
      return [`axios.${method.toLowerCase()}`, 'axios'];
    }

    // Custom wrapper (authFetch, apiFetch, etc.)
    return [library];
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

  /**
   * Extracts the variable name that holds the fetch response.
   * Handles patterns like:
   * - const response = await fetch(url)
   * - let res = await fetch(url)
   * - response = await fetch(url)
   *
   * @param path - NodePath of the CallExpression
   * @returns Variable name or null if not found
   */
  private getResponseVariableName(path: NodePath<CallExpression>): string | null {
    // Walk up the AST to find the variable assignment
    let current: NodePath | null = path.parentPath;

    // Pattern: await fetch()
    if (current && current.node.type === 'AwaitExpression') {
      current = current.parentPath;
    }

    if (!current) return null;

    // Pattern: const response = await fetch() / let response = await fetch()
    if (current.node.type === 'VariableDeclarator') {
      const declarator = current.node as { id: Node };
      if (declarator.id.type === 'Identifier') {
        return (declarator.id as Identifier).name;
      }
    }

    // Pattern: response = await fetch() (reassignment)
    if (current.node.type === 'AssignmentExpression') {
      const assignment = current.node as { left: Node };
      if (assignment.left.type === 'Identifier') {
        return (assignment.left as Identifier).name;
      }
    }

    return null;
  }

  /**
   * Finds the response consumption CALL node (response.json(), response.text(), etc.)
   * by querying the graph for CALL nodes in the same file with matching object name.
   *
   * Important: Filters to find the response.json() call AFTER the fetch line and
   * closest to it, ensuring we match the correct call in the same function scope.
   *
   * @param graph - Graph backend
   * @param file - File path where fetch call is located
   * @param responseVarName - Variable name holding the response
   * @param fetchLine - Line number of the fetch call (response.json must be after this)
   * @returns CALL node ID or null if not found
   */
  private async findResponseJsonCall(
    graph: PluginContext['graph'],
    file: string,
    responseVarName: string,
    fetchLine: number
  ): Promise<string | null> {
    // Collect all matching CALL nodes
    const candidates: Array<{ id: string; line: number }> = [];

    for await (const node of graph.queryNodes({ type: 'CALL' })) {
      // Check if it's in the same file
      if (node.file !== file) continue;

      // Check if object matches response variable name
      const callNode = node as unknown as { object?: string; method?: string };
      if (callNode.object !== responseVarName) continue;

      // Check if method is a response consumption method
      if (callNode.method && RESPONSE_CONSUMPTION_METHODS.includes(callNode.method)) {
        const nodeLine = node.line ?? 0;
        // Only consider calls AFTER the fetch line (response.json comes after fetch)
        if (nodeLine > fetchLine) {
          candidates.push({ id: node.id, line: nodeLine });
        }
      }
    }

    if (candidates.length === 0) return null;

    // Return the closest match (smallest line number after fetch)
    candidates.sort((a, b) => a.line - b.line);
    return candidates[0].id;
  }
}
