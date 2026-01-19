/**
 * Unsafe SQL injection - direct user input in query
 */
import { db } from './db.js';

export function getUser(userId) {
  // UNSAFE: user input directly in query string
  const query = `SELECT * FROM users WHERE id = ${userId}`;
  return db.query(query);
}

export function searchUsers(searchTerm) {
  // UNSAFE: string concatenation with user input
  const query = "SELECT * FROM users WHERE name LIKE '%" + searchTerm + "%'";
  return db.query(query);
}
