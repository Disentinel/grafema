/**
 * ioredis Library Definition
 *
 * Full method coverage for the ioredis npm package with semantic annotations.
 * Each method is classified by operation type (read/write/delete/publish/subscribe/etc.),
 * side effect presence, and key argument position.
 *
 * Used by RedisEnricher to create redis:* nodes from CALL nodes.
 */

import type { LibraryDef, LibraryFunctionDef } from '../types.js';

// Helper to reduce boilerplate
function redisFn(
  name: string,
  operation: LibraryFunctionDef['operation'],
  nodeType: string,
  description: string,
  options: { sideEffect?: boolean; keyArgIndex?: number } = {}
): LibraryFunctionDef {
  return {
    name,
    package: 'ioredis',
    operation,
    sideEffect: options.sideEffect ?? true,
    keyArgIndex: options.keyArgIndex,
    nodeType,
    description,
  };
}

// --- Read operations (redis:read) ---

const READ_METHODS: LibraryFunctionDef[] = [
  // String
  redisFn('get', 'read', 'redis:read', 'Read string value by key', { keyArgIndex: 0 }),
  redisFn('mget', 'read', 'redis:read', 'Batch-read multiple keys', { keyArgIndex: 0 }),
  redisFn('getrange', 'read', 'redis:read', 'Read substring of value', { keyArgIndex: 0 }),
  redisFn('strlen', 'read', 'redis:read', 'Get string length', { keyArgIndex: 0 }),

  // Hash
  redisFn('hget', 'read', 'redis:read', 'Read field from hash', { keyArgIndex: 0 }),
  redisFn('hgetall', 'read', 'redis:read', 'Read all fields from hash', { keyArgIndex: 0 }),
  redisFn('hmget', 'read', 'redis:read', 'Read multiple fields from hash', { keyArgIndex: 0 }),
  redisFn('hkeys', 'read', 'redis:read', 'Get hash field names', { keyArgIndex: 0 }),
  redisFn('hvals', 'read', 'redis:read', 'Get hash field values', { keyArgIndex: 0 }),
  redisFn('hlen', 'read', 'redis:read', 'Get hash field count', { keyArgIndex: 0 }),
  redisFn('hexists', 'read', 'redis:read', 'Check if hash field exists', { keyArgIndex: 0 }),

  // List
  redisFn('lrange', 'read', 'redis:read', 'Read range from list', { keyArgIndex: 0 }),
  redisFn('llen', 'read', 'redis:read', 'Get list length', { keyArgIndex: 0 }),
  redisFn('lindex', 'read', 'redis:read', 'Read element by index', { keyArgIndex: 0 }),

  // Set
  redisFn('smembers', 'read', 'redis:read', 'Read all set members', { keyArgIndex: 0 }),
  redisFn('scard', 'read', 'redis:read', 'Get set size', { keyArgIndex: 0 }),
  redisFn('sismember', 'read', 'redis:read', 'Check set membership', { keyArgIndex: 0 }),
  redisFn('srandmember', 'read', 'redis:read', 'Get random set member', { keyArgIndex: 0 }),

  // Sorted set
  redisFn('zrange', 'read', 'redis:read', 'Read sorted set range', { keyArgIndex: 0 }),
  redisFn('zrangebyscore', 'read', 'redis:read', 'Read sorted set by score range', { keyArgIndex: 0 }),
  redisFn('zrank', 'read', 'redis:read', 'Get member rank in sorted set', { keyArgIndex: 0 }),
  redisFn('zscore', 'read', 'redis:read', 'Get member score in sorted set', { keyArgIndex: 0 }),
  redisFn('zcard', 'read', 'redis:read', 'Get sorted set size', { keyArgIndex: 0 }),

  // Meta/utility reads
  redisFn('type', 'read', 'redis:read', 'Get key type', { keyArgIndex: 0 }),
  redisFn('ttl', 'read', 'redis:read', 'Get TTL in seconds', { keyArgIndex: 0 }),
  redisFn('pttl', 'read', 'redis:read', 'Get TTL in milliseconds', { keyArgIndex: 0 }),
  redisFn('exists', 'read', 'redis:read', 'Check key existence', { keyArgIndex: 0 }),
  redisFn('keys', 'read', 'redis:read', 'Find keys by pattern', { keyArgIndex: 0 }),
  redisFn('scan', 'read', 'redis:read', 'Incrementally iterate keys'),
  redisFn('hscan', 'read', 'redis:read', 'Incrementally iterate hash fields', { keyArgIndex: 0 }),
  redisFn('sscan', 'read', 'redis:read', 'Incrementally iterate set members', { keyArgIndex: 0 }),
  redisFn('zscan', 'read', 'redis:read', 'Incrementally iterate sorted set', { keyArgIndex: 0 }),

  // Stream reads
  redisFn('xrange', 'read', 'redis:read', 'Read stream entries by range', { keyArgIndex: 0 }),
  redisFn('xrevrange', 'read', 'redis:read', 'Read stream entries in reverse', { keyArgIndex: 0 }),
  redisFn('xlen', 'read', 'redis:read', 'Get stream length', { keyArgIndex: 0 }),
  redisFn('xinfo', 'read', 'redis:read', 'Get stream info', { keyArgIndex: 0 }),

  // Read + delete (classified as read since it returns the value)
  redisFn('getdel', 'read', 'redis:read', 'Read and delete key (returns value)', { keyArgIndex: 0 }),
];

