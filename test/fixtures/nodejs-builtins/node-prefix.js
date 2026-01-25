/**
 * Node.js Builtins - node: prefix pattern
 *
 * Tests EXTERNAL_FUNCTION node creation with node: prefix:
 * import { readFile } from 'node:fs'
 */

import { readFile, writeFile } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { Worker, isMainThread } from 'node:worker_threads';
import { EventEmitter } from 'node:events';

// node:fs.readFile
export function loadWithNodePrefix(path, callback) {
  readFile(path, 'utf8', callback);
}

// node:fs.writeFile
export function saveWithNodePrefix(path, content, callback) {
  writeFile(path, content, callback);
}

// node:path.join + node:path.resolve
export function buildWithNodePrefix(base, segment) {
  return resolve(join(base, segment));
}

// node:http.createServer
export function createServerWithNodePrefix(handler) {
  return createServer(handler);
}

// node:worker_threads.Worker
export function createWorker(script) {
  if (isMainThread) {
    return new Worker(script);
  }
  return null;
}

// node:events.EventEmitter
export function createEmitter() {
  return new EventEmitter();
}
