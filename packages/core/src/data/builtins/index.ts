/**
 * Node.js Builtins Registry (REG-218) + Runtime Categories (REG-583)
 *
 * Exports for builtin function registry and runtime categorization.
 */

export { BuiltinRegistry } from './BuiltinRegistry.js';
export type { BuiltinFunctionDef, BuiltinModuleDef, SecurityCategory } from './types.js';
export { ALL_BUILTIN_MODULES, TIER_1_MODULES, TIER_2_MODULES } from './definitions.js';
export { REQUIRE_BUILTINS } from './jsGlobals.js';
export {
  ECMASCRIPT_BUILTIN_OBJECTS,
  WEB_API_OBJECTS,
  WEB_API_FUNCTIONS,
  BROWSER_API_OBJECTS,
  BROWSER_API_FUNCTIONS,
  NODEJS_STDLIB_OBJECTS,
  NODEJS_STDLIB_FUNCTIONS,
  ECMASCRIPT_BUILTIN_FUNCTIONS,
  ALL_KNOWN_OBJECTS,
  ALL_KNOWN_FUNCTIONS,
  resolveBuiltinObjectId,
  resolveBuiltinFunctionId,
  getBuiltinNodeType,
} from './runtimeCategories.js';
