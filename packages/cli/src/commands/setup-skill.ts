/**
 * Setup-skill command - Install Grafema Agent Skill into a project
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync, mkdirSync, readFileSync, cpSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/** Default install paths per platform */
const PLATFORM_PATHS: Record<string, string> = {
  claude: '.claude/skills',
  gemini: '.gemini/skills',
  cursor: '.cursor/skills',
};

const SKILL_DIR_NAME = 'grafema-codebase-analysis';

interface SetupSkillOptions {
  outputDir?: string;
  platform?: string;
  force?: boolean;
}

/**
 * Get the bundled skill source directory.
 * In the published package, skills/ is at the package root alongside dist/.
 */
function getSkillSourceDir(): string {
  // __dirname is dist/commands/ -> go up to package root, then into skills/
  return join(__dirname, '..', '..', 'skills', SKILL_DIR_NAME);
}

/**
 * Read version from skill metadata.
 */
function getSkillVersion(skillDir: string): string | null {
  const skillMd = join(skillDir, 'SKILL.md');
  if (!existsSync(skillMd)) return null;

  const content = readFileSync(skillMd, 'utf-8');
  const versionMatch = content.match(/version:\s*"?([^"\n]+)"?/);
  return versionMatch ? versionMatch[1].trim() : null;
}

/**
 * Resolve the target directory for skill installation.
 */
function resolveTargetDir(projectPath: string, options: SetupSkillOptions): string {
  if (options.outputDir) {
    return resolve(options.outputDir, SKILL_DIR_NAME);
  }

  const platform = options.platform || 'claude';
  const basePath = PLATFORM_PATHS[platform];
  if (!basePath) {
    throw new Error(
      `Unknown platform: ${platform}. Supported: ${Object.keys(PLATFORM_PATHS).join(', ')}`
    );
  }

  return join(projectPath, basePath, SKILL_DIR_NAME);
}

/**
 * Copy skill directory recursively.
 */
function copySkill(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true });
}

/**
 * Install the Grafema Agent Skill into a project directory.
 * Returns true if skill was installed, false if skipped.
 */
export function installSkill(projectPath: string, options: SetupSkillOptions = {}): boolean {
  const sourceDir = getSkillSourceDir();

  if (!existsSync(sourceDir)) {
    throw new Error(`Skill source not found at ${sourceDir}. Package may be corrupted.`);
  }

  const targetDir = resolveTargetDir(projectPath, options);

  // Check if already installed
  if (existsSync(targetDir) && !options.force) {
    const installedVersion = getSkillVersion(targetDir);
    const sourceVersion = getSkillVersion(sourceDir);

    if (installedVersion === sourceVersion) {
      return false; // Same version, skip
    }

    // Different version — warn but don't overwrite without --force
    console.log(`  Skill exists (v${installedVersion}), latest is v${sourceVersion}`);
    console.log('  Use --force to update, or run: grafema setup-skill --force');
    return false;
  }

  copySkill(sourceDir, targetDir);
  return true;
}

export const setupSkillCommand = new Command('setup-skill')
  .description('Install Grafema Agent Skill into your project')
  .argument('[path]', 'Project path', '.')
  .option('--output-dir <path>', 'Custom output directory (overrides --platform)')
  .option('--platform <name>', 'Target platform: claude, gemini, cursor', 'claude')
  .option('-f, --force', 'Overwrite existing skill')
  .addHelpText('after', `
Examples:
  grafema setup-skill                     Install for Claude Code (.claude/skills/)
  grafema setup-skill --platform gemini   Install for Gemini CLI (.gemini/skills/)
  grafema setup-skill --force             Update existing skill
  grafema setup-skill --output-dir ./my-skills/
`)
  .action(async (path: string, options: SetupSkillOptions) => {
    const projectPath = resolve(path);
    const sourceDir = getSkillSourceDir();

    if (!existsSync(sourceDir)) {
      console.error('✗ Skill source not found. Package may be corrupted.');
      process.exit(1);
    }

    const targetDir = resolveTargetDir(projectPath, options);

    // Check if already installed
    if (existsSync(targetDir) && !options.force) {
      const installedVersion = getSkillVersion(targetDir);
      const sourceVersion = getSkillVersion(sourceDir);

      if (installedVersion === sourceVersion) {
        console.log(`✓ Grafema skill already installed (v${installedVersion})`);
        console.log(`  Location: ${targetDir}`);
        return;
      }

      console.log(`  Skill exists (v${installedVersion}), latest is v${sourceVersion}`);
      console.log('  Use --force to update');
      return;
    }

    try {
      copySkill(sourceDir, targetDir);
    } catch (err) {
      console.error('✗ Failed to install skill:', (err as Error).message);
      process.exit(1);
    }

    const sourceVersion = getSkillVersion(sourceDir);
    console.log(`✓ Grafema skill installed (v${sourceVersion})`);
    console.log(`  Location: ${targetDir}`);
    console.log('');
    console.log('Next steps:');
    console.log('  1. Ensure Grafema MCP server is configured in your AI agent');
    console.log('  2. Run "grafema analyze" to build the code graph');
    console.log('  3. Your AI agent will now prefer graph queries over reading files');
  });
