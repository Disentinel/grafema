#!/usr/bin/env node
/**
 * Grafema Lean Analyzer — orchestration script.
 *
 * Detects Lean 4 project, runs GrafemaExtract.lean via `lake env lean --run`,
 * loads JSONL output into RFDB.
 *
 * Usage:
 *   node analyze.mjs --project /path/to/lean-project --socket /tmp/rfdb.sock [--module Mathlib] [--clear]
 *
 * Requirements:
 *   - elan/lean/lake installed and in PATH
 *   - Project has lean-toolchain and built .olean cache
 *   - RFDB server running on given socket
 */
import { existsSync, createReadStream, readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { createConnection } from 'net';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { project: '.', socket: '', module: '', clear: false, database: 'default' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) opts.project = args[++i];
    else if (args[i] === '--socket' && args[i + 1]) opts.socket = args[++i];
    else if (args[i] === '--module' && args[i + 1]) opts.module = args[++i];
    else if (args[i] === '--database' && args[i + 1]) opts.database = args[++i];
    else if (args[i] === '--clear') opts.clear = true;
  }
  return opts;
}

function isLeanProject(projectPath) {
  return existsSync(join(projectPath, 'lakefile.lean')) ||
         existsSync(join(projectPath, 'lakefile.toml')) ||
         existsSync(join(projectPath, 'lean-toolchain'));
}

function detectModule(projectPath) {
  if (existsSync(join(projectPath, 'Mathlib'))) return 'Mathlib';
  if (existsSync(join(projectPath, 'lakefile.lean'))) {
    const content = readFileSync(join(projectPath, 'lakefile.lean'), 'utf8');
    const libMatch = content.match(/lean_lib\s+(\w+)/);
    if (libMatch) return libMatch[1];
    const exeMatch = content.match(/lean_exe\s+(\w+)/);
    if (exeMatch) return exeMatch[1];
  }
  return null;
}

