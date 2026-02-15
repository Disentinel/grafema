/**
 * Main app — imports service and calls its functions.
 */

const { createUser, getUser } = require('./service');

function handleRequest(req) {
  const user = createUser(req.first, req.last, req.email);
  return user;
}

function handleGetUser(id) {
  return getUser(id);
}

module.exports = { handleRequest, handleGetUser };
