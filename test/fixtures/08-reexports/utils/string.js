/**
 * String utilities
 */

export function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function lowercase(str) {
  return str.toLowerCase();
}

export function trim(str) {
  return str.trim();
}
