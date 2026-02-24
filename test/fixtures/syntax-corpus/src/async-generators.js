// =============================================================================
// async-generators.js — Async/Await, Promises, Generators, Iterators
// =============================================================================

// @construct PENDING async-await-basic
// @annotation
// FUNCTION <<fetchData>> -> CONTAINS -> PARAMETER <<url>>
// FUNCTION <<fetchData>> -> CONTAINS -> VARIABLE <<response>>
// VARIABLE <<response>> -> ASSIGNED_FROM -> CALL <<fetch(url)>>
// CALL <<fetch(url)>> -> CALLS -> EXTERNAL <<fetch>>
// CALL <<fetch(url)>> -> PASSES_ARGUMENT -> PARAMETER <<url>>
// FUNCTION <<fetchData>> -> CONTAINS -> VARIABLE <<data>>
// VARIABLE <<data>> -> ASSIGNED_FROM -> CALL <<response.json()>>
// CALL <<response.json()>> -> CALLS -> PROPERTY_ACCESS <<response.json>>
// PROPERTY_ACCESS <<response.json>> -> READS_FROM -> VARIABLE <<response>>
// FUNCTION <<fetchData>> -> RETURNS -> VARIABLE <<data>>
// FUNCTION <<fetchData>> -> AWAITS -> CALL <<fetch(url)>>
// FUNCTION <<fetchData>> -> AWAITS -> CALL <<response.json()>>
// @end-annotation
async function fetchData(url) {
  const response = await fetch(url);
  const data = await response.json();
  return data;
}

// @construct PENDING async-await-try-catch
// @annotation
// FUNCTION <<fetchWithErrorHandling>> -> CONTAINS -> PARAMETER <<url>>
// FUNCTION <<fetchWithErrorHandling>> -> HAS_BODY -> TRY_BLOCK <<try-block>>
// FUNCTION <<fetchWithErrorHandling>> -> HAS_CATCH -> CATCH_BLOCK <<catch-block>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> VARIABLE <<response>>
// VARIABLE <<response>> -> ASSIGNED_FROM -> CALL <<fetch(url)>>
// CALL <<fetch(url)>> -> PASSES_ARGUMENT -> PARAMETER <<url>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> BRANCH <<if-not-ok>>
// BRANCH <<if-not-ok>> -> HAS_CONDITION -> EXPRESSION <<!response.ok>>
// EXPRESSION <<!response.ok>> -> READS_FROM -> PROPERTY_ACCESS <<response.ok>>
// PROPERTY_ACCESS <<response.ok>> -> READS_FROM -> VARIABLE <<response>>
// BRANCH <<if-not-ok>> -> THROWS -> CALL <<new Error>>
// CALL <<new Error>> -> PASSES_ARGUMENT -> LITERAL <<`HTTP ${response.status}`>>
// LITERAL <<`HTTP ${response.status}`>> -> READS_FROM -> PROPERTY_ACCESS <<response.status>>
// PROPERTY_ACCESS <<response.status>> -> READS_FROM -> VARIABLE <<response>>
// TRY_BLOCK <<try-block>> -> RETURNS -> CALL <<response.json()>>
// CALL <<response.json()>> -> CALLS_ON -> VARIABLE <<response>>
// CATCH_BLOCK <<catch-block>> -> CONTAINS -> PARAMETER <<error>>
// CATCH_BLOCK <<catch-block>> -> CONTAINS -> CALL <<console.error>>
// CALL <<console.error>> -> PASSES_ARGUMENT -> LITERAL <<'Fetch failed:'>>
// CALL <<console.error>> -> PASSES_ARGUMENT -> PARAMETER <<error>>
// CATCH_BLOCK <<catch-block>> -> RETURNS -> LITERAL <<null>>
// CATCH_BLOCK <<catch-block>> -> CATCHES_FROM -> TRY_BLOCK <<try-block>>
// CALL <<fetch(url)>> -> AWAITS -> FUNCTION <<fetchWithErrorHandling>>
// CALL <<response.json()>> -> AWAITS -> FUNCTION <<fetchWithErrorHandling>>
// @end-annotation
async function fetchWithErrorHandling(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Fetch failed:', error);
    return null;
  }
}

// @construct PENDING promise-construction
// @annotation
// FUNCTION <<createPromise>> -> HAS_BODY -> PARAMETER <<shouldResolve>>
// FUNCTION <<createPromise>> -> RETURNS -> CALL <<new Promise(...)>>
// CALL <<new Promise(...)>> -> PASSES_ARGUMENT -> FUNCTION <<executor>>
// FUNCTION <<executor>> -> HAS_BODY -> PARAMETER <<resolve>>
// FUNCTION <<executor>> -> HAS_BODY -> PARAMETER <<reject>>
// FUNCTION <<executor>> -> HAS_BODY -> BRANCH <<if-shouldResolve>>
// BRANCH <<if-shouldResolve>> -> HAS_CONDITION -> PARAMETER <<shouldResolve>>
// BRANCH <<if-shouldResolve>> -> HAS_CONSEQUENT -> CALL <<resolve('success')>>
// BRANCH <<if-shouldResolve>> -> HAS_ALTERNATE -> CALL <<reject(new Error('failure'))>>
// CALL <<resolve('success')>> -> CALLS -> PARAMETER <<resolve>>
// CALL <<resolve('success')>> -> PASSES_ARGUMENT -> LITERAL <<'success'>>
// CALL <<reject(new Error('failure'))>> -> CALLS -> PARAMETER <<reject>>
// CALL <<reject(new Error('failure'))>> -> PASSES_ARGUMENT -> CALL <<new Error('failure')>>
// CALL <<new Error('failure')>> -> PASSES_ARGUMENT -> LITERAL <<'failure'>>
// @end-annotation
function createPromise(shouldResolve) {
  return new Promise((resolve, reject) => {
    if (shouldResolve) {
      resolve('success');
    } else {
      reject(new Error('failure'));
    }
  });
}

