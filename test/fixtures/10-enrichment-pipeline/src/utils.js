/**
 * Utility functions for the enrichment pipeline test fixture.
 */

function formatName(first, last) {
  return `${first} ${last}`;
}

function validateEmail(email) {
  return email.includes('@');
}

module.exports = { formatName, validateEmail };
