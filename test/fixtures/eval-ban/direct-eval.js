// Direct eval() call - should be detected
const code = '1 + 1';
const result = eval(code);
console.log('Direct eval result:', result);

// Another direct eval
function executeCode(str) {
  return eval(str);
}
