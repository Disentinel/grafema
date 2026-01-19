// Complex async patterns with Express, Mongoose, and Redis
import express from 'express';
import mongoose from 'mongoose';
import { createClient } from 'redis';
import { router as apiRouter } from './routes/api.js';
import { authMiddleware } from './middleware/auth.js';
import { DataProcessor } from './services/dataProcessor.js';
import { retryWithBackoff, promiseRace } from './utils/asyncHelpers.js';

const app = new express();
const redisClient = createClient();

// Configuration class with this binding
class AppConfig {
  constructor() {
    this.port = 3000;
    this.dbUrl = 'mongodb://localhost:27017/testdb';
    this.retryAttempts = 3;
  }

  getPort() {
    return this.port;
  }

  // Method that uses this and returns promise
  async initDatabase() {
    console.log(`Connecting to ${this.dbUrl}`);
    return mongoose.connect(this.dbUrl, {
      useNewUrlParser: true,
      retryWrites: this.retryAttempts
    });
  }

  // Method with this binding via arrow function
  handleError = (err) => {
    console.error(`Config error on port ${this.port}:`, err);
    this.logError(err);
  }

  logError(err) {
    console.error('Logged:', err.message);
  }
}

const config = new AppConfig();

// Callback hell example - connecting multiple services
function connectServices(callback) {
  redisClient.connect((err) => {
    if (err) return callback(err);

    mongoose.connect(config.dbUrl, (err) => {
      if (err) return callback(err);

      redisClient.get('init_flag', (err, value) => {
        if (err) return callback(err);

        if (!value) {
          redisClient.set('init_flag', 'true', (err) => {
            if (err) return callback(err);
            callback(null, 'All services connected');
          });
        } else {
          callback(null, 'Services already initialized');
        }
      });
    });
  });
}

// Promise hell example
function loadUserData(userId) {
  return mongoose.connection.db.collection('users')
    .findOne({ _id: userId })
    .then(user => {
      return mongoose.connection.db.collection('profiles')
        .findOne({ userId: user._id })
        .then(profile => {
          return mongoose.connection.db.collection('settings')
            .findOne({ userId: user._id })
            .then(settings => {
              return redisClient.get(`cache:user:${userId}`)
                .then(cached => {
                  return {
                    user,
                    profile,
                    settings,
                    cached
                  };
                });
            });
        });
    })
    .catch(err => {
      console.error('Error loading user data:', err);
      throw err;
    });
}

// Generator function for data processing
function* processDataGenerator(items) {
  for (const item of items) {
    yield item.id;
    yield item.name;
    yield item.value * 2;
  }
}

// Async generator
async function* fetchDataStream(startId, count) {
  for (let i = 0; i < count; i++) {
    const id = startId + i;
    const data = await mongoose.connection.db
      .collection('data')
      .findOne({ id });
    yield data;
  }
}

// Complex async/await with multiple operations
async function processUserRequest(userId) {
  try {
    // Parallel async operations
    const [user, permissions, settings] = await Promise.all([
      mongoose.connection.db.collection('users').findOne({ _id: userId }),
      mongoose.connection.db.collection('permissions').find({ userId }).toArray(),
      redisClient.get(`settings:${userId}`)
    ]);

    // Sequential with await
    const processor = new DataProcessor();
    await processor.initialize();

    const processed = await processor.processUser(user);

    // Using generator
    const gen = processDataGenerator([processed]);
    const results = [];
    for (const value of gen) {
      results.push(value);
    }

    // Async generator
    const stream = fetchDataStream(user.dataOffset, 10);
    for await (const data of stream) {
      results.push(data);
    }

    return {
      user: processed,
      permissions,
      settings: JSON.parse(settings || '{}'),
      dataPoints: results
    };
  } catch (error) {
    config.handleError(error);
    throw error;
  }
}

// Middleware setup with this context
app.use(express.json());
app.use(authMiddleware);

// Routes with callback hell
app.post('/api/legacy-register', (req, res) => {
  const { email, password } = req.body;

  // Callback pyramid of doom
  mongoose.connection.db.collection('users').findOne({ email }, (err, existing) => {
    if (err) return res.status(500).json({ error: err.message });

    if (existing) {
      return res.status(400).json({ error: 'User exists' });
    }

    mongoose.connection.db.collection('users').insertOne({
      email,
      password,
      createdAt: new Date()
    }, (err, result) => {
      if (err) return res.status(500).json({ error: err.message });

      redisClient.set(`user:${result.insertedId}`, JSON.stringify({ email }), (err) => {
        if (err) {
          console.error('Cache error:', err);
        }

        res.json({
          id: result.insertedId,
          email
        });
      });
    });
  });
});

// Routes with promise chains
app.get('/api/user/:id', (req, res) => {
  loadUserData(req.params.id)
    .then(userData => {
      return retryWithBackoff(() =>
        redisClient.set(`cache:user:${req.params.id}`, JSON.stringify(userData))
      );
    })
    .then(() => {
      res.json({ success: true });
    })
    .catch(err => {
      res.status(500).json({ error: err.message });
    });
});

// Modern async/await endpoint
app.get('/api/user/:id/full', async (req, res) => {
  try {
    const data = await processUserRequest(req.params.id);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mount API router
app.use('/api', apiRouter);

// Error handler with this binding
const errorHandler = {
  logFile: 'errors.log',

  handleError: function(err, req, res, next) {
    console.error('Error:', err);
    this.writeToLog(err);
    res.status(500).json({ error: 'Internal server error' });
  },

  writeToLog: function(err) {
    console.log(`Writing to ${this.logFile}:`, err.message);
  }
};

app.use(errorHandler.handleError.bind(errorHandler));

// Server startup with callbacks and promises
function startServer() {
  return new Promise((resolve, reject) => {
    connectServices((err, message) => {
      if (err) {
        reject(err);
        return;
      }

      console.log(message);

      config.initDatabase()
        .then(() => {
          const server = app.listen(config.getPort(), () => {
            console.log(`Server running on port ${config.getPort()}`);
            resolve(server);
          });

          server.on('error', config.handleError);
        })
        .catch(reject);
    });
  });
}

// Event handlers with arrow functions preserving this
process.on('SIGINT', () => {
  console.log('Shutting down gracefully');
  mongoose.connection.close(() => {
    redisClient.quit(() => {
      process.exit(0);
    });
  });
});

process.on('uncaughtException', (err) => {
  config.handleError(err);
  process.exit(1);
});

export { app, config, startServer, processDataGenerator, fetchDataStream };
