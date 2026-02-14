/**
 * ESM resolve hook for custom Grafema plugins.
 *
 * Allows plugins in .grafema/plugins/ to `import { Plugin } from '@grafema/core'`
 * without requiring @grafema/core in the target project's node_modules/.
 *
 * The hook maps @grafema/* bare specifiers to the actual package URLs
 * within the CLI's dependency tree.
 *
 * Registered via module.register() before loading custom plugins.
 * Must be plain JS — loader hooks run in a separate thread.
 */

/** @type {Record<string, string>} package name → resolved file URL */
let grafemaPackages = {};

/**
 * Called once when the hook is registered via module.register().
 * @param {{ grafemaPackages: Record<string, string> }} data
 */
export function initialize(data) {
  grafemaPackages = data.grafemaPackages;
}

/**
 * Resolve hook — intercepts bare specifier imports for @grafema/* packages
 * and redirects them to the CLI's bundled versions.
 *
 * Only exact package name matches are handled (e.g. '@grafema/core').
 * All other specifiers pass through to the default resolver.
 */
export function resolve(specifier, context, next) {
  if (grafemaPackages[specifier]) {
    return { url: grafemaPackages[specifier], shortCircuit: true };
  }

  return next(specifier, context);
}
