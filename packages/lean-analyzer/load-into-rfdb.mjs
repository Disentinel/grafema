#!/usr/bin/env node
/**
 * Loads mathlib-graph.jsonl into RFDB server.
 * Reads JSONL, batches nodes and edges, sends via RFDBClient.
 *
 * Usage: node load-into-rfdb.mjs [socket] [jsonl-file]
 */
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { createConnection } from 'net';
import { encode, decode } from '/Users/vadimr/grafema-worker-1/packages/rfdb/node_modules/@msgpack/msgpack/dist.esm/index.mjs';

const SOCKET = process.argv[2] || '/tmp/rfdb-mathlib.sock';
const JSONL = process.argv[3] || 'mathlib-graph.jsonl';
const BATCH_SIZE = 20000;

class SimpleRFDBClient {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.socket = null;
    this.reqId = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.socket = createConnection(this.socketPath, () => resolve());
      this.socket.on('error', reject);
      this.socket.on('data', (chunk) => this._onData(chunk));
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readUInt32BE(0);
      if (this.buffer.length < 4 + len) break;
      const msg = decode(this.buffer.subarray(4, 4 + len));
      this.buffer = this.buffer.subarray(4 + len);
      let id;
      if (msg.requestId && typeof msg.requestId === 'string' && msg.requestId.startsWith('r')) {
        id = parseInt(msg.requestId.slice(1), 10);
      } else {
        // FIFO fallback
        id = this.pending.keys().next().value;
      }
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg);
      }
    }
  }

  async send(cmd, payload = {}, timeoutMs = 60000) {
    const id = this.reqId++;
    const request = { requestId: `r${id}`, cmd, ...payload };
    const msgBytes = encode(request);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(msgBytes.length, 0);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.socket.write(Buffer.concat([header, Buffer.from(msgBytes)]));
    });
  }

  async hello() {
    return this.send('hello', { client: 'mathlib-loader', version: '1.0' });
  }

  async createDatabase(name) {
    return this.send('createDatabase', { name });
  }

  async openDatabase(name) {
    return this.send('openDatabase', { name });
  }

  async addNodes(nodes) {
    return this.send('addNodes', { nodes });
  }

  async addEdges(edges) {
    return this.send('addEdges', { edges, skipValidation: true });
  }

  async compact() {
    return this.send('compact', {}, 300000);
  }

  async getStats() {
    return this.send('stats', {});
  }

  close() {
    if (this.socket) this.socket.end();
  }
}

async function main() {
  const client = new SimpleRFDBClient(SOCKET);
  await client.connect();
  console.log(`Connected to ${SOCKET}`);

  const hello = await client.hello();
  console.log('Hello:', JSON.stringify(hello));

  try {
    await client.createDatabase('mathlib');
    console.log('Created database: mathlib');
  } catch (e) {
    console.log('Database exists or error:', e.message);
  }
  await client.openDatabase('mathlib');
  console.log('Using database: mathlib');

  const rl = createInterface({
    input: createReadStream(JSONL),
    crlfDelay: Infinity,
  });

  let nodeBatch = [];
  let edgeBatch = [];
  let totalNodes = 0;
  let totalEdges = 0;
  let lineNum = 0;

  // Pass 1: load ALL nodes first
  console.log('Pass 1: loading nodes...');
  for await (const line of rl) {
    lineNum++;
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.t === 'n') {
      const node = {
        id: obj.id,
        nodeType: obj.type,
        name: obj.name || '',
        file: obj.file || '',
      };
      if (obj.module) node.module = obj.module;
      if (obj.uparams && obj.uparams.length > 0) {
        node.uparams = obj.uparams.join(',');
      }
      nodeBatch.push(node);

      if (nodeBatch.length >= BATCH_SIZE) {
        await client.addNodes(nodeBatch);
        totalNodes += nodeBatch.length;
        nodeBatch = [];
        process.stderr.write(`\r  ${totalNodes} nodes`);
      }
    }
  }
  if (nodeBatch.length > 0) {
    await client.addNodes(nodeBatch);
    totalNodes += nodeBatch.length;
  }
  console.log(`\nNodes loaded: ${totalNodes}`);

  // Pass 2: load ALL edges
  console.log('Pass 2: loading edges...');
  const rl2 = createInterface({
    input: createReadStream(JSONL),
    crlfDelay: Infinity,
  });
  lineNum = 0;
  for await (const line of rl2) {
    lineNum++;
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.t === 'e') {
      edgeBatch.push({
        src: obj.src,
        dst: obj.tgt,
        edgeType: obj.type,
      });

      if (edgeBatch.length >= BATCH_SIZE) {
        await client.addEdges(edgeBatch);
        totalEdges += edgeBatch.length;
        edgeBatch = [];
        process.stderr.write(`\r  ${totalEdges} edges`);
      }
    }
  }
  if (edgeBatch.length > 0) {
    await client.addEdges(edgeBatch);
    totalEdges += edgeBatch.length;
  }

  console.log(`\nLoaded: ${totalNodes} nodes, ${totalEdges} edges`);
  console.log('Compacting...');
  await client.compact();

  const stats = await client.getStats();
  console.log('Stats:', JSON.stringify(stats));

  client.close();
}

main().catch(e => { console.error(e); process.exit(1); });
