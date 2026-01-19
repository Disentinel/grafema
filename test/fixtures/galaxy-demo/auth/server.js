/**
 * Auth Service - HTTP API
 *
 * Entrypoint for authentication service
 */

import express from 'express';
import { login, register, verifyToken, requestPasswordReset, resetPassword } from './login.js';
import { createSession, validateSession, destroySession, getUserSessions, sessionMiddleware } from './sessions.js';

const app = express();
const PORT = process.env.AUTH_PORT || 3001;

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'auth' });
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await login(email, password);

    // Create session
    const sessionId = await createSession(result.user.id, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });

    res.json({ ...result, sessionId });
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    const result = await register(email, password, name);
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Logout
app.post('/api/auth/logout', sessionMiddleware, async (req, res) => {
  try {
    await destroySession(req.sessionId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify token
app.get('/api/auth/verify', (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const payload = verifyToken(token);
    res.json({ valid: true, payload });
  } catch (error) {
    res.status(401).json({ valid: false, error: error.message });
  }
});

// Password reset request
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email } = req.body;
    await requestPasswordReset(email);
    res.json({ sent: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Password reset confirm
app.post('/api/auth/reset-password/confirm', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    await resetPassword(token, newPassword);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get user sessions
app.get('/api/auth/sessions', sessionMiddleware, async (req, res) => {
  try {
    const sessions = await getUserSessions(req.userId);
    res.json({ sessions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Auth service running on port ${PORT}`);
});
