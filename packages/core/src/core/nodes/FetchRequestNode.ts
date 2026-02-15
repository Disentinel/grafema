/**
 * FetchRequestNode - contract for http:request nodes
 *
 * Represents an HTTP request call site detected from fetch(), axios,
 * or custom wrapper patterns. Created by FetchAnalyzer.
 *
 * NOT the same as HttpRequestNode (type: HTTP_REQUEST), which is the
 * older contract for generic HTTP request nodes created by GraphBuilder.
 * This uses namespaced type 'http:request' for semantic grouping.
 *
 * ID format: http:request#${method}:${url}#${file}#${line}
 */

import type { BaseNodeRecord } from '@grafema/types';

interface FetchRequestNodeRecord extends BaseNodeRecord {
  type: 'http:request';
  method: string;
  url: string;
  library: string;
  file: string;
  line: number;
  column: number;
  staticUrl: 'yes' | 'no';
}

interface FetchRequestNodeOptions {
  /** Human-readable name (e.g., "GET /api/users") */
  name?: string;
  /** How the method was determined */
  methodSource?: 'explicit' | 'default' | 'unknown';
  /** ID of CALL node for response.json(), response.text(), etc. */
  responseDataNode?: string | null;
}

export class FetchRequestNode {
  static readonly TYPE = 'http:request' as const;

  static readonly REQUIRED = ['method', 'url', 'library', 'file', 'line', 'column', 'staticUrl'] as const;
  static readonly OPTIONAL = ['name', 'methodSource', 'responseDataNode'] as const;

  /**
   * Create http:request node
   *
   * @param method - HTTP method (GET, POST, etc.)
   * @param url - Request URL or 'dynamic'/'unknown'
   * @param library - Library name ('fetch', 'axios', or custom wrapper name)
   * @param file - File path where request is made
   * @param line - Line number
   * @param column - Column number
   * @param options - Optional fields
   */
  static create(
    method: string,
    url: string,
    library: string,
    file: string,
    line: number,
    column: number,
    options: FetchRequestNodeOptions = {}
  ): FetchRequestNodeRecord {
    const id = `http:request#${method}:${url}#${file}#${line}`;

    const node: FetchRequestNodeRecord = {
      id,
      type: this.TYPE,
      name: options.name || `${method} ${url}`,
      method,
      url,
      library,
      file,
      line,
      column,
      staticUrl: url !== 'dynamic' && url !== 'unknown' ? 'yes' : 'no',
    };

    if (options.methodSource !== undefined) {
      (node as Record<string, unknown>).methodSource = options.methodSource;
    }
    if (options.responseDataNode !== undefined) {
      (node as Record<string, unknown>).responseDataNode = options.responseDataNode;
    }

    return node;
  }

  /**
   * Validate http:request node structure
   */
  static validate(node: FetchRequestNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) {
      errors.push(`Expected type ${this.TYPE}, got ${node.type}`);
    }
    const record = node as unknown as Record<string, unknown>;
    for (const field of this.REQUIRED) {
      if (record[field] === undefined) {
        errors.push(`Missing required field: ${field}`);
      }
    }
    return errors;
  }
}

export type { FetchRequestNodeRecord, FetchRequestNodeOptions };
