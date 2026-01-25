/**
 * Node.js Builtins - Namespace import pattern
 *
 * Tests EXTERNAL_FUNCTION node creation with namespace imports:
 * import * as fs from 'fs'
 */

import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import * as util from 'util';

// fs.* namespace usage
export function loadViaNamespace(filePath) {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

export function writeViaNamespace(filePath, content) {
  fs.writeFileSync(filePath, content);
}

export function existsViaNamespace(filePath) {
  return fs.existsSync(filePath);
}

// path.* namespace usage
export function joinViaNamespace(...segments) {
  return path.join(...segments);
}

export function parseViaNamespace(filePath) {
  return path.parse(filePath);
}

// url.* namespace usage
export function parseUrl(urlString) {
  return url.parse(urlString);
}

export function formatUrl(urlObj) {
  return url.format(urlObj);
}

// util.* namespace usage
export function promisifyCallback(fn) {
  return util.promisify(fn);
}

export function inspectObject(obj) {
  return util.inspect(obj, { depth: 10 });
}
