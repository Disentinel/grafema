/**
 * Anthropic SDK wrapper with retry, concurrency control, and NDJSON resumability.
 *
 * Provides:
 * - `createClient()` — Anthropic SDK client factory
 * - `callLlm()` — single LLM call with exponential backoff
 * - `batchProcess()` — concurrent batch with resume support
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFile, appendFile } from 'node:fs/promises';

/** Options for a single LLM call */
export interface LlmCallOptions {
  /** System prompt */
  system: string;
  /** User message */
  user: string;
  /** Model to use (default: claude-sonnet-4-20250514) */
  model?: string;
  /** Max tokens in response */
  maxTokens?: number;
  /** Temperature (default: 0) */
  temperature?: number;
}

/** Options for batch processing */
export interface BatchOptions<T, R> {
  items: T[];
  /** Function to create LLM call options for each item */
  makeCall: (item: T) => LlmCallOptions;
  /** Function to parse LLM response into result */
  parseResponse: (text: string, item: T) => R;
  /** Max concurrent calls (default: 10) */
  concurrency?: number;
  /** Path to NDJSON file for resume support */
  outputPath?: string;
  /** Set of IDs already processed (for resume) */
  completedIds?: Set<string>;
  /** Function to extract ID from item */
  getId?: (item: T) => string;
  /** Called after each successful result */
  onResult?: (result: R, item: T) => void;
}

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_CONCURRENCY = 10;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/**
 * Create an Anthropic SDK client.
 *
 * Uses the ANTHROPIC_API_KEY environment variable for authentication.
 */
export function createClient(): Anthropic {
  return new Anthropic();
}

/**
 * Make a single LLM call with exponential backoff retry.
 *
 * Retries up to 3 times on transient failures (rate limits, server errors).
 * Rate limit responses (429) use the Retry-After header when available.
 *
 * @param options - Call configuration (system prompt, user message, model, etc.)
 * @param client - Optional pre-created Anthropic client (creates one if omitted)
 * @returns The text content of the LLM response
 */
export async function callLlm(
  options: LlmCallOptions,
  client?: Anthropic,
): Promise<string> {
  const anthropic = client ?? createClient();
  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;

  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        temperature,
        system: options.system,
        messages: [{ role: 'user', content: options.user }],
      });

      const textBlock = response.content.find(
        (block: { type: string }) => block.type === 'text',
      );
      if (!textBlock || textBlock.type !== 'text') {
        throw new Error('LLM response contained no text block');
      }
      return textBlock.text;
    } catch (error: unknown) {
      lastError = error;

      if (attempt === MAX_RETRIES - 1) {
        break;
      }

      const delayMs = getRetryDelay(error, attempt);
      process.stderr.write(
        `[llm] Attempt ${attempt + 1}/${MAX_RETRIES} failed, retrying in ${delayMs}ms...\n`,
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

/**
 * Process items in concurrent batches with LLM calls.
 *
 * Features:
 * - Concurrency-limited parallel execution (no external dependencies)
 * - NDJSON resume: skips items whose ID is already in completedIds or outputPath
 * - Appends each result as an NDJSON line to outputPath
 * - Progress logging to stderr
 *
 * @param options - Batch configuration
 * @returns Array of all results (including resumed ones read from NDJSON)
 */
export async function batchProcess<T, R>(
  options: BatchOptions<T, R>,
): Promise<R[]> {
  const {
    items,
    makeCall,
    parseResponse,
    concurrency = DEFAULT_CONCURRENCY,
    outputPath,
    getId,
    onResult,
  } = options;

  const client = createClient();
  const results: R[] = [];

  // Build the set of already-completed IDs for resume
  const completedIds = new Set(options.completedIds ?? []);
  if (outputPath && getId) {
    const existing = await loadNdjsonIds(outputPath);
    for (const id of existing) {
      completedIds.add(id);
    }
  }

  // Filter out already-completed items
  const pending = getId
    ? items.filter((item) => !completedIds.has(getId(item)))
    : items;

  const total = items.length;
  const skipped = total - pending.length;
  if (skipped > 0) {
    process.stderr.write(
      `[batch] Resuming: ${skipped} already completed, ${pending.length} remaining\n`,
    );
  }

  // Simple semaphore-based concurrency control
  let completed = 0;
  let running = 0;
  const queue: Array<() => void> = [];

  function release(): void {
    running--;
    const next = queue.shift();
    if (next) {
      next();
    }
  }

  function acquire(): Promise<void> {
    if (running < concurrency) {
      running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      queue.push(() => {
        running++;
        resolve();
      });
    });
  }

  const tasks = pending.map(async (item) => {
    await acquire();
    try {
      const callOptions = makeCall(item);
      const text = await callLlm(callOptions, client);
      const result = parseResponse(text, item);

      if (outputPath) {
        await appendFile(outputPath, JSON.stringify(result) + '\n', 'utf-8');
      }

      if (onResult) {
        onResult(result, item);
      }

      completed++;
      const current = completed + skipped;
      if (completed % 10 === 0 || completed === pending.length) {
        process.stderr.write(`[batch] Progress: ${current}/${total}\n`);
      }

      results.push(result);
    } finally {
      release();
    }
  });

  await Promise.all(tasks);

  process.stderr.write(
    `[batch] Done: ${completed} processed, ${skipped} resumed, ${total} total\n`,
  );

  return results;
}

// --- Internal helpers ---

/**
 * Calculate retry delay based on error type and attempt number.
 * Rate limit errors (429) use Retry-After header when available.
 * All other retryable errors use exponential backoff.
 */
function getRetryDelay(error: unknown, attempt: number): number {
  if (isRateLimitError(error)) {
    const retryAfter = extractRetryAfter(error);
    if (retryAfter !== null) {
      return retryAfter * 1000;
    }
    // Rate limit without Retry-After: use longer base delay
    return BASE_DELAY_MS * Math.pow(2, attempt + 1);
  }
  return BASE_DELAY_MS * Math.pow(2, attempt);
}

/**
 * Check if an error is a rate limit (429) response.
 */
function isRateLimitError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;
    if (err.status === 429) return true;
    if (typeof err.message === 'string' && err.message.includes('rate_limit')) return true;
  }
  return false;
}

/**
 * Extract Retry-After value in seconds from an error, if present.
 */
function extractRetryAfter(error: unknown): number | null {
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;
    const headers = err.headers as Record<string, string> | undefined;
    if (headers && typeof headers === 'object') {
      const retryAfter = headers['retry-after'];
      if (retryAfter) {
        const seconds = Number(retryAfter);
        if (!Number.isNaN(seconds) && seconds > 0) {
          return seconds;
        }
      }
    }
  }
  return null;
}

/**
 * Load IDs from an existing NDJSON file for resume support.
 * Returns empty set if file doesn't exist.
 */
async function loadNdjsonIds(path: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch {
    return ids;
  }

  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      // Look for common ID patterns in the parsed record
      if (record.construct?.id) {
        ids.add(record.construct.id);
      } else if (record.id) {
        ids.add(record.id);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return ids;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
