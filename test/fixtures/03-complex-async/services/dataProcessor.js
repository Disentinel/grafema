// Data processor service with generators, async generators, and complex patterns
import mongoose from 'mongoose';
import { createClient } from 'redis';

const redis = createClient();

export class DataProcessor {
  constructor() {
    this.batchSize = 100;
    this.initialized = false;
    this.cache = new Map();
  }

  // Async initialization with this binding
  async initialize() {
    console.log('Initializing DataProcessor...');
    this.initialized = true;
    await redis.connect();
    return this;
  }

  // Regular generator - yields processed items
  *processBatch(items) {
    for (const item of items) {
      yield {
        id: item.id,
        processed: true,
        timestamp: Date.now(),
        value: item.value * 2
      };
    }
  }

  // Generator with this binding
  *getStats() {
    yield `Batch size: ${this.batchSize}`;
    yield `Initialized: ${this.initialized}`;
    yield `Cache size: ${this.cache.size}`;
  }

  // Async generator - fetches and yields data from database
  async *fetchUsersStream(startId, limit) {
    let processed = 0;

    while (processed < limit) {
      const batch = await mongoose.connection.db
        .collection('users')
        .find({ _id: { $gte: startId + processed } })
        .limit(this.batchSize)
        .toArray();

      if (batch.length === 0) break;

      for (const user of batch) {
        yield user;
        processed++;

        if (processed >= limit) break;
      }
    }
  }

  // Async generator with nested operations and this
  async *processDataStream(dataIds) {
    for (const id of dataIds) {
      // Fetch from database
      const data = await mongoose.connection.db
        .collection('data')
        .findOne({ _id: id });

      if (!data) continue;

      // Check cache using this
      const cacheKey = `data:${id}`;
      if (this.cache.has(cacheKey)) {
        yield this.cache.get(cacheKey);
        continue;
      }

      // Process data
      const processed = {
        ...data,
        processedAt: new Date(),
        batchSize: this.batchSize
      };

      // Store in cache
      this.cache.set(cacheKey, processed);

      // Also cache in Redis
      await redis.set(cacheKey, JSON.stringify(processed), 'EX', 3600);

      yield processed;
    }
  }

  // Method with nested generators
  async processWithNestedGenerators(userIds) {
    const results = [];

    for (const userId of userIds) {
      // Use async generator
      const stream = this.fetchUsersStream(userId, 10);

      for await (const user of stream) {
        // Use regular generator for processing
        const processor = this.processBatch([user]);

        for (const processed of processor) {
          results.push(processed);
        }
      }
    }

    return results;
  }

  // Callback hell with generators
  processWithCallbacks(items, callback) {
    const generator = this.processBatch(items);
    const results = [];

    // Helper to process next item
    const processNext = () => {
      const next = generator.next();

      if (next.done) {
        // All items processed
        mongoose.connection.db.collection('processed_data').insertMany(results, (err) => {
          if (err) return callback(err);

          redis.set('last_batch', JSON.stringify(results), (err) => {
            if (err) {
              console.error('Redis error:', err);
            }
            callback(null, results);
          });
        });
      } else {
        results.push(next.value);

        // Simulate async operation with callback
        setImmediate(() => {
          processNext();
        });
      }
    };

    processNext();
  }

  // Promise chain with generator
  processWithPromises(items) {
    return new Promise((resolve, reject) => {
      const generator = this.processBatch(items);
      const results = [];

      const processItem = () => {
        const next = generator.next();

        if (next.done) {
          return results;
        }

        results.push(next.value);
        return processItem();
      };

      try {
        const allResults = processItem();
        resolve(allResults);
      } catch (err) {
        reject(err);
      }
    })
    .then(results => {
      return mongoose.connection.db
        .collection('processed_data')
        .insertMany(results);
    })
    .then(() => {
      return redis.set('last_batch_promise', JSON.stringify(results));
    })
    .catch(err => {
      console.error('Processing error:', err);
      throw err;
    });
  }

  // Async method using async generator
  async processUser(user) {
    const dataStream = this.processDataStream([user.dataId]);
    const results = [];

    for await (const data of dataStream) {
      results.push(data);
    }

    return {
      ...user,
      processedData: results
    };
  }

  // Complex method mixing callbacks, promises, and generators
  processComplex(items, callback) {
    // Start with generator
    const generator = this.processBatch(items);
    const batch = [];

    // Collect generator results
    for (const item of generator) {
      batch.push(item);
    }

    // Mix in promise
    mongoose.connection.db
      .collection('processed_data')
      .insertMany(batch)
      .then(result => {
        // Back to callback
        redis.set('complex_batch', JSON.stringify(batch), (err) => {
          if (err) {
            return callback(err);
          }

          // More promises
          mongoose.connection.db
            .collection('audit_log')
            .insertOne({
              action: 'complex_process',
              count: batch.length,
              timestamp: new Date()
            })
            .then(() => {
              callback(null, batch);
            })
            .catch(callback);
        });
      })
      .catch(callback);
  }

  // Generator that yields promises
  *generatePromises(userIds) {
    for (const userId of userIds) {
      yield mongoose.connection.db
        .collection('users')
        .findOne({ _id: userId });
    }
  }

  // Process generator of promises
  async processPromiseGenerator(userIds) {
    const promiseGen = this.generatePromises(userIds);
    const results = [];

    for (const promise of promiseGen) {
      const result = await promise;
      results.push(result);
    }

    return results;
  }

  // Delegating generator
  *delegateProcess(items) {
    yield* this.processBatch(items);
    yield* this.getStats();
  }

  // Async method with error handling and generator
  async processWithErrorHandling(items) {
    try {
      const generator = this.processBatch(items);
      const results = [];

      for (const item of generator) {
        try {
          await mongoose.connection.db
            .collection('processed_data')
            .insertOne(item);

          results.push(item);
        } catch (err) {
          console.error('Item processing error:', err);
          // Continue processing other items
        }
      }

      return results;
    } catch (err) {
      console.error('Batch processing error:', err);
      throw err;
    }
  }
}

// Factory function with generator
export function* createProcessors(count) {
  for (let i = 0; i < count; i++) {
    const processor = new DataProcessor();
    processor.batchSize = 50 * (i + 1);
    yield processor;
  }
}

// Async generator factory
export async function* createAsyncProcessors(count) {
  for (let i = 0; i < count; i++) {
    const processor = new DataProcessor();
    await processor.initialize();
    yield processor;
  }
}

// Helper with callback hell and generator
export function processInBatches(items, batchSize, callback) {
  const processor = new DataProcessor();
  processor.batchSize = batchSize;

  processor.initialize()
    .then(() => {
      const generator = processor.processBatch(items);
      const batches = [];
      let currentBatch = [];

      for (const item of generator) {
        currentBatch.push(item);

        if (currentBatch.length >= batchSize) {
          batches.push(currentBatch);
          currentBatch = [];
        }
      }

      if (currentBatch.length > 0) {
        batches.push(currentBatch);
      }

      // Process each batch with callbacks
      let processed = 0;

      const processBatch = (batchIndex) => {
        if (batchIndex >= batches.length) {
          return callback(null, batches.flat());
        }

        mongoose.connection.db.collection('processed_data').insertMany(
          batches[batchIndex],
          (err) => {
            if (err) return callback(err);

            processed += batches[batchIndex].length;
            processBatch(batchIndex + 1);
          }
        );
      };

      processBatch(0);
    })
    .catch(callback);
}
