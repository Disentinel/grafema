// rfdb-client.ts — minimal unix-socket client for rfdb-server.
// Framing: [4-byte BE length][MessagePack body] both directions
// (rfdb_server.rs ⟦let len = u32::from_be_bytes(len_buf) as usize;⟧ read/write
// loop). Requests are internally tagged maps {"cmd": <camelCase>, ...}
// (Request enum serde attrs, rfdb_server.rs:85 ⟦#[serde(tag = "cmd", rename_all = "camelCase")]⟧).

import * as net from 'node:net';
import { encode, decode, type MpValue } from './msgpack.ts';

export interface WireBodyFact { predicate: string; tuple: string[]; }
export interface FactWitness { ruleAstHash: string; body: WireBodyFact[]; }
export interface GapWitness {
  ruleAstHash: string;
  satisfied: WireBodyFact[];
  failingPredicate: string;
  failingIsNegative: boolean;
}

/** Extract the machine-readable E-code from an RFDB error string, if any. */
export function extractECode(error: string): string | null {
  const m = /\[E-[A-Z]+-\d+\]/.exec(error);
  return m ? m[0].slice(1, -1) : null;
}

export class RfdbError extends Error {
  code: string | null;
  constructor(message: string) {
    super(message);
    this.code = extractECode(message);
  }
}

