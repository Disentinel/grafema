/**
 * versionRefEnricher — RFD-75 connascence-of-value vertical, node producer.
 *
 * Emits one `version:ref` node per physical occurrence of a version value that
 * MUST agree with the others that share its logical coordinate (`coord`):
 *
 *   - every `package.json` `version`        → locus "package.version", coord "release"
 *   - every `@grafema/*` dep/peer/optionalDep pin
 *                                            → locus "optionalDeps[<name>]" / "deps[<name>]" / "peerDeps[<name>]",
 *                                              coord = the dependency name
 *   - the git tag (`git describe --tags`)   → locus "git.tag", coord "release"
 *   - the CHANGELOG top entry (first `## [x.y.z]`)
 *                                            → locus "changelog", coord "release"
 *
 * The paired derive packs (version_coords_nodes.dl + version_refs_edges.dl)
 * mint the `version:coord` node per distinct coord and derive the REFERS_TO
 * edge (ref → coord). The `value-lockstep` guarantee then trips when two refs
 * to one coord carry different `value`s — connascence-of-value drift (e.g. cli
 * optionalDeps pinned to a stale version vs the package's own version).
 *
 * Each node carries `value` / `locus` / `coord` in its `metadata` JSON so the
 * lockstep rule reads them via the derive engine's `node_attr` builtin
 * (value/locus/coord are NOT RFDB top-level columns — `attr` would yield zero
 * rows; see the RFD-75 guarantee notes and skill rfdb-batchhandle-deletes-
 * existing-nodes for why we write via direct addNodes, never BatchHandle).
 *
 * Like packageApiEnricher, this writes via direct addNodes (chunked) — NEVER
 * BatchHandle.commit, which would delete pre-existing nodes whose `file` field
 * appears in changedFiles. Node ids are deterministic
 * (`<file>::version:ref::<locus>`) so RFDB dedupes on re-upsert.
 *
 * SCOPE: repo-static loci only. The binary `--version` ref (an ops release
 * hook) is OUT OF SCOPE here — but the graph side is uniform: a future
 * `binary.<name>` ref REFERS_TO the same coord and the lockstep rule needs no
 * change to catch a binary-vs-package mismatch.
 */

import type { RFDBClient } from '@grafema/rfdb-client';
import type { WireNode } from '@grafema/types';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface VersionRefEnrichResult {
  /** Number of `version:ref` nodes created (or re-upserted). */
  nodesCreated: number;
  /** Distinct loci (package.json files + git tag + changelog) scanned. */
  lociScanned: number;
  /** `package.json` `version` refs emitted. */
  packageVersionRefs: number;
  /** `@grafema/*` dependency-pin refs emitted. */
  dependencyRefs: number;
  /** Whether the git tag ref was emitted (1) or not (0 — no tag / not a repo). */
  gitTagRefs: number;
  /** Whether the CHANGELOG top-entry ref was emitted. */
  changelogRefs: number;
}

export interface VersionRefEnrichOptions {
  /** Maximum nodes to flush per addNodes round-trip. */
  flushBatchSize?: number;
  /** Dependency-name prefixes whose pins become coord refs. Defaults to the
   *  internal `@grafema/` scope — the version-lockstep set the RFD targets.
   *  An entry pins a ref for EVERY dependency whose name starts with it. */
  trackedDepPrefixes?: readonly string[];
}

const DEFAULT_FLUSH_BATCH_SIZE = 200;
const DEFAULT_TRACKED_DEP_PREFIXES: readonly string[] = ['@grafema/'];

/** The "release" coordinate: package.version / git.tag / changelog all agree on it. */
const RELEASE_COORD = 'release';

interface PackageJson {
  name?: unknown;
  version?: unknown;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}

/** A dependency section → the locus prefix it contributes. */
const DEP_SECTIONS: ReadonlyArray<{ key: keyof PackageJson; locusKind: string }> = [
  { key: 'dependencies', locusKind: 'deps' },
  { key: 'optionalDependencies', locusKind: 'optionalDeps' },
  { key: 'peerDependencies', locusKind: 'peerDeps' },
];

/**
 * Scan the repo's static version loci and emit `version:ref` nodes.
 *
 * Idempotent: node ids are deterministic (`<file>::version:ref::<locus>`) and
 * the metadata blob is stable, so RFDB dedupes on re-upsert.
 *
 * @param projectPath the repo root — used to find package.json files, the git
 *   tag, and the CHANGELOG. (The graph stores logical paths; version sources
 *   are filesystem reads, so we need the real root — they are not derivable
 *   from analyzer EDB, which is exactly why the enricher mints these nodes.)
 */
