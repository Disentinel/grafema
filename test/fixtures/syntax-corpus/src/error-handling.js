// =============================================================================
// error-handling.js — Custom Errors, Error Cause, Wrapping, Async Errors
// =============================================================================

// --- Custom error classes ---

// @construct PENDING error-custom-class
// @annotation
// CLASS <<AppError>> -> EXTENDS -> UNKNOWN <<Error>>
// CLASS <<AppError>> -> CONTAINS -> METHOD <<AppError.constructor>>
// METHOD <<AppError.constructor>> -> CONTAINS -> PARAMETER <<message>>
// METHOD <<AppError.constructor>> -> CONTAINS -> PARAMETER <<code>>
// CALL <<super(message)>> -> CALLS -> UNKNOWN <<Error>>
// CALL <<super(message)>> -> PASSES_ARGUMENT -> PARAMETER <<message>>
// METHOD <<AppError.constructor>> -> CONTAINS -> CALL <<super(message)>>
// PROPERTY_ACCESS <<this.name>> -> ASSIGNED_FROM -> LITERAL <<'AppError'>>
// METHOD <<AppError.constructor>> -> WRITES_TO -> PROPERTY_ACCESS <<this.name>>
// PROPERTY_ACCESS <<this.code>> -> ASSIGNED_FROM -> PARAMETER <<code>>
// METHOD <<AppError.constructor>> -> WRITES_TO -> PROPERTY_ACCESS <<this.code>>
// @end-annotation
class AppError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

// @construct PENDING error-custom-hierarchy
// @annotation
// CLASS <<ValidationError>> -> CONTAINS -> METHOD <<ValidationError.constructor>>
// METHOD <<ValidationError.constructor>> -> CONTAINS -> PARAMETER <<field>>
// METHOD <<ValidationError.constructor>> -> CONTAINS -> PARAMETER <<message>>
// METHOD <<ValidationError.constructor>> -> CONTAINS -> CALL <<super(message, 'VALIDATION_ERROR')>>
// CALL <<super(message, 'VALIDATION_ERROR')>> -> PASSES_ARGUMENT -> PARAMETER <<message>>
// CALL <<super(message, 'VALIDATION_ERROR')>> -> PASSES_ARGUMENT -> LITERAL <<'VALIDATION_ERROR'>>
// PROPERTY_ACCESS <<this.name>> -> ASSIGNED_FROM -> LITERAL <<'ValidationError'>>
// PROPERTY_ACCESS <<this.field>> -> ASSIGNED_FROM -> PARAMETER <<field>>
// CLASS <<NotFoundError>> -> CONTAINS -> METHOD <<NotFoundError.constructor>>
// METHOD <<NotFoundError.constructor>> -> CONTAINS -> PARAMETER <<resource>>
// METHOD <<NotFoundError.constructor>> -> CONTAINS -> PARAMETER <<id>>
// EXPRESSION <<`${resource} not found: ${id}`>> -> READS_FROM -> PARAMETER <<resource>>
// EXPRESSION <<`${resource} not found: ${id}`>> -> READS_FROM -> PARAMETER <<id>>
// METHOD <<NotFoundError.constructor>> -> CONTAINS -> CALL <<super(`${resource} not found: ${id}`, 'NOT_FOUND')>>
// CALL <<super(`${resource} not found: ${id}`, 'NOT_FOUND')>> -> PASSES_ARGUMENT -> EXPRESSION <<`${resource} not found: ${id}`>>
// CALL <<super(`${resource} not found: ${id}`, 'NOT_FOUND')>> -> PASSES_ARGUMENT -> LITERAL <<'NOT_FOUND'>>
// PROPERTY_ACCESS <<this.name2>> -> ASSIGNED_FROM -> LITERAL <<'NotFoundError'>>
// PROPERTY_ACCESS <<this.resource>> -> ASSIGNED_FROM -> PARAMETER <<resource>>
// PROPERTY_ACCESS <<this.id>> -> ASSIGNED_FROM -> PARAMETER <<id>>
// @end-annotation
class ValidationError extends AppError {
  constructor(field, message) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
    this.field = field;
  }
}

class NotFoundError extends AppError {
  constructor(resource, id) {
    super(`${resource} not found: ${id}`, 'NOT_FOUND');
    this.name = 'NotFoundError';
    this.resource = resource;
    this.id = id;
  }
}

// --- Error cause (ES2022) ---