// @construct PENDING promise-combinators
// @annotation
// @end-annotation
async function promiseCombinators() {
  const p1 = Promise.resolve(1);
  const p2 = Promise.resolve(2);
  const p3 = Promise.resolve(3);

  const all = await Promise.all([p1, p2, p3]);
  const race = await Promise.race([p1, p2, p3]);
  const allSettled = await Promise.allSettled([p1, p2, p3]);
  const any = await Promise.any([p1, p2, p3]);

  return { all, race, allSettled, any };
}

// @construct PENDING promise-chaining
// @annotation
// FUNCTION <<promiseChaining>> -> CONTAINS -> PARAMETER <<url>>
// FUNCTION <<promiseChaining>> -> RETURNS -> CALL <<fetch(url)>>
// CALL <<fetch(url)>> -> PASSES_ARGUMENT -> PARAMETER <<url>>
// CALL <<fetch(url)>> -> CHAINS_FROM -> CALL <<.then(response => response.json())>>
// CALL <<.then(response => response.json())>> -> PASSES_ARGUMENT -> FUNCTION <<response => response.json()>>
// FUNCTION <<response => response.json()>> -> CONTAINS -> PARAMETER <<response>>
// FUNCTION <<response => response.json()>> -> RETURNS -> CALL <<response.json()>>
// CALL <<response.json()>> -> READS_FROM -> PARAMETER <<response>>
// CALL <<.then(response => response.json())>> -> CHAINS_FROM -> CALL <<.then(data => data.result)>>
// CALL <<.then(data => data.result)>> -> PASSES_ARGUMENT -> FUNCTION <<data => data.result>>
// FUNCTION <<data => data.result>> -> CONTAINS -> PARAMETER <<data>>
// FUNCTION <<data => data.result>> -> RETURNS -> PROPERTY_ACCESS <<data.result>>
// PROPERTY_ACCESS <<data.result>> -> READS_FROM -> PARAMETER <<data>>
// CALL <<.then(data => data.result)>> -> CHAINS_FROM -> CALL <<.catch(error => console.error(error))>>
// CALL <<.catch(error => console.error(error))>> -> PASSES_ARGUMENT -> FUNCTION <<error => console.error(error)>>
// FUNCTION <<error => console.error(error)>> -> CONTAINS -> PARAMETER <<error>>
// FUNCTION <<error => console.error(error)>> -> RETURNS -> CALL <<console.error(error)>>
// CALL <<console.error(error)>> -> PASSES_ARGUMENT -> PARAMETER <<error>>
// CALL <<.catch(error => console.error(error))>> -> CHAINS_FROM -> CALL <<.finally(() => console.log('done'))>>
// CALL <<.finally(() => console.log('done'))>> -> PASSES_ARGUMENT -> FUNCTION <<() => console.log('done')>>
// FUNCTION <<() => console.log('done')>> -> RETURNS -> CALL <<console.log('done')>>
// CALL <<console.log('done')>> -> PASSES_ARGUMENT -> LITERAL <<'done'>>
// @end-annotation
function promiseChaining(url) {
  return fetch(url)
    .then(response => response.json())
    .then(data => data.result)
    .catch(error => console.error(error))
    .finally(() => console.log('done'));
}

// @construct PENDING async-arrow
// @annotation
// UNKNOWN <<module>> -> DECLARES -> VARIABLE <<asyncArrow>>
// VARIABLE <<asyncArrow>> -> ASSIGNED_FROM -> FUNCTION <<asyncArrow:fn>>
// FUNCTION <<asyncArrow:fn>> -> RETURNS -> EXPRESSION <<await Promise.resolve(42)>>
// EXPRESSION <<await Promise.resolve(42)>> -> AWAITS -> CALL <<Promise.resolve(42)>>
// CALL <<Promise.resolve(42)>> -> CALLS -> UNKNOWN <<Promise>>
// CALL <<Promise.resolve(42)>> -> PASSES_ARGUMENT -> LITERAL <<42>>
// @end-annotation
const asyncArrow = async () => {
  return await Promise.resolve(42);
};

// @construct PENDING async-arrow-with-params
const asyncArrowWithParams = async (url, options) => {
  const response = await fetch(url, options);
  return response.json();
};

// @construct PENDING generator-basic
// @annotation
// FUNCTION <<counter>> -> CONTAINS -> PARAMETER <<start>>
// FUNCTION <<counter>> -> CONTAINS -> PARAMETER <<end>>
// FUNCTION <<counter>> -> CONTAINS -> LOOP <<for-loop>>
// LOOP <<for-loop>> -> HAS_INIT -> VARIABLE <<i>>
// VARIABLE <<i>> -> ASSIGNED_FROM -> PARAMETER <<start>>
// LOOP <<for-loop>> -> HAS_CONDITION -> EXPRESSION <<i <= end>>
// EXPRESSION <<i <= end>> -> READS_FROM -> VARIABLE <<i>>
// EXPRESSION <<i <= end>> -> READS_FROM -> PARAMETER <<end>>
// LOOP <<for-loop>> -> HAS_UPDATE -> EXPRESSION <<i++>>
// EXPRESSION <<i++>> -> MODIFIES -> VARIABLE <<i>>
// LOOP <<for-loop>> -> HAS_BODY -> EXPRESSION <<yield i>>
// EXPRESSION <<yield i>> -> READS_FROM -> VARIABLE <<i>>
// FUNCTION <<counter>> -> YIELDS -> EXPRESSION <<yield i>>
// @end-annotation
function* counter(start, end) {
  for (let i = start; i <= end; i++) {
    yield i;
  }
}

