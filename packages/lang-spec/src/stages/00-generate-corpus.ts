/**
 * Stage 00 — Generate Corpus
 *
 * Generates corpus fixture files for a new language using LLM.
 * For each category in the language descriptor, prompts the LLM to produce
 * a source file containing representative @construct blocks.
 *
 * Input:  LanguageDescriptor + system prompt at src/prompts/corpus-generation.md
 * Output: corpus directory with src/ containing one file per category,
 *         plus package.json and index file
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callLlm } from '../lib/llm.js';
import type { LanguageDescriptor } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load the corpus generation system prompt from src/prompts/.
 */
async function loadSystemPrompt(): Promise<string> {
  const promptPath = join(__dirname, '..', 'prompts', 'corpus-generation.md');
  return readFile(promptPath, 'utf-8');
}

/**
 * Strip markdown code fences from LLM response if present.
 *
 * Handles ```lang ... ``` wrapping that LLMs sometimes add.
 */
function extractCode(response: string): string {
  const fencePattern = /^```[\w]*\n([\s\S]*?)```\s*$/;
  const match = response.match(fencePattern);
  if (match) {
    return match[1];
  }
  return response;
}

/**
 * Build the set of all categories (base + plugin) from a descriptor.
 */
function getAllCategories(
  descriptor: LanguageDescriptor,
): Array<{ name: string; plugin?: string }> {
  const categories: Array<{ name: string; plugin?: string }> = [];

  for (const cat of descriptor.categories) {
    categories.push({ name: cat });
  }

  if (descriptor.pluginCategories) {
    for (const pc of descriptor.pluginCategories) {
      categories.push({ name: pc.name, plugin: pc.plugin });
    }
  }

  return categories;
}

/**
 * Generate corpus fixture files for a language using LLM.
 *
 * For each category in the descriptor (both base and plugin), calls the LLM
 * to produce a source file with @construct markers, then writes it to the
 * output directory. Also creates a package.json and an index file that
 * imports all generated files.
 *
 * @param descriptor - Language descriptor defining categories, syntax, etc.
 * @param outputDir - Directory to write the generated corpus into
 */
export async function generateCorpus(
  descriptor: LanguageDescriptor,
  outputDir: string,
): Promise<void> {
  const systemPrompt = await loadSystemPrompt();
  const srcDir = join(outputDir, 'src');
  await mkdir(srcDir, { recursive: true });

  const ext = descriptor.fileExtensions[0].replace(/^\./, '');
  const categories = getAllCategories(descriptor);
  const generatedFiles: string[] = [];

  for (const category of categories) {
    const userMessage = buildUserMessage(descriptor, category);
    const response = await callLlm({
      system: systemPrompt,
      user: userMessage,
      model: 'claude-sonnet-4-20250514',
      maxTokens: 8192,
    });

    const code = extractCode(response);
    const fileName = `${category.name}.${ext}`;
    const filePath = join(srcDir, fileName);
    await writeFile(filePath, code, 'utf-8');
    generatedFiles.push(fileName);

    process.stderr.write(
      `[generate] Created ${fileName} (${code.split('\n').length} lines)\n`,
    );
  }

  // Create package.json
  const packageJson = {
    name: `${descriptor.name}-corpus`,
    version: '0.0.1',
    main: `src/index.${ext}`,
    private: true,
  };
  await writeFile(
    join(outputDir, 'package.json'),
    JSON.stringify(packageJson, null, 2) + '\n',
    'utf-8',
  );

  // Create index file that imports all generated files
  const indexContent = buildIndexFile(generatedFiles, descriptor, ext);
  await writeFile(join(srcDir, `index.${ext}`), indexContent, 'utf-8');

  process.stderr.write(
    `[generate] Corpus generated: ${generatedFiles.length} category files in ${srcDir}\n`,
  );
}

/**
 * Build the user message for a single category generation call.
 */
function buildUserMessage(
  descriptor: LanguageDescriptor,
  category: { name: string; plugin?: string },
): string {
  const parts = [
    `Language: ${descriptor.name}`,
    `Version: ${descriptor.version}`,
    `Category: ${category.name}`,
    `File extension: ${descriptor.fileExtensions[0]}`,
    `Comment syntax:`,
    `  Line: ${descriptor.commentSyntax.line}`,
    `  Block start: ${descriptor.commentSyntax.blockStart}`,
    `  Block end: ${descriptor.commentSyntax.blockEnd}`,
  ];

  if (category.plugin) {
    parts.push(`Plugin context: ${category.plugin}`);
  }

  if (descriptor.moduleTypes && descriptor.moduleTypes.length > 0) {
    parts.push(`Module types: ${descriptor.moduleTypes.join(', ')}`);
  }

  if (descriptor.specReference) {
    parts.push(`Spec reference: ${descriptor.specReference}`);
  }

  parts.push(
    '',
    'Generate a comprehensive corpus file for this category.',
    'Each construct must have a @construct PENDING marker.',
    'Cover edge cases, common patterns, and unusual but valid syntax.',
  );

  return parts.join('\n');
}

/**
 * Build the index file content that imports all generated category files.
 */
function buildIndexFile(
  files: string[],
  descriptor: LanguageDescriptor,
  ext: string,
): string {
  const commentLine = descriptor.commentSyntax.line;
  const lines = [
    `${commentLine} Auto-generated index file for ${descriptor.name} corpus`,
    `${commentLine} Imports all category files for analysis`,
    '',
  ];

  for (const file of files) {
    const baseName = file.replace(`.${ext}`, '');
    // Use require for CJS-style, import for ESM-style
    if (ext === 'py') {
      lines.push(`import ${baseName}`);
    } else if (
      descriptor.moduleTypes?.includes('cjs') &&
      !descriptor.moduleTypes?.includes('esm')
    ) {
      lines.push(`require('./${baseName}');`);
    } else {
      lines.push(`import './${baseName}.${ext}';`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