// @construct PENDING error-cause
// @annotation
// FUNCTION <<fetchWithCause>> -> HAS_BODY -> PARAMETER <<url>>
// FUNCTION <<fetchWithCause>> -> HAS_BODY -> TRY_BLOCK <<try-block>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> VARIABLE <<response>>
// VARIABLE <<response>> -> ASSIGNED_FROM -> CALL <<fetch(url)>>
// CALL <<fetch(url)>> -> PASSES_ARGUMENT -> PARAMETER <<url>>
// TRY_BLOCK <<try-block>> -> RETURNS -> CALL <<response.json()>>
// CALL <<response.json()>> -> CALLS_ON -> VARIABLE <<response>>
// FUNCTION <<fetchWithCause>> -> HAS_CATCH -> CATCH_BLOCK <<catch-block>>
// CATCH_BLOCK <<catch-block>> -> CONTAINS -> PARAMETER <<err>>
// CATCH_BLOCK <<catch-block>> -> THROWS -> CALL <<new Error>>
// CALL <<new Error>> -> PASSES_ARGUMENT -> EXPRESSION <<`Failed to fetch ${url}`>>
// CALL <<new Error>> -> PASSES_ARGUMENT -> LITERAL <<{ cause: err }>>
// EXPRESSION <<`Failed to fetch ${url}`>> -> CONTAINS -> LITERAL <<'Failed to fetch '>>
// EXPRESSION <<`Failed to fetch ${url}`>> -> READS_FROM -> PARAMETER <<url>>
// LITERAL <<{ cause: err }>> -> READS_FROM -> PARAMETER <<err>>
// @end-annotation
async function fetchWithCause(url) {
  try {
    const response = await fetch(url);
    return await response.json();
  } catch (err) {
    throw new Error(`Failed to fetch ${url}`, { cause: err });
  }
}

// --- Error wrapping / re-throw ---

// @construct PENDING error-wrap-rethrow
// @annotation
// FUNCTION <<parseConfig>> -> CONTAINS -> PARAMETER <<raw>>
// FUNCTION <<parseConfig>> -> CONTAINS -> TRY_BLOCK <<try-block>>
// FUNCTION <<parseConfig>> -> CONTAINS -> CATCH_BLOCK <<catch-block>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> CALL <<JSON.parse(raw)>>
// FUNCTION <<parseConfig>> -> RETURNS -> CALL <<JSON.parse(raw)>>
// CALL <<JSON.parse(raw)>> -> CALLS -> EXTERNAL <<JSON.parse>>
// CALL <<JSON.parse(raw)>> -> PASSES_ARGUMENT -> PARAMETER <<raw>>
// CATCH_BLOCK <<catch-block>> -> CONTAINS -> PARAMETER <<err>>
// CATCH_BLOCK <<catch-block>> -> THROWS -> CALL <<new AppError>>
// CALL <<new AppError>> -> CALLS -> EXTERNAL <<AppError>>
// CALL <<new AppError>> -> PASSES_ARGUMENT -> EXPRESSION <<`Invalid config: ${err.message}`>>
// CALL <<new AppError>> -> PASSES_ARGUMENT -> LITERAL <<'PARSE_ERROR'>>
// EXPRESSION <<`Invalid config: ${err.message}`>> -> READS_FROM -> PROPERTY_ACCESS <<err.message>>
// PROPERTY_ACCESS <<err.message>> -> READS_FROM -> PARAMETER <<err>>
// TRY_BLOCK <<try-block>> -> HAS_CATCH -> CATCH_BLOCK <<catch-block>>
// CATCH_BLOCK <<catch-block>> -> CATCHES_FROM -> TRY_BLOCK <<try-block>>
// @end-annotation
function parseConfig(raw) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new AppError(`Invalid config: ${err.message}`, 'PARSE_ERROR');
  }
}

