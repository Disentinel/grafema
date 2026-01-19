// Basic template literals
function greet(name) {
  return `Hello, ${name}!`;
}

// Multi-line template literals
function generateEmail(user) {
  return `
    Dear ${user.name},

    Thank you for joining our service.
    Your account email is: ${user.email}

    Best regards,
    The Team
  `;
}

// Template literals with expressions
function calculateTotal(price, quantity, tax) {
  return `Total: $${(price * quantity * (1 + tax)).toFixed(2)}`;
}

// Nested template literals
function buildUrl(protocol, host, port, path) {
  return `${protocol}://${host}${port ? `:${port}` : ''}${path}`;
}

// Template literals with function calls
function formatUser(user) {
  return `User: ${getUserName(user)} (${getUserRole(user)})`;
}

function getUserName(user) {
  return user.name.toUpperCase();
}

function getUserRole(user) {
  return user.role || 'guest';
}

// Template literals in object properties
function createMessage(type, content) {
  return {
    type,
    message: `[${type.toUpperCase()}] ${content}`,
    timestamp: `${new Date().toISOString()}`
  };
}

// Tagged template literals
function highlight(strings, ...values) {
  return strings.reduce((result, str, i) => {
    const value = values[i] ? `<strong>${values[i]}</strong>` : '';
    return result + str + value;
  }, '');
}

function formatMessage(user, action) {
  return highlight`User ${user.name} performed ${action}`;
}

// Template literals with object access
function displayUserInfo(user) {
  return `${user.profile.firstName} ${user.profile.lastName} - ${user.profile.email}`;
}

// Complex template literals
function generateReport(data) {
  const header = `=== Report: ${data.title} ===`;
  const body = data.items.map((item, index) =>
    `${index + 1}. ${item.name}: ${item.value}`
  ).join('\n');
  const footer = `Total items: ${data.items.length}`;

  return `${header}\n${body}\n${footer}`;
}

// Template literals with conditionals
function formatStatus(user) {
  return `Status: ${user.isActive ? 'Active' : 'Inactive'} ${user.isPremium ? '⭐' : ''}`;
}

// Template literals in return statements
function getGreeting(hour) {
  return `Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}!`;
}

export {
  greet,
  generateEmail,
  calculateTotal,
  buildUrl,
  formatUser,
  createMessage,
  formatMessage,
  displayUserInfo,
  generateReport,
  formatStatus,
  getGreeting
};
