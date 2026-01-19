/**
 * Safe SQL - only literal values in query
 */
import { db } from './db.js';

export function getAllUsers() {
  // SAFE: only literal string
  const query = 'SELECT * FROM users';
  return db.query(query);
}

export function getAdmins() {
  // SAFE: literal value only
  const role = 'admin';
  const query = `SELECT * FROM users WHERE role = '${role}'`;
  return db.query(query);
}
