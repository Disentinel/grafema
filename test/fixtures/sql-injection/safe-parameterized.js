/**
 * Safe SQL - parameterized queries
 */
import { db } from './db.js';

export function getUser(userId) {
  // SAFE: parameterized query
  const query = 'SELECT * FROM users WHERE id = ?';
  return db.query(query, [userId]);
}

export function searchUsers(searchTerm) {
  // SAFE: parameterized query with placeholder
  const query = 'SELECT * FROM users WHERE name LIKE ?';
  return db.query(query, [`%${searchTerm}%`]);
}