// @construct PENDING generator-infinite
// @annotation
// FUNCTION <<fibonacci>> -> CONTAINS -> VARIABLE <<a>>
// FUNCTION <<fibonacci>> -> CONTAINS -> VARIABLE <<b>>
// VARIABLE <<a>> -> ASSIGNED_FROM -> LITERAL <<0>>
// VARIABLE <<b>> -> ASSIGNED_FROM -> LITERAL <<1>>
// FUNCTION <<fibonacci>> -> CONTAINS -> LOOP <<while-true>>
// LOOP <<while-true>> -> HAS_CONDITION -> LITERAL <<true>>
// LOOP <<while-true>> -> CONTAINS -> EXPRESSION <<yield-a>>
// LOOP <<while-true>> -> CONTAINS -> EXPRESSION <<destructure-array>>
// EXPRESSION <<yield-a>> -> READS_FROM -> VARIABLE <<a>>
// FUNCTION <<fibonacci>> -> YIELDS -> EXPRESSION <<yield-a>>
// EXPRESSION <<a-plus-b>> -> READS_FROM -> VARIABLE <<a>>
// EXPRESSION <<a-plus-b>> -> READS_FROM -> VARIABLE <<b>>
// EXPRESSION <<destructure-array>> -> READS_FROM -> VARIABLE <<b>>
// EXPRESSION <<destructure-array>> -> READS_FROM -> EXPRESSION <<a-plus-b>>
// VARIABLE <<a>> -> ASSIGNED_FROM -> EXPRESSION <<destructure-array>>
// VARIABLE <<b>> -> ASSIGNED_FROM -> EXPRESSION <<destructure-array>>
// @end-annotation
function* fibonacci() {
  let [a, b] = [0, 1];
  while (true) {
    yield a;
    [a, b] = [b, a + b];
  }
}

// @construct PENDING generator-delegation
// @annotation
// FUNCTION <<innerGenerator>> -> YIELDS -> LITERAL <<'a'>>
// FUNCTION <<innerGenerator>> -> YIELDS -> LITERAL <<'b'>>
// FUNCTION <<outerGenerator>> -> YIELDS -> LITERAL <<1>>
// FUNCTION <<outerGenerator>> -> DELEGATES_TO -> CALL <<innerGenerator()>>
// CALL <<innerGenerator()>> -> CALLS -> FUNCTION <<innerGenerator>>
// FUNCTION <<outerGenerator>> -> YIELDS -> LITERAL <<2>>
// @end-annotation
function* innerGenerator() {
  yield 'a';
  yield 'b';
}

function* outerGenerator() {
  yield 1;
  yield* innerGenerator();
  yield 2;
}

// @construct PENDING async-generator
// @annotation
// FUNCTION <<asyncCounter>> -> CONTAINS -> PARAMETER <<start>>
// FUNCTION <<asyncCounter>> -> CONTAINS -> PARAMETER <<end>>
// FUNCTION <<asyncCounter>> -> CONTAINS -> LOOP <<for-loop>>
// LOOP <<for-loop>> -> HAS_INIT -> VARIABLE <<i>>
// VARIABLE <<i>> -> ASSIGNED_FROM -> PARAMETER <<start>>
// LOOP <<for-loop>> -> HAS_CONDITION -> EXPRESSION <<i <= end>>
// EXPRESSION <<i <= end>> -> READS_FROM -> VARIABLE <<i>>
// EXPRESSION <<i <= end>> -> READS_FROM -> PARAMETER <<end>>
// LOOP <<for-loop>> -> HAS_UPDATE -> EXPRESSION <<i++>>
// EXPRESSION <<i++>> -> MODIFIES -> VARIABLE <<i>>
// LOOP <<for-loop>> -> HAS_BODY -> EXPRESSION <<await new Promise(resolve => setTimeout(resolve, 100))>>
// LOOP <<for-loop>> -> HAS_BODY -> EXPRESSION <<yield i>>
// EXPRESSION <<await new Promise(resolve => setTimeout(resolve, 100))>> -> AWAITS -> CALL <<new Promise(resolve => setTimeout(resolve, 100))>>
// CALL <<new Promise(resolve => setTimeout(resolve, 100))>> -> PASSES_ARGUMENT -> FUNCTION <<resolve => setTimeout(resolve, 100)>>
// FUNCTION <<resolve => setTimeout(resolve, 100)>> -> CONTAINS -> PARAMETER <<resolve>>
// FUNCTION <<resolve => setTimeout(resolve, 100)>> -> RETURNS -> CALL <<setTimeout(resolve, 100)>>
// CALL <<setTimeout(resolve, 100)>> -> PASSES_ARGUMENT -> PARAMETER <<resolve>>
// CALL <<setTimeout(resolve, 100)>> -> PASSES_ARGUMENT -> LITERAL <<100>>
// EXPRESSION <<yield i>> -> YIELDS -> VARIABLE <<i>>
// FUNCTION <<asyncCounter>> -> YIELDS -> EXPRESSION <<yield i>>
// @end-annotation
async function* asyncCounter(start, end) {
  for (let i = start; i <= end; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    yield i;
  }
}

