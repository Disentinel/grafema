// Advanced JavaScript features test fixture
import { Helper } from './helper.js';
import express from 'express';
import { readFile } from 'fs/promises';

// Class instantiation
const app = new express();
const helper = new Helper();

// Arrow functions assigned to variables
const add = (a, b) => a + b;
const multiply = (x, y) => {
  return x * y;
};

// Regular function with arrow callbacks
function processArray(arr) {
  // Array methods with arrow functions
  const doubled = arr.map(x => x * 2);
  const filtered = doubled.filter(x => x > 10);

  return filtered.reduce((acc, val) => acc + val, 0);
}

// Method calls (beyond console.log)
function setupServer() {
  app.listen(3000);
  helper.doSomething();

  const result = helper.calculate(5);
  console.log('Result:', result);
}

// Event handlers
process.on('SIGINT', () => {
  console.log('Shutting down');
  process.exit(0);
});

app.on('error', (err) => {
  console.error('Server error:', err);
});

// Async/await with method calls
async function loadData() {
  const data = await readFile('./data.txt', 'utf8');
  const parsed = JSON.parse(data);
  return parsed;
}

// Main execution
const numbers = [1, 2, 3, 4, 5];
const result = processArray(numbers);
setupServer();
loadData().catch(console.error);