// --- Write operations (redis:write) ---

const WRITE_METHODS: LibraryFunctionDef[] = [
  // String
  redisFn('set', 'write', 'redis:write', 'Write string value', { keyArgIndex: 0 }),
  redisFn('setnx', 'write', 'redis:write', 'Write only if key does not exist (distributed lock pattern)', { keyArgIndex: 0 }),
  redisFn('setex', 'write', 'redis:write', 'Write with TTL in seconds (cache pattern)', { keyArgIndex: 0 }),
  redisFn('psetex', 'write', 'redis:write', 'Write with TTL in milliseconds', { keyArgIndex: 0 }),
  redisFn('mset', 'write', 'redis:write', 'Batch-write multiple keys'),
  redisFn('msetnx', 'write', 'redis:write', 'Batch-write only non-existing keys'),
  redisFn('append', 'write', 'redis:write', 'Append to string value', { keyArgIndex: 0 }),
  redisFn('incr', 'write', 'redis:write', 'Atomic increment', { keyArgIndex: 0 }),
  redisFn('incrby', 'write', 'redis:write', 'Atomic increment by amount', { keyArgIndex: 0 }),
  redisFn('incrbyfloat', 'write', 'redis:write', 'Atomic float increment', { keyArgIndex: 0 }),
  redisFn('decr', 'write', 'redis:write', 'Atomic decrement', { keyArgIndex: 0 }),
  redisFn('decrby', 'write', 'redis:write', 'Atomic decrement by amount', { keyArgIndex: 0 }),
  redisFn('getset', 'write', 'redis:write', 'Atomic replace (returns old value)', { keyArgIndex: 0 }),

  // Hash
  redisFn('hset', 'write', 'redis:write', 'Write hash field', { keyArgIndex: 0 }),
  redisFn('hsetnx', 'write', 'redis:write', 'Write hash field if not exists', { keyArgIndex: 0 }),
  redisFn('hmset', 'write', 'redis:write', 'Write multiple hash fields', { keyArgIndex: 0 }),
  redisFn('hincrby', 'write', 'redis:write', 'Atomic increment hash field', { keyArgIndex: 0 }),
  redisFn('hincrbyfloat', 'write', 'redis:write', 'Atomic float increment hash field', { keyArgIndex: 0 }),

  // List
  redisFn('lpush', 'write', 'redis:write', 'Push to list head', { keyArgIndex: 0 }),
  redisFn('rpush', 'write', 'redis:write', 'Push to list tail', { keyArgIndex: 0 }),
  redisFn('linsert', 'write', 'redis:write', 'Insert element in list', { keyArgIndex: 0 }),
  redisFn('lset', 'write', 'redis:write', 'Set list element by index', { keyArgIndex: 0 }),

  // Set
  redisFn('sadd', 'write', 'redis:write', 'Add to set', { keyArgIndex: 0 }),
  redisFn('smove', 'write', 'redis:write', 'Move between sets', { keyArgIndex: 0 }),

  // Sorted set
  redisFn('zadd', 'write', 'redis:write', 'Add to sorted set', { keyArgIndex: 0 }),
  redisFn('zincrby', 'write', 'redis:write', 'Increment sorted set score', { keyArgIndex: 0 }),

  // Stream
  redisFn('xadd', 'write', 'redis:write', 'Append to stream', { keyArgIndex: 0 }),

  // Key mutation
  redisFn('rename', 'write', 'redis:write', 'Rename key', { keyArgIndex: 0 }),
  redisFn('renamenx', 'write', 'redis:write', 'Rename key if new name does not exist', { keyArgIndex: 0 }),
  redisFn('persist', 'write', 'redis:write', 'Remove TTL from key', { keyArgIndex: 0 }),
  redisFn('expire', 'write', 'redis:write', 'Set TTL in seconds', { keyArgIndex: 0 }),
  redisFn('pexpire', 'write', 'redis:write', 'Set TTL in milliseconds', { keyArgIndex: 0 }),
  redisFn('expireat', 'write', 'redis:write', 'Set expiry timestamp (seconds)', { keyArgIndex: 0 }),
  redisFn('pexpireat', 'write', 'redis:write', 'Set expiry timestamp (milliseconds)', { keyArgIndex: 0 }),

  // Bit/range
  redisFn('setbit', 'write', 'redis:write', 'Set bit at offset', { keyArgIndex: 0 }),
  redisFn('setrange', 'write', 'redis:write', 'Overwrite part of string', { keyArgIndex: 0 }),

  // Scripting (classified as write since scripts can mutate)
  redisFn('eval', 'write', 'redis:write', 'Execute Lua script (may mutate data)'),
  redisFn('evalsha', 'write', 'redis:write', 'Execute cached Lua script (may mutate data)'),
  redisFn('script', 'write', 'redis:write', 'Manage server-side scripts'),
];

