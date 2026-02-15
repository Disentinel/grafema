/**
 * Service module — imports utils and defines business logic.
 */

const { formatName, validateEmail } = require('./utils');

function createUser(first, last, email) {
  if (!validateEmail(email)) {
    throw new Error('Invalid email');
  }
  const name = formatName(first, last);
  return { name, email };
}

function getUser(id) {
  return { id, name: formatName('Default', 'User') };
}

module.exports = { createUser, getUser };
