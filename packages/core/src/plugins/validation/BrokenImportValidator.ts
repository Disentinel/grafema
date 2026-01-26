/**
 * BrokenImportValidator - detects broken imports and undefined symbols (REG-261)
 *
 * This VALIDATION plugin queries the graph (built by ANALYSIS and ENRICHMENT phases)
 * to detect:
 *
 * 1. ERR_BROKEN_IMPORT: Named/default import references non-existent export
 *    - IMPORT node with relative source but no IMPORTS_FROM edge
 *    - Skips: external (npm) imports, namespace imports, type-only imports
 *
 * 2. ERR_UNDEFINED_SYMBOL: Symbol used but not defined, imported, or global
 *    - CALL node without CALLS edge
 *    - Not a method call (no `object` property)
 *    - Not a local definition (FUNCTION/CLASS/VARIABLE in same file)
 *    - Not an import (IMPORT with matching local name)
 *    - Not a known global (console, setTimeout, etc.)
 *
 * Architecture follows existing validator patterns:
 * - Phase: VALIDATION
 * - Priority: 85 (after enrichment, before general validators)
 * - Returns: ValidationError[] collected via DiagnosticCollector
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';
import { ValidationError } from '../../errors/GrafemaError.js';
import { GlobalsRegistry } from '../../data/globals/index.js';

// === INTERFACES ===

interface ImportNode extends BaseNodeRecord {
  source?: string;
  importType?: string; // 'default' | 'named' | 'namespace'
  imported?: string;   // Original name in source module
  local?: string;      // Local binding name in this file
  importBinding?: string; // 'value' | 'type' (TypeScript)
}

interface CallNode extends BaseNodeRecord {
  object?: string; // If present, this is a method call
}

// === CONSTANTS ===

const ERROR_CODES = {
  BROKEN_IMPORT: 'ERR_BROKEN_IMPORT',
  UNDEFINED_SYMBOL: 'ERR_UNDEFINED_SYMBOL',
} as const;

// Types that represent local definitions
const DEFINITION_TYPES = new Set([
  'FUNCTION',
  'CLASS',
  'VARIABLE_DECLARATION',
  'CONSTANT',
  'PARAMETER',
]);

// === PLUGIN CLASS ===

export class BrokenImportValidator extends Plugin {
  private globalsRegistry: GlobalsRegistry;

  constructor(config: Record<string, unknown> = {}) {
    super(config);
    this.globalsRegistry = new GlobalsRegistry();

    // Allow custom globals from config
    const customGlobals = config.customGlobals as string[] | undefined;
    if (customGlobals) {
      this.globalsRegistry.addCustomGlobals(customGlobals);
    }
  }

  get metadata(): PluginMetadata {
    return {
      name: 'BrokenImportValidator',
      phase: 'VALIDATION',
      priority: 85, // After enrichment plugins, before general validators
      creates: {
        nodes: [],
        edges: []
      },
      dependencies: ['ImportExportLinker', 'FunctionCallResolver']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const logger = this.log(context);

    logger.info('Starting broken import validation');
    const startTime = Date.now();

    const errors: ValidationError[] = [];
    const stats = {
      importsChecked: 0,
      brokenImports: 0,
      callsChecked: 0,
      undefinedSymbols: 0,
      skipped: {
        externalImports: 0,
        namespaceImports: 0,
        typeOnlyImports: 0,
        methodCalls: 0,
        alreadyResolved: 0,
        localDefinitions: 0,
        imports: 0,
        globals: 0,
      },
    };

    // === Step 1: Build indexes ===

    // Index: file -> Set<name> for local definitions
    const definitionsByFile = new Map<string, Set<string>>();
    for await (const node of graph.queryNodes({})) {
      if (!DEFINITION_TYPES.has(node.type)) continue;
      if (!node.file || !node.name) continue;

      if (!definitionsByFile.has(node.file)) {
        definitionsByFile.set(node.file, new Set());
      }
      definitionsByFile.get(node.file)!.add(node.name);
    }
    logger.debug('Indexed definitions', { files: definitionsByFile.size });

    // Index: file:local -> ImportNode
    const importsByFile = new Map<string, Map<string, ImportNode>>();
    const allImports: ImportNode[] = [];

    for await (const node of graph.queryNodes({ nodeType: 'IMPORT' })) {
      const imp = node as ImportNode;
      if (!imp.file) continue;

      allImports.push(imp);

      // Index by local name for undefined symbol checking
      const localName = imp.local || imp.name;
      if (localName) {
        if (!importsByFile.has(imp.file)) {
          importsByFile.set(imp.file, new Map());
        }
        importsByFile.get(imp.file)!.set(localName, imp);
      }
    }
    logger.debug('Indexed imports', { count: allImports.length });

    // === Step 2: Check for broken imports ===

    for (const imp of allImports) {
      stats.importsChecked++;

      // Progress reporting
      if (onProgress && stats.importsChecked % 100 === 0) {
        onProgress({
          phase: 'validation',
          currentPlugin: 'BrokenImportValidator',
          message: `Checking imports ${stats.importsChecked}/${allImports.length}`,
          totalFiles: allImports.length,
          processedFiles: stats.importsChecked
        });
      }

      // Skip external (npm) imports - only check relative imports
      const isRelative = imp.source &&
        (imp.source.startsWith('./') || imp.source.startsWith('../'));
      if (!isRelative) {
        stats.skipped.externalImports++;
        continue;
      }

      // Skip namespace imports - they link to MODULE, not EXPORT
      if (imp.importType === 'namespace') {
        stats.skipped.namespaceImports++;
        continue;
      }

      // Skip type-only imports (TypeScript) - erased at compile time
      if (imp.importBinding === 'type') {
        stats.skipped.typeOnlyImports++;
        continue;
      }

      // Check for IMPORTS_FROM edge
      const importsFromEdges = await graph.getOutgoingEdges(imp.id, ['IMPORTS_FROM']);

      if (importsFromEdges.length === 0) {
        // No IMPORTS_FROM edge = broken import
        const importedName = imp.imported || imp.local || imp.name;

        errors.push(new ValidationError(
          `Import "${importedName}" from "${imp.source}" - export doesn't exist`,
          ERROR_CODES.BROKEN_IMPORT,
          {
            filePath: imp.file,
            lineNumber: imp.line as number | undefined,
            phase: 'VALIDATION',
            plugin: 'BrokenImportValidator',
            importedName,
            source: imp.source,
            importType: imp.importType,
          },
          `Check if "${importedName}" is exported from "${imp.source}"`,
          'error'
        ));

        stats.brokenImports++;
      }
    }

    logger.debug('Broken imports found', { count: stats.brokenImports });

    // === Step 3: Check for undefined symbols ===

    const callsToCheck: CallNode[] = [];
    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
      const call = node as CallNode;

      // Skip method calls (have object attribute)
      if (call.object) {
        stats.skipped.methodCalls++;
        continue;
      }

      // Skip if already has CALLS edge (resolved)
      const callsEdges = await graph.getOutgoingEdges(call.id, ['CALLS']);
      if (callsEdges.length > 0) {
        stats.skipped.alreadyResolved++;
        continue;
      }

      callsToCheck.push(call);
    }

    logger.debug('Unresolved calls to check', { count: callsToCheck.length });

    for (const call of callsToCheck) {
      stats.callsChecked++;

      const calledName = call.name;
      const file = call.file;

      if (!calledName || !file) continue;

      // Check 1: Is it a local definition?
      const fileDefinitions = definitionsByFile.get(file);
      if (fileDefinitions?.has(calledName)) {
        stats.skipped.localDefinitions++;
        continue;
      }

      // Check 2: Is it imported? (even if broken, that's a different error)
      const fileImports = importsByFile.get(file);
      if (fileImports?.has(calledName)) {
        stats.skipped.imports++;
        continue;
      }

      // Check 3: Is it a global?
      if (this.globalsRegistry.isGlobal(calledName)) {
        stats.skipped.globals++;
        continue;
      }

      // Symbol is undefined
      errors.push(new ValidationError(
        `"${calledName}" is used but not defined or imported`,
        ERROR_CODES.UNDEFINED_SYMBOL,
        {
          filePath: file,
          lineNumber: call.line as number | undefined,
          phase: 'VALIDATION',
          plugin: 'BrokenImportValidator',
          symbol: calledName,
        },
        `Add an import for "${calledName}" or define it locally`,
        'warning' // Warning severity - might be a false positive
      ));

      stats.undefinedSymbols++;
    }

    // === Step 4: Summary ===

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    const summary = {
      importsChecked: stats.importsChecked,
      brokenImports: stats.brokenImports,
      callsChecked: stats.callsChecked,
      undefinedSymbols: stats.undefinedSymbols,
      skipped: stats.skipped,
      totalIssues: stats.brokenImports + stats.undefinedSymbols,
      time: `${totalTime}s`,
    };

    logger.info('Validation complete', summary);

    if (errors.length > 0) {
      logger.warn('Issues found', {
        brokenImports: stats.brokenImports,
        undefinedSymbols: stats.undefinedSymbols,
      });

      // Log first few errors for visibility
      for (const error of errors.slice(0, 5)) {
        if (error.code === ERROR_CODES.BROKEN_IMPORT) {
          logger.error(`[${error.code}] ${error.message}`);
        } else {
          logger.warn(`[${error.code}] ${error.message}`);
        }
      }
      if (errors.length > 5) {
        logger.debug(`... and ${errors.length - 5} more issues`);
      }
    }

    return createSuccessResult(
      { nodes: 0, edges: 0 },
      { summary },
      errors
    );
  }
}
