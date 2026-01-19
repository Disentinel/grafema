// Простой скрипт с функцией и console.log
function greet(name) {
  console.log('Hello, ' + name);
  return 'Hello, ' + name;
}

function conditionalGreet(name, shouldGreet) {
  if (shouldGreet) {
    // Условный вызов - выполнится только если shouldGreet === true
    greet(name);
  }
}

function createCounter() {
  let count = 0;

  // Замыкание - внутренняя функция захватывает count
  return function increment() {
    count++;
    console.log('Count:', count);
    return count;
  };
}

function main() {
  const result = greet('World');
  console.log('Result:', result);

  // Условный вызов
  conditionalGreet('Alice', true);

  // Замыкание
  const counter = createCounter();
  counter();
}

main();