// @construct PENDING for-await-of
// @annotation
// FUNCTION <<consumeAsyncIterable>> -> CONTAINS -> PARAMETER <<asyncIterable>>
// FUNCTION <<consumeAsyncIterable>> -> CONTAINS -> VARIABLE <<results>>
// VARIABLE <<results>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// FUNCTION <<consumeAsyncIterable>> -> CONTAINS -> LOOP <<for-await-of>>
// LOOP <<for-await-of>> -> ITERATES_OVER -> PARAMETER <<asyncIterable>>
// LOOP <<for-await-of>> -> CONTAINS -> VARIABLE <<item>>
// LOOP <<for-await-of>> -> HAS_BODY -> CALL <<results.push(item)>>
// CALL <<results.push(item)>> -> CALLS_ON -> VARIABLE <<results>>
// CALL <<results.push(item)>> -> PASSES_ARGUMENT -> VARIABLE <<item>>
// FUNCTION <<consumeAsyncIterable>> -> RETURNS -> VARIABLE <<results>>
// @end-annotation
async function consumeAsyncIterable(asyncIterable) {
  const results = [];
  for await (const item of asyncIterable) {
    results.push(item);
  }
  return results;
}

// @construct PENDING top-level-await
// @annotation
// VARIABLE <<config>> -> ASSIGNED_FROM -> EXPRESSION <<await import('./declarations.js')>>
// EXPRESSION <<await import('./declarations.js')>> -> AWAITS -> CALL <<import('./declarations.js')>>
// CALL <<import('./declarations.js')>> -> PASSES_ARGUMENT -> LITERAL <<'./declarations.js'>>
// CALL <<import('./declarations.js')>> -> IMPORTS_FROM -> EXTERNAL_MODULE <<./declarations.js>>
// @end-annotation
const config = await import('./declarations.js');

// @construct PENDING generator-two-way
function* accumulator() {
  let total = 0;
  while (true) {
    const value = yield total;
    total += value;
  }
}

// @construct PENDING generator-return-throw
// @annotation
// FUNCTION <<generatorReturnThrow>> -> CONTAINS -> TRY_BLOCK <<try-block>>
// FUNCTION <<generatorReturnThrow>> -> HAS_FINALLY -> FINALLY_BLOCK <<finally-block>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> EXPRESSION <<yield 1>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> EXPRESSION <<yield 2>>
// EXPRESSION <<yield 1>> -> RETURNS -> LITERAL <<1>>
// EXPRESSION <<yield 2>> -> RETURNS -> LITERAL <<2>>
// FINALLY_BLOCK <<finally-block>> -> CONTAINS -> EXPRESSION <<yield 'cleanup'>>
// EXPRESSION <<yield 'cleanup'>> -> RETURNS -> LITERAL <<'cleanup'>>
// @end-annotation
function* generatorReturnThrow() {
  try {
    yield 1;
    yield 2;
  } finally {
    yield 'cleanup';
  }
}

// @construct PENDING async-iter-manual
// @annotation
// FUNCTION <<manualAsyncIteration>> -> CONTAINS -> PARAMETER <<asyncIterable>>
// FUNCTION <<manualAsyncIteration>> -> CONTAINS -> VARIABLE <<asyncIter>>
// VARIABLE <<asyncIter>> -> ASSIGNED_FROM -> CALL <<asyncIterable[Symbol.asyncIterator]()>>
// CALL <<asyncIterable[Symbol.asyncIterator]()>> -> CALLS -> PROPERTY_ACCESS <<asyncIterable[Symbol.asyncIterator]>>
// PROPERTY_ACCESS <<asyncIterable[Symbol.asyncIterator]>> -> READS_FROM -> PARAMETER <<asyncIterable>>
// FUNCTION <<manualAsyncIteration>> -> CONTAINS -> VARIABLE <<results>>
// VARIABLE <<results>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// FUNCTION <<manualAsyncIteration>> -> CONTAINS -> VARIABLE <<step>>
// VARIABLE <<step>> -> ASSIGNED_FROM -> CALL <<asyncIter.next()>>
// CALL <<asyncIter.next()>> -> READS_FROM -> VARIABLE <<asyncIter>>
// FUNCTION <<manualAsyncIteration>> -> CONTAINS -> LOOP <<while>>
// LOOP <<while>> -> HAS_CONDITION -> EXPRESSION <<!step.done>>
// EXPRESSION <<!step.done>> -> READS_FROM -> PROPERTY_ACCESS <<step.done>>
// PROPERTY_ACCESS <<step.done>> -> READS_FROM -> VARIABLE <<step>>
// LOOP <<while>> -> CONTAINS -> CALL <<results.push(step.value)>>
// CALL <<results.push(step.value)>> -> READS_FROM -> VARIABLE <<results>>
// CALL <<results.push(step.value)>> -> PASSES_ARGUMENT -> PROPERTY_ACCESS <<step.value>>
// PROPERTY_ACCESS <<step.value>> -> READS_FROM -> VARIABLE <<step>>
// LOOP <<while>> -> CONTAINS -> EXPRESSION <<step = await asyncIter.next()>>
// EXPRESSION <<step = await asyncIter.next()>> -> WRITES_TO -> VARIABLE <<step>>
// EXPRESSION <<step = await asyncIter.next()>> -> READS_FROM -> CALL <<asyncIter.next()#2>>
// CALL <<asyncIter.next()#2>> -> READS_FROM -> VARIABLE <<asyncIter>>
// FUNCTION <<manualAsyncIteration>> -> CONTAINS -> CALL <<asyncIter.return?.()>>
// CALL <<asyncIter.return?.()>> -> CALLS -> PROPERTY_ACCESS <<asyncIter.return>>
// PROPERTY_ACCESS <<asyncIter.return>> -> READS_FROM -> VARIABLE <<asyncIter>>
// FUNCTION <<manualAsyncIteration>> -> RETURNS -> VARIABLE <<results>>
// @end-annotation
async function manualAsyncIteration(asyncIterable) {
  const asyncIter = asyncIterable[Symbol.asyncIterator]();
  const results = [];
  let step = await asyncIter.next();
  while (!step.done) {
    results.push(step.value);
    step = await asyncIter.next();
  }
  await asyncIter.return?.();
  return results;
}

