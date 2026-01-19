// Object destructuring in variable declarations
function processUser(user) {
  const { name, email, age } = user;
  console.log(name, email, age);
  return { name, email, age };
}

// Array destructuring
function getCoordinates() {
  const [x, y, z] = [10, 20, 30];
  return { x, y, z };
}

// Nested destructuring
function processConfig(config) {
  const {
    server: { host, port },
    database: { url, name }
  } = config;

  console.log(host, port, url, name);
  return { host, port, url, name };
}

// Destructuring with defaults
function createUser(options) {
  const {
    name = 'Anonymous',
    age = 0,
    role = 'user'
  } = options;

  return { name, age, role };
}

// Destructuring in function parameters
function greetUser({ name, greeting = 'Hello' }) {
  return `${greeting}, ${name}!`;
}

// Array destructuring with rest
function getFirstAndRest(items) {
  const [first, ...rest] = items;
  console.log('First:', first);
  console.log('Rest:', rest);
  return { first, rest };
}

// Object destructuring with rest
function extractMainFields(data) {
  const { id, name, ...metadata } = data;
  return { id, name, metadata };
}

// Destructuring in for loop
function processEntries(entries) {
  const results = [];

  for (const [key, value] of entries) {
    results.push({ key, value });
  }

  return results;
}

// Swapping variables with destructuring
function swapValues(a, b) {
  [a, b] = [b, a];
  return { a, b };
}

// Destructuring from function return
function getUserData() {
  return { id: 1, name: 'Alice', email: 'alice@example.com' };
}

function displayUserData() {
  const { id, name } = getUserData();
  console.log(id, name);
}

// Renaming in destructuring
function processProduct(product) {
  const {
    id: productId,
    name: productName,
    price: productPrice
  } = product;

  return { productId, productName, productPrice };
}

// Mixed destructuring (array + object)
function processResponse(response) {
  const {
    data: [firstItem, secondItem],
    meta: { total, page }
  } = response;

  return { firstItem, secondItem, total, page };
}

export {
  processUser,
  getCoordinates,
  processConfig,
  createUser,
  greetUser,
  getFirstAndRest,
  extractMainFields,
  processEntries,
  swapValues,
  displayUserData,
  processProduct,
  processResponse
};
