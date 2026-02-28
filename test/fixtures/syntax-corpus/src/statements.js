// =============================================================================
// statements.js — Control Flow, Loops, Exception Handling
// =============================================================================

// @construct PENDING if-basic
// @annotation
// FUNCTION <<ifStatement>> -> CONTAINS -> PARAMETER <<x>>
// FUNCTION <<ifStatement>> -> CONTAINS -> BRANCH <<if-branch>>
// BRANCH <<if-branch>> -> HAS_CONDITION -> EXPRESSION <<x > 0>>
// EXPRESSION <<x > 0>> -> READS_FROM -> PARAMETER <<x>>
// EXPRESSION <<x > 0>> -> READS_FROM -> LITERAL <<0>>
// BRANCH <<if-branch>> -> HAS_CONSEQUENT -> LITERAL <<'positive'>>
// FUNCTION <<ifStatement>> -> RETURNS -> LITERAL <<'positive'>>
// FUNCTION <<ifStatement>> -> RETURNS -> LITERAL <<'non-positive'>>
// @end-annotation
function ifStatement(x) {
  if (x > 0) {
    return 'positive';
  }
  return 'non-positive';
}

// @construct PENDING if-else
// @annotation
// FUNCTION <<ifElseStatement>> -> CONTAINS -> PARAMETER <<x>>
// FUNCTION <<ifElseStatement>> -> CONTAINS -> BRANCH <<if-else>>
// BRANCH <<if-else>> -> HAS_CONDITION -> EXPRESSION <<x > 0>>
// EXPRESSION <<x > 0>> -> READS_FROM -> PARAMETER <<x>>
// EXPRESSION <<x > 0>> -> READS_FROM -> LITERAL <<0>>
// BRANCH <<if-else>> -> HAS_CONSEQUENT -> LITERAL <<'positive'>>
// BRANCH <<if-else>> -> HAS_ALTERNATE -> LITERAL <<'non-positive'>>
// FUNCTION <<ifElseStatement>> -> RETURNS -> LITERAL <<'positive'>>
// FUNCTION <<ifElseStatement>> -> RETURNS -> LITERAL <<'non-positive'>>
// @end-annotation
function ifElseStatement(x) {
  if (x > 0) {
    return 'positive';
  } else {
    return 'non-positive';
  }
}

// @construct PENDING if-else-if-chain
// @annotation
// FUNCTION <<ifElseIfChain>> -> CONTAINS -> PARAMETER <<x>>
// FUNCTION <<ifElseIfChain>> -> CONTAINS -> BRANCH <<if-x>0>>
// BRANCH <<if-x>0>> -> HAS_CONDITION -> EXPRESSION <<x > 0>>
// EXPRESSION <<x > 0>> -> READS_FROM -> PARAMETER <<x>>
// EXPRESSION <<x > 0>> -> READS_FROM -> LITERAL <<0-first>>
// BRANCH <<if-x>0>> -> HAS_CONSEQUENT -> LITERAL <<'positive'>>
// FUNCTION <<ifElseIfChain>> -> RETURNS -> LITERAL <<'positive'>>
// BRANCH <<if-x>0>> -> HAS_ALTERNATE -> BRANCH <<else-if-x<0>>
// BRANCH <<else-if-x<0>> -> HAS_CONDITION -> EXPRESSION <<x < 0>>
// EXPRESSION <<x < 0>> -> READS_FROM -> PARAMETER <<x>>
// EXPRESSION <<x < 0>> -> READS_FROM -> LITERAL <<0-second>>
// BRANCH <<else-if-x<0>> -> HAS_CONSEQUENT -> LITERAL <<'negative'>>
// FUNCTION <<ifElseIfChain>> -> RETURNS -> LITERAL <<'negative'>>
// BRANCH <<else-if-x<0>> -> HAS_ALTERNATE -> BRANCH <<else>>
// BRANCH <<else>> -> HAS_CONSEQUENT -> LITERAL <<'zero'>>
// FUNCTION <<ifElseIfChain>> -> RETURNS -> LITERAL <<'zero'>>
// @end-annotation
function ifElseIfChain(x) {
  if (x > 0) {
    return 'positive';
  } else if (x < 0) {
    return 'negative';
  } else {
    return 'zero';
  }
}

// @construct PENDING switch-break
// @annotation
// FUNCTION <<switchWithBreak>> -> CONTAINS -> PARAMETER <<action>>
// FUNCTION <<switchWithBreak>> -> CONTAINS -> VARIABLE <<result>>
// FUNCTION <<switchWithBreak>> -> CONTAINS -> BRANCH <<switch>>
// BRANCH <<switch>> -> HAS_CONDITION -> PARAMETER <<action>>
// BRANCH <<switch>> -> HAS_CASE -> CASE <<case-start>>
// BRANCH <<switch>> -> HAS_CASE -> CASE <<case-stop>>
// BRANCH <<switch>> -> HAS_DEFAULT -> CASE <<default-case>>
// CASE <<case-start>> -> HAS_CONDITION -> LITERAL <<'start'>>
// CASE <<case-start>> -> WRITES_TO -> VARIABLE <<result>>
// VARIABLE <<result>> -> ASSIGNED_FROM -> LITERAL <<'starting'>>
// CASE <<case-stop>> -> HAS_CONDITION -> LITERAL <<'stop'>>
// CASE <<case-stop>> -> WRITES_TO -> VARIABLE <<result>>
// VARIABLE <<result>> -> ASSIGNED_FROM -> LITERAL <<'stopping'>>
// CASE <<default-case>> -> WRITES_TO -> VARIABLE <<result>>
// VARIABLE <<result>> -> ASSIGNED_FROM -> LITERAL <<'unknown'>>
// FUNCTION <<switchWithBreak>> -> RETURNS -> VARIABLE <<result>>
// @end-annotation
function switchWithBreak(action) {
  let result;
  switch (action) {
    case 'start':
      result = 'starting';
      break;
    case 'stop':
      result = 'stopping';
      break;
    default:
      result = 'unknown';
  }
  return result;
}

// @construct PENDING switch-return-fallthrough
// @annotation
// FUNCTION <<switchWithReturn>> -> CONTAINS -> PARAMETER <<action>>
// FUNCTION <<switchWithReturn>> -> CONTAINS -> BRANCH <<switch>>
// BRANCH <<switch>> -> HAS_CONDITION -> PARAMETER <<action>>
// BRANCH <<switch>> -> HAS_CASE -> CASE <<case-start>>
// BRANCH <<switch>> -> HAS_CASE -> CASE <<case-stop>>
// BRANCH <<switch>> -> HAS_CASE -> CASE <<case-pause>>
// BRANCH <<switch>> -> HAS_CASE -> CASE <<case-suspend>>
// BRANCH <<switch>> -> HAS_DEFAULT -> CASE <<default>>
// CASE <<case-start>> -> HAS_CONDITION -> LITERAL <<'start'>>
// CASE <<case-start>> -> RETURNS -> LITERAL <<'starting'>>
// CASE <<case-stop>> -> HAS_CONDITION -> LITERAL <<'stop'>>
// CASE <<case-stop>> -> RETURNS -> LITERAL <<'stopping'>>
// CASE <<case-pause>> -> HAS_CONDITION -> LITERAL <<'pause'>>
// CASE <<case-suspend>> -> HAS_CONDITION -> LITERAL <<'suspend'>>
// CASE <<case-pause>> -> FLOWS_INTO -> CASE <<case-suspend>>
// CASE <<case-suspend>> -> RETURNS -> LITERAL <<'pausing'>>
// CASE <<default>> -> RETURNS -> LITERAL <<'unknown'>>
// @end-annotation
function switchWithReturn(action) {
  switch (action) {
    case 'start':
      return 'starting';
    case 'stop':
      return 'stopping';
    case 'pause':
    case 'suspend':
      return 'pausing';
    default:
      return 'unknown';
  }
}

