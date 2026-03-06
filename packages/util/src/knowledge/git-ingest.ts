import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface RawCommit {
  hash: string;
  message: string;
  authorName: string;
  authorEmail: string;
  date: string;
  files: FileChange[];
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
}

export interface AuthorEntry {
  id: string;
  type: 'AUTHOR';
  name: string;
  emails: string[];
  aliases: string[];
  projections: string[];
}

export interface CommitEntry {
  type: 'COMMIT';
  hash: string;
  message: string;
  author_ref: string;
  date: string;
  files: FileChange[];
  projections: string[];
}

export interface IngestResult {
  commits: number;
  authors: number;
  filesChanged: number;
}

export interface Meta {
  last_commit: string;
  last_ingest: string;
  branch: string;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function resolveRenamedPath(rawPath: string): string {
  const match = rawPath.match(/\{[^}]* => ([^}]*)\}/);
  if (match) {
    return rawPath.replace(/\{[^}]* => [^}]*\}/, match[1]);
  }
  return rawPath;
}

export function parseGitLog(rawOutput: string): RawCommit[] {
  const commits: RawCommit[] = [];
  const blocks = rawOutput.split('COMMIT_START\n').filter(b => b.trim());

  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length < 5) continue;

    const hash = lines[0].trim();
    const message = lines[1].trim();
    const authorName = lines[2].trim();
    const authorEmail = lines[3].trim();
    const date = lines[4].trim();

    const files: FileChange[] = [];
    for (let i = 5; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const parts = line.split('\t');
      if (parts.length < 3) continue;

      const addedRaw = parts[0];
      const removedRaw = parts[1];
      const rawPath = parts.slice(2).join('\t');
      const path = resolveRenamedPath(rawPath);

      const added = addedRaw === '-' ? 0 : parseInt(addedRaw, 10) || 0;
      const removed = removedRaw === '-' ? 0 : parseInt(removedRaw, 10) || 0;

      files.push({ path, added, removed });
    }

    commits.push({ hash, message, authorName, authorEmail, date, files });
  }

  return commits;
}

export function normalizeAuthors(commits: RawCommit[]): Map<string, AuthorEntry> {
  const emailGroups = new Map<string, { names: Map<string, number>; emails: Set<string> }>();

  for (const commit of commits) {
    const emailKey = commit.authorEmail.toLowerCase();
    let group = emailGroups.get(emailKey);
    if (!group) {
      group = { names: new Map(), emails: new Set() };
      emailGroups.set(emailKey, group);
    }
    group.emails.add(commit.authorEmail);
    const count = group.names.get(commit.authorName) || 0;
    group.names.set(commit.authorName, count + 1);
  }

  const authors = new Map<string, AuthorEntry>();

  for (const [, group] of emailGroups) {
    let primaryName = '';
    let maxCount = 0;
    for (const [name, count] of group.names) {
      if (count > maxCount) {
        maxCount = count;
        primaryName = name;
      }
    }

    const aliases: string[] = [];
    for (const [name] of group.names) {
      if (name !== primaryName) {
        aliases.push(name);
      }
    }

    const id = slugify(primaryName);
    const emails = Array.from(group.emails);

    authors.set(id, {
      id,
      type: 'AUTHOR',
      name: primaryName,
      emails,
      aliases,
      projections: ['temporal', 'organizational'],
    });
  }

  return authors;
}

export class GitIngest {
  private knowledgeDir: string;

  constructor(knowledgeDir: string) {
    this.knowledgeDir = knowledgeDir;
  }

  async ingestFull(repoPath: string, branch?: string, since?: string): Promise<IngestResult> {
    const derivedDir = join(this.knowledgeDir, 'derived');
    if (existsSync(derivedDir)) {
      rmSync(derivedDir, { recursive: true, force: true });
    }

    const raw = this.runGitLog(repoPath, undefined, branch, since);
    const rawCommits = parseGitLog(raw);
    const authors = normalizeAuthors(rawCommits);

    const commitEntries = rawCommits.map(rc => this.toCommitEntry(rc, authors));

    this.writeAuthors(authors);
    this.writeCommits(commitEntries);

    const meta: Meta = {
      last_commit: rawCommits.length > 0 ? rawCommits[0].hash : '',
      last_ingest: new Date().toISOString(),
      branch: branch || 'HEAD',
    };
    this.writeMeta(meta);

    const filesChanged = new Set(rawCommits.flatMap(c => c.files.map(f => f.path))).size;

    return {
      commits: rawCommits.length,
      authors: authors.size,
      filesChanged,
    };
  }

  async ingestIncremental(repoPath: string, branch?: string): Promise<IngestResult> {
    const meta = this.readMeta();
    if (!meta) {
      return this.ingestFull(repoPath, branch);
    }

    const lastCommitHash = meta.last_commit;
    const raw = this.runGitLog(repoPath, lastCommitHash, branch);
    const rawCommits = parseGitLog(raw);

    if (rawCommits.length === 0) {
      return { commits: 0, authors: 0, filesChanged: 0 };
    }

    const newAuthors = normalizeAuthors(rawCommits);
    const existingAuthors = this.readExistingAuthors();
    const mergedAuthors = this.mergeAuthors(existingAuthors, newAuthors);

    const newCommitEntries = rawCommits.map(rc => this.toCommitEntry(rc, mergedAuthors));
    this.mergeCommits(newCommitEntries);
    this.writeAuthors(mergedAuthors);

    const updatedMeta: Meta = {
      last_commit: rawCommits[0].hash,
      last_ingest: new Date().toISOString(),
      branch: branch || meta.branch,
    };
    this.writeMeta(updatedMeta);

    const filesChanged = new Set(rawCommits.flatMap(c => c.files.map(f => f.path))).size;

    return {
      commits: rawCommits.length,
      authors: newAuthors.size,
      filesChanged,
    };
  }

