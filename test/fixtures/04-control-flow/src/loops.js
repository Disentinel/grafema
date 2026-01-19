// For loops with different patterns
function processWithForLoop(items) {
  const results = [];

  // Classic for loop with counter
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    results.push(item * 2);
  }

  return results;
}

// For...of loop
function sumWithForOf(numbers) {
  let total = 0;

  for (const num of numbers) {
    total += num;
  }

  return total;
}

// For...in loop
function processObjectKeys(obj) {
  const keys = [];

  for (const key in obj) {
    keys.push(key);
    console.log(key, obj[key]);
  }

  return keys;
}

// While loop
function countDown(start) {
  let count = start;

  while (count > 0) {
    console.log(count);
    count--;
  }

  return count;
}

// Do-while loop
function readUntilValid(validator) {
  let value;
  let attempts = 0;

  do {
    value = Math.random();
    attempts++;
  } while (!validator(value) && attempts < 10);

  return { value, attempts };
}

// Nested loops
function generateMatrix(rows, cols) {
  const matrix = [];

  for (let i = 0; i < rows; i++) {
    const row = [];
    for (let j = 0; j < cols; j++) {
      row.push(i * cols + j);
    }
    matrix.push(row);
  }

  return matrix;
}

// Loop with break
function findFirst(items, predicate) {
  for (let i = 0; i < items.length; i++) {
    if (predicate(items[i])) {
      return items[i];
    }
  }
  return null;
}

// Loop with continue
function processEvenOnly(numbers) {
  const evens = [];

  for (let i = 0; i < numbers.length; i++) {
    if (numbers[i] % 2 !== 0) {
      continue;
    }
    evens.push(numbers[i]);
  }

  return evens;
}

export {
  processWithForLoop,
  sumWithForOf,
  processObjectKeys,
  countDown,
  readUntilValid,
  generateMatrix,
  findFirst,
  processEvenOnly
};