// @construct PENDING for-classic
// @annotation
// FUNCTION <<classicFor>> -> CONTAINS -> VARIABLE <<results>>
// VARIABLE <<results>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// FUNCTION <<classicFor>> -> CONTAINS -> LOOP <<for-classic>>
// LOOP <<for-classic>> -> HAS_INIT -> VARIABLE <<i>>
// VARIABLE <<i>> -> ASSIGNED_FROM -> LITERAL <<0>>
// LOOP <<for-classic>> -> HAS_CONDITION -> EXPRESSION <<i < 10>>
// EXPRESSION <<i < 10>> -> READS_FROM -> VARIABLE <<i>>
// EXPRESSION <<i < 10>> -> READS_FROM -> LITERAL <<10>>
// LOOP <<for-classic>> -> HAS_UPDATE -> EXPRESSION <<i++>>
// EXPRESSION <<i++>> -> MODIFIES -> VARIABLE <<i>>
// LOOP <<for-classic>> -> HAS_BODY -> CALL <<results.push(i)>>
// CALL <<results.push(i)>> -> CALLS -> PROPERTY_ACCESS <<results.push>>
// PROPERTY_ACCESS <<results.push>> -> READS_FROM -> VARIABLE <<results>>
// CALL <<results.push(i)>> -> PASSES_ARGUMENT -> VARIABLE <<i>>
// FUNCTION <<classicFor>> -> RETURNS -> VARIABLE <<results>>
// @end-annotation
function classicFor() {
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(i);
  }
  return results;
}

// @construct PENDING for-in
// @annotation
// FUNCTION <<forIn>> -> CONTAINS -> PARAMETER <<obj>>
// FUNCTION <<forIn>> -> CONTAINS -> VARIABLE <<keys>>
// VARIABLE <<keys>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// FUNCTION <<forIn>> -> CONTAINS -> LOOP <<for-in>>
// LOOP <<for-in>> -> ITERATES_OVER -> PARAMETER <<obj>>
// LOOP <<for-in>> -> CONTAINS -> VARIABLE <<key>>
// FUNCTION <<forIn>> -> CONTAINS -> CALL <<keys.push(key)>>
// CALL <<keys.push(key)>> -> CALLS_ON -> VARIABLE <<keys>>
// CALL <<keys.push(key)>> -> PASSES_ARGUMENT -> VARIABLE <<key>>
// FUNCTION <<forIn>> -> RETURNS -> VARIABLE <<keys>>
// @end-annotation
function forIn(obj) {
  const keys = [];
  for (const key in obj) {
    keys.push(key);
  }
  return keys;
}

// @construct PENDING for-of
// @annotation
// FUNCTION <<forOf>> -> CONTAINS -> PARAMETER <<iterable>>
// FUNCTION <<forOf>> -> DECLARES -> VARIABLE <<values>>
// VARIABLE <<values>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// FUNCTION <<forOf>> -> CONTAINS -> LOOP <<for-of>>
// LOOP <<for-of>> -> ITERATES_OVER -> PARAMETER <<iterable>>
// LOOP <<for-of>> -> CONTAINS -> VARIABLE <<item>>
// LOOP <<for-of>> -> CONTAINS -> CALL <<values.push(item)>>
// CALL <<values.push(item)>> -> CALLS -> PROPERTY_ACCESS <<values.push>>
// PROPERTY_ACCESS <<values.push>> -> READS_FROM -> VARIABLE <<values>>
// CALL <<values.push(item)>> -> PASSES_ARGUMENT -> VARIABLE <<item>>
// FUNCTION <<forOf>> -> RETURNS -> VARIABLE <<values>>
// @end-annotation
function forOf(iterable) {
  const values = [];
  for (const item of iterable) {
    values.push(item);
  }
  return values;
}

// @construct PENDING for-of-destructuring
// @annotation
// FUNCTION <<forOfDestructuring>> -> CONTAINS -> PARAMETER <<entries>>
// FUNCTION <<forOfDestructuring>> -> CONTAINS -> VARIABLE <<result>>
// VARIABLE <<result>> -> ASSIGNED_FROM -> LITERAL <<{}>>
// FUNCTION <<forOfDestructuring>> -> CONTAINS -> LOOP <<for-of>>
// LOOP <<for-of>> -> ITERATES_OVER -> PARAMETER <<entries>>
// LOOP <<for-of>> -> CONTAINS -> VARIABLE <<key>>
// LOOP <<for-of>> -> CONTAINS -> VARIABLE <<value>>
// LOOP <<for-of>> -> CONTAINS -> EXPRESSION <<result[key] = value>>
// EXPRESSION <<result[key] = value>> -> WRITES_TO -> PROPERTY_ACCESS <<result[key]>>
// EXPRESSION <<result[key] = value>> -> READS_FROM -> VARIABLE <<value>>
// PROPERTY_ACCESS <<result[key]>> -> READS_FROM -> VARIABLE <<result>>
// PROPERTY_ACCESS <<result[key]>> -> READS_FROM -> VARIABLE <<key>>
// FUNCTION <<forOfDestructuring>> -> RETURNS -> VARIABLE <<result>>
// @end-annotation
function forOfDestructuring(entries) {
  const result = {};
  for (const [key, value] of entries) {
    result[key] = value;
  }
  return result;
}

// @construct PENDING while
// @annotation
// FUNCTION <<whileLoop>> -> DECLARES -> VARIABLE <<count>>
// VARIABLE <<count>> -> ASSIGNED_FROM -> LITERAL <<0>>
// FUNCTION <<whileLoop>> -> CONTAINS -> LOOP <<while>>
// LOOP <<while>> -> HAS_CONDITION -> EXPRESSION <<count < 5>>
// EXPRESSION <<count < 5>> -> READS_FROM -> VARIABLE <<count>>
// EXPRESSION <<count < 5>> -> READS_FROM -> LITERAL <<5>>
// LOOP <<while>> -> HAS_BODY -> EXPRESSION <<count++>>
// EXPRESSION <<count++>> -> MODIFIES -> VARIABLE <<count>>
// FUNCTION <<whileLoop>> -> RETURNS -> VARIABLE <<count>>
// @end-annotation
function whileLoop() {
  let count = 0;
  while (count < 5) {
    count++;
  }
  return count;
}

