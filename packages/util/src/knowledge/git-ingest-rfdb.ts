/**
 * Git history ingestion into RFDB knowledge database.
 *
 * Uses the existing git-ingest parser (parseGitLog, normalizeAuthors)
 * but writes AUTHOR + COMMIT nodes and edges to RFDB instead of YAML.
 *
 * Nodes:
 *   AUTHOR — person who committed (deduplicated by email)
 *   COMMIT — individual commit with hash, message, date
 *
 * Edges:
 *   COMMIT -[AUTHORED_BY]→ AUTHOR
 *   COMMIT -[MODIFIED]→ MODULE (via file path → code graph SemanticID)
 *
 * Derived edges (computed after ingest):
 *   AUTHOR -[OWNS]→ MODULE (by commit count)
 *   MODULE -[CO_CHANGES_WITH]→ MODULE (temporal coupling)
 */

import { execSync } from 'child_process';
import { parseGitLog, normalizeAuthors } from './git-ingest.js';
import type { RawCommit, AuthorEntry } from './git-ingest.js';

interface RFDBLike {
  addNodes(nodes: Array<Record<string, unknown>>): Promise<unknown>;
  addEdges(edges: Array<Record<string, unknown>>, skipValidation?: boolean): Promise<unknown>;
  flush(): Promise<unknown>;
}

export interface GitIngestRFDBOptions {
  repoPath: string;
  branch?: string;
  since?: string;
  afterCommit?: string;
  batchSize?: number;
}

export interface GitIngestRFDBResult {
  commits: number;
  authors: number;
  filesChanged: number;
  modifiedEdges: number;
  authoredByEdges: number;
}

export class GitIngestRFDB {
  private client: RFDBLike;

  constructor(client: RFDBLike) {
    this.client = client;
  }

  async ingest(options: GitIngestRFDBOptions): Promise<GitIngestRFDBResult> {
    const { repoPath, branch, since, afterCommit, batchSize = 50 } = options;

    const raw = this.runGitLog(repoPath, afterCommit, branch, since);
    const rawCommits = parseGitLog(raw);

    if (rawCommits.length === 0) {
      return { commits: 0, authors: 0, filesChanged: 0, modifiedEdges: 0, authoredByEdges: 0 };
    }

    const authors = normalizeAuthors(rawCommits);

    // Write AUTHOR nodes
    const authorNodes = Array.from(authors.values()).map(a => ({
      id: `author:${a.id}`,
      nodeType: 'AUTHOR',
      name: a.name,
      file: 'git',
      metadata: JSON.stringify({
        emails: a.emails,
        aliases: a.aliases,
        domain: 'temporal',
        created_at: new Date().toISOString(),
      }),
    }));

    for (let i = 0; i < authorNodes.length; i += batchSize) {
      await this.client.addNodes(authorNodes.slice(i, i + batchSize) );
    }

    // Write COMMIT nodes + edges in batches
    let modifiedEdges = 0;
    let authoredByEdges = 0;
    const allFiles = new Set<string>();

    for (let i = 0; i < rawCommits.length; i += batchSize) {
      const batch = rawCommits.slice(i, i + batchSize);
      const nodes: Parameters<RFDBLike['addNodes']>[0] = [];
      const edges: Parameters<RFDBLike['addEdges']>[0] = [];

      for (const commit of batch) {
        const commitId = `commit:${commit.hash.slice(0, 12)}`;
        const authorId = this.findAuthorId(commit, authors);

        nodes.push({
          id: commitId,
          nodeType: 'COMMIT',
          name: commit.message.slice(0, 120),
          file: 'git',
          metadata: JSON.stringify({
            hash: commit.hash,
            date: commit.date,
            files_changed: commit.files.length,
            lines_added: commit.files.reduce((s, f) => s + f.added, 0),
            lines_removed: commit.files.reduce((s, f) => s + f.removed, 0),
            domain: 'temporal',
          }),
        });

        // AUTHORED_BY edge
        if (authorId) {
          edges.push({
            src: commitId,
            dst: authorId,
            edgeType: 'AUTHORED_BY',
            metadata: JSON.stringify({ date: commit.date }),
          });
          authoredByEdges++;
        }

        // MODIFIED edges to files
        for (const file of commit.files) {
          allFiles.add(file.path);
          edges.push({
            src: commitId,
            dst: `file:${file.path}`,
            edgeType: 'MODIFIED',
            metadata: JSON.stringify({
              added: file.added,
              removed: file.removed,
            }),
          });
          modifiedEdges++;
        }
      }

      await this.client.addNodes(nodes);
      if (edges.length > 0) {
        await this.client.addEdges(edges, true);
      }
    }

    await this.client.flush();

    return {
      commits: rawCommits.length,
      authors: authors.size,
      filesChanged: allFiles.size,
      modifiedEdges,
      authoredByEdges,
    };
  }

  /**
   * Compute derived edges: ownership + temporal coupling.
   * Call after ingest.
   */
  async computeDerived(): Promise<{ ownership: number; coChanges: number }> {
    // TODO: implement ownership (AUTHOR -[OWNS]→ MODULE by commit count)
    // TODO: implement co-change (MODULE -[CO_CHANGES_WITH]→ MODULE by temporal coupling)
    return { ownership: 0, coChanges: 0 };
  }

  private findAuthorId(commit: RawCommit, authors: Map<string, AuthorEntry>): string | null {
    for (const [id, author] of authors) {
      if (author.emails.some(e => e.toLowerCase() === commit.authorEmail.toLowerCase())) {
        return `author:${id}`;
      }
    }
    return null;
  }

  private runGitLog(repoPath: string, afterCommit?: string, branch?: string, sinceDate?: string): string {
    const ref = branch || 'HEAD';
    const range = afterCommit ? `${afterCommit}..${ref}` : ref;
    const sinceFlag = sinceDate ? ` --since="${sinceDate}"` : '';
    const cmd = `git log --numstat --format="COMMIT_START%n%H%n%s%n%an%n%ae%n%aI"${sinceFlag} ${range}`;

    try {
      return execSync(cmd, { cwd: repoPath, encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024 });
    } catch (error: unknown) {
      const exitCode = (error as { status?: number }).status;
      if (exitCode === 128) return '';
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`git log failed: ${msg}`);
    }
  }
}
