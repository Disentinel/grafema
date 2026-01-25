/**
 * Node.js Builtins - fs/promises pattern
 *
 * Tests EXTERNAL_FUNCTION node creation with fs/promises import:
 * import { readFile } from 'fs/promises'
 */

import { readFile, writeFile, readdir, mkdir, rm } from 'fs/promises';
import { stat, access, copyFile } from 'fs/promises';

// fs/promises.readFile - should create EXTERNAL_FUNCTION:fs/promises.readFile
export async function loadAsync(path) {
  const content = await readFile(path, 'utf8');
  return JSON.parse(content);
}

// fs/promises.writeFile
export async function saveAsync(path, data) {
  await writeFile(path, JSON.stringify(data, null, 2));
}

// fs/promises.readdir
export async function listDir(path) {
  return await readdir(path, { withFileTypes: true });
}

// fs/promises.mkdir
export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

// fs/promises.rm
export async function removeFile(path) {
  await rm(path, { force: true });
}

// fs/promises.stat
export async function getStats(path) {
  return await stat(path);
}

// fs/promises.access
export async function checkAccess(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// fs/promises.copyFile
export async function copy(src, dest) {
  await copyFile(src, dest);
}
