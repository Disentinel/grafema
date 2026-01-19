// Rest parameters in functions
function sum(...numbers) {
  return numbers.reduce((acc, n) => acc + n, 0);
}

function concatenate(separator, ...strings) {
  return strings.join(separator);
}

// Rest with destructuring
function processRequest(method, url, ...options) {
  const [headers, body] = options;
  return { method, url, headers, body };
}

// Spread in arrays
function mergeArrays(arr1, arr2, arr3) {
  return [...arr1, ...arr2, ...arr3];
}

function cloneArray(original) {
  return [...original];
}

function insertInMiddle(arr, newItems) {
  const middle = Math.floor(arr.length / 2);
  return [
    ...arr.slice(0, middle),
    ...newItems,
    ...arr.slice(middle)
  ];
}

// Spread in objects
function mergeObjects(obj1, obj2, obj3) {
  return { ...obj1, ...obj2, ...obj3 };
}

function updateUser(user, updates) {
  return { ...user, ...updates };
}

function addDefaults(options) {
  const defaults = { timeout: 3000, retries: 3 };
  return { ...defaults, ...options };
}

// Spread in function calls
function callWithSpread(func, args) {
  return func(...args);
}

function maxOfArray(numbers) {
  return Math.max(...numbers);
}

// Combining spread and rest
function wrapWithMetadata(data, ...tags) {
  return {
    ...data,
    tags: [...tags],
    timestamp: Date.now()
  };
}

// Spread with destructuring
function extractAndMerge(obj1, obj2) {
  const { id, ...rest1 } = obj1;
  const { name, ...rest2 } = obj2;

  return {
    id,
    name,
    ...rest1,
    ...rest2
  };
}

// Complex spread patterns
function buildConfig(baseConfig, overrides) {
  return {
    ...baseConfig,
    server: {
      ...baseConfig.server,
      ...overrides.server
    },
    database: {
      ...baseConfig.database,
      ...overrides.database
    }
  };
}

// Spread in array literals with other elements
function createFullList(header, items, footer) {
  return [header, ...items, footer];
}

// Valid version with array destructuring
function processGroups(items) {
  const [first, ...rest] = items;
  const last = rest.pop();
  const middle = rest;

  return { first, middle, last };
}

export {
  sum,
  concatenate,
  processRequest,
  mergeArrays,
  cloneArray,
  insertInMiddle,
  mergeObjects,
  updateUser,
  addDefaults,
  callWithSpread,
  maxOfArray,
  wrapWithMetadata,
  extractAndMerge,
  buildConfig,
  createFullList,
  processGroups
};
