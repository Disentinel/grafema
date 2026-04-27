/**
 * vscodeContributesExtractor (REG-1114) — extracts SpecedContractData for
 * `vscode:command` FEATURE nodes by reading the owning extension's
 * `package.json#contributes` declarative manifest.
 *
 * Each `vscode:command` FEATURE is created by libraryCallbackEnricher when
 * the codebase calls `vscode.commands.registerCommand('graf.refresh', handler)`.
 * The user-facing interface for that command — its **title, category,
 * when-clauses, menu placements, keybindings, configuration schema** — lives
 * entirely in `package.json#contributes`, not in the handler signature.
 *
 * Strategy:
 *   1. Take feature.name (the command id, e.g. `graf.refresh`). Defensively
 *      strip surrounding ASCII quotes (single, double, backtick) in case a
 *      future producer leaves them on.
 *   2. Locate the owning extension's package.json. Start from the directory
 *      containing feature.file and walk **upward** to the nearest package.json
 *      whose `contributes.commands[]` includes a matching command id.
 *   3. Parse the matching `contributes.commands[]` entry for title/category.
 *   4. Parse `contributes.menus.*[]` and `contributes.keybindings[]` for
 *      additional placements that target this command id.
 *
 * v1 limitations (track as REG-* follow-up):
 *   - inputs[] is empty: vscode commands take ad-hoc args from the menu /
 *     keybinding context — there is no enumerable schema on the command itself.
 *   - configuration schema (contributes.configuration) is per-extension and
 *     does not target individual commands; not extracted.
 *
 * Returns null when no matching command entry is found in any ancestor
 * package.json. We do NOT pick a package.json that lacks `contributes.commands`
 * — only the closest ancestor whose contributes block actually declares the
 * command counts; otherwise we'd accidentally bind to a workspace-root
 * package.json that has no contributes section.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, parse as parsePath, resolve } from 'node:path';

import type { RFDBClient } from '@grafema/rfdb-client';
import type { WireNode } from '@grafema/types';

import type {
  SpecedContractData,
  SpecedContractExtractor,
  SpecedContractOutput,
} from '../specedContractEnricher.js';

/** Shape of a single contributes.commands[] entry. */
interface ContributesCommand {
  command?: string;
  title?: string;
  category?: string;
  icon?: unknown;
  enablement?: string;
}

/** Shape of a single menus.*[] / keybindings[] entry that we read. */
interface MenuOrKeybindingEntry {
  command?: string;
  when?: string;
  group?: string;
  // keybinding-only:
  key?: string;
  mac?: string;
  linux?: string;
  win?: string;
}

/** Subset of package.json#contributes we read. */
interface Contributes {
  commands?: ContributesCommand[];
  menus?: Record<string, MenuOrKeybindingEntry[]>;
  keybindings?: MenuOrKeybindingEntry[];
}

interface PackageJson {
  contributes?: Contributes;
}

/**
 * Per-invocation cache of parsed package.json files. Keyed by absolute path.
 * `null` means "tried to read, failed or didn't exist" so we don't retry.
 */
type PkgCache = Map<string, PackageJson | null>;

export const vscodeContributesExtractor: SpecedContractExtractor = {
  category: 'vscode:command',
  source: 'vscode-contributes',
  async extract(_client: RFDBClient, feature: WireNode): Promise<SpecedContractData | null> {
    const commandId = stripQuotes(feature.name ?? '');
    if (!commandId) return null;

    const featureFile = feature.file;
    if (!featureFile) return null;

    const cache: PkgCache = new Map();
    const found = findContributesForCommand(featureFile, commandId, cache);
    if (!found) return null;

    return buildContractData(found.command, found.contributes, commandId);
  },
};

/** ---------------------------------------------------------------------------
 *  package.json walking
 *  ------------------------------------------------------------------------ */

/**
 * Walk upward from feature.file to the filesystem root, parsing every
 * package.json we encounter. Return the first one whose
 * `contributes.commands[]` contains the requested command id. Returns null if
 * none is found in any ancestor.
 *
 * "Closest with a matching command" is the right tie-breaker (rather than
 * "closest with any contributes" or "first found"): in a monorepo, a workspace
 * root package.json may not have a contributes section at all, while the
 * extension's package.json (a sub-package) does. We need that sub-package.
 */