  private runGitLog(repoPath: string, afterCommit?: string, branch?: string, sinceDate?: string): string {
    const ref = branch || 'HEAD';
    const range = afterCommit ? `${afterCommit}..${ref}` : ref;
    const sinceFlag = sinceDate ? ` --since="${sinceDate}"` : '';
    const cmd = `git log --numstat --format="COMMIT_START%n%H%n%s%n%an%n%ae%n%aI"${sinceFlag} ${range}`;

    try {
      return execSync(cmd, { cwd: repoPath, encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024 });
    } catch (error: unknown) {
      // Git exits with 128 for "fatal" errors (empty repo, bad revision, etc.)
      // These are expected cases, not failures worth surfacing.
      const exitCode = (error as { status?: number }).status;
      if (exitCode === 128) {
        return '';
      }
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`git log failed: ${msg}`);
    }
  }

  private writeAuthors(authors: Map<string, AuthorEntry>): void {
    const derivedDir = join(this.knowledgeDir, 'derived');
    mkdirSync(derivedDir, { recursive: true });

    const entries = Array.from(authors.values());
    const filePath = join(derivedDir, 'authors.yaml');
    writeFileSync(filePath, stringifyYaml(entries), 'utf-8');
  }

  private writeCommits(commits: CommitEntry[]): void {
    const commitsDir = join(this.knowledgeDir, 'derived', 'commits');
    mkdirSync(commitsDir, { recursive: true });

    const monthGroups = new Map<string, CommitEntry[]>();
    for (const commit of commits) {
      const month = commit.date.slice(0, 7); // YYYY-MM
      let group = monthGroups.get(month);
      if (!group) {
        group = [];
        monthGroups.set(month, group);
      }
      group.push(commit);
    }

    for (const [month, group] of monthGroups) {
      const filePath = join(commitsDir, `${month}.yaml`);
      writeFileSync(filePath, stringifyYaml(group), 'utf-8');
    }
  }

  private writeMeta(meta: Meta): void {
    const derivedDir = join(this.knowledgeDir, 'derived');
    mkdirSync(derivedDir, { recursive: true });

    const filePath = join(derivedDir, 'meta.yaml');
    writeFileSync(filePath, stringifyYaml(meta), 'utf-8');
  }

  private readMeta(): Meta | null {
    const filePath = join(this.knowledgeDir, 'derived', 'meta.yaml');
    if (!existsSync(filePath)) return null;

    try {
      const content = readFileSync(filePath, 'utf-8');
      return parseYaml(content) as Meta;
    } catch {
      return null;
    }
  }

  private readExistingAuthors(): Map<string, AuthorEntry> {
    const filePath = join(this.knowledgeDir, 'derived', 'authors.yaml');
    const authors = new Map<string, AuthorEntry>();

    if (!existsSync(filePath)) return authors;

    try {
      const content = readFileSync(filePath, 'utf-8');
      const entries = parseYaml(content) as AuthorEntry[];
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          authors.set(entry.id, entry);
        }
      }
    } catch {
      // ignore parse errors
    }

    return authors;
  }

  private mergeAuthors(
    existing: Map<string, AuthorEntry>,
    incoming: Map<string, AuthorEntry>,
  ): Map<string, AuthorEntry> {
    const merged = new Map(existing);

    for (const [id, entry] of incoming) {
      const existingEntry = merged.get(id);
      if (existingEntry) {
        const allEmails = new Set([...existingEntry.emails, ...entry.emails]);
        const allAliases = new Set([...existingEntry.aliases, ...entry.aliases]);
        merged.set(id, {
          ...existingEntry,
          emails: Array.from(allEmails),
          aliases: Array.from(allAliases),
        });
      } else {
        merged.set(id, entry);
      }
    }

    return merged;
  }

  private mergeCommits(newCommits: CommitEntry[]): void {
    const commitsDir = join(this.knowledgeDir, 'derived', 'commits');
    mkdirSync(commitsDir, { recursive: true });

    const monthGroups = new Map<string, CommitEntry[]>();
    for (const commit of newCommits) {
      const month = commit.date.slice(0, 7);
      let group = monthGroups.get(month);
      if (!group) {
        group = [];
        monthGroups.set(month, group);
      }
      group.push(commit);
    }

    for (const [month, group] of monthGroups) {
      const filePath = join(commitsDir, `${month}.yaml`);
      let existing: CommitEntry[] = [];

      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath, 'utf-8');
          const parsed = parseYaml(content);
          if (Array.isArray(parsed)) {
            existing = parsed as CommitEntry[];
          }
        } catch {
          // ignore parse errors, start fresh
        }
      }

      const existingHashes = new Set(existing.map(c => c.hash));
      const dedupedNew = group.filter(c => !existingHashes.has(c.hash));
      const merged = [...existing, ...dedupedNew];

      writeFileSync(filePath, stringifyYaml(merged), 'utf-8');
    }
  }

  private toCommitEntry(rc: RawCommit, authors: Map<string, AuthorEntry>): CommitEntry {
    let authorRef = '';
    for (const [id, author] of authors) {
      if (author.emails.some(e => e.toLowerCase() === rc.authorEmail.toLowerCase())) {
        authorRef = `kb:author:${id}`;
        break;
      }
    }

    return {
      type: 'COMMIT',
      hash: rc.hash,
      message: rc.message,
      author_ref: authorRef,
      date: rc.date,
      files: rc.files,
      projections: ['temporal', 'organizational'],
    };
  }
}
