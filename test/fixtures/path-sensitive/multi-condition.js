// Multiple and nested conditions test

const type = getUserType();
const permission = getPermission();
const resource = getResource();

// Simple condition
if (type === "admin") {
  // type === "admin"
  console.log('Admin access');
  handleAdmin(type);
}

// Nested conditions - both constraints should accumulate
if (permission === "read") {
  // permission === "read"
  console.log('Has read permission');

  if (resource === "file") {
    // permission === "read" AND resource === "file"
    console.log('Reading file');
    readFile(resource);
  }
}

// OR condition - multiple possible values
const mode = getMode();
if (mode === "fast" || mode === "turbo") {
  // mode ∈ {"fast", "turbo"}
  console.log('Speed mode:', mode);
  setSpeed(mode);
}

// else branch - negated constraint
const role = getRole();
if (role === "guest") {
  console.log('Guest user');
} else {
  // role !== "guest"
  console.log('Authenticated user');
  showDashboard(role);
}

// Triple nested
const a = getA();
const b = getB();
const c = getC();

if (a === "x") {
  if (b === "y") {
    if (c === "z") {
      // a === "x" AND b === "y" AND c === "z"
      console.log(a, b, c);
    }
  }
}
