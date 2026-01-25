/**
 * Simple module with no HTTP requests
 * This should NOT create any net:request nodes
 */

function hello() {
  console.log('Hello');
  return 'Hello';
}

function greet(name) {
  console.log('Greeting:', name);
  return `Hello, ${name}!`;
}

module.exports = { hello, greet };
