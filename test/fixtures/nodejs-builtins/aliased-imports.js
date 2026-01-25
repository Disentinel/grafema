/**
 * Node.js Builtins - Aliased imports pattern
 *
 * Tests EXTERNAL_FUNCTION node creation with aliased imports:
 * import { readFile as rf } from 'fs'
 */

import { readFile as rf, writeFile as wf } from 'fs';
import { join as pathJoin, resolve as pathResolve } from 'path';
import { createHash as hash } from 'crypto';

// Using aliased fs.readFile
export function loadWithAlias(path) {
  return new Promise((resolve, reject) => {
    rf(path, 'utf8', (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

// Using aliased fs.writeFile
export function saveWithAlias(path, content) {
  return new Promise((resolve, reject) => {
    wf(path, content, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Using aliased path functions
export function buildPathWithAlias(base, segment) {
  const joined = pathJoin(base, segment);
  return pathResolve(joined);
}

// Using aliased crypto.createHash
export function hashWithAlias(data) {
  return hash('sha256').update(data).digest('hex');
}
