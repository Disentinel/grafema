// =============================================================================
// callbacks.js — Callback Patterns, Event Emitters, Timers, Promisify
// =============================================================================

// --- Error-first callback (Node.js style) ---

// @construct PENDING callback-error-first
// @annotation
// FUNCTION <<readFileCallback>> -> CONTAINS -> PARAMETER <<path>>
// FUNCTION <<readFileCallback>> -> CONTAINS -> PARAMETER <<callback>>
// FUNCTION <<readFileCallback>> -> HAS_BODY -> TRY_BLOCK <<try-block>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> VARIABLE <<data>>
// VARIABLE <<data>> -> ASSIGNED_FROM -> EXPRESSION <<`contents of ${path}`>>
// EXPRESSION <<`contents of ${path}`>> -> READS_FROM -> PARAMETER <<path>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> CALL <<callback(null, data)>>
// CALL <<callback(null, data)>> -> CALLS -> PARAMETER <<callback>>
// CALL <<callback(null, data)>> -> PASSES_ARGUMENT -> LITERAL <<null>>
// CALL <<callback(null, data)>> -> PASSES_ARGUMENT -> VARIABLE <<data>>
// TRY_BLOCK <<try-block>> -> HAS_CATCH -> CATCH_BLOCK <<catch-block>>
// CATCH_BLOCK <<catch-block>> -> CONTAINS -> PARAMETER <<err>>
// CATCH_BLOCK <<catch-block>> -> CONTAINS -> CALL <<callback(err, null)>>
// CALL <<callback(err, null)>> -> CALLS -> PARAMETER <<callback>>
// CALL <<callback(err, null)>> -> PASSES_ARGUMENT -> PARAMETER <<err>>
// CALL <<callback(err, null)>> -> PASSES_ARGUMENT -> LITERAL <<null>>
// @end-annotation
function readFileCallback(path, callback) {
  try {
    const data = `contents of ${path}`;
    callback(null, data);
  } catch (err) {
    callback(err, null);
  }
}

// @construct PENDING callback-error-first-usage
// @annotation
// FUNCTION <<processFile>> -> HAS_BODY -> PARAMETER <<path>>
// FUNCTION <<processFile>> -> HAS_BODY -> CALL <<readFileCallback(path, callback)>>
// CALL <<readFileCallback(path, callback)>> -> PASSES_ARGUMENT -> PARAMETER <<path>>
// CALL <<readFileCallback(path, callback)>> -> PASSES_ARGUMENT -> FUNCTION <<callback>>
// FUNCTION <<callback>> -> HAS_BODY -> PARAMETER <<err>>
// FUNCTION <<callback>> -> HAS_BODY -> PARAMETER <<data>>
// FUNCTION <<callback>> -> HAS_BODY -> BRANCH <<if-err>>
// BRANCH <<if-err>> -> HAS_CONDITION -> PARAMETER <<err>>
// BRANCH <<if-err>> -> HAS_CONSEQUENT -> CALL <<console.error('Failed:', err)>>
// BRANCH <<if-err>> -> HAS_ALTERNATE -> CALL <<console.log('Data:', data)>>
// CALL <<console.error('Failed:', err)>> -> PASSES_ARGUMENT -> LITERAL <<'Failed:'>>
// CALL <<console.error('Failed:', err)>> -> PASSES_ARGUMENT -> PARAMETER <<err>>
// CALL <<console.log('Data:', data)>> -> PASSES_ARGUMENT -> LITERAL <<'Data:'>>
// CALL <<console.log('Data:', data)>> -> PASSES_ARGUMENT -> PARAMETER <<data>>
// @end-annotation
function processFile(path) {
  readFileCallback(path, function (err, data) {
    if (err) {
      console.error('Failed:', err);
      return;
    }
    console.log('Data:', data);
  });
}

// --- Callback hell (3+ levels) ---

// @construct PENDING callback-hell
// @annotation
// @end-annotation
function callbackHell(userId) {
  getUser(userId, function (err, user) {
    if (err) return console.error(err);
    getOrders(user.id, function (err, orders) {
      if (err) return console.error(err);
      getOrderDetails(orders[0].id, function (err, details) {
        if (err) return console.error(err);
        console.log(details);
      });
    });
  });
}

function getUser(id, cb) { cb(null, { id, name: 'Alice' }); }
function getOrders(userId, cb) { cb(null, [{ id: 1 }]); }
function getOrderDetails(orderId, cb) { cb(null, { orderId, items: [] }); }

// --- Higher-order callback patterns ---

