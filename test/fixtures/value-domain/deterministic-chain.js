// Test: Deterministic values through assignment chains

// 2-level chain
const value1 = 'original';
const value2 = value1;  // should be deterministic

// 3-level chain
const a = 42;
const b = a;
const c = b;  // should be deterministic

// Method name aliasing
const User = {
  save() { return 'saved'; },
  delete() { return 'deleted'; }
};

function aliasedMethodCall() {
  const method1 = 'save';
  const method2 = method1;    // transitive
  const method3 = method2;    // transitive
  return User[method3]();     // should resolve to User.save()
}

// Re-exported constant
const API_VERSION = 'v1';
const version = API_VERSION;
const currentVersion = version;  // all deterministic

module.exports = { value2, c, aliasedMethodCall, currentVersion };