// --- Delete operations (redis:delete) ---

const DELETE_METHODS: LibraryFunctionDef[] = [
  redisFn('del', 'delete', 'redis:delete', 'Delete key(s)', { keyArgIndex: 0 }),
  redisFn('unlink', 'delete', 'redis:delete', 'Async delete (lazy free)', { keyArgIndex: 0 }),
  redisFn('hdel', 'delete', 'redis:delete', 'Delete hash field', { keyArgIndex: 0 }),

  // List pop/remove (element is removed)
  redisFn('lpop', 'delete', 'redis:delete', 'Pop from list head', { keyArgIndex: 0 }),
  redisFn('rpop', 'delete', 'redis:delete', 'Pop from list tail', { keyArgIndex: 0 }),
  redisFn('blpop', 'delete', 'redis:delete', 'Blocking pop from list head', { keyArgIndex: 0 }),
  redisFn('brpop', 'delete', 'redis:delete', 'Blocking pop from list tail', { keyArgIndex: 0 }),
  redisFn('lrem', 'delete', 'redis:delete', 'Remove list elements by value', { keyArgIndex: 0 }),
  redisFn('ltrim', 'delete', 'redis:delete', 'Trim list to range', { keyArgIndex: 0 }),

  // Set remove
  redisFn('srem', 'delete', 'redis:delete', 'Remove from set', { keyArgIndex: 0 }),
  redisFn('spop', 'delete', 'redis:delete', 'Pop random from set', { keyArgIndex: 0 }),

  // Sorted set remove
  redisFn('zrem', 'delete', 'redis:delete', 'Remove from sorted set', { keyArgIndex: 0 }),
  redisFn('zremrangebyscore', 'delete', 'redis:delete', 'Remove sorted set range by score', { keyArgIndex: 0 }),
  redisFn('zremrangebyrank', 'delete', 'redis:delete', 'Remove sorted set range by rank', { keyArgIndex: 0 }),

  // Stream trim/delete
  redisFn('xtrim', 'delete', 'redis:delete', 'Trim stream', { keyArgIndex: 0 }),
  redisFn('xdel', 'delete', 'redis:delete', 'Delete stream entries', { keyArgIndex: 0 }),

  // Full flush (no specific key)
  redisFn('flushdb', 'delete', 'redis:delete', 'Delete all keys in current database'),
  redisFn('flushall', 'delete', 'redis:delete', 'Delete all keys in all databases'),
];

