/**
 * Entry point that imports from barrel file
 */

import { add, multiply } from './utils/index.js';
import { capitalize } from './utils/index.js';

export function calculate(a, b) {
  return add(a, b) + multiply(a, b);
}

export function formatName(name) {
  return capitalize(name);
}