// @construct PENDING do-while
// @annotation
// FUNCTION <<doWhileLoop>> -> CONTAINS -> VARIABLE <<attempts>>
// VARIABLE <<attempts>> -> ASSIGNED_FROM -> LITERAL <<0>>
// FUNCTION <<doWhileLoop>> -> CONTAINS -> LOOP <<do-while>>
// LOOP <<do-while>> -> HAS_BODY -> EXPRESSION <<attempts++>>
// LOOP <<do-while>> -> HAS_CONDITION -> EXPRESSION <<attempts < 3>>
// EXPRESSION <<attempts++>> -> MODIFIES -> VARIABLE <<attempts>>
// EXPRESSION <<attempts < 3>> -> READS_FROM -> VARIABLE <<attempts>>
// EXPRESSION <<attempts < 3>> -> READS_FROM -> LITERAL <<3>>
// FUNCTION <<doWhileLoop>> -> RETURNS -> VARIABLE <<attempts>>
// @end-annotation
function doWhileLoop() {
  let attempts = 0;
  do {
    attempts++;
  } while (attempts < 3);
  return attempts;
}

// @construct PENDING try-catch
// @annotation
// FUNCTION <<tryCatch>> -> CONTAINS -> TRY_BLOCK <<try-block>>
// FUNCTION <<tryCatch>> -> CONTAINS -> CATCH_BLOCK <<catch-block>>
// TRY_BLOCK <<try-block>> -> HAS_CATCH -> CATCH_BLOCK <<catch-block>>
// CATCH_BLOCK <<catch-block>> -> CONTAINS -> PARAMETER <<error>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> CALL <<JSON.parse('invalid')>>
// CALL <<JSON.parse('invalid')>> -> CALLS -> EXTERNAL <<JSON.parse>>
// CALL <<JSON.parse('invalid')>> -> PASSES_ARGUMENT -> LITERAL <<'invalid'>>
// CALL <<JSON.parse('invalid')>> -> THROWS -> CATCH_BLOCK <<catch-block>>
// CATCH_BLOCK <<catch-block>> -> CONTAINS -> CALL <<console.error(error.message)>>
// CALL <<console.error(error.message)>> -> CALLS -> EXTERNAL <<console.error>>
// CALL <<console.error(error.message)>> -> PASSES_ARGUMENT -> PROPERTY_ACCESS <<error.message>>
// PROPERTY_ACCESS <<error.message>> -> READS_FROM -> PARAMETER <<error>>
// @end-annotation
function tryCatch() {
  try {
    JSON.parse('invalid');
  } catch (error) {
    console.error(error.message);
  }
}

// @construct PENDING try-catch-finally
// @annotation
// FUNCTION <<tryCatchFinally>> -> CONTAINS -> VARIABLE <<resource>>
// FUNCTION <<tryCatchFinally>> -> CONTAINS -> TRY_BLOCK <<try-block>>
// FUNCTION <<tryCatchFinally>> -> HAS_CATCH -> CATCH_BLOCK <<catch-block>>
// FUNCTION <<tryCatchFinally>> -> HAS_FINALLY -> FINALLY_BLOCK <<finally-block>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> CALL <<openResource()>>
// VARIABLE <<resource>> -> ASSIGNED_FROM -> CALL <<openResource()>>
// CATCH_BLOCK <<catch-block>> -> CONTAINS -> PARAMETER <<error>>
// CATCH_BLOCK <<catch-block>> -> CONTAINS -> CALL <<handleError(error)>>
// CALL <<handleError(error)>> -> PASSES_ARGUMENT -> PARAMETER <<error>>
// FINALLY_BLOCK <<finally-block>> -> CONTAINS -> CALL <<cleanup(resource)>>
// CALL <<cleanup(resource)>> -> PASSES_ARGUMENT -> VARIABLE <<resource>>
// @end-annotation
function tryCatchFinally() {
  let resource;
  try {
    resource = openResource();
  } catch (error) {
    handleError(error);
  } finally {
    cleanup(resource);
  }
}

// @construct PENDING try-finally
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<tryFinally>>
// FUNCTION <<tryFinally>> -> CONTAINS -> TRY_BLOCK <<try-block>>
// FUNCTION <<tryFinally>> -> CONTAINS -> FINALLY_BLOCK <<finally-block>>
// TRY_BLOCK <<try-block>> -> HAS_BODY -> CALL <<doSomething()>>
// FINALLY_BLOCK <<finally-block>> -> HAS_BODY -> CALL <<alwaysRun()>>
// TRY_BLOCK <<try-block>> -> FLOWS_INTO -> FINALLY_BLOCK <<finally-block>>
// CALL <<doSomething()>> -> CALLS -> UNKNOWN <<doSomething>>
// CALL <<alwaysRun()>> -> CALLS -> UNKNOWN <<alwaysRun>>
// @end-annotation
function tryFinally() {
  try {
    doSomething();
  } finally {
    alwaysRun();
  }
}

// @construct PENDING try-nested
// @annotation
// FUNCTION <<nestedTryCatch>> -> HAS_BODY -> TRY_BLOCK <<outer-try>>
// TRY_BLOCK <<outer-try>> -> HAS_CATCH -> CATCH_BLOCK <<outer-catch>>
// CATCH_BLOCK <<outer-catch>> -> RECEIVES_ARGUMENT -> PARAMETER <<outerError>>
// TRY_BLOCK <<outer-try>> -> CONTAINS -> TRY_BLOCK <<inner-try>>
// TRY_BLOCK <<inner-try>> -> HAS_CATCH -> CATCH_BLOCK <<inner-catch>>
// CATCH_BLOCK <<inner-catch>> -> RECEIVES_ARGUMENT -> PARAMETER <<innerError>>
// TRY_BLOCK <<inner-try>> -> CONTAINS -> CALL <<riskyOperation()>>
// CATCH_BLOCK <<inner-catch>> -> CONTAINS -> CALL <<fallback(innerError)>>
// CATCH_BLOCK <<outer-catch>> -> CONTAINS -> CALL <<lastResort(outerError)>>
// CALL <<riskyOperation()>> -> CALLS -> EXTERNAL <<riskyOperation>>
// CALL <<fallback(innerError)>> -> CALLS -> EXTERNAL <<fallback>>
// CALL <<fallback(innerError)>> -> PASSES_ARGUMENT -> PARAMETER <<innerError>>
// CALL <<lastResort(outerError)>> -> CALLS -> EXTERNAL <<lastResort>>
// CALL <<lastResort(outerError)>> -> PASSES_ARGUMENT -> PARAMETER <<outerError>>
// CALL <<riskyOperation()>> -> CATCHES_FROM -> CATCH_BLOCK <<inner-catch>>
// CALL <<fallback(innerError)>> -> CATCHES_FROM -> CATCH_BLOCK <<outer-catch>>
// @end-annotation
function nestedTryCatch() {
  try {
    try {
      riskyOperation();
    } catch (innerError) {
      fallback(innerError);
    }
  } catch (outerError) {
    lastResort(outerError);
  }
}

// @construct PENDING catch-no-binding
// @annotation
// FUNCTION <<catchWithoutBinding>> -> CONTAINS -> TRY_BLOCK <<try-block>>
// FUNCTION <<catchWithoutBinding>> -> HAS_CATCH -> CATCH_BLOCK <<catch-block>>
// TRY_BLOCK <<try-block>> -> CONTAINS -> CALL <<JSON.parse('{}')>>
// CALL <<JSON.parse('{}')>> -> CALLS -> PROPERTY_ACCESS <<JSON.parse>>
// CALL <<JSON.parse('{}')>> -> PASSES_ARGUMENT -> LITERAL <<'{}'>>
// CATCH_BLOCK <<catch-block>> -> CONTAINS -> CALL <<console.error('parse failed')>>
// CALL <<console.error('parse failed')>> -> CALLS -> PROPERTY_ACCESS <<console.error>>
// CALL <<console.error('parse failed')>> -> PASSES_ARGUMENT -> LITERAL <<'parse failed'>>
// @end-annotation
function catchWithoutBinding() {
  try {
    JSON.parse('{}');
  } catch {
    console.error('parse failed');
  }
}

