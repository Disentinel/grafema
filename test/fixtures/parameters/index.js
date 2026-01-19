// Test fixtures for PARAMETER node detection

// Regular function with parameters
function greet(name, greeting = 'Hello') {
  return `${greeting}, ${name}!`;
}

// Arrow function with parameters
const add = (a, b) => a + b;

// Rest parameters
function sum(...numbers) {
  return numbers.reduce((acc, n) => acc + n, 0);
}

// Function with callback parameter
function processData(data, callback) {
  const result = data.map(x => x * 2);
  callback(result);
}

// Async function with parameters
async function fetchUser(userId) {
  return { id: userId, name: 'Test User' };
}

// Export for module detection
export { greet, add, sum, processData, fetchUser };
