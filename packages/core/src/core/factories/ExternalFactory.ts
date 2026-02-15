/**
 * ExternalFactory - factory methods for external module/function graph nodes
 *
 * Handles: EXTERNAL_MODULE, EXTERNAL_FUNCTION
 */

import {
  ExternalModuleNode,
  ExternalFunctionNode,
  type ExternalFunctionOptions,
} from '../nodes/index.js';

import { brandNodeInternal } from '../brandNodeInternal.js';

export class ExternalFactory {
  static createExternalModule(source: string) {
    return brandNodeInternal(ExternalModuleNode.create(source));
  }

  static createExternalFunction(moduleName: string, functionName: string, options: ExternalFunctionOptions = {}) {
    return brandNodeInternal(ExternalFunctionNode.create(moduleName, functionName, options));
  }
}
