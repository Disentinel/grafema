/**
 * HttpRequestCallNode - contract for http:request nodes
 *
 * Represents HTTP request call sites (fetch(), axios.get(), etc.)
 * These connect to net:request singleton via CALLS edges.
 *
 * ID format: http:request:{method}:{url}:{file}:{line}
 * Note: line is included because same file can have multiple requests to same URL
 */

import type { HttpRequestCallNodeRecord } from '@grafema/types';

interface HttpRequestCallNodeOptions {
  responseDataNode?: string | null;  // ID of CALL node for response.json(), etc.
}

export class HttpRequestCallNode {
  static readonly TYPE = 'http:request' as const;

  static readonly REQUIRED = ['name', 'file', 'line', 'column', 'method', 'url', 'library', 'staticUrl'] as const;
  static readonly OPTIONAL = ['responseDataNode'] as const;

  /**
   * Create http:request node
   *
   * @param method - HTTP method (GET, POST, etc.)
   * @param url - Request URL (may be 'dynamic' if not statically determinable)
   * @param library - Library used ('fetch', 'axios', or custom wrapper name)
   * @param file - Absolute file path
   * @param line - Line number
   * @param column - Column position
   * @param staticUrl - 'yes' if URL is a static string, 'no' if dynamic
   * @param options - Optional fields
   */
  static create(
    method: string,
    url: string,
    library: string,
    file: string,
    line: number,
    column: number,
    staticUrl: 'yes' | 'no',
    options: HttpRequestCallNodeOptions = {}
  ): HttpRequestCallNodeRecord {
    if (!method) throw new Error('HttpRequestCallNode.create: method is required');
    if (!url) throw new Error('HttpRequestCallNode.create: url is required');
    if (!library) throw new Error('HttpRequestCallNode.create: library is required');
    if (!file) throw new Error('HttpRequestCallNode.create: file is required');
    if (line === undefined) throw new Error('HttpRequestCallNode.create: line is required');
    if (column === undefined) throw new Error('HttpRequestCallNode.create: column is required');

    const upperMethod = method.toUpperCase();
    // Line is included for disambiguation (same URL can be called from multiple places)
    const id = `http:request#${upperMethod}:${url}#${file}#${line}`;

    return {
      id,
      type: this.TYPE,
      name: `${upperMethod} ${url}`,
      method: upperMethod,
      url,
      library,
      staticUrl,
      responseDataNode: options.responseDataNode,
      file,
      line,
      column,
    };
  }

  static validate(node: HttpRequestCallNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) errors.push(`Expected type ${this.TYPE}`);
    const nodeRecord = node as unknown as Record<string, unknown>;
    for (const field of this.REQUIRED) {
      if (nodeRecord[field] === undefined) errors.push(`Missing: ${field}`);
    }
    return errors;
  }
}

export type { HttpRequestCallNodeRecord };
