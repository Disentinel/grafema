/**
 * RustFactory - factory methods for Rust-specific graph nodes
 *
 * Handles: RUST_MODULE, RUST_FUNCTION, RUST_STRUCT, RUST_IMPL,
 * RUST_METHOD, RUST_TRAIT, RUST_CALL
 */

import {
  RustModuleNode,
  RustFunctionNode,
  RustStructNode,
  RustImplNode,
  RustMethodNode,
  RustTraitNode,
  RustCallNode,
  type RustCallType,
  type RustTraitMethodRecord,
} from '../nodes/index.js';

import { brandNodeInternal } from '../brandNodeInternal.js';

export class RustFactory {
  static createRustModule(
    moduleName: string,
    file: string,
    contentHash: string,
    prefixedPath: string,
    options: { isLib?: boolean; isMod?: boolean; isTest?: boolean } = {}
  ) {
    return brandNodeInternal(RustModuleNode.create(moduleName, file, contentHash, prefixedPath, options));
  }

  static createRustFunction(
    name: string,
    file: string,
    line: number,
    column: number,
    options: {
      pub?: boolean;
      async?: boolean;
      unsafe?: boolean;
      const?: boolean;
      napi?: boolean;
      napiJsName?: string | null;
      napiConstructor?: boolean;
      napiGetter?: string | null;
      napiSetter?: string | null;
      params?: string[];
      returnType?: string | null;
      unsafeBlocks?: number;
    } = {}
  ) {
    return brandNodeInternal(RustFunctionNode.create(name, file, line, column, options));
  }

  static createRustStruct(
    name: string,
    file: string,
    line: number,
    options: { pub?: boolean; napi?: boolean; fields?: unknown[] } = {}
  ) {
    return brandNodeInternal(RustStructNode.create(name, file, line, options));
  }

  static createRustImpl(
    targetType: string,
    file: string,
    line: number,
    options: { traitName?: string | null } = {}
  ) {
    return brandNodeInternal(RustImplNode.create(targetType, file, line, options));
  }

  static createRustMethod(
    name: string,
    file: string,
    line: number,
    column: number,
    implId: string,
    implType: string,
    options: {
      pub?: boolean;
      async?: boolean;
      unsafe?: boolean;
      const?: boolean;
      napi?: boolean;
      napiJsName?: string | null;
      napiConstructor?: boolean;
      napiGetter?: string | null;
      napiSetter?: string | null;
      params?: string[];
      returnType?: string | null;
      selfType?: string | null;
      unsafeBlocks?: number;
    } = {}
  ) {
    return brandNodeInternal(RustMethodNode.create(name, file, line, column, implId, implType, options));
  }

  static createRustTrait(
    name: string,
    file: string,
    line: number,
    options: {
      pub?: boolean;
      methods?: RustTraitMethodRecord[];
    } = {}
  ) {
    return brandNodeInternal(RustTraitNode.create(name, file, line, options));
  }

  static createRustCall(
    parentName: string,
    file: string,
    line: number,
    column: number,
    callType: RustCallType,
    argsCount: number,
    options: {
      name?: string | null;
      receiver?: string | null;
      method?: string | null;
      sideEffect?: string | null;
    } = {}
  ) {
    return brandNodeInternal(RustCallNode.create(parentName, file, line, column, callType, argsCount, options));
  }
}