// @construct PENDING async-return-thenable
// @annotation
// FUNCTION <<returnsThenable>> -> RETURNS -> EXPRESSION <<thenable-object>>
// EXPRESSION <<thenable-object>> -> HAS_PROPERTY -> METHOD <<then>>
// METHOD <<then>> -> HAS_BODY -> PARAMETER <<resolve>>
// METHOD <<then>> -> HAS_BODY -> CALL <<resolve(42)>>
// CALL <<resolve(42)>> -> CALLS -> PARAMETER <<resolve>>
// CALL <<resolve(42)>> -> PASSES_ARGUMENT -> LITERAL <<42>>
// @end-annotation
async function returnsThenable() {
  return {
    then(resolve) {
      resolve(42);
    },
  };
}

// @construct PENDING promise-resolve-thenable
// @annotation
// FUNCTION <<nestedThenable>> -> CONTAINS -> VARIABLE <<thenable>>
// VARIABLE <<thenable>> -> ASSIGNED_FROM -> LITERAL <<thenable-object>>
// LITERAL <<thenable-object>> -> HAS_PROPERTY -> METHOD <<thenable.then>>
// METHOD <<thenable.then>> -> RECEIVES_ARGUMENT -> PARAMETER <<resolve>>
// METHOD <<thenable.then>> -> CONTAINS -> CALL <<resolve(nested-thenable)>>
// CALL <<resolve(nested-thenable)>> -> CALLS -> PARAMETER <<resolve>>
// CALL <<resolve(nested-thenable)>> -> PASSES_ARGUMENT -> LITERAL <<nested-thenable-object>>
// LITERAL <<nested-thenable-object>> -> HAS_PROPERTY -> METHOD <<nested-thenable.then>>
// METHOD <<nested-thenable.then>> -> RECEIVES_ARGUMENT -> PARAMETER <<resolve2>>
// METHOD <<nested-thenable.then>> -> CONTAINS -> CALL <<resolve2(42)>>
// CALL <<resolve2(42)>> -> CALLS -> PARAMETER <<resolve2>>
// CALL <<resolve2(42)>> -> PASSES_ARGUMENT -> LITERAL <<42>>
// CALL <<Promise.resolve(thenable)>> -> PASSES_ARGUMENT -> VARIABLE <<thenable>>
// EXPRESSION <<await Promise.resolve(thenable)>> -> AWAITS -> CALL <<Promise.resolve(thenable)>>
// FUNCTION <<nestedThenable>> -> RETURNS -> EXPRESSION <<await Promise.resolve(thenable)>>
// @end-annotation
async function nestedThenable() {
  const thenable = {
    then(resolve) {
      resolve({
        then(resolve2) {
          resolve2(42); // nested thenables unwrap recursively
        },
      });
    },
  };
  return await Promise.resolve(thenable);
}

// @construct PENDING generator-observer-pattern
// @annotation
// FUNCTION <<observer>> -> CONTAINS -> VARIABLE <<results>>
// VARIABLE <<results>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// FUNCTION <<observer>> -> CONTAINS -> TRY_BLOCK <<try-block>>
// FUNCTION <<observer>> -> CONTAINS -> FINALLY_BLOCK <<finally-block>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> LOOP <<while-true>>
// LOOP <<while-true>> -> HAS_CONDITION -> LITERAL <<true>>
// LOOP <<while-true>> -> CONTAINS -> VARIABLE <<value>>
// VARIABLE <<value>> -> ASSIGNED_FROM -> EXPRESSION <<yield>>
// LOOP <<while-true>> -> CONTAINS -> CALL <<results.push(value)>>
// CALL <<results.push(value)>> -> CALLS -> PROPERTY_ACCESS <<results.push>>
// PROPERTY_ACCESS <<results.push>> -> READS_FROM -> VARIABLE <<results>>
// CALL <<results.push(value)>> -> PASSES_ARGUMENT -> VARIABLE <<value>>
// FINALLY_BLOCK <<finally-block>> -> CONTAINS -> EXPRESSION <<return results>>
// EXPRESSION <<return results>> -> READS_FROM -> VARIABLE <<results>>
// FUNCTION <<observer>> -> RETURNS -> EXPRESSION <<return results>>
// @end-annotation
function* observer() {
  const results = [];
  try {
    while (true) {
      const value = yield;
      results.push(value);
    }
  } finally {
    return results;
  }
}

// --- Generator finally cleanup (control flow edge case) ---

// @construct PENDING generator-finally-cleanup
// @annotation
// FUNCTION <<resourceGenerator>> -> CONTAINS -> VARIABLE <<resource>>
// VARIABLE <<resource>> -> ASSIGNED_FROM -> LITERAL <<{ acquired: true }>>
// FUNCTION <<resourceGenerator>> -> CONTAINS -> TRY_BLOCK <<try-block>>
// FUNCTION <<resourceGenerator>> -> CONTAINS -> FINALLY_BLOCK <<finally-block>>
// TRY_BLOCK <<try-block>> -> HAS_FINALLY -> FINALLY_BLOCK <<finally-block>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> EXPRESSION <<yield resource>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> EXPRESSION <<yield { transformed: true }>>
// EXPRESSION <<yield resource>> -> READS_FROM -> VARIABLE <<resource>>
// EXPRESSION <<yield { transformed: true }>> -> READS_FROM -> LITERAL <<{ transformed: true }>>
// FINALLY_BLOCK <<finally-block>> -> WRITES_TO -> PROPERTY_ACCESS <<resource.acquired>>
// PROPERTY_ACCESS <<resource.acquired>> -> ASSIGNED_FROM -> LITERAL <<false>>
// PROPERTY_ACCESS <<resource.acquired>> -> READS_FROM -> VARIABLE <<resource>>
// @end-annotation
function* resourceGenerator() {
  const resource = { acquired: true };
  try {
    yield resource;
    yield { transformed: true };
  } finally {
    resource.acquired = false; // runs even when consumer calls .return() or .throw()
  }
}