async function runExtractor(projectPath, module, outputPath) {
  // Use full extractor (with Aesop/NormNum) for Mathlib projects,
  // standalone extractor for non-Mathlib Lean projects
  const isMathlib = existsSync(join(projectPath, 'Mathlib')) ||
                    existsSync(join(projectPath, '.lake', 'packages', 'aesop'));
  const extractorName = isMathlib ? 'GrafemaExtract.lean' : 'test-fixture/Extract.lean';
  const extractorPath = join(__dirname, extractorName);
  if (!existsSync(extractorPath)) {
    throw new Error(`${extractorName} not found at ${extractorPath}`);
  }

  // Check for .olean cache — Lean needs compiled .olean files to inspect the environment
  const oleanDir = join(projectPath, '.lake', 'build', 'lib');
  if (!existsSync(oleanDir)) {
    console.error(`[lean] Warning: No .olean cache found at ${oleanDir}`);
    console.error(`[lean] Run 'lake build' or 'lake exe cache get' first.`);
    process.exit(1);
  }

  return new Promise((resolve, reject) => {
    console.error(`[lean] Running: lake env lean --run ${extractorPath} ${module} ${outputPath}`);
    const child = spawn('lake', ['env', 'lean', '--run', extractorPath, module, outputPath], {
      cwd: projectPath,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Lean extraction failed with exit code ${code}`));
    });
    child.on('error', reject);
  });
}

// Minimal msgpack-free RFDB client using raw protocol
class RFDBClient {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.socket = null;
    this.reqId = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this._encoder = null;
    this._decoder = null;
  }

  async _loadMsgpack() {
    // Strategy 1: try normal module resolution (works when installed as dependency)
    try {
      const m = await import('@msgpack/msgpack');
      this._encoder = m.encode;
      this._decoder = m.decode;
      return;
    } catch {}

    // Strategy 2: walk up from __dirname looking for node_modules/@msgpack/msgpack
    let dir = __dirname;
    const root = dirname(dir); // stop condition
    while (dir.length > 1) {
      const candidate = join(dir, 'node_modules', '@msgpack', 'msgpack');
      if (existsSync(candidate)) {
        try {
          const esmEntry = join(candidate, 'dist.esm', 'index.mjs');
          const target = existsSync(esmEntry) ? esmEntry : candidate;
          const m = await import(target);
          this._encoder = m.encode;
          this._decoder = m.decode;
          return;
        } catch {}
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    throw new Error('Cannot find @msgpack/msgpack. Install it or run from grafema monorepo.');
  }

  async connect() {
    await this._loadMsgpack();
    return new Promise((resolve, reject) => {
      this.socket = createConnection(this.socketPath, () => resolve());
      this.socket.on('error', reject);
      this.socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
          const len = this.buffer.readUInt32BE(0);
          if (this.buffer.length < 4 + len) break;
          const msg = this._decoder(this.buffer.subarray(4, 4 + len));
          this.buffer = this.buffer.subarray(4 + len);
          const rid = msg.requestId?.startsWith?.('r')
            ? parseInt(msg.requestId.slice(1))
            : this.pending.keys().next().value;
          const p = this.pending.get(rid);
          if (p) { this.pending.delete(rid); if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg); }
        }
      });
    });
  }

  async send(cmd, payload = {}, timeoutMs = 300000) {
    const id = this.reqId++;
    const req = { requestId: `r${id}`, cmd, ...payload };
    const packed = this._encoder(req);
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32BE(packed.length, 0);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.socket.write(Buffer.concat([hdr, Buffer.from(packed)]));
    });
  }

  close() { if (this.socket) this.socket.end(); }
}

const BATCH_SIZE = 20000;

async function loadIntoRFDB(client, jsonlPath) {
  // Pass 1: nodes
  console.error('[lean] Pass 1: loading nodes...');
  let totalNodes = 0, totalEdges = 0;

  const rl1 = createInterface({ input: createReadStream(jsonlPath), crlfDelay: Infinity });
  let nodeBatch = [];
  for await (const line of rl1) {
    if (!line.includes('"t":"n"')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.t !== 'n') continue;
    const node = { id: o.id, nodeType: o.type, name: o.name || '', file: o.file || '' };
    if (o.module) node.module = o.module;
    if (o.origin) node.origin = o.origin;
    if (o.simp) node.simp = 'true';
    if (o.ext) node.ext = 'true';
    if (o.norm_num) node.norm_num = 'true';
    if (o.line !== undefined) node.line = String(o.line);
    if (o.col !== undefined) node.col = String(o.col);
    nodeBatch.push(node);
    if (nodeBatch.length >= BATCH_SIZE) {
      await client.send('addNodes', { nodes: nodeBatch });
      totalNodes += nodeBatch.length;
      nodeBatch = [];
      process.stderr.write(`\r[lean]   ${totalNodes} nodes`);
    }
  }
  if (nodeBatch.length > 0) { await client.send('addNodes', { nodes: nodeBatch }); totalNodes += nodeBatch.length; }
  console.error(`\n[lean] Nodes: ${totalNodes}`);

  // Pass 2: edges
  console.error('[lean] Pass 2: loading edges...');
  const rl2 = createInterface({ input: createReadStream(jsonlPath), crlfDelay: Infinity });
  let edgeBatch = [];
  for await (const line of rl2) {
    if (!line.includes('"t":"e"')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.t !== 'e') continue;
    edgeBatch.push({ src: o.src, dst: o.tgt, edgeType: o.type });
    if (edgeBatch.length >= BATCH_SIZE) {
      await client.send('addEdges', { edges: edgeBatch, skipValidation: true });
      totalEdges += edgeBatch.length;
      edgeBatch = [];
      process.stderr.write(`\r[lean]   ${totalEdges} edges`);
    }
  }
  if (edgeBatch.length > 0) { await client.send('addEdges', { edges: edgeBatch, skipValidation: true }); totalEdges += edgeBatch.length; }
  console.error(`\n[lean] Edges: ${totalEdges}`);

  return { totalNodes, totalEdges };
}

async function main() {
  const opts = parseArgs();
  const projectPath = resolve(opts.project);

  if (!isLeanProject(projectPath)) {
    console.error(`Not a Lean project: ${projectPath}`);
    console.error('Expected lakefile.lean, lakefile.toml, or lean-toolchain');
    process.exit(1);
  }

  const module = opts.module || detectModule(projectPath);
  if (!module) {
    console.error('Cannot detect Lean module. Use --module <name>');
    process.exit(1);
  }

  if (!opts.socket) {
    console.error('--socket required (RFDB server socket path)');
    process.exit(1);
  }

  console.error(`[lean] Project: ${projectPath}`);
  console.error(`[lean] Module: ${module}`);
  console.error(`[lean] Socket: ${opts.socket}`);

  const grafemaDir = join(projectPath, '.grafema');
  if (!existsSync(grafemaDir)) {
    const { mkdirSync } = await import('fs');
    mkdirSync(grafemaDir, { recursive: true });
  }
  const outputPath = join(grafemaDir, 'lean-graph.jsonl');

  // Step 1: Extract
  const extractStart = Date.now();
  await runExtractor(projectPath, module, outputPath);
  console.error(`[lean] Extraction: ${((Date.now() - extractStart) / 1000).toFixed(1)}s`);

  // Step 2: Connect to RFDB
  const client = new RFDBClient(opts.socket);
  await client.connect();
  await client.send('hello', { client: 'lean-analyzer', version: '1.0' });

  if (opts.database !== 'default') {
    try { await client.send('createDatabase', { name: opts.database }); } catch {}
    await client.send('openDatabase', { name: opts.database });
  }

  if (opts.clear) {
    console.error('[lean] Clearing database...');
    await client.send('clear', {});
  }

  // Step 3: Load
  const loadStart = Date.now();
  const { totalNodes, totalEdges } = await loadIntoRFDB(client, outputPath);
  console.error(`[lean] Load: ${((Date.now() - loadStart) / 1000).toFixed(1)}s`);

  // Step 4: Compact
  console.error('[lean] Compacting...');
  await client.send('compact', {});

  const totalTime = ((Date.now() - extractStart) / 1000).toFixed(1);
  console.error(`[lean] Complete: ${totalNodes} nodes, ${totalEdges} edges in ${totalTime}s`);

  client.close();
}

main().catch(e => { console.error(e); process.exit(1); });
