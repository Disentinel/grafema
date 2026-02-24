// =============================================================================
// iterators.js — Custom Iterables, Iterator Protocol, Async Iterables
// =============================================================================

// --- Custom iterable ---

// @construct PENDING iter-custom-iterable
// @annotation
// @end-annotation
class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }

  [Symbol.iterator]() {
    let current = this.start;
    const end = this.end;
    return {
      next() {
        if (current <= end) {
          return { value: current++, done: false };
        }
        return { value: undefined, done: true };
      },
    };
  }
}

// @construct PENDING iter-usage-for-of
// @annotation
// FUNCTION <<consumeRange>> -> CONTAINS -> PARAMETER <<start>>
// FUNCTION <<consumeRange>> -> CONTAINS -> PARAMETER <<end>>
// FUNCTION <<consumeRange>> -> CONTAINS -> VARIABLE <<range>>
// VARIABLE <<range>> -> ASSIGNED_FROM -> CALL <<new Range(start, end)>>
// CALL <<new Range(start, end)>> -> PASSES_ARGUMENT -> PARAMETER <<start>>
// CALL <<new Range(start, end)>> -> PASSES_ARGUMENT -> PARAMETER <<end>>
// FUNCTION <<consumeRange>> -> CONTAINS -> VARIABLE <<values>>
// VARIABLE <<values>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// FUNCTION <<consumeRange>> -> CONTAINS -> LOOP <<for-of>>
// LOOP <<for-of>> -> ITERATES_OVER -> VARIABLE <<range>>
// LOOP <<for-of>> -> CONTAINS -> VARIABLE <<n>>
// LOOP <<for-of>> -> CONTAINS -> CALL <<values.push(n)>>
// CALL <<values.push(n)>> -> PASSES_ARGUMENT -> VARIABLE <<n>>
// FUNCTION <<consumeRange>> -> RETURNS -> VARIABLE <<values>>
// @end-annotation
function consumeRange(start, end) {
  const range = new Range(start, end);
  const values = [];
  for (const n of range) {
    values.push(n);
  }
  return values;
}

// @construct PENDING iter-usage-spread
// @annotation
// FUNCTION <<spreadRange>> -> CONTAINS -> PARAMETER <<start>>
// FUNCTION <<spreadRange>> -> CONTAINS -> PARAMETER <<end>>
// FUNCTION <<spreadRange>> -> RETURNS -> EXPRESSION <<...new Range(start, end)>>
// EXPRESSION <<...new Range(start, end)>> -> SPREADS_FROM -> CALL <<new Range(start, end)>>
// EXPRESSION <<...new Range(start, end)>> -> HAS_ELEMENT -> LITERAL <<[]>>
// CALL <<new Range(start, end)>> -> PASSES_ARGUMENT -> PARAMETER <<start>>
// CALL <<new Range(start, end)>> -> PASSES_ARGUMENT -> PARAMETER <<end>>
// @end-annotation
function spreadRange(start, end) {
  return [...new Range(start, end)];
}

// @construct PENDING iter-usage-destructuring
function destructureRange(start, end) {
  const [first, second, ...rest] = new Range(start, end);
  return { first, second, rest };
}

// --- Iterator protocol manual ---

// @construct PENDING iter-manual-next
// @annotation
// FUNCTION <<manualIteration>> -> CONTAINS -> PARAMETER <<iterable>>
// FUNCTION <<manualIteration>> -> CONTAINS -> VARIABLE <<iterator>>
// VARIABLE <<iterator>> -> ASSIGNED_FROM -> CALL <<iterable[Symbol.iterator]()>>
// CALL <<iterable[Symbol.iterator]()>> -> CALLS -> PROPERTY_ACCESS <<iterable[Symbol.iterator]>>
// PROPERTY_ACCESS <<iterable[Symbol.iterator]>> -> READS_FROM -> PARAMETER <<iterable>>
// FUNCTION <<manualIteration>> -> CONTAINS -> VARIABLE <<results>>
// VARIABLE <<results>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// FUNCTION <<manualIteration>> -> CONTAINS -> VARIABLE <<step>>
// VARIABLE <<step>> -> ASSIGNED_FROM -> CALL <<iterator.next()>>
// CALL <<iterator.next()>> -> READS_FROM -> VARIABLE <<iterator>>
// FUNCTION <<manualIteration>> -> CONTAINS -> LOOP <<while>>
// LOOP <<while>> -> HAS_CONDITION -> EXPRESSION <<!step.done>>
// EXPRESSION <<!step.done>> -> READS_FROM -> PROPERTY_ACCESS <<step.done>>
// PROPERTY_ACCESS <<step.done>> -> READS_FROM -> VARIABLE <<step>>
// LOOP <<while>> -> CONTAINS -> CALL <<results.push(step.value)>>
// CALL <<results.push(step.value)>> -> READS_FROM -> VARIABLE <<results>>
// CALL <<results.push(step.value)>> -> PASSES_ARGUMENT -> PROPERTY_ACCESS <<step.value>>
// PROPERTY_ACCESS <<step.value>> -> READS_FROM -> VARIABLE <<step>>
// LOOP <<while>> -> CONTAINS -> EXPRESSION <<step = iterator.next()>>
// EXPRESSION <<step = iterator.next()>> -> WRITES_TO -> VARIABLE <<step>>
// EXPRESSION <<step = iterator.next()>> -> READS_FROM -> CALL <<iterator.next()#2>>
// CALL <<iterator.next()#2>> -> READS_FROM -> VARIABLE <<iterator>>
// FUNCTION <<manualIteration>> -> RETURNS -> VARIABLE <<results>>
// @end-annotation
function manualIteration(iterable) {
  const iterator = iterable[Symbol.iterator]();
  const results = [];
  let step = iterator.next();
  while (!step.done) {
    results.push(step.value);
    step = iterator.next();
  }
  return results;
}