// @construct PENDING throw
// @annotation
// FUNCTION <<throwError>> -> CONTAINS -> PARAMETER <<type>>
// FUNCTION <<throwError>> -> CONTAINS -> BRANCH <<if-error>>
// FUNCTION <<throwError>> -> CONTAINS -> BRANCH <<if-custom>>
// FUNCTION <<throwError>> -> CONTAINS -> BRANCH <<if-string>>
// BRANCH <<if-error>> -> HAS_CONDITION -> EXPRESSION <<type === 'error'>>
// EXPRESSION <<type === 'error'>> -> READS_FROM -> PARAMETER <<type>>
// EXPRESSION <<type === 'error'>> -> READS_FROM -> LITERAL <<'error'>>
// BRANCH <<if-error>> -> HAS_CONSEQUENT -> EXPRESSION <<throw-error>>
// EXPRESSION <<throw-error>> -> THROWS -> CALL <<new Error('Something went wrong')>>
// CALL <<new Error('Something went wrong')>> -> PASSES_ARGUMENT -> LITERAL <<'Something went wrong'>>
// BRANCH <<if-custom>> -> HAS_CONDITION -> EXPRESSION <<type === 'custom'>>
// EXPRESSION <<type === 'custom'>> -> READS_FROM -> PARAMETER <<type>>
// EXPRESSION <<type === 'custom'>> -> READS_FROM -> LITERAL <<'custom'>>
// BRANCH <<if-custom>> -> HAS_CONSEQUENT -> EXPRESSION <<throw-custom>>
// EXPRESSION <<throw-custom>> -> THROWS -> LITERAL <<custom-object>>
// LITERAL <<custom-object>> -> HAS_PROPERTY -> LITERAL <<'CUSTOM'>>
// LITERAL <<custom-object>> -> HAS_PROPERTY -> LITERAL <<'Custom error'>>
// BRANCH <<if-string>> -> HAS_CONDITION -> EXPRESSION <<type === 'string'>>
// EXPRESSION <<type === 'string'>> -> READS_FROM -> PARAMETER <<type>>
// EXPRESSION <<type === 'string'>> -> READS_FROM -> LITERAL <<'string'>>
// BRANCH <<if-string>> -> HAS_CONSEQUENT -> EXPRESSION <<throw-string>>
// EXPRESSION <<throw-string>> -> THROWS -> LITERAL <<'simple string error'>>
// @end-annotation
function throwError(type) {
  if (type === 'error') {
    throw new Error('Something went wrong');
  }
  if (type === 'custom') {
    throw { code: 'CUSTOM', message: 'Custom error' };
  }
  if (type === 'string') {
    throw 'simple string error';
  }
}

// @construct PENDING labeled-break
// @annotation
// @end-annotation
function labeledBreak() {
  outer: for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      if (i === 2 && j === 2) break outer;
    }
  }
}

// @construct PENDING labeled-continue
// @annotation
// FUNCTION <<labeledContinue>> -> CONTAINS -> VARIABLE <<results>>
// VARIABLE <<results>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// FUNCTION <<labeledContinue>> -> CONTAINS -> LABEL <<loop>>
// FUNCTION <<labeledContinue>> -> CONTAINS -> LOOP <<for-loop>>
// LOOP <<for-loop>> -> CONTAINS -> VARIABLE <<i>>
// VARIABLE <<i>> -> ASSIGNED_FROM -> LITERAL <<0>>
// LOOP <<for-loop>> -> HAS_CONDITION -> EXPRESSION <<i < 5>>
// EXPRESSION <<i < 5>> -> READS_FROM -> VARIABLE <<i>>
// EXPRESSION <<i < 5>> -> READS_FROM -> LITERAL <<5>>
// LOOP <<for-loop>> -> HAS_UPDATE -> EXPRESSION <<i++>>
// EXPRESSION <<i++>> -> MODIFIES -> VARIABLE <<i>>
// LOOP <<for-loop>> -> HAS_BODY -> BRANCH <<if-i===3>>
// BRANCH <<if-i===3>> -> HAS_CONDITION -> EXPRESSION <<i === 3>>
// EXPRESSION <<i === 3>> -> READS_FROM -> VARIABLE <<i>>
// EXPRESSION <<i === 3>> -> READS_FROM -> LITERAL <<3>>
// BRANCH <<if-i===3>> -> HAS_CONSEQUENT -> EXPRESSION <<continue-loop>>
// EXPRESSION <<continue-loop>> -> FLOWS_INTO -> LABEL <<loop>>
// LOOP <<for-loop>> -> HAS_BODY -> CALL <<results.push(i)>>
// CALL <<results.push(i)>> -> CALLS -> PROPERTY_ACCESS <<results.push>>
// PROPERTY_ACCESS <<results.push>> -> READS_FROM -> VARIABLE <<results>>
// CALL <<results.push(i)>> -> PASSES_ARGUMENT -> VARIABLE <<i>>
// FUNCTION <<labeledContinue>> -> RETURNS -> VARIABLE <<results>>
// @end-annotation
function labeledContinue() {
  const results = [];
  loop: for (let i = 0; i < 5; i++) {
    if (i === 3) continue loop;
    results.push(i);
  }
  return results;
}

// @construct PENDING labeled-block
// @annotation
// FUNCTION <<labeledBlock>> -> CONTAINS -> LABEL <<block>>
// LABEL <<block>> -> HAS_SCOPE -> SCOPE <<block-scope>>
// SCOPE <<block-scope>> -> CONTAINS -> BRANCH <<if-true>>
// BRANCH <<if-true>> -> HAS_CONDITION -> LITERAL <<true>>
// SCOPE <<block-scope>> -> CONTAINS -> CALL <<unreachable()>>
// CALL <<unreachable()>> -> CALLS -> UNKNOWN <<unreachable>>
// @end-annotation
function labeledBlock() {
  block: {
    if (true) break block;
    unreachable();
  }
}

// @construct PENDING debugger
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<debuggerStatement>>
// FUNCTION <<debuggerStatement>> -> CONTAINS -> SIDE_EFFECT <<debugger>>
// FUNCTION <<debuggerStatement>> -> RETURNS -> LITERAL <<'after debugger'>>
// @end-annotation
function debuggerStatement() {
  debugger;
  return 'after debugger';
}