// --- Pub/Sub operations ---

const PUBSUB_METHODS: LibraryFunctionDef[] = [
  redisFn('publish', 'publish', 'redis:publish', 'Publish message to channel', { keyArgIndex: 0 }),
  redisFn('subscribe', 'subscribe', 'redis:subscribe', 'Subscribe to channel', { keyArgIndex: 0 }),
  redisFn('psubscribe', 'subscribe', 'redis:subscribe', 'Subscribe to channel pattern', { keyArgIndex: 0 }),
  redisFn('unsubscribe', 'subscribe', 'redis:subscribe', 'Unsubscribe from channel', { keyArgIndex: 0 }),
  redisFn('punsubscribe', 'subscribe', 'redis:subscribe', 'Unsubscribe from pattern', { keyArgIndex: 0 }),
];

// --- Transaction/Pipeline operations ---

const TRANSACTION_METHODS: LibraryFunctionDef[] = [
  redisFn('multi', 'transaction', 'redis:transaction', 'Begin transaction', { sideEffect: false }),
  redisFn('exec', 'transaction', 'redis:transaction', 'Execute transaction'),
  redisFn('pipeline', 'transaction', 'redis:transaction', 'Create pipeline (batch without atomicity)', { sideEffect: false }),
  redisFn('discard', 'transaction', 'redis:transaction', 'Discard transaction', { sideEffect: false }),
];

// --- Connection operations ---

const CONNECTION_METHODS: LibraryFunctionDef[] = [
  redisFn('connect', 'connection', 'redis:connection', 'Establish connection', { sideEffect: false }),
  redisFn('disconnect', 'connection', 'redis:connection', 'Close connection', { sideEffect: false }),
  redisFn('quit', 'connection', 'redis:connection', 'Gracefully close connection', { sideEffect: false }),
  redisFn('ping', 'connection', 'redis:connection', 'Check connection', { sideEffect: false }),
  redisFn('select', 'connection', 'redis:connection', 'Select database', { sideEffect: false, keyArgIndex: 0 }),
  redisFn('auth', 'connection', 'redis:connection', 'Authenticate', { sideEffect: false }),
];

// --- Utility operations ---

const UTILITY_METHODS: LibraryFunctionDef[] = [
  redisFn('duplicate', 'utility', 'redis:connection', 'Clone client', { sideEffect: false }),
  redisFn('status', 'utility', 'redis:connection', 'Get connection status', { sideEffect: false }),
];

export const IOREDIS_LIBRARY: LibraryDef = {
  name: 'ioredis',
  aliases: ['redis'],
  category: 'cache',
  functions: [
    ...READ_METHODS,
    ...WRITE_METHODS,
    ...DELETE_METHODS,
    ...PUBSUB_METHODS,
    ...TRANSACTION_METHODS,
    ...CONNECTION_METHODS,
    ...UTILITY_METHODS,
  ],
};
