#!/usr/bin/env node
/**
 * Enrich paper nodes with full abstracts from arxiv API.
 * Processes in batches of 20 (arxiv API limit per request).
 * Rate-limited: 3 seconds between requests per arxiv guidelines.
 *
 * Usage: node enrich-abstracts.js [--batch N] [--offset N]
 *   --batch N   which batch number to process (0-indexed)
 *   --offset N  skip first N IDs
 *   --all       process all batches sequentially
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const BATCH_SIZE = 20;  // arxiv API max per request
const DELAY_MS = 3500;  // be nice to arxiv
const mergedDir = join(import.meta.dirname, 'merged');
const enrichedFile = join(mergedDir, 'abstracts.jsonl');

// Parse args
const args = process.argv.slice(2);
const batchArg = args.indexOf('--batch');
const offsetArg = args.indexOf('--offset');
const doAll = args.includes('--all');
const batchNum = batchArg >= 0 ? parseInt(args[batchArg + 1]) : null;
const offset = offsetArg >= 0 ? parseInt(args[offsetArg + 1]) : 0;

// Load all nodes
const nodesFile = join(mergedDir, 'nodes.jsonl');
const nodes = readFileSync(nodesFile, 'utf-8')
  .split('\n')
  .filter(l => l.trim())
  .map(l => JSON.parse(l));

// Get papers with arxiv_id
const papersWithArxiv = nodes.filter(n => n.node_type === 'paper' && n.arxiv_id);
console.log(`Papers with arxiv_id: ${papersWithArxiv.length}`);

// Load already-enriched IDs to skip
const alreadyEnriched = new Set();
if (existsSync(enrichedFile)) {
  const existing = readFileSync(enrichedFile, 'utf-8').split('\n').filter(l => l.trim());
  for (const line of existing) {
    try {
      const obj = JSON.parse(line);
      alreadyEnriched.add(obj.arxiv_id);
    } catch {}
  }
  console.log(`Already enriched: ${alreadyEnriched.size}`);
}

// Filter out already-enriched
const toProcess = papersWithArxiv.filter(p => !alreadyEnriched.has(p.arxiv_id));
console.log(`Remaining to enrich: ${toProcess.length}`);

// Apply offset
const afterOffset = toProcess.slice(offset);
const totalBatches = Math.ceil(afterOffset.length / BATCH_SIZE);

// Determine which batches to run
let batches;
if (batchNum !== null) {
  batches = [batchNum];
} else if (doAll) {
  batches = Array.from({ length: totalBatches }, (_, i) => i);
} else {
  console.log(`Total batches: ${totalBatches}. Use --batch N or --all`);
  process.exit(0);
}

async function fetchBatch(ids) {
  const idList = ids.join(',');
  const url = `https://export.arxiv.org/api/query?id_list=${idList}&max_results=${ids.length}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`arxiv API error: ${res.status} ${res.statusText}`);
  }

  const xml = await res.text();

  // Parse XML entries
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];

    const getId = (text) => {
      const m = text.match(/<id>(.*?)<\/id>/);
      return m ? m[1].replace('http://arxiv.org/abs/', '').replace(/v\d+$/, '') : null;
    };

    const getTitle = (text) => {
      const m = text.match(/<title>([\s\S]*?)<\/title>/);
      return m ? m[1].replace(/\s+/g, ' ').trim() : null;
    };

    const getAbstract = (text) => {
      const m = text.match(/<summary>([\s\S]*?)<\/summary>/);
      return m ? m[1].replace(/\s+/g, ' ').trim() : null;
    };

    const getAuthors = (text) => {
      const authors = [];
      const authorRegex = /<author>\s*<name>(.*?)<\/name>/g;
      let am;
      while ((am = authorRegex.exec(text)) !== null) {
        authors.push(am[1].trim());
      }
      return authors;
    };

    const getCategories = (text) => {
      const cats = [];
      const catRegex = /<category[^>]*term="([^"]+)"/g;
      let cm;
      while ((cm = catRegex.exec(text)) !== null) {
        cats.push(cm[1]);
      }
      return cats;
    };

    const getPublished = (text) => {
      const m = text.match(/<published>(.*?)<\/published>/);
      return m ? m[1].trim() : null;
    };

    const getDoi = (text) => {
      const m = text.match(/<arxiv:doi[^>]*>(.*?)<\/arxiv:doi>/);
      return m ? m[1].trim() : null;
    };

    const arxivId = getId(entry);
    if (arxivId) {
      entries.push({
        arxiv_id: arxivId,
        title: getTitle(entry),
        abstract: getAbstract(entry),
        authors: getAuthors(entry),
        categories: getCategories(entry),
        published: getPublished(entry),
        doi: getDoi(entry),
      });
    }
  }

  return entries;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  let totalFetched = 0;

  for (const bi of batches) {
    const start = bi * BATCH_SIZE;
    const batch = afterOffset.slice(start, start + BATCH_SIZE);
    if (batch.length === 0) continue;

    const ids = batch.map(p => p.arxiv_id);
    console.log(`\nBatch ${bi}/${totalBatches - 1}: fetching ${ids.length} papers (${ids[0]}...${ids[ids.length - 1]})`);

    try {
      const entries = await fetchBatch(ids);
      console.log(`  Got ${entries.length} results from arxiv`);

      // Append to file
      const lines = entries.map(e => JSON.stringify(e)).join('\n');
      if (entries.length > 0) {
        const { appendFileSync } = await import('fs');
        appendFileSync(enrichedFile, lines + '\n');
      }

      totalFetched += entries.length;

      // Log missing
      const gotIds = new Set(entries.map(e => e.arxiv_id));
      const missing = ids.filter(id => !gotIds.has(id));
      if (missing.length > 0) {
        console.log(`  Missing: ${missing.join(', ')}`);
      }
    } catch (err) {
      console.error(`  Error: ${err.message}`);
    }

    // Rate limit between batches
    if (bi < batches[batches.length - 1]) {
      console.log(`  Waiting ${DELAY_MS}ms...`);
      await sleep(DELAY_MS);
    }
  }

  console.log(`\nDone. Total fetched: ${totalFetched}`);
  console.log(`Output: ${enrichedFile}`);
}

main().catch(console.error);
