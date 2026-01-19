// Test: Deterministic values from literals

// Simple literal assignments
const apiEndpoint = '/api/users';
const timeout = 3000;
const debug = true;

// Should be deterministic
function makeRequest() {
  const method = 'GET';
  const url = apiEndpoint;
  return fetch(url, { method });
}

// Computed member access with deterministic value
const obj = {
  save() { return 'saved'; },
  load() { return 'loaded'; }
};

function callMethod() {
  const methodName = 'save';  // literal → deterministic
  return obj[methodName]();   // should be resolvable to obj.save()
}

// Config validation use case
const config = {
  port: 8080,        // literal → deterministic
  host: 'localhost'  // literal → deterministic
};

module.exports = { makeRequest, callMethod, config };