// @construct PENDING callback-higher-order
// @annotation
// FUNCTION <<retry>> -> CONTAINS -> PARAMETER <<fn>>
// FUNCTION <<retry>> -> CONTAINS -> PARAMETER <<attempts>>
// FUNCTION <<retry>> -> CONTAINS -> PARAMETER <<callback>>
// FUNCTION <<retry>> -> CONTAINS -> CALL <<fn-call>>
// CALL <<fn-call>> -> CALLS -> PARAMETER <<fn>>
// CALL <<fn-call>> -> PASSES_ARGUMENT -> FUNCTION <<anonymous-callback>>
// FUNCTION <<anonymous-callback>> -> CONTAINS -> PARAMETER <<err>>
// FUNCTION <<anonymous-callback>> -> CONTAINS -> PARAMETER <<result>>
// FUNCTION <<anonymous-callback>> -> CONTAINS -> BRANCH <<if-err-attempts>>
// BRANCH <<if-err-attempts>> -> HAS_CONDITION -> EXPRESSION <<err && attempts > 1>>
// EXPRESSION <<err && attempts > 1>> -> READS_FROM -> PARAMETER <<err>>
// EXPRESSION <<err && attempts > 1>> -> READS_FROM -> EXPRESSION <<attempts > 1>>
// EXPRESSION <<attempts > 1>> -> READS_FROM -> PARAMETER <<attempts>>
// EXPRESSION <<attempts > 1>> -> READS_FROM -> LITERAL <<1>>
// BRANCH <<if-err-attempts>> -> HAS_CONSEQUENT -> CALL <<retry-recursive>>
// CALL <<retry-recursive>> -> CALLS -> FUNCTION <<retry>>
// CALL <<retry-recursive>> -> PASSES_ARGUMENT -> PARAMETER <<fn>>
// CALL <<retry-recursive>> -> PASSES_ARGUMENT -> EXPRESSION <<attempts - 1>>
// CALL <<retry-recursive>> -> PASSES_ARGUMENT -> PARAMETER <<callback>>
// EXPRESSION <<attempts - 1>> -> READS_FROM -> PARAMETER <<attempts>>
// EXPRESSION <<attempts - 1>> -> READS_FROM -> LITERAL <<1>>
// BRANCH <<if-err-attempts>> -> HAS_ALTERNATE -> CALL <<callback-call>>
// CALL <<callback-call>> -> CALLS -> PARAMETER <<callback>>
// CALL <<callback-call>> -> PASSES_ARGUMENT -> PARAMETER <<err>>
// CALL <<callback-call>> -> PASSES_ARGUMENT -> PARAMETER <<result>>
// @end-annotation
function retry(fn, attempts, callback) {
  fn(function (err, result) {
    if (err && attempts > 1) {
      retry(fn, attempts - 1, callback);
    } else {
      callback(err, result);
    }
  });
}

// @construct PENDING callback-continuation-passing
// @annotation
// FUNCTION <<waterfall>> -> CONTAINS -> PARAMETER <<tasks>>
// FUNCTION <<waterfall>> -> CONTAINS -> PARAMETER <<callback>>
// FUNCTION <<waterfall>> -> DECLARES -> VARIABLE <<index>>
// VARIABLE <<index>> -> ASSIGNED_FROM -> LITERAL <<0>>
// FUNCTION <<waterfall>> -> DECLARES -> FUNCTION <<next>>
// FUNCTION <<next>> -> CONTAINS -> PARAMETER <<err>>
// FUNCTION <<next>> -> CONTAINS -> PARAMETER <<result>>
// EXPRESSION <<err || index >= tasks.length>> -> READS_FROM -> PARAMETER <<err>>
// EXPRESSION <<err || index >= tasks.length>> -> READS_FROM -> EXPRESSION <<index >= tasks.length>>
// EXPRESSION <<index >= tasks.length>> -> READS_FROM -> VARIABLE <<index>>
// EXPRESSION <<index >= tasks.length>> -> READS_FROM -> PROPERTY_ACCESS <<tasks.length>>
// PROPERTY_ACCESS <<tasks.length>> -> READS_FROM -> PARAMETER <<tasks>>
// CALL <<callback(err, result)>> -> CALLS -> PARAMETER <<callback>>
// CALL <<callback(err, result)>> -> PASSES_ARGUMENT -> PARAMETER <<err>>
// CALL <<callback(err, result)>> -> PASSES_ARGUMENT -> PARAMETER <<result>>
// EXPRESSION <<tasks[index++]>> -> READS_FROM -> PARAMETER <<tasks>>
// EXPRESSION <<tasks[index++]>> -> READS_FROM -> EXPRESSION <<index++>>
// EXPRESSION <<index++>> -> MODIFIES -> VARIABLE <<index>>
// CALL <<tasks[index++](result, next)>> -> CALLS -> EXPRESSION <<tasks[index++]>>
// CALL <<tasks[index++](result, next)>> -> PASSES_ARGUMENT -> PARAMETER <<result>>
// CALL <<tasks[index++](result, next)>> -> PASSES_ARGUMENT -> FUNCTION <<next>>
// CALL <<next(null, null)>> -> CALLS -> FUNCTION <<next>>
// CALL <<next(null, null)>> -> PASSES_ARGUMENT -> LITERAL <<null1>>
// CALL <<next(null, null)>> -> PASSES_ARGUMENT -> LITERAL <<null2>>
// FUNCTION <<next>> -> CAPTURES -> PARAMETER <<callback>>
// FUNCTION <<next>> -> CAPTURES -> PARAMETER <<tasks>>
// FUNCTION <<next>> -> CAPTURES -> VARIABLE <<index>>
// @end-annotation
function waterfall(tasks, callback) {
  let index = 0;
  function next(err, result) {
    if (err || index >= tasks.length) return callback(err, result);
    tasks[index++](result, next);
  }
  next(null, null);
}