// @construct PENDING error-rethrow-conditional
// @annotation
// FUNCTION <<processData>> -> CONTAINS -> PARAMETER <<data>>
// FUNCTION <<processData>> -> CONTAINS -> TRY_BLOCK <<processData:try>>
// TRY_BLOCK <<processData:try>> -> CONTAINS -> CALL <<transform(data)>>
// TRY_BLOCK <<processData:try>> -> RETURNS -> CALL <<transform(data)>>
// CALL <<transform(data)>> -> CALLS -> FUNCTION <<transform>>
// CALL <<transform(data)>> -> PASSES_ARGUMENT -> PARAMETER <<data>>
// FUNCTION <<processData>> -> HAS_CATCH -> CATCH_BLOCK <<processData:catch>>
// CATCH_BLOCK <<processData:catch>> -> CONTAINS -> PARAMETER <<err>>
// CATCH_BLOCK <<processData:catch>> -> CONTAINS -> EXPRESSION <<err instanceof ValidationError>>
// EXPRESSION <<err instanceof ValidationError>> -> HAS_CONDITION -> EXPRESSION <<err instanceof ValidationError>>
// EXPRESSION <<err instanceof ValidationError>> -> READS_FROM -> PARAMETER <<err>>
// EXPRESSION <<err instanceof ValidationError>> -> HAS_CONSEQUENT -> EXPRESSION <<throw err>>
// EXPRESSION <<throw err>> -> THROWS -> PARAMETER <<err>>
// EXPRESSION <<err instanceof ValidationError>> -> HAS_ALTERNATE -> EXPRESSION <<throw new AppError(...)>>
// CALL <<new AppError(...)>> -> READS_FROM -> PARAMETER <<err>>
// EXPRESSION <<throw new AppError(...)>> -> THROWS -> CALL <<new AppError(...)>>
// FUNCTION <<transform>> -> CONTAINS -> PARAMETER <<transform:data>>
// FUNCTION <<transform>> -> CONTAINS -> BRANCH <<transform:if>>
// BRANCH <<transform:if>> -> HAS_CONDITION -> EXPRESSION <<!data>>
// EXPRESSION <<!data>> -> READS_FROM -> PARAMETER <<transform:data>>
// BRANCH <<transform:if>> -> HAS_CONSEQUENT -> EXPRESSION <<throw new ValidationError(...)>>
// EXPRESSION <<throw new ValidationError(...)>> -> THROWS -> CALL <<new ValidationError(...)>>
// FUNCTION <<transform>> -> RETURNS -> PARAMETER <<transform:data>>
// @end-annotation
function processData(data) {
  try {
    return transform(data);
  } catch (err) {
    if (err instanceof ValidationError) {
      throw err; // re-throw known errors as-is
    }
    throw new AppError(`Unexpected: ${err.message}`, 'INTERNAL');
  }
}

function transform(data) {
  if (!data) throw new ValidationError('data', 'Data is required');
  return data;
}

// --- instanceof checks in catch ---

// @construct PENDING error-catch-instanceof
// @annotation
// @end-annotation
function handleError(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ValidationError) {
      return { type: 'validation', field: err.field, message: err.message };
    }
    if (err instanceof NotFoundError) {
      return { type: 'notfound', resource: err.resource };
    }
    if (err instanceof TypeError) {
      return { type: 'type', message: err.message };
    }
    throw err; // unknown — re-throw
  }
}

// --- Async error propagation ---

// @construct PENDING error-async-propagation
// @annotation
// @end-annotation
async function pipeline(input) {
  const step1 = await validateAsync(input);
  const step2 = await transformAsync(step1);
  const step3 = await saveAsync(step2);
  return step3;
}

async function validateAsync(data) {
  if (!data) throw new ValidationError('input', 'Required');
  return data;
}

async function transformAsync(data) {
  return { ...data, transformed: true };
}

async function saveAsync(data) {
  return { ...data, saved: true };
}

// @construct PENDING error-async-catch-all
// @annotation
// FUNCTION <<safeExecute>> -> CONTAINS -> PARAMETER <<asyncFn>>
// FUNCTION <<safeExecute>> -> HAS_BODY -> TRY_BLOCK <<safeExecute:try>>
// FUNCTION <<safeExecute>> -> HAS_CATCH -> CATCH_BLOCK <<safeExecute:catch>>
// CATCH_BLOCK <<safeExecute:catch>> -> CONTAINS -> PARAMETER <<err>>
// TRY_BLOCK <<safeExecute:try>> -> RETURNS -> LITERAL <<{ ok: true, value: await asyncFn() }>>
// CATCH_BLOCK <<safeExecute:catch>> -> RETURNS -> LITERAL <<{ ok: false, error: err }>>
// EXPRESSION <<await asyncFn()>> -> AWAITS -> CALL <<asyncFn()>>
// CALL <<asyncFn()>> -> CALLS -> PARAMETER <<asyncFn>>
// LITERAL <<{ ok: true, value: await asyncFn() }>> -> HAS_PROPERTY -> LITERAL <<true>>
// LITERAL <<{ ok: true, value: await asyncFn() }>> -> HAS_PROPERTY -> EXPRESSION <<await asyncFn()>>
// LITERAL <<{ ok: false, error: err }>> -> HAS_PROPERTY -> LITERAL <<false>>
// LITERAL <<{ ok: false, error: err }>> -> HAS_PROPERTY -> PARAMETER <<err>>
// CATCH_BLOCK <<safeExecute:catch>> -> CATCHES_FROM -> PARAMETER <<err>>
// @end-annotation
async function safeExecute(asyncFn) {
  try {
    return { ok: true, value: await asyncFn() };
  } catch (err) {
    return { ok: false, error: err };
  }
}

// --- Promise rejection handling ---

