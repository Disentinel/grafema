// msgpack.ts — hand-rolled MessagePack subset for the RFDB wire protocol.
// Zero dependencies (offline story). Covers exactly what rfdb-server's
// rmp-serde speaks for our requests/responses: nil, bool, int (incl. 64-bit
// via BigInt-safe decode), float64, str (fixstr/8/16/32), bin (8/16/32),
// array (fix/16/32), map (fix/16/32).

export type MpValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | MpValue[]
  | { [k: string]: MpValue };

export function encode(v: MpValue): Uint8Array {
  const chunks: number[] = [];
  encInto(v, chunks);
  return Uint8Array.from(chunks);
}

function pushU32(out: number[], n: number): void {
  out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function encInto(v: MpValue, out: number[]): void {
  if (v === null) { out.push(0xc0); return; }
  if (v === true) { out.push(0xc3); return; }
  if (v === false) { out.push(0xc2); return; }
  if (typeof v === 'number') {
    if (Number.isInteger(v)) {
      if (v >= 0 && v <= 0x7f) { out.push(v); return; }
      if (v < 0 && v >= -32) { out.push(0x100 + v); return; }
      if (v >= 0 && v <= 0xffffffff) { out.push(0xce); pushU32(out, v); return; }
      if (v < 0 && v >= -0x80000000) { out.push(0xd2); pushU32(out, v >>> 0); return; }
      // int64 via BigInt (safe-integer inputs only)
      const b = BigInt(v);
      out.push(v < 0 ? 0xd3 : 0xcf);
      const u = v < 0 ? BigInt.asUintN(64, b) : b;
      for (let s = 56n; s >= 0n; s -= 8n) out.push(Number((u >> s) & 0xffn));
      return;
    }
    out.push(0xcb);
    const buf = new DataView(new ArrayBuffer(8));
    buf.setFloat64(0, v);
    for (let i = 0; i < 8; i++) out.push(buf.getUint8(i));
    return;
  }
  if (typeof v === 'string') {
    const b = new TextEncoder().encode(v);
    if (b.length < 32) out.push(0xa0 | b.length);
    else if (b.length < 256) out.push(0xd9, b.length);
    else if (b.length < 65536) { out.push(0xda, b.length >>> 8, b.length & 0xff); }
    else { out.push(0xdb); pushU32(out, b.length); }
    for (const x of b) out.push(x);
    return;
  }
  if (v instanceof Uint8Array) {
    if (v.length < 256) out.push(0xc4, v.length);
    else if (v.length < 65536) out.push(0xc5, v.length >>> 8, v.length & 0xff);
    else { out.push(0xc6); pushU32(out, v.length); }
    for (const x of v) out.push(x);
    return;
  }
  if (Array.isArray(v)) {
    if (v.length < 16) out.push(0x90 | v.length);
    else if (v.length < 65536) out.push(0xdc, v.length >>> 8, v.length & 0xff);
    else { out.push(0xdd); pushU32(out, v.length); }
    for (const x of v) encInto(x, out);
    return;
  }
  // object map
  const keys = Object.keys(v);
  if (keys.length < 16) out.push(0x80 | keys.length);
  else if (keys.length < 65536) out.push(0xde, keys.length >>> 8, keys.length & 0xff);
  else { out.push(0xdf); pushU32(out, keys.length); }
  for (const k of keys) { encInto(k, out); encInto((v as { [k: string]: MpValue })[k], out); }
}

export function decode(buf: Uint8Array): MpValue {
  const [v, end] = dec(buf, 0);
  if (end !== buf.length) {
    throw new Error(`msgpack: trailing bytes (${buf.length - end}) after value`);
  }
  return v;
}

const TD = new TextDecoder('utf8');

function dec(b: Uint8Array, i: number): [MpValue, number] {
  const t = b[i++];
  if (t <= 0x7f) return [t, i];
  if (t >= 0xe0) return [t - 0x100, i];
  if (t >= 0x80 && t <= 0x8f) return decMap(b, i, t & 0x0f);
  if (t >= 0x90 && t <= 0x9f) return decArr(b, i, t & 0x0f);
  if (t >= 0xa0 && t <= 0xbf) { const n = t & 0x1f; return [TD.decode(b.subarray(i, i + n)), i + n]; }
  switch (t) {
    case 0xc0: return [null, i];
    case 0xc2: return [false, i];
    case 0xc3: return [true, i];
    case 0xc4: { const n = b[i]; i += 1; return [b.slice(i, i + n), i + n]; }
    case 0xc5: { const n = u16(b, i); i += 2; return [b.slice(i, i + n), i + n]; }
    case 0xc6: { const n = u32(b, i); i += 4; return [b.slice(i, i + n), i + n]; }
    case 0xca: { const v = new DataView(b.buffer, b.byteOffset + i, 4).getFloat32(0); return [v, i + 4]; }
    case 0xcb: { const v = new DataView(b.buffer, b.byteOffset + i, 8).getFloat64(0); return [v, i + 8]; }
    case 0xcc: return [b[i], i + 1];
    case 0xcd: return [u16(b, i), i + 2];
    case 0xce: return [u32(b, i), i + 4];
    case 0xcf: { const v = u64(b, i); return [bigToNum(v), i + 8]; }
    case 0xd0: { const v = b[i]; return [v > 0x7f ? v - 0x100 : v, i + 1]; }
    case 0xd1: { const v = u16(b, i); return [v > 0x7fff ? v - 0x10000 : v, i + 2]; }
    case 0xd2: { const v = u32(b, i); return [v > 0x7fffffff ? v - 0x100000000 : v, i + 4]; }
    case 0xd3: { const v = BigInt.asIntN(64, u64(b, i)); return [bigToNum(v), i + 8]; }
    case 0xd9: { const n = b[i]; i += 1; return [TD.decode(b.subarray(i, i + n)), i + n]; }
    case 0xda: { const n = u16(b, i); i += 2; return [TD.decode(b.subarray(i, i + n)), i + n]; }
    case 0xdb: { const n = u32(b, i); i += 4; return [TD.decode(b.subarray(i, i + n)), i + n]; }
    case 0xdc: { const n = u16(b, i); return decArr(b, i + 2, n); }
    case 0xdd: { const n = u32(b, i); return decArr(b, i + 4, n); }
    case 0xde: { const n = u16(b, i); return decMap(b, i + 2, n); }
    case 0xdf: { const n = u32(b, i); return decMap(b, i + 4, n); }
    default:
      throw new Error(`msgpack: unsupported type byte 0x${t.toString(16)}`);
  }
}

function u16(b: Uint8Array, i: number): number { return (b[i] << 8) | b[i + 1]; }
function u32(b: Uint8Array, i: number): number { return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0; }
function u64(b: Uint8Array, i: number): bigint {
  let v = 0n;
  for (let k = 0; k < 8; k++) v = (v << 8n) | BigInt(b[i + k]);
  return v;
}
function bigToNum(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`msgpack: 64-bit integer ${v} exceeds JS safe range`);
  }
  return Number(v);
}

function decArr(b: Uint8Array, i: number, n: number): [MpValue, number] {
  const out: MpValue[] = [];
  for (let k = 0; k < n; k++) { const [v, j] = dec(b, i); out.push(v); i = j; }
  return [out, i];
}

function decMap(b: Uint8Array, i: number, n: number): [MpValue, number] {
  const out: { [k: string]: MpValue } = {};
  for (let k = 0; k < n; k++) {
    const [key, j] = dec(b, i);
    const [val, j2] = dec(b, j);
    out[String(key)] = val;
    i = j2;
  }
  return [out, i];
}
