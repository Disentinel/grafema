/**
 * GraphFreshnessChecker - checks if graph data matches current files
 *
 * Compares contentHash stored in MODULE nodes against current file hashes.
 * Used by `grafema check` to detect when files have changed since analysis.
 */

import { access, constants } from 'fs/promises';
import { calculateFileHashAsync } from './HashUtils.js';
import type { NodeRecord } from '@grafema/types';

export interface StaleModule {
  id: string;
  file: string;
  storedHash: string;
  currentHash: string | null;
  reason: 'changed' | 'deleted' | 'unreadable';
}

export interface FreshnessResult {
  isFresh: boolean;
  staleModules: StaleModule[];
  freshCount: number;
  staleCount: number;
  deletedCount: number;
  checkDurationMs: number;
}

export interface FreshnessGraph {
  queryNodes(query: { type: string }): AsyncGenerator<NodeRecord, void, unknown>;
}

interface ModuleInfo {
  id: string;
  file: string;
  contentHash: string;
}

const BATCH_SIZE = 50;

export class GraphFreshnessChecker {
  async checkFreshness(graph: FreshnessGraph): Promise<FreshnessResult> {
    const startTime = Date.now();

    const modules: ModuleInfo[] = [];
    for await (const node of graph.queryNodes({ type: 'MODULE' })) {
      if (node.file && typeof node.contentHash === 'string') {
        modules.push({
          id: node.id,
          file: node.file,
          contentHash: node.contentHash
        });
      }
    }

    if (modules.length === 0) {
      return {
        isFresh: true,
        staleModules: [],
        freshCount: 0,
        staleCount: 0,
        deletedCount: 0,
        checkDurationMs: Date.now() - startTime
      };
    }

    const staleModules: StaleModule[] = [];
    let freshCount = 0;
    let deletedCount = 0;

    for (let i = 0; i < modules.length; i += BATCH_SIZE) {
      const batch = modules.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(module => this._checkModuleFreshness(module))
      );

      for (const result of results) {
        if (result === null) {
          freshCount++;
        } else {
          staleModules.push(result);
          if (result.reason === 'deleted') {
            deletedCount++;
          }
        }
      }
    }

    return {
      isFresh: staleModules.length === 0,
      staleModules,
      freshCount,
      staleCount: staleModules.length,
      deletedCount,
      checkDurationMs: Date.now() - startTime
    };
  }

  private async _checkModuleFreshness(module: ModuleInfo): Promise<StaleModule | null> {
    const exists = await this._fileExists(module.file);
    if (!exists) {
      return {
        id: module.id,
        file: module.file,
        storedHash: module.contentHash,
        currentHash: null,
        reason: 'deleted'
      };
    }

    const currentHash = await calculateFileHashAsync(module.file);
    if (currentHash === null) {
      return {
        id: module.id,
        file: module.file,
        storedHash: module.contentHash,
        currentHash: null,
        reason: 'unreadable'
      };
    }

    if (currentHash !== module.contentHash) {
      return {
        id: module.id,
        file: module.file,
        storedHash: module.contentHash,
        currentHash,
        reason: 'changed'
      };
    }

    return null;
  }

  private async _fileExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
}