// @construct PENDING empty-statement
// @annotation
// FUNCTION <<emptyStatements>> -> CONTAINS -> LOOP <<for-loop>>
// LOOP <<for-loop>> -> DECLARES -> VARIABLE <<i>>
// VARIABLE <<i>> -> ASSIGNED_FROM -> LITERAL <<0-init>>
// LOOP <<for-loop>> -> HAS_CONDITION -> EXPRESSION <<i < 0>>
// EXPRESSION <<i < 0>> -> READS_FROM -> VARIABLE <<i>>
// EXPRESSION <<i < 0>> -> READS_FROM -> LITERAL <<0-condition>>
// LOOP <<for-loop>> -> HAS_UPDATE -> EXPRESSION <<i++>>
// EXPRESSION <<i++>> -> MODIFIES -> VARIABLE <<i>>
// @end-annotation
function emptyStatements() {
  ;
  for (let i = 0; i < 0; i++);
}

// @construct PENDING labeled-function
// @annotation
// UNKNOWN <<module>> -> CONTAINS -> LABEL <<myLabel>>
// LABEL <<myLabel>> -> CONTAINS -> FUNCTION <<labeledFn>>
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<labeledFn>>
// FUNCTION <<labeledFn>> -> RETURNS -> LITERAL <<1>>
// @end-annotation
// Labeled function declarations are illegal in strict mode (ES modules).
// Commented out — not parseable in module context.
// myLabel: function labeledFn() { return 1; }

// @construct PENDING finally-return-override
function finallyReturnOverride() {
  try {
    return 1;
  } finally {
    return 2; // swallows try return — returns 2
  }
}

// @construct PENDING finally-throw-override
// @annotation
// FUNCTION <<finallyThrowOverride>> -> CONTAINS -> TRY_BLOCK <<try-block>>
// FUNCTION <<finallyThrowOverride>> -> HAS_CATCH -> CATCH_BLOCK <<catch-block>>
// FUNCTION <<finallyThrowOverride>> -> HAS_FINALLY -> FINALLY_BLOCK <<finally-block>>
// CATCH_BLOCK <<catch-block>> -> CONTAINS -> PARAMETER <<e>>
// TRY_BLOCK <<try-block>> -> THROWS -> CALL <<new Error('original')>>
// CALL <<new Error('original')>> -> PASSES_ARGUMENT -> LITERAL <<'original'>>
// CATCH_BLOCK <<catch-block>> -> THROWS -> CALL <<new Error('from catch')>>
// CALL <<new Error('from catch')>> -> PASSES_ARGUMENT -> LITERAL <<'from catch'>>
// FINALLY_BLOCK <<finally-block>> -> THROWS -> CALL <<new Error('from finally')>>
// CALL <<new Error('from finally')>> -> PASSES_ARGUMENT -> LITERAL <<'from finally'>>
// CATCH_BLOCK <<catch-block>> -> CATCHES_FROM -> CALL <<new Error('original')>>
// @end-annotation
function finallyThrowOverride() {
  try {
    throw new Error('original');
  } catch (e) {
    throw new Error('from catch');
  } finally {
    throw new Error('from finally'); // swallows catch throw
  }
}

// @construct PENDING tdz-switch-fallthrough
// @annotation
// FUNCTION <<tdzSwitch>> -> CONTAINS -> PARAMETER <<x>>
// FUNCTION <<tdzSwitch>> -> CONTAINS -> BRANCH <<switch>>
// BRANCH <<switch>> -> HAS_CONDITION -> PARAMETER <<x>>
// BRANCH <<switch>> -> HAS_SCOPE -> SCOPE <<switch-block-scope>>
// SCOPE <<switch-block-scope>> -> DECLARES -> VARIABLE <<y>>
// BRANCH <<switch>> -> HAS_CASE -> CASE <<case-1>>
// CASE <<case-1>> -> HAS_CONDITION -> LITERAL <<1>>
// CASE <<case-1>> -> CONTAINS -> VARIABLE <<y>>
// VARIABLE <<y>> -> ASSIGNED_FROM -> LITERAL <<1-init>>
// BRANCH <<switch>> -> HAS_CASE -> CASE <<case-2>>
// CASE <<case-2>> -> HAS_CONDITION -> LITERAL <<2>>
// @end-annotation
function tdzSwitch(x) {
  switch (x) {
    case 1:
      let y = 1; // y scoped to ENTIRE switch block
      break;
    case 2:
      // console.log(y); // ReferenceError — TDZ
      break;
  }
}

// @construct PENDING for-in-inherited
// @annotation
// @end-annotation
function forInInherited() {
  const parent = { inherited: true };
  const child = Object.create(parent);
  child.own = true;

  const allKeys = [];
  for (const key in child) {
    allKeys.push(key); // ['own', 'inherited']
  }

  const ownKeys = [];
  for (const key in child) {
    if (Object.hasOwn(child, key)) {
      ownKeys.push(key); // ['own']
    }
  }
  return { allKeys, ownKeys };
}

// @construct PENDING destructure-catch-clause
// @annotation
// FUNCTION <<destructureCatchClause>> -> CONTAINS -> TRY_BLOCK <<try-block>>
// FUNCTION <<destructureCatchClause>> -> CONTAINS -> CATCH_BLOCK <<catch-block>>
// TRY_BLOCK <<try-block>> -> HAS_CATCH -> CATCH_BLOCK <<catch-block>>
// TRY_BLOCK <<try-block>> -> THROWS -> LITERAL <<{ code: 'ENOENT', message: 'not found' }>>
// LITERAL <<{ code: 'ENOENT', message: 'not found' }>> -> HAS_PROPERTY -> LITERAL <<'ENOENT'>>
// LITERAL <<{ code: 'ENOENT', message: 'not found' }>> -> HAS_PROPERTY -> LITERAL <<'not found'>>
// CATCH_BLOCK <<catch-block>> -> DECLARES -> VARIABLE <<code>>
// CATCH_BLOCK <<catch-block>> -> DECLARES -> VARIABLE <<message>>
// VARIABLE <<code>> -> ASSIGNED_FROM -> LITERAL <<{ code: 'ENOENT', message: 'not found' }>>
// VARIABLE <<message>> -> ASSIGNED_FROM -> LITERAL <<{ code: 'ENOENT', message: 'not found' }>>
// FUNCTION <<destructureCatchClause>> -> RETURNS -> LITERAL <<{ code, message }>>
// LITERAL <<{ code, message }>> -> READS_FROM -> VARIABLE <<code>>
// LITERAL <<{ code, message }>> -> READS_FROM -> VARIABLE <<message>>
// @end-annotation
function destructureCatchClause() {
  try {
    throw { code: 'ENOENT', message: 'not found' };
  } catch ({ code, message }) {
    return { code, message };
  }
}

