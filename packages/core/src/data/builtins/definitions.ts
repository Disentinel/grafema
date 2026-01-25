/**
 * Node.js Builtin Definitions (REG-218)
 *
 * Tier 1 builtin module definitions:
 * - fs (filesystem)
 * - fs/promises (async filesystem)
 * - path (path manipulation)
 * - http/https (network)
 * - crypto (cryptography)
 * - child_process (process execution)
 *
 * Additional modules (Tier 2):
 * - url, util, os, events, stream, buffer, worker_threads
 */

import type { BuiltinModuleDef } from './types.js';

/**
 * Tier 1: Core Node.js modules (most commonly used)
 */
export const TIER_1_MODULES: BuiltinModuleDef[] = [
  // fs - Filesystem operations
  {
    name: 'fs',
    functions: [
      { name: 'readFile', module: 'fs', security: 'file-io', pure: false },
      { name: 'readFileSync', module: 'fs', security: 'file-io', pure: false },
      { name: 'writeFile', module: 'fs', security: 'file-io', pure: false },
      { name: 'writeFileSync', module: 'fs', security: 'file-io', pure: false },
      { name: 'appendFile', module: 'fs', security: 'file-io', pure: false },
      { name: 'appendFileSync', module: 'fs', security: 'file-io', pure: false },
      { name: 'readdir', module: 'fs', security: 'file-io', pure: false },
      { name: 'readdirSync', module: 'fs', security: 'file-io', pure: false },
      { name: 'mkdir', module: 'fs', security: 'file-io', pure: false },
      { name: 'mkdirSync', module: 'fs', security: 'file-io', pure: false },
      { name: 'rmdir', module: 'fs', security: 'file-io', pure: false },
      { name: 'rmdirSync', module: 'fs', security: 'file-io', pure: false },
      { name: 'rm', module: 'fs', security: 'file-io', pure: false },
      { name: 'rmSync', module: 'fs', security: 'file-io', pure: false },
      { name: 'unlink', module: 'fs', security: 'file-io', pure: false },
      { name: 'unlinkSync', module: 'fs', security: 'file-io', pure: false },
      { name: 'stat', module: 'fs', security: 'file-io', pure: false },
      { name: 'statSync', module: 'fs', security: 'file-io', pure: false },
      { name: 'lstat', module: 'fs', security: 'file-io', pure: false },
      { name: 'lstatSync', module: 'fs', security: 'file-io', pure: false },
      { name: 'access', module: 'fs', security: 'file-io', pure: false },
      { name: 'accessSync', module: 'fs', security: 'file-io', pure: false },
      { name: 'chmod', module: 'fs', security: 'file-io', pure: false },
      { name: 'chmodSync', module: 'fs', security: 'file-io', pure: false },
      { name: 'chown', module: 'fs', security: 'file-io', pure: false },
      { name: 'chownSync', module: 'fs', security: 'file-io', pure: false },
      { name: 'rename', module: 'fs', security: 'file-io', pure: false },
      { name: 'renameSync', module: 'fs', security: 'file-io', pure: false },
      { name: 'copyFile', module: 'fs', security: 'file-io', pure: false },
      { name: 'copyFileSync', module: 'fs', security: 'file-io', pure: false },
      { name: 'createReadStream', module: 'fs', security: 'file-io', pure: false },
      { name: 'createWriteStream', module: 'fs', security: 'file-io', pure: false },
      { name: 'watch', module: 'fs', security: 'file-io', pure: false },
      { name: 'watchFile', module: 'fs', security: 'file-io', pure: false },
      { name: 'existsSync', module: 'fs', security: 'file-io', pure: false },
      { name: 'truncate', module: 'fs', security: 'file-io', pure: false },
      { name: 'truncateSync', module: 'fs', security: 'file-io', pure: false },
    ]
  },

  // fs/promises - Async filesystem operations
  {
    name: 'fs/promises',
    functions: [
      { name: 'readFile', module: 'fs/promises', security: 'file-io', pure: false },
      { name: 'writeFile', module: 'fs/promises', security: 'file-io', pure: false },
      { name: 'appendFile', module: 'fs/promises', security: 'file-io', pure: false },
      { name: 'readdir', module: 'fs/promises', security: 'file-io', pure: false },
      { name: 'mkdir', module: 'fs/promises', security: 'file-io', pure: false },
      { name: 'rmdir', module: 'fs/promises', security: 'file-io', pure: false },
      { name: 'rm', module: 'fs/promises', security: 'file-io', pure: false },
      { name: 'unlink', module: 'fs/promises', security: 'file-io', pure: false },
      { name: 'stat', module: 'fs/promises', security: 'file-io', pure: false },
      { name: 'lstat', module: 'fs/promises', security: 'file-io', pure: false },
      { name: 'access', module: 'fs/promises', security: 'file-io', pure: false },
      { name: 'chmod', module: 'fs/promises', security: 'file-io', pure: false },
      { name: 'chown', module: 'fs/promises', security: 'file-io', pure: false },
      { name: 'rename', module: 'fs/promises', security: 'file-io', pure: false },
      { name: 'copyFile', module: 'fs/promises', security: 'file-io', pure: false },
      { name: 'truncate', module: 'fs/promises', security: 'file-io', pure: false },
    ]
  },

  // path - Path manipulation (pure functions)
  {
    name: 'path',
    functions: [
      { name: 'join', module: 'path', pure: true },
      { name: 'resolve', module: 'path', pure: true },
      { name: 'normalize', module: 'path', pure: true },
      { name: 'basename', module: 'path', pure: true },
      { name: 'dirname', module: 'path', pure: true },
      { name: 'extname', module: 'path', pure: true },
      { name: 'parse', module: 'path', pure: true },
      { name: 'format', module: 'path', pure: true },
      { name: 'relative', module: 'path', pure: true },
      { name: 'isAbsolute', module: 'path', pure: true },
      { name: 'sep', module: 'path', pure: true },
      { name: 'delimiter', module: 'path', pure: true },
    ]
  },

  // http - HTTP server/client
  {
    name: 'http',
    functions: [
      { name: 'createServer', module: 'http', security: 'net', pure: false },
      { name: 'request', module: 'http', security: 'net', pure: false },
      { name: 'get', module: 'http', security: 'net', pure: false },
    ]
  },

  // https - HTTPS server/client
  {
    name: 'https',
    functions: [
      { name: 'createServer', module: 'https', security: 'net', pure: false },
      { name: 'request', module: 'https', security: 'net', pure: false },
      { name: 'get', module: 'https', security: 'net', pure: false },
    ]
  },

  // crypto - Cryptographic operations
  {
    name: 'crypto',
    functions: [
      { name: 'createHash', module: 'crypto', security: 'crypto', pure: false },
      { name: 'createHmac', module: 'crypto', security: 'crypto', pure: false },
      { name: 'createCipher', module: 'crypto', security: 'crypto', pure: false },
      { name: 'createDecipher', module: 'crypto', security: 'crypto', pure: false },
      { name: 'createCipheriv', module: 'crypto', security: 'crypto', pure: false },
      { name: 'createDecipheriv', module: 'crypto', security: 'crypto', pure: false },
      { name: 'randomBytes', module: 'crypto', security: 'crypto', pure: false },
      { name: 'randomFill', module: 'crypto', security: 'crypto', pure: false },
      { name: 'randomFillSync', module: 'crypto', security: 'crypto', pure: false },
      { name: 'randomUUID', module: 'crypto', security: 'crypto', pure: false },
      { name: 'pbkdf2', module: 'crypto', security: 'crypto', pure: false },
      { name: 'pbkdf2Sync', module: 'crypto', security: 'crypto', pure: false },
      { name: 'scrypt', module: 'crypto', security: 'crypto', pure: false },
      { name: 'scryptSync', module: 'crypto', security: 'crypto', pure: false },
      { name: 'generateKey', module: 'crypto', security: 'crypto', pure: false },
      { name: 'generateKeyPair', module: 'crypto', security: 'crypto', pure: false },
      { name: 'generateKeyPairSync', module: 'crypto', security: 'crypto', pure: false },
    ]
  },

  // child_process - Process execution (SECURITY SENSITIVE)
  {
    name: 'child_process',
    functions: [
      { name: 'exec', module: 'child_process', security: 'exec', pure: false },
      { name: 'execSync', module: 'child_process', security: 'exec', pure: false },
      { name: 'execFile', module: 'child_process', security: 'exec', pure: false },
      { name: 'execFileSync', module: 'child_process', security: 'exec', pure: false },
      { name: 'spawn', module: 'child_process', security: 'exec', pure: false },
      { name: 'spawnSync', module: 'child_process', security: 'exec', pure: false },
      { name: 'fork', module: 'child_process', security: 'exec', pure: false },
    ]
  },
];

