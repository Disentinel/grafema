// Function constructor - should be detected

// new Function()
const add = new Function('a', 'b', 'return a + b');
console.log('new Function result:', add(1, 2));

// Function() without new
const multiply = Function('a', 'b', 'return a * b');
console.log('Function result:', multiply(3, 4));

// Function constructor in expression
const ops = {
  divide: new Function('a', 'b', 'return a / b')
};
