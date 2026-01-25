// Test RECEIVES_ARGUMENT edge creation
// RECEIVES_ARGUMENT connects PARAMETER nodes to their argument sources at call sites

// === 1. Basic argument binding ===
// PARAMETER(data) should RECEIVES_ARGUMENT from VARIABLE(userInput)
const userInput = 'some input';
function process(data) {
  return data;
}
process(userInput);

// === 2. Multi-argument binding ===
// Each parameter receives its corresponding argument by index
function combine(a, b) {
  return a + b;
}
const x = 1;
const y = 2;
combine(x, y);

// === 3. Method call binding ===
// Class method parameters should also receive arguments
class Service {
  process(data) {
    return data;
  }

  save(entity, options) {
    return { entity, options };
  }
}
const service = new Service();
service.process(userInput);
service.save({ name: 'John' }, { validate: true });

// === 4. Arrow function binding ===
// Arrow function parameters receive arguments
const double = (num) => num * 2;
const value = 42;
double(value);

// === 5. Unresolved call ===
// When function cannot be resolved (no CALLS edge), no RECEIVES_ARGUMENT should be created
// This should not crash the analyzer
unknownFunction(userInput);

// === 6. Missing arguments ===
// Function with more parameters than arguments passed
// Extra parameters should have no RECEIVES_ARGUMENT edge
function threeParams(a, b, c) {
  return [a, b, c];
}
threeParams(x, y); // only 2 args for 3 params

// === 7. Extra arguments ===
// Call with more arguments than parameters
// Extra arguments should not create edges (no matching parameter)
function oneParam(single) {
  return single;
}
oneParam(x, y, value); // 3 args for 1 param

// === 8. Literal arguments ===
// Parameters should receive literal values too
function processNumber(num) {
  return num * 2;
}
processNumber(42);

function processString(str) {
  return str.toUpperCase();
}
processString('hello');

// === 9. Nested call as argument ===
// Parameter receives CALL node (result of inner function)
function outer(val) {
  return val;
}
function inner(msg) {
  return msg + '!';
}
outer(inner('test'));

// === 10. Function expression parameter binding ===
// Named function expression
const namedFn = function handler(event) {
  return event.type;
};
namedFn({ type: 'click' });

// === 11. Rest parameter binding ===
// Rest parameter receives spread or multiple args
function withRest(first, ...rest) {
  return [first, rest];
}
const nums = [1, 2, 3];
withRest(0, ...nums);

// === 12. Callback with parameters ===
// Anonymous callback function parameters should receive arguments
function withCallback(data, callback) {
  return callback(data);
}
withCallback('test', (d) => d.trim());

// === 13. IIFE parameters ===
// Immediately invoked function expression
(function(msg) {
  console.log(msg);
})('IIFE message');

// === 14. Method with multiple calls ===
// Same method called multiple times - each call creates separate edges
service.process('first');
service.process('second');
