/**
 * Login Service - Authentication
 *
 * Handles user authentication and session creation
 * External connections: db:postgres, api:payments
 */

import { Pool } from 'pg';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const JWT_SECRET = process.env.JWT_SECRET;
const PAYMENTS_SERVICE_URL = process.env.PAYMENTS_SERVICE_URL || 'http://localhost:3001';

/**
 * Authenticate user with email and password
 */
export async function login(email, password) {
  // Find user by email
  const result = await pool.query(
    'SELECT id, email, password_hash, name, role FROM users WHERE email = $1',
    [email]
  );

  if (result.rows.length === 0) {
    throw new Error('Invalid email or password');
  }

  const user = result.rows[0];

  // Verify password
  const isValid = await bcrypt.compare(password, user.password_hash);

  if (!isValid) {
    throw new Error('Invalid email or password');
  }

  // Update last login
  await pool.query(
    'UPDATE users SET last_login = NOW() WHERE id = $1',
    [user.id]
  );

  // Generate JWT token
  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role
    }
  };
}

/**
 * Register a new user
 */
export async function register(email, password, name) {
  // Check if email already exists
  const existingUser = await pool.query(
    'SELECT id FROM users WHERE email = $1',
    [email]
  );

  if (existingUser.rows.length > 0) {
    throw new Error('Email already registered');
  }

  // Hash password
  const passwordHash = await bcrypt.hash(password, 12);

  // Insert user
  const result = await pool.query(
    'INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4) RETURNING id',
    [email, passwordHash, name, 'user']
  );

  const userId = result.rows[0].id;

  // Initialize user in payments service
  await initPaymentsAccount(userId, email);

  return { userId };
}

/**
 * Initialize user account in payments service
 */
async function initPaymentsAccount(userId, email) {
  try {
    const response = await fetch(`${PAYMENTS_SERVICE_URL}/api/accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SERVICE_TOKEN}`
      },
      body: JSON.stringify({ userId, email })
    });

    if (!response.ok) {
      console.error('Failed to initialize payments account:', await response.text());
    }
  } catch (error) {
    console.error('Error calling payments service:', error);
  }
}

/**
 * Verify JWT token
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    throw new Error('Invalid or expired token');
  }
}

/**
 * Request password reset
 */
export async function requestPasswordReset(email) {
  const result = await pool.query(
    'SELECT id FROM users WHERE email = $1',
    [email]
  );

  if (result.rows.length === 0) {
    // Don't reveal if email exists
    return { sent: true };
  }

  const userId = result.rows[0].id;

  // Generate reset token
  const resetToken = jwt.sign(
    { userId, type: 'password_reset' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  // Store reset token
  await pool.query(
    'INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'1 hour\')',
    [userId, resetToken]
  );

  // TODO: Send email with reset link

  return { sent: true };
}

/**
 * Reset password with token
 */
export async function resetPassword(token, newPassword) {
  // Verify token
  const payload = jwt.verify(token, JWT_SECRET);

  if (payload.type !== 'password_reset') {
    throw new Error('Invalid reset token');
  }

  // Check if token is still valid in database
  const result = await pool.query(
    'SELECT user_id FROM password_resets WHERE token = $1 AND expires_at > NOW()',
    [token]
  );

  if (result.rows.length === 0) {
    throw new Error('Reset token expired or invalid');
  }

  const userId = result.rows[0].user_id;

  // Hash new password
  const passwordHash = await bcrypt.hash(newPassword, 12);

  // Update password
  await pool.query(
    'UPDATE users SET password_hash = $1 WHERE id = $2',
    [passwordHash, userId]
  );

  // Invalidate reset token
  await pool.query(
    'DELETE FROM password_resets WHERE token = $1',
    [token]
  );

  return { success: true };
}

/**
 * Get user by ID
 */
export async function getUserById(userId) {
  const result = await pool.query(
    'SELECT id, email, name, role, created_at, last_login FROM users WHERE id = $1',
    [userId]
  );

  return result.rows[0] || null;
}
