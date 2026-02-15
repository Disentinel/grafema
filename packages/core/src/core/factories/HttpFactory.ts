/**
 * HttpFactory - factory methods for HTTP-related graph nodes
 *
 * Handles: net:request, http:route, http:request, express:mount,
 * express:middleware, EXTERNAL (api domain), HTTP_REQUEST
 */

import {
  NetworkRequestNode,
  HttpRouteNode,
  type HttpRouteNodeOptions,
  FetchRequestNode,
  type FetchRequestNodeOptions,
  ExpressMountNode,
  type ExpressMountNodeOptions,
  ExpressMiddlewareNode,
  type ExpressMiddlewareNodeOptions,
  ExternalApiNode,
  HttpRequestNode,
} from '../nodes/index.js';

import { brandNodeInternal } from '../brandNodeInternal.js';

interface HttpRequestOptions {
  parentScopeId?: string;
  counter?: number;
}

export class HttpFactory {
  static createNetworkRequest() {
    return brandNodeInternal(NetworkRequestNode.create());
  }

  static createHttpRoute(method: string, path: string, file: string, line: number, options: HttpRouteNodeOptions = {}) {
    return brandNodeInternal(HttpRouteNode.create(method, path, file, line, options));
  }

  static createFetchRequest(method: string, url: string, library: string, file: string, line: number, column: number, options: FetchRequestNodeOptions = {}) {
    return brandNodeInternal(FetchRequestNode.create(method, url, library, file, line, column, options));
  }

  static createExpressMount(prefix: string, file: string, line: number, column: number, options: ExpressMountNodeOptions = {}) {
    return brandNodeInternal(ExpressMountNode.create(prefix, file, line, column, options));
  }

  static createExpressMiddleware(name: string, file: string, line: number, column: number, options: ExpressMiddlewareNodeOptions = {}) {
    return brandNodeInternal(ExpressMiddlewareNode.create(name, file, line, column, options));
  }

  static createExternalApi(domain: string) {
    return brandNodeInternal(ExternalApiNode.create(domain));
  }

  static createHttpRequest(url: string | undefined, method: string | undefined, file: string, line: number, column: number, options: HttpRequestOptions = {}) {
    return brandNodeInternal(HttpRequestNode.create(url, method, file, line, column, options));
  }
}