// @construct PENDING switch-true-pattern
// @annotation
// FUNCTION <<switchTruePattern>> -> CONTAINS -> PARAMETER <<x>>
// FUNCTION <<switchTruePattern>> -> CONTAINS -> BRANCH <<switch-true>>
// BRANCH <<switch-true>> -> HAS_CONDITION -> LITERAL <<true>>
// BRANCH <<switch-true>> -> HAS_CASE -> CASE <<case-x>100>>
// BRANCH <<switch-true>> -> HAS_CASE -> CASE <<case-x>50>>
// BRANCH <<switch-true>> -> HAS_CASE -> CASE <<case-x>0>>
// BRANCH <<switch-true>> -> HAS_DEFAULT -> CASE <<default-case>>
// CASE <<case-x>100>> -> HAS_CONDITION -> EXPRESSION <<x > 100>>
// EXPRESSION <<x > 100>> -> READS_FROM -> PARAMETER <<x>>
// EXPRESSION <<x > 100>> -> READS_FROM -> LITERAL <<100>>
// CASE <<case-x>100>> -> RETURNS -> LITERAL <<'high'>>
// CASE <<case-x>50>> -> HAS_CONDITION -> EXPRESSION <<x > 50>>
// EXPRESSION <<x > 50>> -> READS_FROM -> PARAMETER <<x>>
// EXPRESSION <<x > 50>> -> READS_FROM -> LITERAL <<50>>
// CASE <<case-x>50>> -> RETURNS -> LITERAL <<'medium'>>
// CASE <<case-x>0>> -> HAS_CONDITION -> EXPRESSION <<x > 0>>
// EXPRESSION <<x > 0>> -> READS_FROM -> PARAMETER <<x>>
// EXPRESSION <<x > 0>> -> READS_FROM -> LITERAL <<0>>
// CASE <<case-x>0>> -> RETURNS -> LITERAL <<'low'>>
// CASE <<default-case>> -> RETURNS -> LITERAL <<'none'>>
// @end-annotation
function switchTruePattern(x) {
  switch (true) {
    case x > 100: return 'high';
    case x > 50:  return 'medium';
    case x > 0:   return 'low';
    default:       return 'none';
  }
}

// @construct PENDING for-of-destructuring-object
// @annotation
// FUNCTION <<forOfDestructuringObject>> -> CONTAINS -> VARIABLE <<points>>
// VARIABLE <<points>> -> ASSIGNED_FROM -> LITERAL <<[{ x: 1, y: 2 }, { x: 3, y: 4 }]>>
// LITERAL <<[{ x: 1, y: 2 }, { x: 3, y: 4 }]>> -> HAS_ELEMENT -> LITERAL <<{ x: 1, y: 2 }>>
// LITERAL <<[{ x: 1, y: 2 }, { x: 3, y: 4 }]>> -> HAS_ELEMENT -> LITERAL <<{ x: 3, y: 4 }>>
// LITERAL <<{ x: 1, y: 2 }>> -> HAS_PROPERTY -> LITERAL <<1>>
// LITERAL <<{ x: 1, y: 2 }>> -> HAS_PROPERTY -> LITERAL <<2>>
// LITERAL <<{ x: 3, y: 4 }>> -> HAS_PROPERTY -> LITERAL <<3>>
// LITERAL <<{ x: 3, y: 4 }>> -> HAS_PROPERTY -> LITERAL <<4>>
// FUNCTION <<forOfDestructuringObject>> -> CONTAINS -> VARIABLE <<results>>
// VARIABLE <<results>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// FUNCTION <<forOfDestructuringObject>> -> CONTAINS -> LOOP <<for-of>>
// LOOP <<for-of>> -> ITERATES_OVER -> VARIABLE <<points>>
// LOOP <<for-of>> -> CONTAINS -> VARIABLE <<x>>
// LOOP <<for-of>> -> CONTAINS -> VARIABLE <<y>>
// LOOP <<for-of>> -> HAS_BODY -> CALL <<results.push(x + y)>>
// CALL <<results.push(x + y)>> -> CALLS_ON -> VARIABLE <<results>>
// CALL <<results.push(x + y)>> -> PASSES_ARGUMENT -> EXPRESSION <<x + y>>
// EXPRESSION <<x + y>> -> READS_FROM -> VARIABLE <<x>>
// EXPRESSION <<x + y>> -> READS_FROM -> VARIABLE <<y>>
// FUNCTION <<forOfDestructuringObject>> -> RETURNS -> VARIABLE <<results>>
// @end-annotation
function forOfDestructuringObject() {
  const points = [{ x: 1, y: 2 }, { x: 3, y: 4 }];
  const results = [];
  for (const { x, y } of points) {
    results.push(x + y);
  }
  return results;
}

// @construct PENDING labeled-for-switch-interaction
// @annotation
// @end-annotation
function labeledForSwitch(items) {
  const processed = [];
  loop: for (const item of items) {
    switch (item.type) {
      case 'skip': continue loop;    // continues FOR, not switch
      case 'stop': break loop;       // breaks FOR, not switch
      case 'data': processed.push(item); break; // breaks switch only
    }
  }
  return processed;
}

// @construct PENDING for-of-no-declaration
// @annotation
// FUNCTION <<forOfNoDeclaration>> -> CONTAINS -> PARAMETER <<items>>
// FUNCTION <<forOfNoDeclaration>> -> CONTAINS -> VARIABLE <<item>>
// FUNCTION <<forOfNoDeclaration>> -> CONTAINS -> LOOP <<for-of>>
// LOOP <<for-of>> -> ITERATES_OVER -> PARAMETER <<items>>
// LOOP <<for-of>> -> MODIFIES -> VARIABLE <<item>>
// LOOP <<for-of>> -> CONTAINS -> CALL <<console.log(item)>>
// CALL <<console.log(item)>> -> CALLS -> PROPERTY_ACCESS <<console.log>>
// CALL <<console.log(item)>> -> PASSES_ARGUMENT -> VARIABLE <<item>>
// FUNCTION <<forOfNoDeclaration>> -> RETURNS -> VARIABLE <<item>>
// @end-annotation
function forOfNoDeclaration(items) {
  let item;
  for (item of items) {           // REASSIGNS existing var, not declaration
    console.log(item);
  }
  return item; // last item — outer var mutated
}

// @construct PENDING for-in-no-declaration
// @annotation
// FUNCTION <<forInNoDeclaration>> -> CONTAINS -> PARAMETER <<obj>>
// FUNCTION <<forInNoDeclaration>> -> CONTAINS -> VARIABLE <<key>>
// FUNCTION <<forInNoDeclaration>> -> CONTAINS -> LOOP <<for-in>>
// LOOP <<for-in>> -> ITERATES_OVER -> PARAMETER <<obj>>
// LOOP <<for-in>> -> MODIFIES -> VARIABLE <<key>>
// LOOP <<for-in>> -> HAS_BODY -> CALL <<console.log(key)>>
// CALL <<console.log(key)>> -> CALLS -> PROPERTY_ACCESS <<console.log>>
// CALL <<console.log(key)>> -> PASSES_ARGUMENT -> VARIABLE <<key>>
// FUNCTION <<forInNoDeclaration>> -> RETURNS -> VARIABLE <<key>>
// @end-annotation
function forInNoDeclaration(obj) {
  let key;
  for (key in obj) {              // REASSIGNS existing var
    console.log(key);
  }
  return key; // last key — outer var mutated
}

