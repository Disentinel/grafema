/**
 * Grafema instruction documents for AI agents.
 *
 * Instructions are markdown documents that guide agent behavior.
 * They are read at runtime from the installed package.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Get the onboarding instruction document.
 *
 * Returns the full markdown text of the onboarding procedure
 * that guides an AI agent through project study and configuration.
 */
export function getOnboardingInstruction(): string {
  return readFileSync(join(__dirname, 'onboarding.md'), 'utf-8');
}
