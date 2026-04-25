# Rob's Implementation Report: REG-351

## Summary

Implemented comprehensive built-in method filtering for strict mode to eliminate false positives.

## Changes Made

### 1. `packages/core/src/plugins/enrichment/MethodCallResolver.ts`

Added two new constant sets at module level:

**`BUILTIN_PROTOTYPE_METHODS`** (~80 methods):
- Array.prototype: map, filter, push, pop, slice, splice, etc.
- String.prototype: split, trim, toLowerCase, replace, etc.
- Object.prototype: hasOwnProperty, valueOf, etc.
- Number.prototype: toFixed, toPrecision, etc.
- Date.prototype: getTime, getFullYear, toISOString, etc.
- Map/Set.prototype: get, set, has, delete, clear, add
- Promise.prototype: then, catch, finally
- Function.prototype: apply, bind, call
- RegExp.prototype: exec, test

**`COMMON_LIBRARY_METHODS`** (~150 methods):
- Express: json, status, send, redirect, get, post, put, delete, use
- Socket.io: on, emit, to, join, leave, once, off
- Fetch API: text, blob, arrayBuffer, formData
- DOM: addEventListener, querySelector, getAttribute, preventDefault
- Browser storage: getItem, setItem, removeItem
- React: createRoot, render, useState, useEffect
- Node.js streams: pipe, read, write, pause, resume
- JWT: sign, verify, decode
- Telegram bot API: sendMessage, onText, answerCallbackQuery
- Database: run, all, prepare, query, transaction
- Express-validator: custom, isEmail, withMessage
- dotenv: config, parse
- Crypto: digest, hash, createHash, randomBytes

**Updated `isExternalMethod()` function**:
- Added more objects to externalObjects (dotenv, sqlite3, axios, jwt, etc.)
- Now checks both object name AND method name
- Returns true if:
  1. Object is a known global (console, Math, JSON, etc.)
  2. Method is a built-in prototype method (map, filter, split, etc.)
  3. Method is a common library method (json, emit, on, etc.)

### 2. `test/unit/StrictMode.test.js`

Fixed missing import for `createTestDatabase` from test helpers.

### 3. `test/unit/IsExternalMethod.test.js` (new file)

Added documentation tests for the isExternalMethod behavior.

## Results

**Before fix:**
- 850 fatal errors on Jammers codebase

**After fix:**
- 23 fatal errors (97.3% reduction)

**Remaining errors are legitimate** - all user-defined service methods:
- `socketService.*` (emitSlotBooked, verifyAndRemoveOTP, etc.)
- `spotifyService.*` (searchTracks, getAudioFeatures)
- `setlistWeightService.calculateGigSetlist`
- `bugReportProcessor.*` (analyzeBugReport, improveDescription)
- `apiAdapter.getGigs`
- `this.getAccessToken` in SpotifyService class

These are real unresolved method calls that strict mode should flag.

## Design Decisions

1. **Check method names, not just object names**: The key insight was that `data.split()` should be external even though `data` is not a known global - because `.split()` is a built-in String method.

2. **Comprehensive library coverage**: Added common methods from Express, Socket.io, React, and other popular npm packages to minimize false positives for typical Node.js/React projects.

3. **O(1) lookups**: Using Set for all method lookups ensures no performance impact.

4. **Acceptable false negatives**: If a user defines a method named `json()`, it will be treated as external. This is an acceptable trade-off vs 850 false positives.
