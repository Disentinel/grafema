// Async utility functions with promise chains, callbacks, and complex patterns

// Promise chain hell - retry with exponential backoff
export function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    const execute = () => {
      fn()
        .then(result => resolve(result))
        .catch(err => {
          attempt++;

          if (attempt >= maxRetries) {
            return reject(new Error(`Failed after ${maxRetries} attempts: ${err.message}`));
          }

          const delay = baseDelay * Math.pow(2, attempt);
          console.log(`Retry attempt ${attempt} after ${delay}ms`);

          setTimeout(() => {
            execute();
          }, delay);
        });
    };

    execute();
  });
}

// Promise race with timeout
export function promiseRace(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then(result => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

// Callback to Promise converter
export function callbackToPromise(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
}

// Promise chain with sequential execution
export function sequentialPromises(tasks) {
  return tasks.reduce((chain, task) => {
    return chain
      .then(results => {
        return task()
          .then(result => {
            return [...results, result];
          });
      });
  }, Promise.resolve([]));
}

// Mixed callback and promise - batch processor
export function processBatch(items, processor, callback) {
  const results = [];
  let index = 0;

  const processNext = () => {
    if (index >= items.length) {
      return callback(null, results);
    }

    const item = items[index++];

    // Mix promise with callback
    Promise.resolve(processor(item))
      .then(result => {
        results.push(result);
        processNext();
      })
      .catch(err => {
        callback(err);
      });
  };

  processNext();
}

// Promise chain with error recovery
export function withErrorRecovery(fn, fallbackFn) {
  return fn()
    .catch(err => {
      console.error('Primary function failed:', err);
      return fallbackFn();
    })
    .catch(err => {
      console.error('Fallback function also failed:', err);
      throw new Error('Both primary and fallback failed');
    });
}

// Nested promise chains
export function nestedChain(urls) {
  return Promise.resolve(urls[0])
    .then(url => {
      return fetch(url)
        .then(response => response.json())
        .then(data => {
          return Promise.resolve(urls[1])
            .then(url2 => {
              return fetch(url2)
                .then(response2 => response2.json())
                .then(data2 => {
                  return Promise.resolve(urls[2])
                    .then(url3 => {
                      return fetch(url3)
                        .then(response3 => response3.json())
                        .then(data3 => {
                          return [data, data2, data3];
                        });
                    });
                });
            });
        });
    })
    .catch(err => {
      console.error('Chain failed:', err);
      throw err;
    });
}

// Callback hell example
export function callbackHell(data, callback) {
  setTimeout(() => {
    console.log('Step 1');

    setTimeout(() => {
      console.log('Step 2');

      setTimeout(() => {
        console.log('Step 3');

        setTimeout(() => {
          console.log('Step 4');

          setTimeout(() => {
            console.log('Step 5');
            callback(null, { processed: data, steps: 5 });
          }, 100);
        }, 100);
      }, 100);
    }, 100);
  }, 100);
}

// Promise chain with parallel sections
export function mixedParallelSequential(ids) {
  // Sequential part 1
  return Promise.resolve(ids[0])
    .then(id => fetch(`/api/data/${id}`))
    .then(response => response.json())
    .then(data1 => {
      // Parallel section
      return Promise.all([
        fetch(`/api/related/${data1.id}`).then(r => r.json()),
        fetch(`/api/comments/${data1.id}`).then(r => r.json()),
        fetch(`/api/meta/${data1.id}`).then(r => r.json())
      ])
      .then(([related, comments, meta]) => {
        return { data1, related, comments, meta };
      });
    })
    .then(combined => {
      // Sequential part 2
      return fetch('/api/save', {
        method: 'POST',
        body: JSON.stringify(combined)
      })
      .then(r => r.json())
      .then(saved => {
        return { ...combined, saved };
      });
    })
    .catch(err => {
      console.error('Mixed operation failed:', err);
      throw err;
    });
}

// Async function with promise chain inside
export async function asyncWithPromiseChain(userId) {
  try {
    const user = await fetch(`/api/users/${userId}`).then(r => r.json());

    // Promise chain inside async function
    return fetch(`/api/profile/${user.id}`)
      .then(r => r.json())
      .then(profile => {
        return fetch(`/api/settings/${user.id}`)
          .then(r => r.json())
          .then(settings => {
            return fetch(`/api/preferences/${user.id}`)
              .then(r => r.json())
              .then(preferences => {
                return {
                  user,
                  profile,
                  settings,
                  preferences
                };
              });
          });
      })
      .catch(err => {
        console.error('Profile chain failed:', err);
        throw err;
      });
  } catch (err) {
    console.error('User fetch failed:', err);
    throw err;
  }
}

// Generator with promises
export function* promiseGenerator(count) {
  for (let i = 0; i < count; i++) {
    yield new Promise((resolve) => {
      setTimeout(() => {
        resolve(i * 2);
      }, 100 * i);
    });
  }
}

// Execute promise generator
export function executePromiseGenerator(count) {
  const gen = promiseGenerator(count);
  const promises = [];

  for (const promise of gen) {
    promises.push(promise);
  }

  return Promise.all(promises)
    .then(results => {
      return results.reduce((sum, val) => sum + val, 0);
    })
    .catch(err => {
      console.error('Generator execution failed:', err);
      throw err;
    });
}

// Recursive promise chain
export function recursivePromiseChain(n, accumulator = []) {
  if (n <= 0) {
    return Promise.resolve(accumulator);
  }

  return Promise.resolve(n)
    .then(value => {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(value * 2);
        }, 50);
      });
    })
    .then(processed => {
      accumulator.push(processed);
      return recursivePromiseChain(n - 1, accumulator);
    })
    .catch(err => {
      console.error('Recursive chain error:', err);
      throw err;
    });
}

// Callback-based debounce with promise
export function debouncePromise(fn, delay) {
  let timeoutId;
  let pendingResolve;
  let pendingReject;

  return function(...args) {
    return new Promise((resolve, reject) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      pendingResolve = resolve;
      pendingReject = reject;

      timeoutId = setTimeout(() => {
        try {
          const result = fn(...args);
          if (result && typeof result.then === 'function') {
            result.then(resolve).catch(reject);
          } else {
            resolve(result);
          }
        } catch (err) {
          reject(err);
        }
      }, delay);
    });
  };
}

// Promise pool with concurrency limit
export function promisePool(tasks, concurrency) {
  return new Promise((resolve, reject) => {
    const results = [];
    let index = 0;
    let running = 0;
    let completed = 0;

    const runNext = () => {
      if (completed === tasks.length) {
        return resolve(results);
      }

      while (running < concurrency && index < tasks.length) {
        const taskIndex = index++;
        const task = tasks[taskIndex];

        running++;

        Promise.resolve(task())
          .then(result => {
            results[taskIndex] = result;
            completed++;
            running--;
            runNext();
          })
          .catch(err => {
            reject(err);
          });
      }
    };

    runNext();
  });
}
