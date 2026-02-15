/**
 * Plugin loading — resolves built-in and custom plugins from config.
 *
 * Handles:
 * - ESM resolve hook for custom plugin @grafema/* imports
 * - Loading custom plugins from .grafema/plugins/
 * - Creating plugin instances from config phases
 */

import { join } from 'path';
import { existsSync, readdirSync } from 'fs';
import { pathToFileURL } from 'url';
import { register } from 'node:module';
import type { Plugin, GrafemaConfig } from '@grafema/core';
import { BUILTIN_PLUGINS } from './builtinPlugins.js';

/**
 * Register ESM resolve hook so custom plugins can import @grafema/* packages.
 *
 * Plugins in .grafema/plugins/ do `import { Plugin } from '@grafema/core'`,
 * but @grafema/core isn't in the target project's node_modules/.
 * This hook redirects those imports to the CLI's bundled packages.
 *
 * Uses module.register() (stable Node.js 20.6+ API).
 * Safe to call multiple times — subsequent calls add redundant hooks
 * that short-circuit on the same specifiers.
 */
let pluginResolverRegistered = false;

export function registerPluginResolver(): void {
  if (pluginResolverRegistered) return;
  pluginResolverRegistered = true;

  const grafemaPackages: Record<string, string> = {};
  for (const pkg of ['@grafema/core', '@grafema/types']) {
    try {
      grafemaPackages[pkg] = import.meta.resolve(pkg);
    } catch {
      // Package not available from CLI context — skip
    }
  }

  register(
    new URL('./pluginResolver.js', import.meta.url),
    { data: { grafemaPackages } },
  );
}

/**
 * Load custom plugins from .grafema/plugins/ directory
 */
export async function loadCustomPlugins(
  projectPath: string,
  log: (msg: string) => void
): Promise<Record<string, () => Plugin>> {
  const pluginsDir = join(projectPath, '.grafema', 'plugins');
  if (!existsSync(pluginsDir)) {
    return {};
  }

  // Ensure @grafema/* imports resolve for custom plugins (REG-380)
  registerPluginResolver();

  const customPlugins: Record<string, () => Plugin> = {};

  try {
    const files = readdirSync(pluginsDir).filter(
      (f) => f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.cjs')
    );

    for (const file of files) {
      try {
        const pluginPath = join(pluginsDir, file);
        const pluginUrl = pathToFileURL(pluginPath).href;
        const module = await import(pluginUrl);

        const PluginClass = module.default || module[file.replace(/\.[cm]?js$/, '')];
        if (PluginClass && typeof PluginClass === 'function') {
          const pluginName = PluginClass.name || file.replace(/\.[cm]?js$/, '');
          customPlugins[pluginName] = () => {
            const instance = new PluginClass() as Plugin;
            instance.config.sourceFile = pluginPath;
            return instance;
          };
          log(`Loaded custom plugin: ${pluginName}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`Failed to load plugin ${file}: ${message}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Error loading custom plugins: ${message}`);
  }

  return customPlugins;
}

export function createPlugins(
  config: GrafemaConfig['plugins'],
  customPlugins: Record<string, () => Plugin> = {},
  verbose: boolean = false
): Plugin[] {
  const plugins: Plugin[] = [];
  const phases: (keyof GrafemaConfig['plugins'])[] = ['discovery', 'indexing', 'analysis', 'enrichment', 'validation'];

  for (const phase of phases) {
    const names = config[phase] || [];
    for (const name of names) {
      // Check built-in first, then custom
      const factory = BUILTIN_PLUGINS[name] || customPlugins[name];
      if (factory) {
        plugins.push(factory());
      } else if (verbose) {
        // Only show plugin warning in verbose mode
        console.warn(`Plugin not found: ${name} (skipping). Check .grafema/config.yaml or add to .grafema/plugins/`);
      }
    }
  }

  return plugins;
}
