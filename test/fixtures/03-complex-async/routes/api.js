// API routes with callback hell, promise chains, and async/await
import { Router } from 'express';
import { User } from '../models/User.js';
import mongoose from 'mongoose';
import { createClient } from 'redis';

const router = Router();
const redis = createClient();

// Callback hell - nested resource creation
router.post('/users/register', (req, res) => {
  const { email, password, firstName, lastName } = req.body;

  // Level 1: Check if user exists
  User.findByEmail(email, (err, existingUser) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Level 2: Create user
    const newUser = new User({
      email,
      password,
      profile: { firstName, lastName }
    });

    newUser.save((err, savedUser) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to create user' });
      }

      // Level 3: Create initial settings
      mongoose.connection.db.collection('settings').insertOne({
        userId: savedUser._id,
        theme: 'light',
        notifications: true
      }, (err, settingsResult) => {
        if (err) {
          console.error('Settings creation failed:', err);
        }

        // Level 4: Cache user data
        redis.set(`user:${savedUser._id}`, JSON.stringify({
          email: savedUser.email,
          name: savedUser.fullName
        }), (err) => {
          if (err) {
            console.error('Cache failed:', err);
          }

          // Level 5: Generate auth token
          savedUser.generateAuthToken((err, token) => {
            if (err) {
              return res.status(500).json({ error: 'Token generation failed' });
            }

            // Level 6: Log registration
            mongoose.connection.db.collection('audit_log').insertOne({
              action: 'user_registered',
              userId: savedUser._id,
              timestamp: new Date()
            }, (err) => {
              if (err) {
                console.error('Audit log failed:', err);
              }

              // Finally respond
              res.json({
                user: {
                  id: savedUser._id,
                  email: savedUser.email,
                  fullName: savedUser.fullName
                },
                token
              });
            });
          });
        });
      });
    });
  });
});

// Promise hell - chained then() calls
router.get('/users/:id/data', (req, res) => {
  const userId = req.params.id;

  User.findById(userId)
    .then(user => {
      if (!user) {
        throw new Error('User not found');
      }
      return user.getFullProfile();
    })
    .then(profile => {
      return mongoose.connection.db
        .collection('posts')
        .find({ userId: profile._id })
        .toArray()
        .then(posts => {
          return { profile, posts };
        });
    })
    .then(data => {
      return mongoose.connection.db
        .collection('comments')
        .find({ userId: data.profile._id })
        .toArray()
        .then(comments => {
          return { ...data, comments };
        });
    })
    .then(data => {
      return redis.get(`cache:user:${userId}`)
        .then(cached => {
          return { ...data, cached: JSON.parse(cached || '{}') };
        });
    })
    .then(data => {
      return mongoose.connection.db
        .collection('friendships')
        .find({ userId: data.profile._id })
        .toArray()
        .then(friends => {
          return { ...data, friends };
        });
    })
    .then(finalData => {
      res.json(finalData);
    })
    .catch(err => {
      console.error('Error:', err);
      res.status(500).json({ error: err.message });
    });
});

// Mixed callback and promise hell
router.put('/users/:id/profile', (req, res) => {
  const userId = req.params.id;
  const updates = req.body;

  // Start with callback
  User.findById(userId, (err, user) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Mix in promises
    user.updateLastLogin()
      .then(updatedUser => {
        return mongoose.connection.db
          .collection('profiles')
          .updateOne(
            { userId: updatedUser._id },
            { $set: updates }
          );
      })
      .then(result => {
        // Back to callbacks
        redis.del(`cache:user:${userId}`, (err) => {
          if (err) {
            console.error('Cache clear failed:', err);
          }

          // More promises
          mongoose.connection.db
            .collection('audit_log')
            .insertOne({
              action: 'profile_updated',
              userId: user._id,
              changes: updates,
              timestamp: new Date()
            })
            .then(() => {
              res.json({ success: true });
            })
            .catch(err => {
              console.error('Audit error:', err);
              res.json({ success: true, warning: 'Audit log failed' });
            });
        });
      })
      .catch(err => {
        res.status(500).json({ error: err.message });
      });
  });
});

// Async/await with try-catch and nested async operations
router.get('/users/:id/complete', async (req, res) => {
  try {
    const userId = req.params.id;

    // Parallel async operations
    const [user, posts, friends] = await Promise.all([
      User.findById(userId),
      mongoose.connection.db.collection('posts').find({ userId }).toArray(),
      mongoose.connection.db.collection('friendships').find({ userId }).toArray()
    ]);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Sequential async operations
    const profile = await user.getFullProfile();
    await user.updateLastLogin();

    // Nested async loop
    const postsWithComments = [];
    for (const post of posts) {
      const comments = await mongoose.connection.db
        .collection('comments')
        .find({ postId: post._id })
        .toArray();

      postsWithComments.push({
        ...post,
        commentsCount: comments.length
      });
    }

    // Cache result
    await redis.set(
      `cache:complete:${userId}`,
      JSON.stringify({ profile, postsCount: posts.length }),
      'EX',
      3600
    );

    res.json({
      user: profile,
      posts: postsWithComments,
      friendsCount: friends.length
    });
  } catch (error) {
    console.error('Complete endpoint error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Callback hell with early returns and error handling
router.delete('/users/:id', (req, res) => {
  const userId = req.params.id;

  User.findById(userId, (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Check if user can be deleted
    mongoose.connection.db.collection('posts').countDocuments({ userId }, (err, postCount) => {
      if (err) return res.status(500).json({ error: err.message });

      if (postCount > 0) {
        // Delete posts first
        mongoose.connection.db.collection('posts').deleteMany({ userId }, (err) => {
          if (err) return res.status(500).json({ error: err.message });

          // Delete comments
          mongoose.connection.db.collection('comments').deleteMany({ userId }, (err) => {
            if (err) return res.status(500).json({ error: err.message });

            // Delete friendships
            mongoose.connection.db.collection('friendships').deleteMany({ userId }, (err) => {
              if (err) return res.status(500).json({ error: err.message });

              // Finally delete user
              user.deleteOne((err) => {
                if (err) return res.status(500).json({ error: err.message });

                redis.del(`cache:user:${userId}`, () => {
                  res.json({ success: true, message: 'User deleted' });
                });
              });
            });
          });
        });
      } else {
        // No posts, just delete user
        user.deleteOne((err) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ success: true, message: 'User deleted' });
        });
      }
    });
  });
});

// Generator usage in route
router.get('/users/:id/activity-log', (req, res) => {
  User.findById(req.params.id, (err, user) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const logGenerator = user.getActivityLog();
    const logs = [];

    for (const logEntry of logGenerator) {
      logs.push(logEntry);
    }

    res.json({ logs });
  });
});

export { router };
