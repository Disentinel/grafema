/**
 * Node.js Builtins - CommonJS require pattern
 *
 * Tests EXTERNAL_FUNCTION node creation with require() syntax
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// fs.readFileSync via require
function loadSync(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

// fs.existsSync via require
function fileExists(filePath) {
  return fs.existsSync(filePath);
}

// path.dirname via require
function getDirectory(fullPath) {
  return path.dirname(fullPath);
}

// path.extname via require
function getExtension(fullPath) {
  return path.extname(fullPath);
}

// crypto.createHash - should create EXTERNAL_FUNCTION:crypto.createHash
function hashString(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// crypto.randomBytes - should create EXTERNAL_FUNCTION:crypto.randomBytes
function generateToken(size) {
  return crypto.randomBytes(size).toString('hex');
}

module.exports = {
  loadSync,
  fileExists,
  getDirectory,
  getExtension,
  hashString,
  generateToken
};