// @construct PENDING error-promise-catch
// @annotation
// FUNCTION <<promiseErrorHandling>> -> RETURNS -> CALL <<Promise.reject(new Error('boom'))>>
// CALL <<Promise.reject(new Error('boom'))>> -> PASSES_ARGUMENT -> CALL <<new Error('boom')>>
// CALL <<new Error('boom')>> -> PASSES_ARGUMENT -> LITERAL <<'boom'>>
// CALL <<Promise.reject(new Error('boom'))>> -> CHAINS_FROM -> CALL <<.catch(err => {...})>>
// CALL <<.catch(err => {...})>> -> PASSES_ARGUMENT -> FUNCTION <<catch-handler>>
// FUNCTION <<catch-handler>> -> CONTAINS -> PARAMETER <<err>>
// FUNCTION <<catch-handler>> -> CONTAINS -> CALL <<console.error('Caught:', err.message)>>
// CALL <<console.error('Caught:', err.message)>> -> PASSES_ARGUMENT -> LITERAL <<'Caught:'>>
// CALL <<console.error('Caught:', err.message)>> -> PASSES_ARGUMENT -> PROPERTY_ACCESS <<err.message>>
// PROPERTY_ACCESS <<err.message>> -> READS_FROM -> PARAMETER <<err>>
// FUNCTION <<catch-handler>> -> RETURNS -> LITERAL <<'recovered'>>
// @end-annotation
function promiseErrorHandling() {
  return Promise.reject(new Error('boom'))
    .catch(err => {
      console.error('Caught:', err.message);
      return 'recovered';
    });
}

// @construct PENDING error-promise-chain-error
// @annotation
// @end-annotation
function chainedErrors() {
  return Promise.resolve(1)
    .then(v => { throw new Error(`step1: ${v}`); })
    .then(v => v + 1) // skipped
    .catch(err => `caught: ${err.message}`)
    .then(v => `final: ${v}`);
}

// --- Aggregated errors ---

// @construct PENDING error-aggregate
// @annotation
// FUNCTION <<aggregatedErrors>> -> CONTAINS -> VARIABLE <<errors>>
// VARIABLE <<errors>> -> ASSIGNED_FROM -> LITERAL <<['first', 'second', 'third']>>
// LITERAL <<['first', 'second', 'third']>> -> HAS_ELEMENT -> CALL <<new Error('first')>>
// LITERAL <<['first', 'second', 'third']>> -> HAS_ELEMENT -> CALL <<new Error('second')>>
// LITERAL <<['first', 'second', 'third']>> -> HAS_ELEMENT -> CALL <<new Error('third')>>
// CALL <<new Error('first')>> -> CALLS -> EXTERNAL <<Error>>
// CALL <<new Error('first')>> -> PASSES_ARGUMENT -> LITERAL <<'first'>>
// CALL <<new Error('second')>> -> CALLS -> EXTERNAL <<Error>>
// CALL <<new Error('second')>> -> PASSES_ARGUMENT -> LITERAL <<'second'>>
// CALL <<new Error('third')>> -> CALLS -> EXTERNAL <<Error>>
// CALL <<new Error('third')>> -> PASSES_ARGUMENT -> LITERAL <<'third'>>
// FUNCTION <<aggregatedErrors>> -> THROWS -> CALL <<new AggregateError(errors, 'Multiple failures')>>
// CALL <<new AggregateError(errors, 'Multiple failures')>> -> CALLS -> EXTERNAL <<AggregateError>>
// CALL <<new AggregateError(errors, 'Multiple failures')>> -> PASSES_ARGUMENT -> VARIABLE <<errors>>
// CALL <<new AggregateError(errors, 'Multiple failures')>> -> PASSES_ARGUMENT -> LITERAL <<'Multiple failures'>>
// @end-annotation
function aggregatedErrors() {
  const errors = [
    new Error('first'),
    new Error('second'),
    new Error('third'),
  ];
  throw new AggregateError(errors, 'Multiple failures');
}

// --- Finally for cleanup ---

// @construct PENDING error-finally-cleanup
// @annotation
// @end-annotation
function withCleanup(resource) {
  let handle;
  try {
    handle = openResource(resource);
    return processResource(handle);
  } catch (err) {
    logError(err);
    throw err;
  } finally {
    if (handle) closeResource(handle);
  }
}

function openResource(r) { return { id: r }; }
function processResource(h) { return h.id; }
function closeResource(h) { h.id = null; }
function logError(e) { console.error(e); }

// @construct PENDING export-named-list
// @annotation
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<AppError>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<ValidationError>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<NotFoundError>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<fetchWithCause>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<parseConfig>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<processData>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<handleError>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<pipeline>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<safeExecute>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<promiseErrorHandling>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<chainedErrors>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<aggregatedErrors>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<withCleanup>>
// @end-annotation
export {
  AppError,
  ValidationError,
  NotFoundError,
  fetchWithCause,
  parseConfig,
  processData,
  handleError,
  pipeline,
  safeExecute,
  promiseErrorHandling,
  chainedErrors,
  aggregatedErrors,
  withCleanup,
};
