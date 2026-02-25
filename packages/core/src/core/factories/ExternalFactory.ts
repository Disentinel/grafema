/**
 * ExternalFactory - factory methods for external module/function graph nodes
 *
 * Handles: EXTERNAL_MODULE, EXTERNAL_FUNCTION, ECMASCRIPT_BUILTIN,
 *          WEB_API, BROWSER_API, NODEJS_STDLIB, UNKNOWN_CALL_TARGET
 */

import {
  ExternalModuleNode,
  ExternalFunctionNode,
  EcmascriptBuiltinNode,
  WebApiNode,
  BrowserApiNode,
  NodejsStdlibNode,
  UnknownCallTargetNode,
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

  static createEcmascriptBuiltin(name: string) {
    return brandNodeInternal(EcmascriptBuiltinNode.create(name));
  }

  static createWebApi(name: string) {
    return brandNodeInternal(WebApiNode.create(name));
  }

  static createBrowserApi(name: string) {
    return brandNodeInternal(BrowserApiNode.create(name));
  }

  static createNodejsStdlib(name: string) {
    return brandNodeInternal(NodejsStdlibNode.create(name));
  }

  static createUnknownCallTarget(objectName: string) {
    return brandNodeInternal(UnknownCallTargetNode.create(objectName));
  }
}
