// Safe code - should NOT trigger any violations

// Regular function calls
function calculate(a, b) {
  return a + b;
}

const result = calculate(1, 2);
console.log('Safe result:', result);

// Regular constructors
class Calculator {
  add(a, b) {
    return a + b;
  }
}

const calc = new Calculator();
console.log('Calculator result:', calc.add(3, 4));

// JSON.parse is safe (not eval)
const data = JSON.parse('{"key": "value"}');
console.log('Parsed data:', data);

// String methods that might look suspicious but are safe
const str = 'hello';
const evaluated = str.includes('eval'); // This is fine