// @construct PENDING generator-break-triggers-finally
// @annotation
// FUNCTION <<consumeWithBreak>> -> CONTAINS -> PARAMETER <<gen>>
// FUNCTION <<consumeWithBreak>> -> CONTAINS -> LOOP <<for-of>>
// LOOP <<for-of>> -> ITERATES_OVER -> PARAMETER <<gen>>
// LOOP <<for-of>> -> CONTAINS -> VARIABLE <<item>>
// LOOP <<for-of>> -> CONTAINS -> BRANCH <<if-transformed>>
// BRANCH <<if-transformed>> -> HAS_CONDITION -> PROPERTY_ACCESS <<item.transformed>>
// PROPERTY_ACCESS <<item.transformed>> -> READS_FROM -> VARIABLE <<item>>
// BRANCH <<if-transformed>> -> HAS_CONSEQUENT -> SIDE_EFFECT <<break>>
// SIDE_EFFECT <<break>> -> FLOWS_INTO -> LOOP <<for-of>>
// @end-annotation
function consumeWithBreak(gen) {
  for (const item of gen) {
    if (item.transformed) break; // implicitly calls generator.return() → finally runs
  }
}

// @construct PENDING generator-finally-yield-trap
// @annotation
// FUNCTION <<trickyFinally>> -> CONTAINS -> TRY_BLOCK <<try-block>>
// FUNCTION <<trickyFinally>> -> CONTAINS -> FINALLY_BLOCK <<finally-block>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> EXPRESSION <<yield 1>>
// FINALLY_BLOCK <<finally-block>> -> CONTAINS -> EXPRESSION <<yield 2>>
// EXPRESSION <<yield 1>> -> YIELDS -> LITERAL <<1>>
// EXPRESSION <<yield 2>> -> YIELDS -> LITERAL <<2>>
// TRY_BLOCK <<try-block>> -> HAS_FINALLY -> FINALLY_BLOCK <<finally-block>>
// @end-annotation
function* trickyFinally() {
  try {
    yield 1;
  } finally {
    yield 2; // return() pauses HERE, not at the return point
  }
}
// const g = trickyFinally(); g.next(); g.return('end');
// → { value: 2, done: false } — NOT 'end'!
// g.next() → { value: 'end', done: true }

// --- Async iterator cancellation ---

// @construct PENDING async-iterator-cancel-break
// @annotation
// FUNCTION <<streamChunks>> -> CONTAINS -> PARAMETER <<url>>
// FUNCTION <<streamChunks>> -> CONTAINS -> VARIABLE <<reader>>
// VARIABLE <<reader>> -> ASSIGNED_FROM -> LITERAL <<{ locked: true }>>
// FUNCTION <<streamChunks>> -> CONTAINS -> TRY_BLOCK <<try-block>>
// FUNCTION <<streamChunks>> -> CONTAINS -> FINALLY_BLOCK <<finally-block>>
// TRY_BLOCK <<try-block>> -> HAS_FINALLY -> FINALLY_BLOCK <<finally-block>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> LOOP <<for-loop>>
// LOOP <<for-loop>> -> CONTAINS -> VARIABLE <<i>>
// VARIABLE <<i>> -> ASSIGNED_FROM -> LITERAL <<0>>
// LOOP <<for-loop>> -> HAS_CONDITION -> EXPRESSION <<i < 10>>
// EXPRESSION <<i < 10>> -> READS_FROM -> VARIABLE <<i>>
// EXPRESSION <<i < 10>> -> READS_FROM -> LITERAL <<10>>
// LOOP <<for-loop>> -> HAS_UPDATE -> EXPRESSION <<i++>>
// EXPRESSION <<i++>> -> MODIFIES -> VARIABLE <<i>>
// LOOP <<for-loop>> -> HAS_BODY -> EXPRESSION <<yield { chunk: i, size: i * 100 }>>
// EXPRESSION <<yield { chunk: i, size: i * 100 }>> -> YIELDS -> LITERAL <<{ chunk: i, size: i * 100 }>>
// LITERAL <<{ chunk: i, size: i * 100 }>> -> READS_FROM -> VARIABLE <<i>>
// LITERAL <<{ chunk: i, size: i * 100 }>> -> READS_FROM -> EXPRESSION <<i * 100>>
// EXPRESSION <<i * 100>> -> READS_FROM -> VARIABLE <<i>>
// EXPRESSION <<i * 100>> -> READS_FROM -> LITERAL <<100>>
// FINALLY_BLOCK <<finally-block>> -> CONTAINS -> PROPERTY_ACCESS <<reader.locked>>
// PROPERTY_ACCESS <<reader.locked>> -> ASSIGNED_FROM -> LITERAL <<false>>
// PROPERTY_ACCESS <<reader.locked>> -> READS_FROM -> VARIABLE <<reader>>
// @end-annotation
async function* streamChunks(url) {
  const reader = { locked: true };
  try {
    for (let i = 0; i < 10; i++) {
      yield { chunk: i, size: i * 100 };
    }
  } finally {
    reader.locked = false; // MUST run on break/throw/return
  }
}