export async function enrichVersionRefs(
  client: RFDBClient,
  projectPath: string,
  options?: VersionRefEnrichOptions,
): Promise<VersionRefEnrichResult> {
  const result: VersionRefEnrichResult = {
    nodesCreated: 0,
    lociScanned: 0,
    packageVersionRefs: 0,
    dependencyRefs: 0,
    gitTagRefs: 0,
    changelogRefs: 0,
  };

  const flushSize = options?.flushBatchSize ?? DEFAULT_FLUSH_BATCH_SIZE;
  const trackedPrefixes = options?.trackedDepPrefixes ?? DEFAULT_TRACKED_DEP_PREFIXES;

  const newNodes: WireNode[] = [];
  const seenNodeIds = new Set<string>();

  const pushRef = (file: string, value: string, locus: string, coord: string): void => {
    const id = makeRefNodeId(file, locus);
    if (seenNodeIds.has(id)) return;
    seenNodeIds.add(id);
    newNodes.push({
      id,
      nodeType: 'version:ref' as never,
      // Human-facing label parallels http:route using its path as the name.
      name: value,
      file,
      exported: false,
      metadata: JSON.stringify({ value, locus, coord }),
    });
    result.nodesCreated++;
  };

  // ── package.json loci: own version + tracked dependency pins ──────────────
  for (const pkgJsonPath of discoverPackageJsonFiles(projectPath)) {
    const parsed = readJsonFile(pkgJsonPath);
    if (!parsed) continue;
    result.lociScanned++;
    // Store the path relative to the repo root so the node `file` is stable and
    // matches the logical-path convention the rest of the graph uses.
    const relFile = relativeTo(projectPath, pkgJsonPath);

    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      pushRef(relFile, parsed.version, 'package.version', RELEASE_COORD);
      result.packageVersionRefs++;
    }

    for (const { key, locusKind } of DEP_SECTIONS) {
      const section = parsed[key];
      if (!section || typeof section !== 'object') continue;
      for (const [depName, depVersion] of Object.entries(section as Record<string, unknown>)) {
        if (typeof depVersion !== 'string' || depVersion.length === 0) continue;
        if (!trackedPrefixes.some(p => depName.startsWith(p))) continue;
        // coord = the dependency name: every pin of @grafema/x across the repo
        // (and @grafema/x's own package.version, whose coord is "release", NOT
        // the dep name — distinct coords) must agree among the pins.
        pushRef(relFile, depVersion, `${locusKind}[${depName}]`, depName);
        result.dependencyRefs++;
      }
    }
  }

  // ── git tag locus ─────────────────────────────────────────────────────────
  const gitTag = readGitTag(projectPath);
  if (gitTag) {
    result.lociScanned++;
    pushRef('<git>', gitTag, 'git.tag', RELEASE_COORD);
    result.gitTagRefs = 1;
  }

  // ── CHANGELOG top-entry locus ─────────────────────────────────────────────
  const changelog = readChangelogTopVersion(projectPath);
  if (changelog) {
    result.lociScanned++;
    pushRef(changelog.file, changelog.value, 'changelog', RELEASE_COORD);
    result.changelogRefs = 1;
  }

  for (let i = 0; i < newNodes.length; i += flushSize) {
    await client.addNodes(newNodes.slice(i, i + flushSize));
  }

  return result;
}

/** ---------------------------------------------------------------------------
 *  Source discovery / parsing
 *  ------------------------------------------------------------------------ */

/**
 * Find every package.json under the repo root: the root manifest plus each
 * direct child of `packages/` (the Grafema monorepo layout). We deliberately do
 * NOT recurse into node_modules or nested package dirs — those are vendored or
 * out-of-scope for the repo's own version lockstep.
 */
function discoverPackageJsonFiles(projectPath: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string): void => {
    if (!seen.has(p) && existsSync(p)) {
      seen.add(p);
      out.push(p);
    }
  };

  push(join(projectPath, 'package.json'));

  const packagesDir = join(projectPath, 'packages');
  if (existsSync(packagesDir) && isDirectory(packagesDir)) {
    for (const entry of readdirSync(packagesDir)) {
      if (entry === 'node_modules') continue;
      const childDir = join(packagesDir, entry);
      if (!isDirectory(childDir)) continue;
      push(join(childDir, 'package.json'));
    }
  }

  return out.sort();
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readJsonFile(path: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

/**
 * Read the repo's current git tag via `git describe --tags --abbrev=0` (the
 * most recent tag, exact or ancestor). Returns null when not a git repo, no
 * tags exist, or git is unavailable — git.tag is then simply not a locus.
 *
 * We strip a leading `v` / `rfdb-v` / `binaries-v` prefix so the value compares
 * as a bare semver against package.version (the release.sh tag convention).
 */
function readGitTag(projectPath: string): string | null {
  try {
    const raw = execFileSync('git', ['describe', '--tags', '--abbrev=0'], {
      cwd: projectPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!raw) return null;
    return stripTagPrefix(raw);
  } catch {
    return null;
  }
}

/** Strip the known release tag prefixes, leaving a bare semver. */
function stripTagPrefix(tag: string): string {
  const m = tag.match(/^(?:rfdb-v|binaries-v|v)(.+)$/);
  return m ? m[1] : tag;
}

/**
 * Read the top version of the repo's CHANGELOG — the first `## [x.y.z]` (or
 * `## x.y.z`) heading. Returns null when no CHANGELOG exists or no heading
 * matches.
 */
function readChangelogTopVersion(
  projectPath: string,
): { file: string; value: string } | null {
  const candidates = ['CHANGELOG.md', 'CHANGELOG'];
  for (const name of candidates) {
    const path = join(projectPath, name);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    // First `## [x.y.z]` or `## x.y.z` heading. The semver is captured; an
    // `[Unreleased]` / non-version heading is skipped (no semver match).
    const re = /^##\s*\[?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\]?/m;
    const m = text.match(re);
    if (m) return { file: name, value: m[1] };
  }
  return null;
}

/** ---------------------------------------------------------------------------
 *  Helpers
 *  ------------------------------------------------------------------------ */

function makeRefNodeId(file: string, locus: string): string {
  return `${file || '<unknown>'}::version:ref::${locus}`;
}

/** Render `absPath` relative to `root` (logical-path convention), with a
 *  forward-slash separator. Falls back to the abs path if it is not under root. */
function relativeTo(root: string, absPath: string): string {
  const normRoot = root.endsWith('/') ? root : `${root}/`;
  return absPath.startsWith(normRoot) ? absPath.slice(normRoot.length) : absPath;
}
