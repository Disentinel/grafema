/**
 * Git Query Functions for KnowledgeBase
 *
 * Provides analytical queries over git data (COMMIT, AUTHOR nodes)
 * stored in the KnowledgeBase. Operates on KBNode arrays loaded from
 * YAML files into the KB index.
 *
 * COMMIT nodes carry raw YAML fields: hash, message, author_ref, date, files.
 * AUTHOR nodes carry: name, emails, aliases.
 * These are accessed via type assertion since they're extra properties
 * on KBNode objects loaded from YAML frontmatter.
 */

import type { KBNode } from './types.js';
import type { KnowledgeBase } from './KnowledgeBase.js';

// -- Public result types --

export interface ChurnEntry {
  path: string;
  changeCount: number;
  totalAdded: number;
  totalRemoved: number;
}

export interface CoChangeEntry {
  path: string;
  coChangeCount: number;
  support: number;
}

export interface OwnershipEntry {
  authorId: string;
  authorName: string;
  commits: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface ArchaeologyEntry {
  path: string;
  lastCommitHash: string;
  lastCommitDate: string;
  lastAuthor: string;
  firstCommitDate: string;
  firstAuthor: string;
}

// -- Internal raw-data accessors --

interface RawCommitFile {
  path: string;
  added: number;
  removed: number;
}

function getCommitHash(node: KBNode): string {
  return (node as any).hash ?? '';
}

function getCommitDate(node: KBNode): string {
  return (node as any).date ?? '';
}

function getCommitFiles(node: KBNode): RawCommitFile[] {
  return (node as any).files ?? [];
}

function getCommitAuthorRef(node: KBNode): string {
  return (node as any).author_ref ?? '';
}

function getAuthorName(node: KBNode): string {
  return (node as any).name ?? '';
}

// -- Query functions --

/**
 * Compute file churn: how many commits touch each file and total lines added/removed.
 *
 * @param kb - KnowledgeBase instance (must be loaded)
 * @param opts.limit - Return only the top N entries
 * @param opts.since - ISO date string; only consider commits on or after this date
 * @returns Churn entries sorted by changeCount descending
 */
export async function getChurn(
  kb: KnowledgeBase,
  opts?: { limit?: number; since?: string },
): Promise<ChurnEntry[]> {
  const commits = await kb.queryNodes({ type: 'COMMIT' });

  const filtered = opts?.since
    ? commits.filter(c => getCommitDate(c) >= opts.since!)
    : commits;

  const map = new Map<string, ChurnEntry>();

  for (const commit of filtered) {
    for (const file of getCommitFiles(commit)) {
      let entry = map.get(file.path);
      if (!entry) {
        entry = { path: file.path, changeCount: 0, totalAdded: 0, totalRemoved: 0 };
        map.set(file.path, entry);
      }
      entry.changeCount += 1;
      entry.totalAdded += file.added;
      entry.totalRemoved += file.removed;
    }
  }

  const sorted = Array.from(map.values()).sort((a, b) => b.changeCount - a.changeCount);

  return opts?.limit ? sorted.slice(0, opts.limit) : sorted;
}

/**
 * Find files that frequently change together with the given file.
 *
 * For every commit that touches `filePath`, counts how many of those commits
 * also touch each other file. `support` is the ratio of co-change count to
 * the total number of commits touching `filePath`.
 *
 * @param kb - KnowledgeBase instance (must be loaded)
 * @param filePath - The file to find co-changes for
 * @param opts.minSupport - Minimum support threshold (default 0.1 = 10%)
 * @returns Co-change entries sorted by coChangeCount descending
 */
export async function getCoChanges(
  kb: KnowledgeBase,
  filePath: string,
  opts?: { minSupport?: number },
): Promise<CoChangeEntry[]> {
  const commits = await kb.queryNodes({ type: 'COMMIT' });
  const minSupport = opts?.minSupport ?? 0.1;

  // Find commits that touch the target file
  const touchingCommits = commits.filter(c =>
    getCommitFiles(c).some(f => f.path === filePath),
  );

  const totalTouching = touchingCommits.length;
  if (totalTouching === 0) return [];

  // Count co-occurrences of other files
  const coMap = new Map<string, number>();

  for (const commit of touchingCommits) {
    for (const file of getCommitFiles(commit)) {
      if (file.path === filePath) continue;
      coMap.set(file.path, (coMap.get(file.path) ?? 0) + 1);
    }
  }

  const entries: CoChangeEntry[] = [];

  for (const [path, count] of coMap) {
    const support = count / totalTouching;
    if (support >= minSupport) {
      entries.push({ path, coChangeCount: count, support });
    }
  }

  return entries.sort((a, b) => b.coChangeCount - a.coChangeCount);
}

/**
 * Compute ownership of a file: who committed changes and how much.
 *
 * Groups commits touching `filePath` by author_ref, sums commit count and
 * lines added/removed. Looks up author names from AUTHOR nodes in the KB.
 *
 * @param kb - KnowledgeBase instance (must be loaded)
 * @param filePath - The file to compute ownership for
 * @returns Ownership entries sorted by commits descending
 */
export async function getOwnership(
  kb: KnowledgeBase,
  filePath: string,
): Promise<OwnershipEntry[]> {
  const commits = await kb.queryNodes({ type: 'COMMIT' });
  const authors = await kb.queryNodes({ type: 'AUTHOR' });

  // Build author name lookup: id -> name
  const authorNameById = new Map<string, string>();
  for (const author of authors) {
    authorNameById.set(author.id, getAuthorName(author));
  }

  // Accumulate per-author stats
  const map = new Map<string, { commits: number; linesAdded: number; linesRemoved: number }>();

  for (const commit of commits) {
    const files = getCommitFiles(commit);
    const fileEntry = files.find(f => f.path === filePath);
    if (!fileEntry) continue;

    const authorRef = getCommitAuthorRef(commit);
    let stats = map.get(authorRef);
    if (!stats) {
      stats = { commits: 0, linesAdded: 0, linesRemoved: 0 };
      map.set(authorRef, stats);
    }
    stats.commits += 1;
    stats.linesAdded += fileEntry.added;
    stats.linesRemoved += fileEntry.removed;
  }

  const entries: OwnershipEntry[] = [];

  for (const [authorId, stats] of map) {
    entries.push({
      authorId,
      authorName: authorNameById.get(authorId) ?? authorId,
      commits: stats.commits,
      linesAdded: stats.linesAdded,
      linesRemoved: stats.linesRemoved,
    });
  }

  return entries.sort((a, b) => b.commits - a.commits);
}

/**
 * Dig into the history of a file: when it was first created, last modified, and by whom.
 *
 * @param kb - KnowledgeBase instance (must be loaded)
 * @param filePath - The file to investigate
 * @returns Archaeology entry with first/last commit info, or empty strings if no commits found
 */
export async function getArchaeology(
  kb: KnowledgeBase,
  filePath: string,
): Promise<ArchaeologyEntry> {
  const commits = await kb.queryNodes({ type: 'COMMIT' });

  // Filter to commits touching this file
  const touching = commits.filter(c =>
    getCommitFiles(c).some(f => f.path === filePath),
  );

  if (touching.length === 0) {
    return {
      path: filePath,
      lastCommitHash: '',
      lastCommitDate: '',
      lastAuthor: '',
      firstCommitDate: '',
      firstAuthor: '',
    };
  }

  // Sort by date ascending
  const sorted = touching.sort((a, b) =>
    getCommitDate(a).localeCompare(getCommitDate(b)),
  );

  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  return {
    path: filePath,
    lastCommitHash: getCommitHash(last),
    lastCommitDate: getCommitDate(last),
    lastAuthor: getCommitAuthorRef(last),
    firstCommitDate: getCommitDate(first),
    firstAuthor: getCommitAuthorRef(first),
  };
}
