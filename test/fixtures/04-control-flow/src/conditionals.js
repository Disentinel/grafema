// Switch statement with multiple cases
function processCommand(command) {
  let result;

  switch (command) {
    case 'start':
      result = 'Starting service';
      console.log(result);
      break;

    case 'stop':
      result = 'Stopping service';
      console.log(result);
      break;

    case 'restart':
      result = 'Restarting service';
      console.log(result);
      break;

    case 'status':
      result = 'Service is running';
      break;

    default:
      result = 'Unknown command';
      console.error(result);
  }

  return result;
}

// Switch with fall-through
function getCategory(value) {
  let category;

  switch (value) {
    case 1:
    case 2:
    case 3:
      category = 'low';
      break;

    case 4:
    case 5:
    case 6:
      category = 'medium';
      break;

    case 7:
    case 8:
    case 9:
    case 10:
      category = 'high';
      break;

    default:
      category = 'invalid';
  }

  return category;
}

// Ternary operators
function getStatus(isActive) {
  return isActive ? 'active' : 'inactive';
}

function calculatePrice(quantity, isPremium) {
  const basePrice = quantity * 10;
  return isPremium ? basePrice * 0.9 : basePrice;
}

// Nested ternary (complex)
function getGrade(score) {
  return score >= 90 ? 'A' :
         score >= 80 ? 'B' :
         score >= 70 ? 'C' :
         score >= 60 ? 'D' : 'F';
}

// Ternary with function calls
function processUser(user) {
  const name = user ? user.name : 'Guest';
  const greeting = user ? greetUser(user) : greetGuest();
  return { name, greeting };
}

function greetUser(user) {
  return `Hello, ${user.name}!`;
}

function greetGuest() {
  return 'Hello, Guest!';
}

// Logical operators as conditionals
function getValue(input, defaultValue) {
  return input || defaultValue;
}

function safeAccess(obj) {
  return obj && obj.property;
}

// Nullish coalescing
function getConfigValue(config, key) {
  return config[key] ?? 'default';
}

// Optional chaining
function getUserEmail(user) {
  return user?.profile?.email;
}

function getFirstItemName(data) {
  return data?.items?.[0]?.name;
}

export {
  processCommand,
  getCategory,
  getStatus,
  calculatePrice,
  getGrade,
  processUser,
  getValue,
  safeAccess,
  getConfigValue,
  getUserEmail,
  getFirstItemName
};
