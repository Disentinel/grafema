/**
 * Node.js Builtins - Unused imports pattern
 *
 * Tests that EXTERNAL_FUNCTION nodes are NOT created for unused imports
 * (lazy creation - only when calls are resolved)
 */

import { readFile, writeFile, appendFile, truncate, chmod } from 'fs';
import { join, resolve, normalize, relative, isAbsolute } from 'path';
import { createHash, randomBytes, scrypt } from 'crypto';

// Only readFile is used - should create EXTERNAL_FUNCTION:fs.readFile
// writeFile, appendFile, truncate, chmod are imported but NOT used
export function onlyReadFile(path) {
  return new Promise((resolve, reject) => {
    readFile(path, 'utf8', (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

// Only join and resolve are used
// normalize, relative, isAbsolute are imported but NOT used
export function onlyJoinAndResolve(base, segment) {
  return resolve(join(base, segment));
}

// Only createHash is used
// randomBytes, scrypt are imported but NOT used
export function onlyCreateHash(data) {
  return createHash('sha256').update(data).digest('hex');
}

// EXPECTED BEHAVIOR:
// - EXTERNAL_FUNCTION:fs.readFile - CREATED (used in onlyReadFile)
// - EXTERNAL_FUNCTION:fs.writeFile - NOT CREATED (unused)
// - EXTERNAL_FUNCTION:fs.appendFile - NOT CREATED (unused)
// - EXTERNAL_FUNCTION:fs.truncate - NOT CREATED (unused)
// - EXTERNAL_FUNCTION:fs.chmod - NOT CREATED (unused)
// - EXTERNAL_FUNCTION:path.join - CREATED (used in onlyJoinAndResolve)
// - EXTERNAL_FUNCTION:path.resolve - CREATED (used in onlyJoinAndResolve)
// - EXTERNAL_FUNCTION:path.normalize - NOT CREATED (unused)
// - EXTERNAL_FUNCTION:path.relative - NOT CREATED (unused)
// - EXTERNAL_FUNCTION:path.isAbsolute - NOT CREATED (unused)
// - EXTERNAL_FUNCTION:crypto.createHash - CREATED (used in onlyCreateHash)
// - EXTERNAL_FUNCTION:crypto.randomBytes - NOT CREATED (unused)
// - EXTERNAL_FUNCTION:crypto.scrypt - NOT CREATED (unused)