// @construct PENDING async-iterator-cancel-manual
// @annotation
// FUNCTION <<manualAsyncCancel>> -> CONTAINS -> PARAMETER <<asyncGen>>
// VARIABLE <<iter>> -> ASSIGNED_FROM -> CALL <<asyncGen[Symbol.asyncIterator]()>>
// CALL <<asyncGen[Symbol.asyncIterator]()>> -> CALLS -> PROPERTY_ACCESS <<asyncGen[Symbol.asyncIterator]>>
// PROPERTY_ACCESS <<asyncGen[Symbol.asyncIterator]>> -> READS_FROM -> PARAMETER <<asyncGen>>
// VARIABLE <<first>> -> ASSIGNED_FROM -> CALL <<iter.next()>>
// CALL <<iter.next()>> -> CALLS -> PROPERTY_ACCESS <<iter.next>>
// PROPERTY_ACCESS <<iter.next>> -> READS_FROM -> VARIABLE <<iter>>
// CALL <<iter.return()>> -> CALLS -> PROPERTY_ACCESS <<iter.return>>
// PROPERTY_ACCESS <<iter.return>> -> READS_FROM -> VARIABLE <<iter>>
// FUNCTION <<manualAsyncCancel>> -> RETURNS -> EXPRESSION <<return first>>
// EXPRESSION <<return first>> -> READS_FROM -> VARIABLE <<first>>
// @end-annotation
async function manualAsyncCancel(asyncGen) {
  const iter = asyncGen[Symbol.asyncIterator]();
  const first = await iter.next();
  await iter.return(); // explicitly close, triggers finally
  return first;
}

// @construct PENDING yield-star-return-value
// @annotation
// FUNCTION <<innerWithReturn>> -> YIELDS -> LITERAL <<1>>
// FUNCTION <<innerWithReturn>> -> YIELDS -> LITERAL <<2>>
// FUNCTION <<innerWithReturn>> -> RETURNS -> LITERAL <<'done'>>
// VARIABLE <<result>> -> ASSIGNED_FROM -> EXPRESSION <<yield* innerWithReturn()>>
// EXPRESSION <<yield* innerWithReturn()>> -> DELEGATES_TO -> CALL <<innerWithReturn()>>
// CALL <<innerWithReturn()>> -> CALLS -> FUNCTION <<innerWithReturn>>
// FUNCTION <<outerCapturesReturn>> -> YIELDS -> VARIABLE <<result>>
// @end-annotation
function* innerWithReturn() {
  yield 1;
  yield 2;
  return 'done';                         // return value, NOT yielded
}

function* outerCapturesReturn() {
  const result = yield* innerWithReturn(); // result === 'done'
  yield result;
}

// @construct PENDING for-await-sync-iterable
// @annotation
// FUNCTION <<forAwaitSyncIterable>> -> CONTAINS -> VARIABLE <<results>>
// VARIABLE <<results>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// FUNCTION <<forAwaitSyncIterable>> -> CONTAINS -> LOOP <<for-await>>
// LOOP <<for-await>> -> ITERATES_OVER -> LITERAL <<[1, 2, 3]>>
// LOOP <<for-await>> -> CONTAINS -> VARIABLE <<item>>
// LOOP <<for-await>> -> CONTAINS -> CALL <<results.push(item)>>
// CALL <<results.push(item)>> -> CALLS_ON -> VARIABLE <<results>>
// CALL <<results.push(item)>> -> PASSES_ARGUMENT -> VARIABLE <<item>>
// FUNCTION <<forAwaitSyncIterable>> -> CONTAINS -> EXPRESSION <<return results>>
// EXPRESSION <<return results>> -> READS_FROM -> VARIABLE <<results>>
// FUNCTION <<forAwaitSyncIterable>> -> RETURNS -> EXPRESSION <<return results>>
// @end-annotation
async function forAwaitSyncIterable() {
  const results = [];
  for await (const item of [1, 2, 3]) { // sync array — each value wrapped in Promise
    results.push(item);
  }
  return results;
}

// @construct PENDING async-generator-destructure-default
// @annotation
// FUNCTION <<processStream>> -> HAS_BODY -> PARAMETER <<source>>
// FUNCTION <<processStream>> -> CONTAINS -> LOOP <<for-await-of>>
// LOOP <<for-await-of>> -> ITERATES_OVER -> PARAMETER <<source>>
// LOOP <<for-await-of>> -> CONTAINS -> VARIABLE <<data>>
// LOOP <<for-await-of>> -> CONTAINS -> VARIABLE <<priority>>
// VARIABLE <<priority>> -> DEFAULTS_TO -> LITERAL <<'normal'>>
// EXPRESSION <<{ ...data, priority }>> -> SPREADS_FROM -> VARIABLE <<data>>
// EXPRESSION <<{ ...data, priority }>> -> READS_FROM -> VARIABLE <<priority>>
// EXPRESSION <<yield { ...data, priority }>> -> YIELDS -> EXPRESSION <<{ ...data, priority }>>
// LOOP <<for-await-of>> -> CONTAINS -> EXPRESSION <<yield { ...data, priority }>>
// @end-annotation
async function* processStream(source) {
  for await (const { data, meta: { priority = 'normal' } = {} } of source) {
    yield { ...data, priority };
  }
}

// --- yield in exotic expression positions ---

// @construct PENDING yield-expression-positions
// @annotation
// @end-annotation
function* exoticYield() {
  console.log(yield 'prompt');                 // yield as function argument
  const pair = [yield 'a', yield 'b'];         // yield in array literal
  const msg = `Hello ${yield 'name'}!`;        // yield in template literal
  const val = (yield 'check') ? 'yes' : 'no'; // yield in ternary condition
  const obj = { x: yield 'x', y: yield 'y' }; // yield in object literal
}

