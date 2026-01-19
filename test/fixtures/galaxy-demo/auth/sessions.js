/**
 * Sessions Service - Session Management
 *
 * Handles user session storage and validation
 * External connections: db:redis, sys:env
 */

import Redis from 'ioredis';

// Initialize Redis client from environment
const redis = new Redis(process.env.REDIS_URL);

const SESSION_TTL = parseInt(process.env.SESSION_TTL || '86400', 10); // 24 hours default
const SESSION_PREFIX = process.env.SESSION_PREFIX || 'session:';

/**
 * Create a new session
 */
export async function createSession(userId, metadata = {}) {
  const sessionId = generateSessionId();

  const sessionData = {
    userId,
    createdAt: Date.now(),
    lastAccess: Date.now(),
    userAgent: metadata.userAgent || null,
    ipAddress: metadata.ipAddress || null,
    device: metadata.device || null
  };

  await redis.setex(
    `${SESSION_PREFIX}${sessionId}`,
    SESSION_TTL,
    JSON.stringify(sessionData)
  );

  // Add to user's session list
  await redis.sadd(`${SESSION_PREFIX}user:${userId}`, sessionId);

  return sessionId;
}

/**
 * Get session by ID
 */
export async function getSession(sessionId) {
  const data = await redis.get(`${SESSION_PREFIX}${sessionId}`);

  if (!data) {
    return null;
  }

  const session = JSON.parse(data);

  // Update last access time
  session.lastAccess = Date.now();
  await redis.setex(
    `${SESSION_PREFIX}${sessionId}`,
    SESSION_TTL,
    JSON.stringify(session)
  );

  return session;
}

/**
 * Validate session and return user ID
 */
export async function validateSession(sessionId) {
  const session = await getSession(sessionId);

  if (!session) {
    throw new Error('Invalid or expired session');
  }

  return session.userId;
}

/**
 * Destroy a session
 */
export async function destroySession(sessionId) {
  const data = await redis.get(`${SESSION_PREFIX}${sessionId}`);

  if (data) {
    const session = JSON.parse(data);
    // Remove from user's session list
    await redis.srem(`${SESSION_PREFIX}user:${session.userId}`, sessionId);
  }

  await redis.del(`${SESSION_PREFIX}${sessionId}`);
}

/**
 * Get all sessions for a user
 */
export async function getUserSessions(userId) {
  const sessionIds = await redis.smembers(`${SESSION_PREFIX}user:${userId}`);

  const sessions = [];
  for (const sessionId of sessionIds) {
    const data = await redis.get(`${SESSION_PREFIX}${sessionId}`);
    if (data) {
      sessions.push({
        sessionId,
        ...JSON.parse(data)
      });
    } else {
      // Clean up stale session reference
      await redis.srem(`${SESSION_PREFIX}user:${userId}`, sessionId);
    }
  }

  return sessions;
}

/**
 * Destroy all sessions for a user (logout everywhere)
 */
export async function destroyAllUserSessions(userId) {
  const sessionIds = await redis.smembers(`${SESSION_PREFIX}user:${userId}`);

  const pipeline = redis.pipeline();

  for (const sessionId of sessionIds) {
    pipeline.del(`${SESSION_PREFIX}${sessionId}`);
  }

  pipeline.del(`${SESSION_PREFIX}user:${userId}`);

  await pipeline.exec();

  return sessionIds.length;
}

/**
 * Refresh session TTL
 */
export async function refreshSession(sessionId) {
  const data = await redis.get(`${SESSION_PREFIX}${sessionId}`);

  if (!data) {
    return false;
  }

  const session = JSON.parse(data);
  session.lastAccess = Date.now();

  await redis.setex(
    `${SESSION_PREFIX}${sessionId}`,
    SESSION_TTL,
    JSON.stringify(session)
  );

  return true;
}

/**
 * Get session statistics
 */
export async function getSessionStats() {
  const keys = await redis.keys(`${SESSION_PREFIX}*`);

  const userSessions = keys.filter(k => k.includes(':user:'));
  const activeSessions = keys.filter(k => !k.includes(':user:'));

  return {
    totalActiveSessions: activeSessions.length,
    totalUsers: userSessions.length,
    ttl: SESSION_TTL
  };
}

/**
 * Generate a secure session ID
 */
function generateSessionId() {
  const crypto = require('crypto');
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Middleware to check session
 */
export function sessionMiddleware(req, res, next) {
  const sessionId = req.headers['x-session-id'] || req.cookies?.sessionId;

  if (!sessionId) {
    return res.status(401).json({ error: 'No session provided' });
  }

  validateSession(sessionId)
    .then(userId => {
      req.userId = userId;
      req.sessionId = sessionId;
      next();
    })
    .catch(error => {
      res.status(401).json({ error: error.message });
    });
}
