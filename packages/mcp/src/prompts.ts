/**
 * MCP Prompts handler logic.
 * Extracted for testability — server.ts is a thin wrapper.
 */
import { getOnboardingInstruction } from '@grafema/core';

export interface PromptDefinition {
  name: string;
  description: string;
  arguments: Array<{ name: string; description: string; required?: boolean }>;
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

export interface PromptResult {
  [x: string]: unknown;
  description: string;
  messages: PromptMessage[];
  _meta?: Record<string, unknown>;
}

export const PROMPTS: PromptDefinition[] = [
  {
    name: 'onboard_project',
    description:
      'Step-by-step instructions for studying a new project and ' +
      'configuring Grafema for analysis. Use this when setting up ' +
      'Grafema for the first time on a project.',
    arguments: [],
  },
];

export function getPrompt(name: string): PromptResult {
  if (name === 'onboard_project') {
    const instruction = getOnboardingInstruction();
    return {
      description: PROMPTS[0].description,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: instruction,
          },
        },
      ],
    };
  }

  throw new Error(
    `Unknown prompt: ${name}. Available prompts: ${PROMPTS.map(p => p.name).join(', ')}`
  );
}