// @construct PENDING for-of-destructure-assign
// @annotation
// FUNCTION <<forOfDestructureAssign>> -> CONTAINS -> PARAMETER <<pairs>>
// FUNCTION <<forOfDestructureAssign>> -> CONTAINS -> VARIABLE <<a>>
// FUNCTION <<forOfDestructureAssign>> -> CONTAINS -> VARIABLE <<b>>
// FUNCTION <<forOfDestructureAssign>> -> CONTAINS -> LOOP <<for-of>>
// LOOP <<for-of>> -> ITERATES_OVER -> PARAMETER <<pairs>>
// EXPRESSION <<[a, b]>> -> ASSIGNED_FROM -> VARIABLE <<a>>
// EXPRESSION <<[a, b]>> -> ASSIGNED_FROM -> VARIABLE <<b>>
// LOOP <<for-of>> -> CONTAINS -> CALL <<console.log(a, b)>>
// CALL <<console.log(a, b)>> -> CALLS -> PROPERTY_ACCESS <<console.log>>
// CALL <<console.log(a, b)>> -> PASSES_ARGUMENT -> VARIABLE <<a>>
// CALL <<console.log(a, b)>> -> PASSES_ARGUMENT -> VARIABLE <<b>>
// FUNCTION <<forOfDestructureAssign>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<a>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<b>>
// @end-annotation
function forOfDestructureAssign(pairs) {
  let a, b;
  for ([a, b] of pairs) {        // destructuring assignment in for-of head
    console.log(a, b);
  }
  return { a, b }; // last pair values
}

// @construct PENDING typeof-switch-narrowing
// @annotation
// @end-annotation
function typeofSwitch(val) {
  switch (typeof val) {
    case 'string': return val.trim();
    case 'number': return val.toFixed(2);
    case 'object': return val === null ? 'null' : JSON.stringify(val);
    case 'function': return val();
    default: return String(val);
  }
}

// @construct PENDING destructure-catch-nested
// @annotation
// FUNCTION <<destructureCatchNested>> -> CONTAINS -> TRY_BLOCK <<try-block>>
// FUNCTION <<destructureCatchNested>> -> CONTAINS -> CATCH_BLOCK <<catch-block>>
// TRY_BLOCK <<try-block>> -> HAS_CATCH -> CATCH_BLOCK <<catch-block>>
// TRY_BLOCK <<try-block>> -> THROWS -> LITERAL <<{ errors: [{ code: 'E1', path: '/api' }], status: 500 }>>
// LITERAL <<{ errors: [{ code: 'E1', path: '/api' }], status: 500 }>> -> CONTAINS -> LITERAL <<'E1'>>
// LITERAL <<{ errors: [{ code: 'E1', path: '/api' }], status: 500 }>> -> CONTAINS -> LITERAL <<'/api'>>
// LITERAL <<{ errors: [{ code: 'E1', path: '/api' }], status: 500 }>> -> CONTAINS -> LITERAL <<500>>
// CATCH_BLOCK <<catch-block>> -> DECLARES -> VARIABLE <<code>>
// CATCH_BLOCK <<catch-block>> -> DECLARES -> VARIABLE <<path>>
// CATCH_BLOCK <<catch-block>> -> DECLARES -> VARIABLE <<status>>
// VARIABLE <<code>> -> ASSIGNED_FROM -> LITERAL <<{ errors: [{ code: 'E1', path: '/api' }], status: 500 }>>
// VARIABLE <<path>> -> ASSIGNED_FROM -> LITERAL <<{ errors: [{ code: 'E1', path: '/api' }], status: 500 }>>
// VARIABLE <<status>> -> ASSIGNED_FROM -> LITERAL <<{ errors: [{ code: 'E1', path: '/api' }], status: 500 }>>
// FUNCTION <<destructureCatchNested>> -> RETURNS -> EXPRESSION <<{ code, path, status }>>
// EXPRESSION <<{ code, path, status }>> -> READS_FROM -> VARIABLE <<code>>
// EXPRESSION <<{ code, path, status }>> -> READS_FROM -> VARIABLE <<path>>
// EXPRESSION <<{ code, path, status }>> -> READS_FROM -> VARIABLE <<status>>
// @end-annotation
function destructureCatchNested() {
  try {
    throw { errors: [{ code: 'E1', path: '/api' }], status: 500 };
  } catch ({ errors: [{ code, path }], status }) {
    return { code, path, status };
  }
}

// @construct PENDING for-in-destructuring
// @annotation
// FUNCTION <<forInDestructuring>> -> CONTAINS -> VARIABLE <<results>>
// VARIABLE <<results>> -> ASSIGNED_FROM -> LITERAL <<[]>>
// FUNCTION <<forInDestructuring>> -> CONTAINS -> LOOP <<for-in>>
// LOOP <<for-in>> -> ITERATES_OVER -> LITERAL <<{ abc: 1, de: 2, f: 3 }>>
// LOOP <<for-in>> -> CONTAINS -> VARIABLE <<length>>
// LOOP <<for-in>> -> HAS_BODY -> CALL <<results.push(length)>>
// CALL <<results.push(length)>> -> CALLS -> PROPERTY_ACCESS <<results.push>>
// PROPERTY_ACCESS <<results.push>> -> READS_FROM -> VARIABLE <<results>>
// CALL <<results.push(length)>> -> PASSES_ARGUMENT -> VARIABLE <<length>>
// FUNCTION <<forInDestructuring>> -> RETURNS -> VARIABLE <<results>>
// @end-annotation
function forInDestructuring() {
  const results = [];
  for (const { length } in { abc: 1, de: 2, f: 3 }) {
    results.push(length); // 3, 2, 1 — destructures the string KEY, not value
  }
  return results;
}

// @construct PENDING for-comma-update
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<forCommaUpdate>>
// FUNCTION <<forCommaUpdate>> -> CONTAINS -> VARIABLE <<arr>>
// VARIABLE <<arr>> -> ASSIGNED_FROM -> LITERAL <<[1, 2, 3, 4, 5]>>
// FUNCTION <<forCommaUpdate>> -> CONTAINS -> LOOP <<for-two-pointer>>
// LOOP <<for-two-pointer>> -> HAS_INIT -> VARIABLE <<lo>>
// VARIABLE <<lo>> -> ASSIGNED_FROM -> LITERAL <<0>>
// LOOP <<for-two-pointer>> -> HAS_INIT -> VARIABLE <<hi>>
// VARIABLE <<hi>> -> ASSIGNED_FROM -> EXPRESSION <<arr.length - 1>>
// EXPRESSION <<arr.length - 1>> -> READS_FROM -> VARIABLE <<arr>>
// LOOP <<for-two-pointer>> -> HAS_CONDITION -> EXPRESSION <<lo < hi>>
// EXPRESSION <<lo < hi>> -> READS_FROM -> VARIABLE <<lo>>
// EXPRESSION <<lo < hi>> -> READS_FROM -> VARIABLE <<hi>>
// LOOP <<for-two-pointer>> -> HAS_UPDATE -> EXPRESSION <<lo++>>
// EXPRESSION <<lo++>> -> MODIFIES -> VARIABLE <<lo>>
// LOOP <<for-two-pointer>> -> HAS_UPDATE -> EXPRESSION <<hi-->>
// EXPRESSION <<hi-->> -> MODIFIES -> VARIABLE <<hi>>
// LOOP <<for-two-pointer>> -> HAS_BODY -> EXPRESSION <<[arr[lo], arr[hi]] = [arr[hi], arr[lo]]>>
// EXPRESSION <<[arr[lo], arr[hi]] = [arr[hi], arr[lo]]>> -> MODIFIES -> VARIABLE <<arr>>
// EXPRESSION <<[arr[lo], arr[hi]] = [arr[hi], arr[lo]]>> -> READS_FROM -> VARIABLE <<lo>>
// EXPRESSION <<[arr[lo], arr[hi]] = [arr[hi], arr[lo]]>> -> READS_FROM -> VARIABLE <<hi>>
// FUNCTION <<forCommaUpdate>> -> CONTAINS -> VARIABLE <<processed>>
// VARIABLE <<processed>> -> ASSIGNED_FROM -> LITERAL <<0-2>>
// FUNCTION <<forCommaUpdate>> -> CONTAINS -> LOOP <<for-side-effect>>
// LOOP <<for-side-effect>> -> HAS_INIT -> VARIABLE <<i>>
// VARIABLE <<i>> -> ASSIGNED_FROM -> LITERAL <<0-3>>
// LOOP <<for-side-effect>> -> HAS_CONDITION -> EXPRESSION <<i < 3>>
// EXPRESSION <<i < 3>> -> READS_FROM -> VARIABLE <<i>>
// EXPRESSION <<i < 3>> -> READS_FROM -> LITERAL <<3>>
// LOOP <<for-side-effect>> -> HAS_UPDATE -> EXPRESSION <<i++>>
// EXPRESSION <<i++>> -> MODIFIES -> VARIABLE <<i>>
// LOOP <<for-side-effect>> -> HAS_UPDATE -> EXPRESSION <<processed++>>
// EXPRESSION <<processed++>> -> MODIFIES -> VARIABLE <<processed>>
// FUNCTION <<forCommaUpdate>> -> RETURNS -> LITERAL <<{...}>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<arr>>
// LITERAL <<{...}>> -> READS_FROM -> VARIABLE <<processed>>
// @end-annotation
function forCommaUpdate() {
  const arr = [1, 2, 3, 4, 5];

  // Two-pointer technique — comma in both init and update
  for (let lo = 0, hi = arr.length - 1; lo < hi; lo++, hi--) {
    [arr[lo], arr[hi]] = [arr[hi], arr[lo]]; // swap
  }

  // Side effect in update clause
  let processed = 0;
  for (let i = 0; i < 3; i++, processed++) {
    // comma separates two update expressions
  }

  return { arr, processed };
}

