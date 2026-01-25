/**
 * Node.js Builtins - main scenario (ES imports)
 *
 * Tests EXTERNAL_FUNCTION node creation for Node.js built-in modules
 */

import { readFile, writeFile, readdir } from 'fs';
import { join, resolve, basename } from 'path';
import { createServer } from 'http';
import { exec, spawn } from 'child_process';

// Import other fixture files to ensure they are analyzed
import './aliased-imports.js';
import './fs-promises.js';
import './namespace-import.js';
import './node-prefix.js';
import './unused-imports.js';

// fs.readFile - should create EXTERNAL_FUNCTION:fs.readFile
export async function loadConfig(configPath) {
  return new Promise((resolve, reject) => {
    readFile(configPath, 'utf8', (err, data) => {
      if (err) reject(err);
      else resolve(JSON.parse(data));
    });
  });
}

// fs.writeFile - should create EXTERNAL_FUNCTION:fs.writeFile
export function saveData(filePath, data) {
  writeFile(filePath, JSON.stringify(data), (err) => {
    if (err) console.error('Write failed:', err);
  });
}

// fs.readdir - should create EXTERNAL_FUNCTION:fs.readdir
export function listFiles(dir, callback) {
  readdir(dir, callback);
}

// path.join + path.resolve - should create EXTERNAL_FUNCTION:path.join, EXTERNAL_FUNCTION:path.resolve
export function buildPath(base, ...segments) {
  const full = join(base, ...segments);
  return resolve(full);
}

// path.basename - should create EXTERNAL_FUNCTION:path.basename
export function getFilename(fullPath) {
  return basename(fullPath);
}

// http.createServer - should create EXTERNAL_FUNCTION:http.createServer
export function startServer(port) {
  const server = createServer((req, res) => {
    res.writeHead(200);
    res.end('Hello');
  });
  server.listen(port);
  return server;
}

// child_process.exec - SECURITY SENSITIVE: security:exec
export function runCommand(cmd) {
  exec(cmd, (error, stdout, stderr) => {
    console.log(stdout);
  });
}

// child_process.spawn - SECURITY SENSITIVE: security:exec
export function spawnProcess(command, args) {
  const child = spawn(command, args);
  child.stdout.on('data', (data) => console.log(data.toString()));
  return child;
}
