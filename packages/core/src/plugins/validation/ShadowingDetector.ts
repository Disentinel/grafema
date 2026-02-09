/**
 * ShadowingDetector - detects variable shadowing issues
 *
 * Detects two types of shadowing:
 *
 * 1. Cross-file shadowing:
 *    - CLASS `User` defined in models.js
 *    - VARIABLE `User` in handlers.js shadows the class
 *    - Method calls on the variable go to wrong target
 *
 * 2. Scope-aware shadowing:
 *    - import { User } from './models'
 *    - function handler() { const User = {...}; User.save(); }
 *    - Local variable shadows the imported class
 *
 * Implementation notes:
 * - Datalog doesn't support inequality (\=), so we use JS filtering
 * - queryNodes is an async generator, use getAllNodes for arrays
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord, NodeRecord } from '@grafema/types';

/**
 * Shadowing issue
 */
interface ShadowingIssue {
  type: string;
  severity: string;
  message: string;
  shadowingNodeId: string;
  shadowedName: string;
  shadowedNodeId: string;
  shadowedFile?: string;
  file?: string;
  line?: number;
  scope?: string;
}

/**
 * Extended node with shadowing properties
 */
interface ShadowableNode extends BaseNodeRecord {
  local?: string;
  parentScopeId?: string;
}

/**
 * Validation summary
 */
interface ValidationSummary {
  crossFileShadows: number;
  scopeShadows: number;
  totalIssues: number;
}

export class ShadowingDetector extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'ShadowingDetector',
      phase: 'VALIDATION',
      dependencies: ['JSASTAnalyzer'],
      creates: {
        nodes: [],
        edges: []
      }
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph } = context;
    const logger = this.log(context);

    logger.info('Starting variable shadowing detection');

    const issues: ShadowingIssue[] = [];

    // Get all relevant nodes
    const allClasses = await graph.getAllNodes({ type: 'CLASS' });
    const allVariables = await graph.getAllNodes({ type: 'VARIABLE' }) as ShadowableNode[];
    const allConstants = await graph.getAllNodes({ type: 'CONSTANT' }) as ShadowableNode[];
    const allImports = await graph.getAllNodes({ type: 'IMPORT' }) as ShadowableNode[];

    // Build maps for efficient lookup
    const classesByName = new Map<string, NodeRecord[]>();
    for (const cls of allClasses) {
      const name = cls.name as string;
      if (!classesByName.has(name)) {
        classesByName.set(name, []);
      }
      classesByName.get(name)!.push(cls);
    }

    const importsByFileAndLocal = new Map<string, ShadowableNode>();
    for (const imp of allImports) {
      const key = `${imp.file}:${imp.local}`;
      importsByFileAndLocal.set(key, imp);
    }

    // 1. Cross-file shadowing: VARIABLE shadows CLASS from another file
    for (const variable of allVariables) {
      const name = variable.name as string;
      const classesWithSameName = classesByName.get(name);
      if (classesWithSameName) {
        // Find classes in different files
        const shadowedClasses = classesWithSameName.filter(c => c.file !== variable.file);
        for (const shadowedClass of shadowedClasses) {
          issues.push({
            type: 'CROSS_FILE_SHADOW',
            severity: 'WARNING',
            message: `Variable "${name}" at ${variable.file}:${variable.line || '?'} shadows class "${name}" from ${shadowedClass.file}`,
            shadowingNodeId: variable.id,
            shadowedName: name,
            shadowedNodeId: shadowedClass.id,
            shadowedFile: shadowedClass.file,
            file: variable.file,
            line: variable.line as number | undefined
          });
        }
      }
    }

    // 2. Scope-aware shadowing: local VARIABLE/CONSTANT shadows IMPORT
    // Variables/constants with parentScopeId (inside functions) that shadow imports
    const allLocalVars = [...allVariables, ...allConstants].filter(v => v.parentScopeId);

    for (const localVar of allLocalVars) {
      const name = localVar.name as string;
      const importKey = `${localVar.file}:${name}`;
      const shadowedImport = importsByFileAndLocal.get(importKey);

      if (shadowedImport) {
        const nodeType = localVar.type === 'CONSTANT' ? 'constant' : 'variable';
        issues.push({
          type: 'SCOPE_SHADOW',
          severity: 'WARNING',
          message: `Local ${nodeType} "${name}" at ${localVar.file}:${localVar.line || '?'} shadows imported "${name}"`,
          shadowingNodeId: localVar.id,
          shadowedName: name,
          shadowedNodeId: shadowedImport.id,
          file: localVar.file,
          line: localVar.line as number | undefined,
          scope: localVar.parentScopeId
        });
      }
    }

    const crossFileCount = issues.filter(i => i.type === 'CROSS_FILE_SHADOW').length;
    const scopeCount = issues.filter(i => i.type === 'SCOPE_SHADOW').length;

    const summary: ValidationSummary = {
      crossFileShadows: crossFileCount,
      scopeShadows: scopeCount,
      totalIssues: issues.length
    };

    logger.info('Detection complete', { ...summary });

    if (issues.length > 0) {
      logger.warn('Shadowing issues found', { count: issues.length });
      for (const issue of issues) {
        logger.warn(issue.message, { type: issue.type });
      }
    } else {
      logger.info('No shadowing issues detected');
    }

    return createSuccessResult(
      { nodes: 0, edges: 0 },
      { summary, issues }
    );
  }
}
