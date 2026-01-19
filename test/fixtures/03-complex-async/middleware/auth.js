// Authentication middleware with callbacks, promises, and async/await
import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';
import { createClient } from 'redis';

const redis = createClient();
const SECRET_KEY = 'secret-key';

// Callback-based token verification
export function verifyTokenCallback(token, callback) {
  jwt.verify(token, SECRET_KEY, (err, decoded) => {
    if (err) {
      return callback(new Error('Invalid token'));
    }

    User.findById(decoded._id, (err, user) => {
      if (err) {
        return callback(err);
      }

      if (!user) {
        return callback(new Error('User not found'));
      }

      redis.get(`blacklist:${token}`, (err, blacklisted) => {
        if (err) {
          console.error('Redis error:', err);
        }

        if (blacklisted) {
          return callback(new Error('Token blacklisted'));
        }

        callback(null, { user, decoded });
      });
    });
  });
}

// Promise-based token verification with chain
export function verifyTokenPromise(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(token, SECRET_KEY, (err, decoded) => {
      if (err) {
        reject(new Error('Invalid token'));
      } else {
        resolve(decoded);
      }
    });
  })
  .then(decoded => {
    return User.findById(decoded._id)
      .then(user => {
        if (!user) {
          throw new Error('User not found');
        }
        return { user, decoded };
      });
  })
  .then(data => {
    return redis.get(`blacklist:${token}`)
      .then(blacklisted => {
        if (blacklisted) {
          throw new Error('Token blacklisted');
        }
        return data;
      });
  })
  .catch(err => {
    console.error('Verification error:', err);
    throw err;
  });
}

// Async/await version
export async function verifyTokenAsync(token) {
  try {
    const decoded = await new Promise((resolve, reject) => {
      jwt.verify(token, SECRET_KEY, (err, decoded) => {
        if (err) reject(err);
        else resolve(decoded);
      });
    });

    const user = await User.findById(decoded._id);

    if (!user) {
      throw new Error('User not found');
    }

    const blacklisted = await redis.get(`blacklist:${token}`);

    if (blacklisted) {
      throw new Error('Token blacklisted');
    }

    return { user, decoded };
  } catch (error) {
    console.error('Token verification failed:', error);
    throw error;
  }
}

// Middleware with callback hell
export function authMiddlewareCallback(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  // Callback pyramid
  jwt.verify(token, SECRET_KEY, (err, decoded) => {
    if (err) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    User.findById(decoded._id, (err, user) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      redis.get(`blacklist:${token}`, (err, blacklisted) => {
        if (err) {
          console.error('Redis error:', err);
        }

        if (blacklisted) {
          return res.status(401).json({ error: 'Token revoked' });
        }

        redis.get(`session:${user._id}`, (err, session) => {
          if (err) {
            console.error('Session error:', err);
          }

          req.user = user;
          req.session = session ? JSON.parse(session) : null;
          next();
        });
      });
    });
  });
}

// Middleware with promise chain
export function authMiddlewarePromise(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  verifyTokenPromise(token)
    .then(({ user, decoded }) => {
      return redis.get(`session:${user._id}`)
        .then(session => {
          return { user, decoded, session };
        });
    })
    .then(({ user, decoded, session }) => {
      req.user = user;
      req.decoded = decoded;
      req.session = session ? JSON.parse(session) : null;
      next();
    })
    .catch(err => {
      res.status(401).json({ error: err.message });
    });
}

// Modern async middleware
export async function authMiddleware(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const { user, decoded } = await verifyTokenAsync(token);

    const session = await redis.get(`session:${user._id}`);

    req.user = user;
    req.decoded = decoded;
    req.session = session ? JSON.parse(session) : null;

    next();
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
}

// Role-based authorization with callbacks
export function requireRole(role) {
  return function(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    User.findById(req.user._id, (err, user) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }

      if (user.role !== role) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      redis.get(`permissions:${user._id}`, (err, permissions) => {
        if (err) {
          console.error('Permissions error:', err);
        }

        req.permissions = permissions ? JSON.parse(permissions) : [];
        next();
      });
    });
  };
}

// Role check with promise chain
export function requireRolePromise(role) {
  return function(req, res, next) {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    User.findById(req.user._id)
      .then(user => {
        if (user.role !== role) {
          throw new Error('Insufficient permissions');
        }
        return user;
      })
      .then(user => {
        return redis.get(`permissions:${user._id}`)
          .then(permissions => {
            return { user, permissions };
          });
      })
      .then(({ user, permissions }) => {
        req.permissions = permissions ? JSON.parse(permissions) : [];
        next();
      })
      .catch(err => {
        res.status(403).json({ error: err.message });
      });
  };
}

// Async role check
export function requireRoleAsync(role) {
  return async function(req, res, next) {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const user = await User.findById(req.user._id);

      if (user.role !== role) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }

      const permissions = await redis.get(`permissions:${user._id}`);
      req.permissions = permissions ? JSON.parse(permissions) : [];

      next();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };
}

// Complex middleware with mixed async patterns
export function rateLimitMiddleware(req, res, next) {
  const userId = req.user?._id || req.ip;
  const key = `ratelimit:${userId}`;

  // Mix of callback and promise
  redis.get(key, (err, current) => {
    if (err) {
      console.error('Rate limit error:', err);
      return next();
    }

    const requests = parseInt(current || '0');

    if (requests >= 100) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }

    // Promise chain for incrementing
    redis.incr(key)
      .then(() => {
        return redis.expire(key, 3600);
      })
      .then(() => {
        next();
      })
      .catch(err => {
        console.error('Rate limit update error:', err);
        next();
      });
  });
}

// Session refresh with callback hell
export function refreshSession(userId, callback) {
  User.findById(userId, (err, user) => {
    if (err) return callback(err);
    if (!user) return callback(new Error('User not found'));

    const sessionData = {
      userId: user._id,
      email: user.email,
      role: user.role,
      lastActivity: new Date()
    };

    redis.set(`session:${userId}`, JSON.stringify(sessionData), (err) => {
      if (err) return callback(err);

      redis.expire(`session:${userId}`, 86400, (err) => {
        if (err) return callback(err);

        user.updateLastLogin((err, updatedUser) => {
          if (err) return callback(err);

          callback(null, { session: sessionData, user: updatedUser });
        });
      });
    });
  });
}

// Token blacklisting with promise chain
export function blacklistToken(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(token, SECRET_KEY, (err, decoded) => {
      if (err) {
        reject(new Error('Invalid token'));
      } else {
        resolve(decoded);
      }
    });
  })
  .then(decoded => {
    const expiresIn = decoded.exp - Math.floor(Date.now() / 1000);
    return redis.set(`blacklist:${token}`, 'true', 'EX', expiresIn);
  })
  .then(() => {
    return { success: true };
  })
  .catch(err => {
    console.error('Blacklist error:', err);
    throw err;
  });
}

export default authMiddleware;
