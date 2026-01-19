// Multiple parameters data flow

// Function with multiple parameters
export function transform(input, multiplier) {
  // Using both parameters
  const scaled = input * multiplier;
  return scaled;
}

// Call with multiple arguments
const result = transform(5, 10);

// Function with default parameter
export function greet(name, greeting = 'Hello') {
  // Using both parameters
  return greeting + ' ' + name;
}

const message = greet('World');
const customMessage = greet('World', 'Hi');

// Function with rest parameter
export function sum(...numbers) {
  // Using rest parameter
  return numbers.reduce((a, b) => a + b, 0);
}

const total = sum(1, 2, 3, 4, 5);

// Parameter reassignment
export function normalize(data) {
  // First usage of original parameter
  const original = data;

  // Reassignment
  data = data.toLowerCase();

  // Usage after reassignment
  return data.trim();
}