// --- Iterator with return() ---

// @construct PENDING iter-return-cleanup
// @annotation
// @end-annotation
function createCleanupIterator(items) {
  let index = 0;
  let cleaned = false;
  return {
    [Symbol.iterator]() { return this; },
    next() {
      if (index < items.length) {
        return { value: items[index++], done: false };
      }
      return { value: undefined, done: true };
    },
    return() {
      cleaned = true;
      return { value: undefined, done: true };
    },
    wasCleaned() { return cleaned; },
  };
}

// --- Infinite iterator ---

// @construct PENDING for-of-break-iterator-return
// @annotation
// FUNCTION <<naturals>> -> CONTAINS -> VARIABLE <<n>>
// VARIABLE <<n>> -> ASSIGNED_FROM -> LITERAL <<1>>
// FUNCTION <<naturals>> -> RETURNS -> EXPRESSION <<object-literal>>
// EXPRESSION <<object-literal>> -> HAS_PROPERTY -> METHOD <<[Symbol.iterator]>>
// EXPRESSION <<object-literal>> -> HAS_PROPERTY -> METHOD <<next>>
// METHOD <<[Symbol.iterator]>> -> RETURNS -> EXPRESSION <<object-literal>>
// METHOD <<next>> -> RETURNS -> EXPRESSION <<return-object>>
// EXPRESSION <<return-object>> -> HAS_PROPERTY -> EXPRESSION <<n++>>
// EXPRESSION <<return-object>> -> HAS_PROPERTY -> LITERAL <<false>>
// EXPRESSION <<n++>> -> READS_FROM -> VARIABLE <<n>>
// EXPRESSION <<n++>> -> WRITES_TO -> VARIABLE <<n>>
// @end-annotation
// break in for-of triggers .return() on the underlying iterator
function consumeWithCleanup(items) {
  const resourceIter = {
    [Symbol.iterator]() {
      let i = 0;
      let returnCalled = false;
      return {
        next() {
          return i < items.length
            ? { value: items[i++], done: false }
            : { value: undefined, done: true };
        },
        return(value) {
          returnCalled = true; // implicitly called by break, throw, return
          return { value, done: true };
        },
        wasReturnCalled() { return returnCalled; },
      };
    },
  };

  let found = null;
  for (const item of resourceIter) {
    if (item > 3) {
      found = item;
      break;  // ← this triggers .return() on the iterator object
    }
  }
  return found;
}

// @construct PENDING iter-infinite
// @annotation
// @end-annotation
function naturals() {
  let n = 1;
  return {
    [Symbol.iterator]() { return this; },
    next() {
      return { value: n++, done: false };
    },
  };
}

// @construct PENDING iter-take
function take(iterable, count) {
  const result = [];
  let i = 0;
  for (const value of iterable) {
    if (i++ >= count) break;
    result.push(value);
  }
  return result;
}

// --- Generator as iterable ---

// @construct PENDING iter-generator-iterable
// @annotation
// FUNCTION <<consumeAsyncRange>> -> CONTAINS -> PARAMETER <<start>>
// FUNCTION <<consumeAsyncRange>> -> CONTAINS -> PARAMETER <<end>>
// FUNCTION <<consumeAsyncRange>> -> CONTAINS -> VARIABLE <<values>>
// VARIABLE <<values>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// FUNCTION <<consumeAsyncRange>> -> CONTAINS -> LOOP <<for-await>>
// LOOP <<for-await>> -> ITERATES_OVER -> CALL <<new AsyncRange(start, end, 0)>>
// LOOP <<for-await>> -> CONTAINS -> VARIABLE <<n>>
// CALL <<new AsyncRange(start, end, 0)>> -> PASSES_ARGUMENT -> PARAMETER <<start>>
// CALL <<new AsyncRange(start, end, 0)>> -> PASSES_ARGUMENT -> PARAMETER <<end>>
// CALL <<new AsyncRange(start, end, 0)>> -> PASSES_ARGUMENT -> LITERAL <<0>>
// LOOP <<for-await>> -> HAS_BODY -> CALL <<values.push(n)>>
// CALL <<values.push(n)>> -> CALLS -> PROPERTY_ACCESS <<values.push>>
// CALL <<values.push(n)>> -> PASSES_ARGUMENT -> VARIABLE <<n>>
// PROPERTY_ACCESS <<values.push>> -> READS_FROM -> VARIABLE <<values>>
// FUNCTION <<consumeAsyncRange>> -> RETURNS -> VARIABLE <<values>>
// @end-annotation
function* rangeGenerator(start, end) {
  for (let i = start; i <= end; i++) {
    yield i;
  }
}

