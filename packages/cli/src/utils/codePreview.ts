/**
 * Code Preview Utility
 *
 * Reads source files and extracts code snippets around a given line number
 * for displaying in the explorer UI.
 */

import { readFileSync, existsSync } from 'fs';

export interface CodePreviewOptions {
  file: string;
  line: number;
  contextBefore?: number;  // default: 2
  contextAfter?: number;   // default: 12
}

export interface CodePreviewResult {
  lines: string[];
  startLine: number;
  endLine: number;
}

/**
 * Get a code preview snippet from a source file.
 * Returns lines around the specified line number with context.
 */
export function getCodePreview(options: CodePreviewOptions): CodePreviewResult | null {
  const { file, line, contextBefore = 2, contextAfter = 12 } = options;

  if (!existsSync(file)) {
    return null;
  }

  try {
    const content = readFileSync(file, 'utf-8');
    const allLines = content.split('\n');

    // Calculate range (1-indexed)
    const startLine = Math.max(1, line - contextBefore);
    const endLine = Math.min(allLines.length, line + contextAfter);

    // Extract lines (convert to 0-indexed for array access)
    const lines = allLines.slice(startLine - 1, endLine);

    return {
      lines,
      startLine,
      endLine
    };
  } catch {
    return null;
  }
}

/**
 * Format code preview lines with line numbers for display.
 * Returns an array of formatted strings like "  42 | code here"
 */
export function formatCodePreview(
  preview: CodePreviewResult,
  highlightLine?: number
): string[] {
  const { lines, startLine } = preview;
  const maxLineNum = startLine + lines.length - 1;
  const lineNumWidth = String(maxLineNum).length;

  return lines.map((line, index) => {
    const lineNum = startLine + index;
    const paddedNum = String(lineNum).padStart(lineNumWidth, ' ');
    const prefix = highlightLine === lineNum ? '>' : ' ';

    // Truncate very long lines
    const displayLine = line.length > 80 ? line.slice(0, 77) + '...' : line;

    return `${prefix}${paddedNum} | ${displayLine}`;
  });
}