// @construct PENDING in-operator-type-guard
// @annotation
// UNKNOWN <<module>> -> DECLARES -> FUNCTION <<inOperatorTypeGuard>>
// FUNCTION <<inOperatorTypeGuard>> -> CONTAINS -> PARAMETER <<input>>
// FUNCTION <<inOperatorTypeGuard>> -> CONTAINS -> BRANCH <<if-name-in-input>>
// BRANCH <<if-name-in-input>> -> HAS_CONDITION -> EXPRESSION <<'name' in input>>
// EXPRESSION <<'name' in input>> -> READS_FROM -> LITERAL <<'name'>>
// EXPRESSION <<'name' in input>> -> READS_FROM -> PARAMETER <<input>>
// BRANCH <<if-name-in-input>> -> HAS_CONSEQUENT -> CALL <<input.name.toUpperCase()>>
// CALL <<input.name.toUpperCase()>> -> CALLS -> PROPERTY_ACCESS <<input.name>>
// PROPERTY_ACCESS <<input.name>> -> READS_FROM -> PARAMETER <<input>>
// FUNCTION <<inOperatorTypeGuard>> -> CONTAINS -> BRANCH <<if-items-and-count>>
// BRANCH <<if-items-and-count>> -> HAS_CONDITION -> EXPRESSION <<'items' in input && 'count' in input>>
// EXPRESSION <<'items' in input && 'count' in input>> -> READS_FROM -> EXPRESSION <<'items' in input>>
// EXPRESSION <<'items' in input && 'count' in input>> -> READS_FROM -> EXPRESSION <<'count' in input>>
// EXPRESSION <<'items' in input>> -> READS_FROM -> LITERAL <<'items'>>
// EXPRESSION <<'items' in input>> -> READS_FROM -> PARAMETER <<input>>
// EXPRESSION <<'count' in input>> -> READS_FROM -> LITERAL <<'count'>>
// EXPRESSION <<'count' in input>> -> READS_FROM -> PARAMETER <<input>>
// BRANCH <<if-items-and-count>> -> HAS_CONSEQUENT -> CALL <<input.items.slice(0, input.count)>>
// CALL <<input.items.slice(0, input.count)>> -> CALLS -> PROPERTY_ACCESS <<input.items>>
// CALL <<input.items.slice(0, input.count)>> -> PASSES_ARGUMENT -> LITERAL <<0>>
// CALL <<input.items.slice(0, input.count)>> -> PASSES_ARGUMENT -> PROPERTY_ACCESS <<input.count>>
// PROPERTY_ACCESS <<input.items>> -> READS_FROM -> PARAMETER <<input>>
// PROPERTY_ACCESS <<input.count>> -> READS_FROM -> PARAMETER <<input>>
// FUNCTION <<inOperatorTypeGuard>> -> CONTAINS -> BRANCH <<if-not-error>>
// BRANCH <<if-not-error>> -> HAS_CONDITION -> EXPRESSION <<!('error' in input)>>
// EXPRESSION <<!('error' in input)>> -> READS_FROM -> EXPRESSION <<'error' in input>>
// EXPRESSION <<'error' in input>> -> READS_FROM -> LITERAL <<'error'>>
// EXPRESSION <<'error' in input>> -> READS_FROM -> PARAMETER <<input>>
// BRANCH <<if-not-error>> -> HAS_CONSEQUENT -> PARAMETER <<input>>
// FUNCTION <<inOperatorTypeGuard>> -> RETURNS -> LITERAL <<null>>
// BRANCH <<if-name-in-input>> -> RETURNS -> CALL <<input.name.toUpperCase()>>
// BRANCH <<if-items-and-count>> -> RETURNS -> CALL <<input.items.slice(0, input.count)>>
// BRANCH <<if-not-error>> -> RETURNS -> PARAMETER <<input>>
// @end-annotation
function inOperatorTypeGuard(input) {
  // 'prop' in obj as conditional guard — narrows type inside branch
  if ('name' in input) {
    return input.name.toUpperCase(); // safe — guarded by 'in' check
  }

  // Compound in-check — multiple property guards
  if ('items' in input && 'count' in input) {
    return input.items.slice(0, input.count);
  }

  // Negated in-check
  if (!('error' in input)) {
    return input;
  }

  return null;
}

// @construct PENDING export-named-list
// @annotation
// @end-annotation
export {
  ifStatement,
  ifElseStatement,
  ifElseIfChain,
  switchWithBreak,
  switchWithReturn,
  classicFor,
  forIn,
  forOf,
  forOfDestructuring,
  whileLoop,
  doWhileLoop,
  tryCatch,
  tryCatchFinally,
  tryFinally,
  nestedTryCatch,
  catchWithoutBinding,
  throwError,
  labeledBreak,
  labeledContinue,
  labeledBlock,
  debuggerStatement,
  emptyStatements,
  // labeledFn, // commented out — labeled function invalid in strict mode
  finallyReturnOverride,
  finallyThrowOverride,
  tdzSwitch,
  forInInherited,
  destructureCatchClause,
  switchTruePattern,
  forOfDestructuringObject,
  labeledForSwitch,
  forOfNoDeclaration,
  forInNoDeclaration,
  forOfDestructureAssign,
  typeofSwitch,
  destructureCatchNested,
  forInDestructuring,
  forCommaUpdate,
  inOperatorTypeGuard,
};
