// Test PASSES_ARGUMENT edge creation

// === Simple cases ===

// 1. Direct literal argument
function processLiteral(value) {
  return value;
}
processLiteral('hello');
processLiteral(42);

// 2. Variable argument
const userInput = 'some input';
processLiteral(userInput);

// 3. Multiple arguments
function multiArgs(a, b, c) {
  return a + b + c;
}
const x = 1;
const y = 2;
multiArgs(x, y, 3);

// === Complex cases ===

// 4. Expression as argument
function processExpr(val) {
  return val * 2;
}
processExpr(x + y);
processExpr(userInput.toUpperCase());

// 5. Nested calls
function outer(val) {
  return val;
}
function inner(val) {
  return val + '!';
}
outer(inner('test'));

// 6. Callback argument (function as argument)
function withCallback(data, callback) {
  return callback(data);
}
withCallback('data', (d) => d.trim());

// 7. Object/array argument
function processObject(obj) {
  return obj.name;
}
const user = { name: 'John', age: 30 };
processObject(user);
processObject({ inline: true });

function processArray(arr) {
  return arr.length;
}
processArray([1, 2, 3]);

// 8. Spread argument
function sum(...numbers) {
  return numbers.reduce((a, b) => a + b, 0);
}
const nums = [1, 2, 3];
sum(...nums);

// === Method calls ===

// 9. Method call with arguments
class Service {
  process(input) {
    return input;
  }

  save(data, options) {
    return { data, options };
  }
}

const service = new Service();
service.process(userInput);
service.save(user, { validate: true });

// === Chained/tainted data flow ===

// 10. Tainted data through function
function sanitize(input) {
  return input.replace(/</g, '&lt;');
}
const tainted = process.env.USER_INPUT;
const sanitized = sanitize(tainted);

// 11. Multiple levels of passing
function level1(a) { return level2(a); }
function level2(b) { return level3(b); }
function level3(c) { return c; }
level1(tainted);