// --- Event emitter pattern ---

// @construct PENDING callback-event-emitter
// @annotation
// @end-annotation
class EventEmitter {
  constructor() {
    this._listeners = {};
  }

  on(event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
    return this;
  }

  off(event, handler) {
    if (!this._listeners[event]) return this;
    this._listeners[event] = this._listeners[event].filter(h => h !== handler);
    return this;
  }

  once(event, handler) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      handler(...args);
    };
    return this.on(event, wrapper);
  }

  emit(event, ...args) {
    if (!this._listeners[event]) return false;
    this._listeners[event].forEach(h => h(...args));
    return true;
  }
}

// --- Timer callbacks ---

// @construct PENDING callback-settimeout
// @annotation
// FUNCTION <<delayedExecution>> -> HAS_BODY -> PARAMETER <<fn>>
// FUNCTION <<delayedExecution>> -> HAS_BODY -> PARAMETER <<ms>>
// FUNCTION <<delayedExecution>> -> HAS_BODY -> VARIABLE <<id>>
// VARIABLE <<id>> -> ASSIGNED_FROM -> CALL <<setTimeout(fn, ms)>>
// CALL <<setTimeout(fn, ms)>> -> CALLS -> EXTERNAL <<setTimeout>>
// CALL <<setTimeout(fn, ms)>> -> PASSES_ARGUMENT -> PARAMETER <<fn>>
// CALL <<setTimeout(fn, ms)>> -> PASSES_ARGUMENT -> PARAMETER <<ms>>
// FUNCTION <<delayedExecution>> -> RETURNS -> FUNCTION <<cancel>>
// FUNCTION <<cancel>> -> HAS_BODY -> CALL <<clearTimeout(id)>>
// CALL <<clearTimeout(id)>> -> CALLS -> EXTERNAL <<clearTimeout>>
// CALL <<clearTimeout(id)>> -> PASSES_ARGUMENT -> VARIABLE <<id>>
// FUNCTION <<cancel>> -> CAPTURES -> VARIABLE <<id>>
// @end-annotation
function delayedExecution(fn, ms) {
  const id = setTimeout(fn, ms);
  return function cancel() {
    clearTimeout(id);
  };
}

// @construct PENDING callback-setinterval
// @annotation
// @end-annotation
function pollUntil(check, interval, maxAttempts, callback) {
  let attempts = 0;
  const id = setInterval(function () {
    attempts++;
    if (check()) {
      clearInterval(id);
      callback(null, attempts);
    } else if (attempts >= maxAttempts) {
      clearInterval(id);
      callback(new Error('Max attempts reached'), attempts);
    }
  }, interval);
  return id;
}

// --- queueMicrotask ---

// @construct PENDING callback-microtask
// @annotation
// FUNCTION <<withMicrotask>> -> HAS_BODY -> PARAMETER <<fn>>
// FUNCTION <<withMicrotask>> -> HAS_BODY -> CALL <<queueMicrotask(...)>>
// CALL <<queueMicrotask(...)>> -> CALLS -> UNKNOWN <<queueMicrotask>>
// CALL <<queueMicrotask(...)>> -> PASSES_ARGUMENT -> FUNCTION <<microtask-callback>>
// FUNCTION <<microtask-callback>> -> HAS_BODY -> CALL <<fn()>>
// CALL <<fn()>> -> CALLS -> PARAMETER <<fn>>
// FUNCTION <<microtask-callback>> -> CAPTURES -> PARAMETER <<fn>>
// @end-annotation
function withMicrotask(fn) {
  queueMicrotask(() => {
    fn();
  });
}

