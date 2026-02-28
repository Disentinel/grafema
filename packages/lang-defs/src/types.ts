export interface TypeDef {
  kind: 'class' | 'function' | 'namespace';
  /** Instance methods (on prototype) */
  prototype?: string[];
  /** Static methods (on constructor/namespace) */
  static?: string[];
}

export interface LangDefs {
  language: string;
  version: string;
  extends?: string;
  types: Record<string, TypeDef>;
}

export interface BuiltinRegistry {
  /** method name -> type names that have this instance method */
  resolveMethod(name: string): string[];
  /** Get type definition by name */
  getType(name: string): TypeDef | undefined;
}
