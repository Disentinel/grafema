// Test: Nondeterministic values from function parameters

// Function parameter → nondeterministic
function dynamicMethodCall(methodName) {
  const obj = {
    foo() { return 'foo'; },
    bar() { return 'bar'; }
  };
  // methodName is from parameter → nondeterministic
  return obj[methodName]();  // CANNOT be resolved statically
}

// SQL injection risk - parameter
function unsafeQuery(tableName) {
  const db = require('sqlite3');
  // tableName is from parameter → nondeterministic → SECURITY RISK
  return db.query(`SELECT * FROM ${tableName}`);
}

// Nested function parameter
function outer(value) {
  const x = value;  // x is nondeterministic (from parameter)

  function inner() {
    const y = x;    // y is also nondeterministic (transitively)
    return y;
  }

  return inner();
}

// Mixed: some deterministic, some not
function mixedValues(userInput) {
  const static1 = 'constant';     // deterministic
  const dynamic1 = userInput;     // nondeterministic
  const static2 = static1;        // deterministic
  const dynamic2 = dynamic1;      // nondeterministic

  return { static2, dynamic2 };
}

module.exports = { dynamicMethodCall, unsafeQuery, outer, mixedValues };