// --- Promisify ---

// @construct PENDING callback-promisify
// @annotation
// FUNCTION <<promisify>> -> HAS_BODY -> PARAMETER <<fn>>
// FUNCTION <<promisify>> -> RETURNS -> FUNCTION <<promisify:wrapper>>
// FUNCTION <<promisify:wrapper>> -> HAS_BODY -> PARAMETER <<...args>>
// FUNCTION <<promisify:wrapper>> -> RETURNS -> CALL <<new Promise>>
// CALL <<new Promise>> -> PASSES_ARGUMENT -> FUNCTION <<promisify:executor>>
// FUNCTION <<promisify:executor>> -> HAS_BODY -> PARAMETER <<resolve>>
// FUNCTION <<promisify:executor>> -> HAS_BODY -> PARAMETER <<reject>>
// FUNCTION <<promisify:executor>> -> HAS_BODY -> CALL <<fn(...args, callback)>>
// CALL <<fn(...args, callback)>> -> CALLS -> PARAMETER <<fn>>
// CALL <<fn(...args, callback)>> -> PASSES_ARGUMENT -> PARAMETER <<...args>>
// CALL <<fn(...args, callback)>> -> PASSES_ARGUMENT -> FUNCTION <<promisify:callback>>
// FUNCTION <<promisify:callback>> -> HAS_BODY -> PARAMETER <<err>>
// FUNCTION <<promisify:callback>> -> HAS_BODY -> PARAMETER <<result>>
// FUNCTION <<promisify:callback>> -> HAS_BODY -> BRANCH <<if-err>>
// BRANCH <<if-err>> -> HAS_CONSEQUENT -> CALL <<reject(err)>>
// BRANCH <<if-err>> -> HAS_ALTERNATE -> CALL <<resolve(result)>>
// CALL <<reject(err)>> -> CALLS -> PARAMETER <<reject>>
// CALL <<reject(err)>> -> PASSES_ARGUMENT -> PARAMETER <<err>>
// CALL <<resolve(result)>> -> CALLS -> PARAMETER <<resolve>>
// CALL <<resolve(result)>> -> PASSES_ARGUMENT -> PARAMETER <<result>>
// @end-annotation
function promisify(fn) {
  return function (...args) {
    return new Promise((resolve, reject) => {
      fn(...args, function (err, result) {
        if (err) reject(err);
        else resolve(result);
      });
    });
  };
}

// @construct PENDING callback-promisify-usage
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<readFileAsync>>
// VARIABLE <<readFileAsync>> -> ASSIGNED_FROM -> CALL <<promisify(readFileCallback)>>
// CALL <<promisify(readFileCallback)>> -> CALLS -> UNKNOWN <<promisify>>
// CALL <<promisify(readFileCallback)>> -> PASSES_ARGUMENT -> UNKNOWN <<readFileCallback>>
// @end-annotation
const readFileAsync = promisify(readFileCallback);

// --- Array callback patterns ---

// @construct PENDING callback-array-methods
function arrayCallbackPatterns(items) {
  const mapped = items.map(item => item * 2);
  const filtered = items.filter(item => item > 0);
  const reduced = items.reduce((acc, item) => acc + item, 0);
  const found = items.find(item => item > 5);
  const some = items.some(item => item < 0);
  const every = items.every(item => typeof item === 'number');
  const sorted = [...items].sort((a, b) => a - b);
  const flatMapped = [items, items].flatMap(arr => arr);
  items.forEach(item => console.log(item));
  return { mapped, filtered, reduced, found, some, every, sorted, flatMapped };
}

// --- Array/Map/Set callback thisArg (hidden `this` binding) ---

// @construct PENDING callback-thisarg-map
// @annotation
// CLASS <<Processor>> -> CONTAINS -> PROPERTY <<Processor.multiplier>>
// PROPERTY <<Processor.multiplier>> -> ASSIGNED_FROM -> LITERAL <<3>>
// CLASS <<Processor>> -> CONTAINS -> METHOD <<Processor.process>>
// METHOD <<Processor.process>> -> CONTAINS -> PARAMETER <<items>>
// METHOD <<Processor.process>> -> RETURNS -> CALL <<items.map(...)>>
// CALL <<items.map(...)>> -> CALLS_ON -> PARAMETER <<items>>
// CALL <<items.map(...)>> -> PASSES_ARGUMENT -> FUNCTION <<map-callback>>
// CALL <<items.map(...)>> -> BINDS_THIS_TO -> CLASS <<Processor>>
// FUNCTION <<map-callback>> -> CONTAINS -> PARAMETER <<item>>
// FUNCTION <<map-callback>> -> RETURNS -> EXPRESSION <<item * this.multiplier>>
// EXPRESSION <<item * this.multiplier>> -> READS_FROM -> PARAMETER <<item>>
// EXPRESSION <<item * this.multiplier>> -> READS_FROM -> PROPERTY_ACCESS <<this.multiplier>>
// PROPERTY_ACCESS <<this.multiplier>> -> RESOLVES_TO -> PROPERTY <<Processor.multiplier>>
// @end-annotation
class Processor {
  multiplier = 3;
  process(items) {
    return items.map(function(item) {
      return item * this.multiplier; // `this` = Processor instance via thisArg
    }, this);
  }
}

