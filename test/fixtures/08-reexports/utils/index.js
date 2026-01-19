/**
 * Barrel file - re-exports from other modules
 * This pattern is common in libraries to provide clean public API
 */

// Re-export everything from math.js
export * from './math.js';

// Re-export everything from string.js
export * from './string.js';

// Named re-export
export { helper } from './helpers.js';
