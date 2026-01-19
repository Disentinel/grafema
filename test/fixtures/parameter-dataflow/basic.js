// Basic parameter data flow

// Function with single parameter
export function processData(data) {
  // Using 'data' parameter - should trace back to PARAMETER node
  const result = data.map(x => x * 2);
  const length = data.length;
  return result;
}

// Call site - argument should connect to parameter via PASSES_ARGUMENT
const items = [1, 2, 3];
const processed = processData(items);

// Arrow function with parameter
export const filterItems = (items) => {
  // Using 'items' parameter
  return items.filter(x => x > 0);
};

const filtered = filterItems([1, -2, 3]);