// @construct PENDING callback-thisarg-filter
// @annotation
// CLASS <<Validator>> -> CONTAINS -> PROPERTY <<Validator.threshold>>
// PROPERTY <<Validator.threshold>> -> ASSIGNED_FROM -> LITERAL <<10>>
// CLASS <<Validator>> -> CONTAINS -> METHOD <<Validator.filter>>
// METHOD <<Validator.filter>> -> CONTAINS -> PARAMETER <<items>>
// METHOD <<Validator.filter>> -> RETURNS -> CALL <<items.filter(...)>>
// CALL <<items.filter(...)>> -> CALLS_ON -> PARAMETER <<items>>
// CALL <<items.filter(...)>> -> PASSES_ARGUMENT -> FUNCTION <<filter-callback>>
// CALL <<items.filter(...)>> -> BINDS_THIS_TO -> CLASS <<Validator>>
// FUNCTION <<filter-callback>> -> CONTAINS -> PARAMETER <<item>>
// FUNCTION <<filter-callback>> -> RETURNS -> EXPRESSION <<item > this.threshold>>
// EXPRESSION <<item > this.threshold>> -> READS_FROM -> PARAMETER <<item>>
// EXPRESSION <<item > this.threshold>> -> READS_FROM -> PROPERTY_ACCESS <<this.threshold>>
// PROPERTY_ACCESS <<this.threshold>> -> RESOLVES_TO -> PROPERTY <<Validator.threshold>>
// @end-annotation
class Validator {
  threshold = 10;
  filter(items) {
    return items.filter(function(item) {
      return item > this.threshold;
    }, this);
  }
}

// @construct PENDING callback-thisarg-foreach
// @annotation
// FUNCTION <<forEachWithContext>> -> CONTAINS -> PARAMETER <<items>>
// FUNCTION <<forEachWithContext>> -> CONTAINS -> PARAMETER <<logger>>
// FUNCTION <<forEachWithContext>> -> CONTAINS -> CALL <<items.forEach>>
// CALL <<items.forEach>> -> CALLS_ON -> PARAMETER <<items>>
// CALL <<items.forEach>> -> PASSES_ARGUMENT -> FUNCTION <<forEach-callback>>
// CALL <<items.forEach>> -> PASSES_ARGUMENT -> PARAMETER <<logger>>
// FUNCTION <<forEach-callback>> -> CONTAINS -> PARAMETER <<item>>
// FUNCTION <<forEach-callback>> -> CONTAINS -> CALL <<this.log(item)>>
// CALL <<this.log(item)>> -> CALLS -> PROPERTY_ACCESS <<this.log>>
// CALL <<this.log(item)>> -> PASSES_ARGUMENT -> PARAMETER <<item>>
// PROPERTY_ACCESS <<this.log>> -> BINDS_THIS_TO -> PARAMETER <<logger>>
// @end-annotation
function forEachWithContext(items, logger) {
  items.forEach(function(item) {
    this.log(item); // `this` = logger
  }, logger);
}

// @construct PENDING export-named-list
// @annotation
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<readFileCallback>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<processFile>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<callbackHell>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<getUser>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<getOrders>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<getOrderDetails>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<retry>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<waterfall>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<EventEmitter>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<delayedExecution>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<pollUntil>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<withMicrotask>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<promisify>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<readFileAsync>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<arrayCallbackPatterns>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<Processor>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<Validator>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<forEachWithContext>>
// @end-annotation
export {
  readFileCallback,
  processFile,
  callbackHell,
  getUser,
  getOrders,
  getOrderDetails,
  retry,
  waterfall,
  EventEmitter,
  delayedExecution,
  pollUntil,
  withMicrotask,
  promisify,
  readFileAsync,
  arrayCallbackPatterns,
  Processor,
  Validator,
  forEachWithContext,
};
