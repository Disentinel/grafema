// Try/catch with finally
function readFileWithErrorHandling(filename) {
  let file = null;

  try {
    console.log('Opening file:', filename);
    file = openFile(filename);
    const content = file.read();
    return content;
  } catch (error) {
    console.error('Error reading file:', error.message);
    return null;
  } finally {
    if (file) {
      console.log('Closing file');
      file.close();
    }
  }
}

function openFile(filename) {
  return { read: () => 'content', close: () => {} };
}

// Try/catch with re-throw
function validateAndProcess(data) {
  try {
    if (!data) {
      throw new Error('Data is required');
    }

    const result = processData(data);
    return result;
  } catch (error) {
    console.error('Validation failed:', error);
    throw error;
  }
}

function processData(data) {
  return data.toUpperCase();
}

// Nested try/catch
function complexOperation(input) {
  try {
    const parsed = parseInput(input);

    try {
      const validated = validateInput(parsed);
      return validated;
    } catch (validationError) {
      console.error('Validation error:', validationError);
      return null;
    }
  } catch (parseError) {
    console.error('Parse error:', parseError);
    throw parseError;
  }
}

function parseInput(input) {
  if (!input) throw new Error('Empty input');
  return JSON.parse(input);
}

function validateInput(data) {
  if (!data.id) throw new Error('Missing id');
  return data;
}

// Try/catch in async function
async function fetchWithRetry(url, retries = 3) {
  let lastError;

  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url);
      return await response.json();
    } catch (error) {
      console.log(`Attempt ${i + 1} failed:`, error.message);
      lastError = error;
    }
  }

  throw lastError;
}

// Multiple catch blocks simulation (JS doesn't have, but we can check error type)
function handleDifferentErrors(operation) {
  try {
    return operation();
  } catch (error) {
    if (error.name === 'TypeError') {
      console.error('Type error:', error.message);
      return null;
    } else if (error.name === 'ReferenceError') {
      console.error('Reference error:', error.message);
      return null;
    } else {
      console.error('Unknown error:', error.message);
      throw error;
    }
  }
}

// Error with finally but no catch
function withFinally(operation) {
  let result;
  try {
    result = operation();
  } finally {
    console.log('Cleanup');
  }
  return result;
}

export {
  readFileWithErrorHandling,
  validateAndProcess,
  complexOperation,
  fetchWithRetry,
  handleDifferentErrors,
  withFinally
};