// --- Custom async iterable ---

// @construct PENDING iter-async-iterable
// @annotation
// FUNCTION <<asyncMap>> -> HAS_BODY -> PARAMETER <<iterable>>
// FUNCTION <<asyncMap>> -> HAS_BODY -> PARAMETER <<fn>>
// FUNCTION <<asyncMap>> -> HAS_BODY -> LOOP <<for-await-of>>
// LOOP <<for-await-of>> -> ITERATES_OVER -> PARAMETER <<iterable>>
// LOOP <<for-await-of>> -> CONTAINS -> VARIABLE <<item>>
// LOOP <<for-await-of>> -> HAS_BODY -> EXPRESSION <<yield fn(item)>>
// CALL <<fn(item)>> -> CALLS -> PARAMETER <<fn>>
// CALL <<fn(item)>> -> PASSES_ARGUMENT -> VARIABLE <<item>>
// EXPRESSION <<yield fn(item)>> -> YIELDS -> CALL <<fn(item)>>
// FUNCTION <<asyncMap>> -> YIELDS -> EXPRESSION <<yield fn(item)>>
// @end-annotation
class AsyncRange {
  constructor(start, end, delayMs = 10) {
    this.start = start;
    this.end = end;
    this.delayMs = delayMs;
  }

  [Symbol.asyncIterator]() {
    let current = this.start;
    const end = this.end;
    const delay = this.delayMs;
    return {
      async next() {
        if (current <= end) {
          await new Promise(r => setTimeout(r, delay));
          return { value: current++, done: false };
        }
        return { value: undefined, done: true };
      },
    };
  }
}

// @construct PENDING iter-async-for-await
// @annotation
// FUNCTION <<filterIter>> -> CONTAINS -> PARAMETER <<iterable>>
// FUNCTION <<filterIter>> -> CONTAINS -> PARAMETER <<predicate>>
// FUNCTION <<filterIter>> -> CONTAINS -> LOOP <<for-of>>
// LOOP <<for-of>> -> ITERATES_OVER -> PARAMETER <<iterable>>
// LOOP <<for-of>> -> CONTAINS -> VARIABLE <<item>>
// LOOP <<for-of>> -> CONTAINS -> BRANCH <<if-predicate>>
// BRANCH <<if-predicate>> -> HAS_CONDITION -> CALL <<predicate(item)>>
// CALL <<predicate(item)>> -> CALLS -> PARAMETER <<predicate>>
// CALL <<predicate(item)>> -> PASSES_ARGUMENT -> VARIABLE <<item>>
// BRANCH <<if-predicate>> -> HAS_CONSEQUENT -> EXPRESSION <<yield item>>
// EXPRESSION <<yield item>> -> YIELDS -> VARIABLE <<item>>
// @end-annotation
async function consumeAsyncRange(start, end) {
  const values = [];
  for await (const n of new AsyncRange(start, end, 0)) {
    values.push(n);
  }
  return values;
}

// --- Async generator as async iterable ---

// @construct PENDING iter-async-generator
// @annotation
// @end-annotation
async function* asyncMap(iterable, fn) {
  for await (const item of iterable) {
    yield fn(item);
  }
}

// --- Composable iterators ---

// @construct PENDING iter-compose-map
// @annotation
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<Range>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<consumeRange>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<spreadRange>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<destructureRange>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<manualIteration>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<createCleanupIterator>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<naturals>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<take>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<rangeGenerator>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<AsyncRange>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<consumeAsyncRange>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<asyncMap>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<mapIter>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<filterIter>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<chainIter>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<zipIter>>
// @end-annotation
function* mapIter(iterable, fn) {
  for (const item of iterable) {
    yield fn(item);
  }
}

// @construct PENDING iter-compose-filter
function* filterIter(iterable, predicate) {
  for (const item of iterable) {
    if (predicate(item)) yield item;
  }
}

// @construct PENDING iter-compose-chain
function* chainIter(...iterables) {
  for (const iterable of iterables) {
    yield* iterable;
  }
}

// @construct PENDING iter-compose-zip
function* zipIter(a, b) {
  const iterA = a[Symbol.iterator]();
  const iterB = b[Symbol.iterator]();
  while (true) {
    const stepA = iterA.next();
    const stepB = iterB.next();
    if (stepA.done || stepB.done) return;
    yield [stepA.value, stepB.value];
  }
}

// @construct PENDING export-named-list
export {
  Range,
  consumeRange,
  spreadRange,
  destructureRange,
  manualIteration,
  createCleanupIterator,
  naturals,
  take,
  rangeGenerator,
  AsyncRange,
  consumeAsyncRange,
  asyncMap,
  mapIter,
  filterIter,
  chainIter,
  zipIter,
  consumeWithCleanup,
};