// --- yield yield (chained) ---

// @construct PENDING yield-yield-chained
// @annotation
// FUNCTION <<chainedYield>> -> CONTAINS -> VARIABLE <<result>>
// FUNCTION <<chainedYield>> -> CONTAINS -> EXPRESSION <<yield yield 1>>
// VARIABLE <<result>> -> ASSIGNED_FROM -> EXPRESSION <<yield yield 1>>
// EXPRESSION <<yield yield 1>> -> CONTAINS -> EXPRESSION <<outer-yield>>
// EXPRESSION <<outer-yield>> -> YIELDS -> EXPRESSION <<inner-yield>>
// EXPRESSION <<inner-yield>> -> YIELDS -> LITERAL <<1>>
// FUNCTION <<chainedYield>> -> RETURNS -> VARIABLE <<result>>
// @end-annotation
function* chainedYield() {
  const result = yield yield 1; // two suspension points in one expression
  // Step 1: yields 1, suspends
  // Step 2: .next(x) resumes, yields x, suspends again
  // Step 3: .next(y) resumes, result = y
  return result;
}

// --- async destructuring with await in defaults ---

// @construct PENDING async-destructure-await-default
// @annotation
// FUNCTION <<getConfigValue>> -> CONTAINS -> PARAMETER <<key>>
// FUNCTION <<getConfigValue>> -> RETURNS -> PARAMETER <<key>>
// VARIABLE <<asyncDestructureHandler>> -> ASSIGNED_FROM -> FUNCTION <<asyncDestructureHandler:fn>>
// FUNCTION <<asyncDestructureHandler:fn>> -> CONTAINS -> PARAMETER <<destructured-param>>
// PARAMETER <<destructured-param>> -> HAS_PROPERTY -> PROPERTY <<timeout>>
// PARAMETER <<destructured-param>> -> HAS_PROPERTY -> PROPERTY <<retries>>
// PROPERTY <<timeout>> -> DEFAULTS_TO -> CALL <<getConfigValue('timeout')>>
// PROPERTY <<retries>> -> DEFAULTS_TO -> CALL <<getConfigValue('retries')>>
// CALL <<getConfigValue('timeout')>> -> CALLS -> FUNCTION <<getConfigValue>>
// CALL <<getConfigValue('timeout')>> -> PASSES_ARGUMENT -> LITERAL <<'timeout'>>
// CALL <<getConfigValue('retries')>> -> CALLS -> FUNCTION <<getConfigValue>>
// CALL <<getConfigValue('retries')>> -> PASSES_ARGUMENT -> LITERAL <<'retries'>>
// FUNCTION <<asyncDestructureHandler:fn>> -> RETURNS -> EXPRESSION <<{ timeout, retries }>>
// EXPRESSION <<{ timeout, retries }>> -> READS_FROM -> PROPERTY <<timeout>>
// EXPRESSION <<{ timeout, retries }>> -> READS_FROM -> PROPERTY <<retries>>
// CALL <<getConfigValue('timeout')>> -> AWAITS -> PROPERTY <<timeout>>
// CALL <<getConfigValue('retries')>> -> AWAITS -> PROPERTY <<retries>>
// @end-annotation
async function getConfigValue(key) { return key; }

const asyncDestructureHandler = async ({
  timeout = await getConfigValue('timeout'),
  retries = await getConfigValue('retries'),
} = {}) => {
  return { timeout, retries };
};

// @construct PENDING generator-throw-injection
// @annotation
// @end-annotation
function* resilientGenerator() {
  try {
    const x = yield 'ready';
    return x * 2;
  } catch (err) {
    // Catch point — triggered by gen.throw(), NOT a throw inside the body.
    // The error appears AT the yield site, routing execution here.
    yield `recovered: ${err.message}`;
    return -1;
  }
}

function demonstrateThrow() {
  const gen = resilientGenerator();
  gen.next();                          // → { value: 'ready', done: false }
  return gen.throw(new Error('injected'));
  // → { value: 'recovered: injected', done: false }
}

// @construct PENDING await-multi-subexpression
async function awaitMultiSubexpression(getA, getB, fetchSuccess, fetchFallback) {
  // Multiple awaits in a single BinaryExpression — sequential, not concurrent
  const sum = (await getA()) + (await getB());

  // Await in conditional expression
  const flag = true;
  const result = flag
    ? await fetchSuccess()
    : await fetchFallback();

  // Await in array literal — sequential, NOT Promise.all
  const all = [await getA(), await getB()];

  // Await as function argument — sequential
  function merge(a, b) { return { ...a, ...b }; }
  const combined = merge(await getA(), await getB());

  return { sum, result, all, combined };
}

// @construct PENDING export-named-list
export {
  fetchData,
  fetchWithErrorHandling,
  createPromise,
  promiseCombinators,
  promiseChaining,
  asyncArrow,
  asyncArrowWithParams,
  counter,
  fibonacci,
  innerGenerator,
  outerGenerator,
  asyncCounter,
  consumeAsyncIterable,
  config,
  accumulator,
  generatorReturnThrow,
  manualAsyncIteration,
  returnsThenable,
  nestedThenable,
  observer,
  resourceGenerator,
  consumeWithBreak,
  trickyFinally,
  streamChunks,
  manualAsyncCancel,
  innerWithReturn,
  outerCapturesReturn,
  forAwaitSyncIterable,
  processStream,
  exoticYield,
  chainedYield,
  getConfigValue,
  asyncDestructureHandler,
  resilientGenerator,
  demonstrateThrow,
  awaitMultiSubexpression,
};