function findContributesForCommand(
  featureFile: string,
  commandId: string,
  cache: PkgCache,
): { command: ContributesCommand; contributes: Contributes; pkgPath: string } | null {
  // Resolve to absolute. Relative paths are relative to cwd at analyze time —
  // best effort; if file isn't absolute we still walk from its dirname.
  const startDir = dirname(isAbsolute(featureFile) ? featureFile : resolve(featureFile));
  const root = parsePath(startDir).root;

  let current = startDir;
  // Guard against infinite loops on weird filesystems.
  for (let i = 0; i < 64; i++) {
    const pkgPath = resolve(current, 'package.json');
    const pkg = readPackageJson(pkgPath, cache);
    if (pkg && pkg.contributes && Array.isArray(pkg.contributes.commands)) {
      const cmd = pkg.contributes.commands.find(c => typeof c?.command === 'string' && c.command === commandId);
      if (cmd) {
        return { command: cmd, contributes: pkg.contributes, pkgPath };
      }
    }

    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function readPackageJson(path: string, cache: PkgCache): PackageJson | null {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;

  let pkg: PackageJson | null = null;
  try {
    if (existsSync(path) && statSync(path).isFile()) {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') {
        pkg = parsed as PackageJson;
      }
    }
  } catch {
    pkg = null;
  }
  cache.set(path, pkg);
  return pkg;
}

/** ---------------------------------------------------------------------------
 *  Data assembly
 *  ------------------------------------------------------------------------ */

function buildContractData(
  command: ContributesCommand,
  contributes: Contributes,
  commandId: string,
): SpecedContractData {
  const outputs: SpecedContractOutput[] = [];

  // Primary output row: the user-visible command label, qualified with
  // category if present (matches how VS Code displays it in the palette).
  const title = typeof command.title === 'string' ? command.title : commandId;
  const category = typeof command.category === 'string' ? command.category : undefined;
  const description = category ? `${category}: ${title}` : title;
  outputs.push({ description });

  // Menu placements — one row per `menus.<location>[]` entry that targets
  // this command. Description carries the menu location and `when` clause so
  // consumers can reason about visibility without re-parsing package.json.
  const menus = contributes.menus ?? {};
  for (const [location, entries] of Object.entries(menus)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || entry.command !== commandId) continue;
      const parts = [`menu: ${location}`];
      if (typeof entry.when === 'string' && entry.when.length > 0) parts.push(`when: ${entry.when}`);
      if (typeof entry.group === 'string' && entry.group.length > 0) parts.push(`group: ${entry.group}`);
      outputs.push({ description: parts.join(' | ') });
    }
  }

  // Keybindings — one row per binding that targets this command. We surface
  // the cross-platform key fields together; consumers can split on ' | ' if
  // they need structured access.
  const keybindings = Array.isArray(contributes.keybindings) ? contributes.keybindings : [];
  for (const kb of keybindings) {
    if (!kb || kb.command !== commandId) continue;
    const parts: string[] = ['keybinding'];
    if (typeof kb.key === 'string') parts.push(`key: ${kb.key}`);
    if (typeof kb.mac === 'string') parts.push(`mac: ${kb.mac}`);
    if (typeof kb.linux === 'string') parts.push(`linux: ${kb.linux}`);
    if (typeof kb.win === 'string') parts.push(`win: ${kb.win}`);
    if (typeof kb.when === 'string' && kb.when.length > 0) parts.push(`when: ${kb.when}`);
    outputs.push({ description: parts.join(' | ') });
  }

  return {
    source: 'vscode-contributes',
    inputs: [],
    outputs,
    errors: [],
  };
}

/** ---------------------------------------------------------------------------
 *  Helpers
 *  ------------------------------------------------------------------------ */

/**
 * Strip a single matching pair of surrounding ASCII quotes (single, double,
 * backtick). Mirrors libraryCallbackEnricher.stripQuotes — kept private here
 * to avoid a cross-file dependency between sibling extractors.
 */
function stripQuotes(s: string): string {
  if (s.length < 2) return s;
  const first = s.charCodeAt(0);
  const last = s.charCodeAt(s.length - 1);
  // 0x27 ', 0x22 ", 0x60 `
  if ((first === 0x27 || first === 0x22 || first === 0x60) && first === last) {
    return s.slice(1, -1);
  }
  return s;
}
