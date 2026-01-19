// Test: Nondeterministic values from external sources

const express = require('express');
const app = express();

// HTTP request body → nondeterministic
app.post('/api/query', (req, res) => {
  const db = require('sqlite3');
  const tableName = req.body.table;  // from HTTP request → nondeterministic

  // SECURITY RISK: SQL injection
  const result = db.query(`SELECT * FROM ${tableName}`);
  res.json(result);
});

// fetch() result → nondeterministic
async function fetchData() {
  const response = await fetch('/api/data');
  const data = await response.json();

  const methodName = data.method;  // from HTTP response → nondeterministic
  const obj = { foo() {}, bar() {} };

  return obj[methodName]();  // CANNOT be resolved
}

// Database query result → nondeterministic
async function getFromDb() {
  const db = require('sqlite3');
  const rows = await db.query('SELECT config_value FROM settings');

  const value = rows[0].config_value;  // from DB → nondeterministic
  return value;
}

// Environment variable → nondeterministic
function getEnvConfig() {
  const nodeEnv = process.env.NODE_ENV;  // from env → nondeterministic
  return nodeEnv;
}

// File read → nondeterministic
async function readConfig() {
  const fs = require('fs').promises;
  const content = await fs.readFile('./config.json', 'utf8');
  const config = JSON.parse(content);  // from file → nondeterministic
  return config;
}

module.exports = { app, fetchData, getFromDb, getEnvConfig, readConfig };