export class RfdbClient {
  private socket: net.Socket;
  private buf: Buffer = Buffer.alloc(0);
  private waiters: { resolve: (v: MpValue) => void; reject: (e: Error) => void }[] = [];
  /** Wire round-trips issued on this client — the suite runner diffs it around
   *  each scenario so a GREEN's evidence string states honestly whether the
   *  engine was consulted at all (parse-reject scenarios never hit the wire). */
  callCount = 0;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (e) => this.failAll(e));
    socket.on('close', () => this.failAll(new Error('rfdb socket closed')));
  }

  static async connect(socketPath: string): Promise<RfdbClient> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(socketPath);
      s.once('connect', () => { s.removeListener('error', reject); resolve(s); });
      s.once('error', reject);
    });
    return new RfdbClient(socket);
  }

  close(): void {
    this.socket.removeAllListeners();
    this.socket.destroy();
  }

  private failAll(e: Error): void {
    const ws = this.waiters.splice(0);
    for (const w of ws) w.reject(e);
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) return;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      const w = this.waiters.shift();
      if (!w) throw new Error('rfdb-client: response with no pending request');
      try {
        w.resolve(decode(new Uint8Array(body)));
      } catch (e) {
        w.reject(e as Error);
      }
    }
  }

  call(req: { [k: string]: MpValue }): Promise<MpValue> {
    this.callCount++;
    const payload = encode(req);
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32BE(payload.length, 0);
    frame.set(payload, 4);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.socket.write(frame);
    });
  }

  /** Hello handshake; asserts protocol v3 + the datalogDerive feature so the
   *  harness never silently tests the wrong engine. */
  async hello(): Promise<{ protocolVersion: number; serverVersion: string; features: string[] }> {
    const r = (await this.call({ cmd: 'hello', protocolVersion: 3, clientId: 'rofl-conformance' })) as {
      [k: string]: MpValue;
    };
    if (r['ok'] !== true) throw new Error(`hello failed: ${JSON.stringify(r)}`);
    const features = (r['features'] as string[]) ?? [];
    if (r['protocolVersion'] !== 3) throw new Error(`unexpected protocolVersion: ${r['protocolVersion']}`);
    if (!features.includes('datalogDerive')) {
      throw new Error('rfdb-server does not advertise datalogDerive — derive engine is off; the harness would test the wrong engine');
    }
    return {
      protocolVersion: r['protocolVersion'] as number,
      serverVersion: r['serverVersion'] as string,
      features,
    };
  }

  /** Execute a derive program; returns rows of variable bindings for the FIRST
   *  rule head's predicate (rfdb_server.rs:3062-3065 ⟦Some(program.rules()[0].head().clone())⟧ — callers hoist the wanted
   *  predicate's first rule to the top). explain is ALWAYS false: explain=true
   *  silently reroutes to the legacy v1 query engine
   *  (rfdb_server.rs:3061 ⟦if derive_engine_enabled() && !explain⟧). */
  async executeDatalog(source: string): Promise<Record<string, string>[]> {
    const r = (await this.call({ cmd: 'executeDatalog', source, explain: false })) as { [k: string]: MpValue };
    if (typeof r['error'] === 'string') throw new RfdbError(r['error']);
    const results = r['results'];
    if (!Array.isArray(results)) throw new Error(`unexpected executeDatalog response: ${JSON.stringify(r)}`);
    return results.map((row) => ((row as { [k: string]: MpValue })['bindings'] ?? {}) as Record<string, string>);
  }

  /** why(): one supporting derivation of predicate(key), or null. */
  async explainDatalogFact(source: string, predicate: string, key: string[]): Promise<FactWitness | null> {
    const r = (await this.call({ cmd: 'explainDatalogFact', source, predicate, key })) as { [k: string]: MpValue };
    if (typeof r['error'] === 'string') throw new RfdbError(r['error']);
    if (!('witness' in r)) throw new Error(`unexpected explainDatalogFact response: ${JSON.stringify(r)}`);
    return (r['witness'] as FactWitness | null) ?? null;
  }

  /** why-not(): satisfied prefix + first failing premise, or null (= derivable). */
  async explainDatalogGap(source: string, predicate: string, key: string[]): Promise<GapWitness | null> {
    const r = (await this.call({ cmd: 'explainDatalogGap', source, predicate, key })) as { [k: string]: MpValue };
    if (typeof r['error'] === 'string') throw new RfdbError(r['error']);
    if (!('witness' in r)) throw new Error(`unexpected explainDatalogGap response: ${JSON.stringify(r)}`);
    return (r['witness'] as GapWitness | null) ?? null;
  }

  /** Projection T: reflect a program's RULES into the open database as facts, returning
   *  how many facts were written. Additive and idempotent — re-reflecting the same program
   *  hits the same content-addressed nodes, a second program lands BESIDE the first, and
   *  there is no retraction.
   *
   *  The returned count is the caller's POSITIVE CONTROL and has to be checked: a program
   *  that never reached the store answers empty to every later store-mode query, and an
   *  empty answer is indistinguishable from an honest zero. A program Projection T cannot
   *  carry whole (#requires, an @materialize / @materialize_node annotation, a lattice head)
   *  is REFUSED — it arrives here as an RfdbError whose `code` is the E-REFLECT-… the server
   *  put in brackets, never as a silent 0. */
  async reflectProgram(source: string): Promise<number> {
    const r = (await this.call({ cmd: 'reflectProgram', source })) as { [k: string]: MpValue };
    if (typeof r['error'] === 'string') throw new RfdbError(r['error']);
    if (!('count' in r)) throw new Error(`unexpected reflectProgram response: ${JSON.stringify(r)}`);
    return r['count'] as number;
  }

  /** Switch where the open database's rules come from: 'text' (the program text sent with
   *  each query — the historical default) or 'store' (the facts reflectProgram wrote). A
   *  durable property of the DATABASE, persisted server-side, reversible in both directions.
   *
   *  The reply is the mode the server read off its engine after the switch — but read it for
   *  what it is: the setter is TOTAL, so on today's engine that value and an echo of the
   *  argument coincide on every input, and no measurement can tell them apart. A caller that
   *  needs to CONFIRM the mode asks {@link getRuleSource}, which never saw the request. Note
   *  that while the source is 'store' every @materialize write-back refuses with
   *  E-REFLECT-003 by design: Projection T carries no annotations. */
  async setRuleSource(mode: 'text' | 'store'): Promise<'text' | 'store'> {
    const r = (await this.call({ cmd: 'setRuleSource', mode })) as { [k: string]: MpValue };
    if (typeof r['error'] === 'string') throw new RfdbError(r['error']);
    if (!('ruleSource' in r)) throw new Error(`unexpected setRuleSource response: ${JSON.stringify(r)}`);
    return r['ruleSource'] as 'text' | 'store';
  }

  /** Where the open database's rules come from — an OBSERVATION, changing nothing.
   *
   *  This is the door a confirmation has to go through: `setRuleSource`'s reply is a reply
   *  to the request, this one is an answer about the database asked separately, and a server
   *  that ignored the switch is caught here and nowhere else.
   *
   *  It is also what any ordinary client (orchestrator, MCP, CLI) needs in order to tell
   *  "this database derives nothing" apart from "this database is in store mode, so my
   *  program text is not its program" — the two look identical, both are zero rows with no
   *  error. Until this command existed the only way to find out was to SET the mode, i.e. to
   *  change the thing being measured. */
  async getRuleSource(): Promise<'text' | 'store'> {
    const r = (await this.call({ cmd: 'getRuleSource' })) as { [k: string]: MpValue };
    if (typeof r['error'] === 'string') throw new RfdbError(r['error']);
    if (!('ruleSource' in r)) throw new Error(`unexpected getRuleSource response: ${JSON.stringify(r)}`);
    return r['ruleSource'] as 'text' | 'store';
  }

  /** Create a database. `ephemeral` keeps it out of the server's data directory.
   *
   *  Reflection is ADDITIVE and has no retraction (`engine_v2.rs:1454-1456`
   *  ⟦rule is rule supersession⟧), and the rule source is a property of the
   *  DATABASE — so a store-mode measurement over many programs needs one database per
   *  program, or program N+1 executes program N's rules as well as its own. */
  async createDatabase(name: string, ephemeral = false): Promise<void> {
    const r = (await this.call({ cmd: 'createDatabase', name, ephemeral })) as { [k: string]: MpValue };
    if (typeof r['error'] === 'string') throw new RfdbError(r['error']);
    if (r['ok'] !== true) throw new Error(`unexpected createDatabase response: ${JSON.stringify(r)}`);
  }

  /** Open a database as this SESSION's current one; returns its node count.
   *
   *  Current-database is per connection, so a second client can drive per-seed databases
   *  while the first keeps answering off the server's default database, untouched. */
  async openDatabase(name: string, mode = 'rw'): Promise<number> {
    const r = (await this.call({ cmd: 'openDatabase', name, mode })) as { [k: string]: MpValue };
    if (typeof r['error'] === 'string') throw new RfdbError(r['error']);
    if (r['ok'] !== true) throw new Error(`unexpected openDatabase response: ${JSON.stringify(r)}`);
    return (r['nodeCount'] as number) ?? 0;
  }

  /** Names of the databases the server currently holds.
   *
   *  Closing the last connection to an EPHEMERAL database removes it
   *  (`rfdb_server.rs:2900-2907` ⟦Cleanup ephemeral database if no connections remain⟧), so this is
   *  how a caller proves its per-seed databases went away instead of piling up behind it. */
  async listDatabases(): Promise<string[]> {
    const r = (await this.call({ cmd: 'listDatabases' })) as { [k: string]: MpValue };
    if (typeof r['error'] === 'string') throw new RfdbError(r['error']);
    const dbs = r['databases'];
    if (!Array.isArray(dbs)) throw new Error(`unexpected listDatabases response: ${JSON.stringify(r)}`);
    return dbs.map((d) => (d as { [k: string]: MpValue })['name'] as string);
  }

  async closeDatabase(): Promise<void> {
    const r = (await this.call({ cmd: 'closeDatabase' })) as { [k: string]: MpValue };
    if (typeof r['error'] === 'string') throw new RfdbError(r['error']);
    if (r['ok'] !== true) throw new Error(`unexpected closeDatabase response: ${JSON.stringify(r)}`);
  }

}
