/**
 * MCP Coverage Handlers
 */

import { getOrCreateBackend, getProjectPath } from '../state.js';
import { CoverageAnalyzer } from '@grafema/core';
import {
  textResult,
  errorResult,
} from '../utils.js';
import type {
  ToolResult,
  GetCoverageArgs,
} from '../types.js';

// === COVERAGE ===

export async function handleGetCoverage(args: GetCoverageArgs): Promise<ToolResult> {
  const db = await getOrCreateBackend();
  const projectPath = getProjectPath();
  const { path: targetPath = projectPath } = args;

  try {
    const analyzer = new CoverageAnalyzer(db, targetPath);
    const result = await analyzer.analyze();

    // Format output for AI agents
    let output = `Analysis Coverage for ${targetPath}\n`;
    output += `==============================\n\n`;

    output += `File breakdown:\n`;
    output += `  Total files:     ${result.total}\n`;
    output += `  Analyzed:        ${result.analyzed.count} (${result.percentages.analyzed}%) - in graph\n`;
    output += `  Unsupported:     ${result.unsupported.count} (${result.percentages.unsupported}%) - no indexer available\n`;
    output += `  Unreachable:     ${result.unreachable.count} (${result.percentages.unreachable}%) - not imported from entrypoints\n`;

    if (result.unsupported.count > 0) {
      output += `\nUnsupported files by extension:\n`;
      for (const [ext, files] of Object.entries(result.unsupported.byExtension)) {
        output += `  ${ext}: ${files.length} files\n`;
      }
    }

    if (result.unreachable.count > 0) {
      output += `\nUnreachable source files:\n`;
      for (const [ext, files] of Object.entries(result.unreachable.byExtension)) {
        output += `  ${ext}: ${files.length} files\n`;
      }
    }

    return textResult(output);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to calculate coverage: ${message}`);
  }
}
