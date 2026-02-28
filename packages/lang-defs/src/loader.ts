import type { LangDefs, TypeDef, BuiltinRegistry } from './types.js';

/**
 * Build a BuiltinRegistry from one or more LangDefs definitions.
 *
 * Builds a reverse index: methodName -> typeNames[] for prototype methods.
 * Static methods are not indexed (they resolve via type name directly).
 */
export function loadBuiltinRegistry(defs: LangDefs[]): BuiltinRegistry {
  const typeMap = new Map<string, TypeDef>();
  const methodIndex = new Map<string, string[]>();

  for (const def of defs) {
    for (const [typeName, typeDef] of Object.entries(def.types)) {
      typeMap.set(typeName, typeDef);

      if (typeDef.prototype) {
        for (const method of typeDef.prototype) {
          const existing = methodIndex.get(method);
          if (existing) {
            if (!existing.includes(typeName)) {
              existing.push(typeName);
            }
          } else {
            methodIndex.set(method, [typeName]);
          }
        }
      }
    }
  }

  return {
    resolveMethod(name: string): string[] {
      return methodIndex.get(name) || [];
    },
    getType(name: string): TypeDef | undefined {
      return typeMap.get(name);
    },
  };
}
