/**
 * Perspective Presets — archetype filters for describe tool
 *
 * Shared between MCP and CLI to keep perspectives in sync.
 *
 * @module notation/perspectives
 */

import type { Archetype } from './types.js';

/** Perspective presets map to archetype filters */
export const PERSPECTIVES: Record<string, Archetype[]> = {
  security: ['write', 'exception'],
  data: ['flow_out', 'flow_in', 'write'],
  errors: ['exception'],
  api: ['flow_out', 'publishes', 'depends'],
  events: ['publishes'],
};