/**
 * Tier 2: Additional commonly used modules
 */
export const TIER_2_MODULES: BuiltinModuleDef[] = [
  // url - URL parsing
  {
    name: 'url',
    functions: [
      { name: 'parse', module: 'url', pure: true },
      { name: 'format', module: 'url', pure: true },
      { name: 'resolve', module: 'url', pure: true },
      { name: 'fileURLToPath', module: 'url', pure: true },
      { name: 'pathToFileURL', module: 'url', pure: true },
    ]
  },

  // util - Utilities
  {
    name: 'util',
    functions: [
      { name: 'promisify', module: 'util', pure: true },
      { name: 'callbackify', module: 'util', pure: true },
      { name: 'inspect', module: 'util', pure: true },
      { name: 'format', module: 'util', pure: true },
      { name: 'deprecate', module: 'util', pure: false },
      { name: 'inherits', module: 'util', pure: false },
    ]
  },

  // os - Operating system info
  {
    name: 'os',
    functions: [
      { name: 'platform', module: 'os', pure: true },
      { name: 'arch', module: 'os', pure: true },
      { name: 'cpus', module: 'os', pure: false },
      { name: 'hostname', module: 'os', pure: false },
      { name: 'homedir', module: 'os', pure: false },
      { name: 'tmpdir', module: 'os', pure: false },
      { name: 'type', module: 'os', pure: true },
      { name: 'release', module: 'os', pure: true },
      { name: 'totalmem', module: 'os', pure: false },
      { name: 'freemem', module: 'os', pure: false },
    ]
  },

  // events - Event emitter
  {
    name: 'events',
    functions: [
      { name: 'EventEmitter', module: 'events', pure: false },
      { name: 'once', module: 'events', pure: false },
      { name: 'on', module: 'events', pure: false },
    ]
  },

  // stream - Streams
  {
    name: 'stream',
    functions: [
      { name: 'Readable', module: 'stream', pure: false },
      { name: 'Writable', module: 'stream', pure: false },
      { name: 'Duplex', module: 'stream', pure: false },
      { name: 'Transform', module: 'stream', pure: false },
      { name: 'pipeline', module: 'stream', pure: false },
      { name: 'finished', module: 'stream', pure: false },
    ]
  },

  // buffer - Buffer operations
  {
    name: 'buffer',
    functions: [
      { name: 'Buffer', module: 'buffer', pure: false },
      { name: 'alloc', module: 'buffer', pure: true },
      { name: 'allocUnsafe', module: 'buffer', pure: true },
      { name: 'from', module: 'buffer', pure: true },
      { name: 'concat', module: 'buffer', pure: true },
      { name: 'isBuffer', module: 'buffer', pure: true },
    ]
  },

  // worker_threads - Worker threads
  {
    name: 'worker_threads',
    functions: [
      { name: 'Worker', module: 'worker_threads', pure: false },
      { name: 'isMainThread', module: 'worker_threads', pure: true },
      { name: 'parentPort', module: 'worker_threads', pure: false },
      { name: 'workerData', module: 'worker_threads', pure: false },
    ]
  },
];

/**
 * All builtin modules combined
 */
export const ALL_BUILTIN_MODULES: BuiltinModuleDef[] = [
  ...TIER_1_MODULES,
  ...TIER_2_MODULES,
];
