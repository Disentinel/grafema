// =============================================================================
// runtime-apis.js — Runtime-Specific APIs (Workers, Atomics, Globals)
// =============================================================================
//
// PLUGIN TERRITORY: These patterns use platform APIs (Node.js, Browser, Deno).
// From AST perspective they are regular constructor/method calls — already
// covered by the base JS analyzer as call-expr / new-expr.
//
// The SEMANTIC MEANING (cross-thread data flow, global error sinks, etc.)
// requires a runtime-aware PLUGIN that enriches the graph with:
//   - Cross-worker FLOWS_INTO edges (postMessage → onmessage)
//   - SharedArrayBuffer cross-thread mutation edges
//   - Global error sink edges (any unhandled throw → handler)
//   - Platform-specific module resolution (import.meta.resolve)
//
// Each section notes which plugin would handle it.
// =============================================================================

// --- SharedArrayBuffer + Atomics (Plugin: concurrency) ---

// @construct PENDING runtime-shared-array-buffer
// @annotation
// @end-annotation
function sharedMemory() {
  const sab = new SharedArrayBuffer(1024);
  const view = new Int32Array(sab);
  Atomics.store(view, 0, 42);
  const val = Atomics.load(view, 0);
  Atomics.add(view, 0, 1);
  Atomics.sub(view, 0, 1);
  Atomics.and(view, 0, 0xff);
  Atomics.or(view, 0, 0x0f);
  Atomics.xor(view, 0, 0xff);
  Atomics.exchange(view, 0, 99);
  Atomics.compareExchange(view, 0, 99, 100);
  return { sab, val };
}

// @construct PENDING runtime-atomics-wait-notify
// @annotation
// FUNCTION <<atomicsSynchronization>> -> HAS_BODY -> PARAMETER <<view>>
// FUNCTION <<atomicsSynchronization>> -> HAS_BODY -> CALL <<Atomics.notify(view, 0, 1)>>
// FUNCTION <<atomicsSynchronization>> -> HAS_BODY -> CALL <<Atomics.waitAsync(view, 0, 0)>>
// CALL <<Atomics.notify(view, 0, 1)>> -> CALLS -> PROPERTY_ACCESS <<Atomics.notify>>
// CALL <<Atomics.notify(view, 0, 1)>> -> PASSES_ARGUMENT -> PARAMETER <<view>>
// CALL <<Atomics.notify(view, 0, 1)>> -> PASSES_ARGUMENT -> LITERAL <<0>>
// CALL <<Atomics.notify(view, 0, 1)>> -> PASSES_ARGUMENT -> LITERAL <<1>>
// CALL <<Atomics.waitAsync(view, 0, 0)>> -> CALLS -> PROPERTY_ACCESS <<Atomics.waitAsync>>
// CALL <<Atomics.waitAsync(view, 0, 0)>> -> PASSES_ARGUMENT -> PARAMETER <<view>>
// CALL <<Atomics.waitAsync(view, 0, 0)>> -> PASSES_ARGUMENT -> LITERAL <<0_2>>
// CALL <<Atomics.waitAsync(view, 0, 0)>> -> PASSES_ARGUMENT -> LITERAL <<0_3>>
// @end-annotation
function atomicsSynchronization(view) {
  // Atomics.wait(view, 0, 0);     // blocks thread (worker only)
  Atomics.notify(view, 0, 1);      // wake one waiting thread
  Atomics.waitAsync(view, 0, 0);   // non-blocking, returns Promise
}

// --- Worker Communication (Plugin: workers) ---

// @construct PENDING runtime-worker-postmessage
// @annotation
// FUNCTION <<workerCommunication>> -> CONTAINS -> VARIABLE <<worker>>
// VARIABLE <<worker>> -> ASSIGNED_FROM -> CALL <<new Worker('./task.js')>>
// CALL <<new Worker('./task.js')>> -> PASSES_ARGUMENT -> LITERAL <<'./task.js'>>
// FUNCTION <<workerCommunication>> -> CONTAINS -> CALL <<worker.postMessage>>
// CALL <<worker.postMessage>> -> PASSES_ARGUMENT -> LITERAL <<{ type: 'start', payload: 'data' }>>
// PROPERTY_ACCESS <<worker.onmessage>> -> ASSIGNED_FROM -> FUNCTION <<onmessage-handler>>
// FUNCTION <<onmessage-handler>> -> CONTAINS -> PARAMETER <<e>>
// FUNCTION <<onmessage-handler>> -> CONTAINS -> CALL <<console.log(e.data)>>
// CALL <<console.log(e.data)>> -> PASSES_ARGUMENT -> PROPERTY_ACCESS <<e.data>>
// PROPERTY_ACCESS <<e.data>> -> READS_FROM -> PARAMETER <<e>>
// PROPERTY_ACCESS <<worker.onerror>> -> ASSIGNED_FROM -> FUNCTION <<onerror-handler>>
// FUNCTION <<onerror-handler>> -> CONTAINS -> PARAMETER <<err>>
// FUNCTION <<onerror-handler>> -> CONTAINS -> CALL <<console.error(err)>>
// CALL <<console.error(err)>> -> PASSES_ARGUMENT -> PARAMETER <<err>>
// FUNCTION <<workerCommunication>> -> CONTAINS -> CALL <<worker.terminate>>
// @end-annotation
function workerCommunication() {
  const worker = new Worker('./task.js');
  worker.postMessage({ type: 'start', payload: 'data' });
  worker.onmessage = (e) => console.log(e.data);
  worker.onerror = (err) => console.error(err);
  worker.terminate();
}

// @construct PENDING runtime-message-channel
// @annotation
// FUNCTION <<messageChannelPattern>> -> CONTAINS -> VARIABLE <<port1>>
// FUNCTION <<messageChannelPattern>> -> CONTAINS -> VARIABLE <<port2>>
// VARIABLE <<port1>> -> ASSIGNED_FROM -> CALL <<new MessageChannel()>>
// VARIABLE <<port2>> -> ASSIGNED_FROM -> CALL <<new MessageChannel()>>
// CALL <<new MessageChannel()>> -> CALLS -> UNKNOWN <<MessageChannel>>
// PROPERTY_ACCESS <<port1.onmessage>> -> ASSIGNED_FROM -> FUNCTION <<onmessage-handler>>
// FUNCTION <<onmessage-handler>> -> CONTAINS -> PARAMETER <<e>>
// FUNCTION <<onmessage-handler>> -> CONTAINS -> CALL <<console.log(e.data)>>
// CALL <<console.log(e.data)>> -> CALLS -> UNKNOWN <<console.log>>
// CALL <<console.log(e.data)>> -> PASSES_ARGUMENT -> PROPERTY_ACCESS <<e.data>>
// PROPERTY_ACCESS <<e.data>> -> READS_FROM -> PARAMETER <<e>>
// FUNCTION <<messageChannelPattern>> -> CONTAINS -> CALL <<port2.postMessage('hello')>>
// CALL <<port2.postMessage('hello')>> -> CALLS -> UNKNOWN <<port2.postMessage>>
// CALL <<port2.postMessage('hello')>> -> PASSES_ARGUMENT -> LITERAL <<'hello'>>
// @end-annotation
function messageChannelPattern() {
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = (e) => console.log(e.data);
  port2.postMessage('hello');
}

// @construct PENDING runtime-broadcast-channel
// @annotation
// FUNCTION <<broadcastChannelPattern>> -> CONTAINS -> VARIABLE <<bc>>
// VARIABLE <<bc>> -> ASSIGNED_FROM -> CALL <<new BroadcastChannel('updates')>>
// CALL <<new BroadcastChannel('updates')>> -> PASSES_ARGUMENT -> LITERAL <<'updates'>>
// CALL <<bc.postMessage({ type: 'refresh' })>> -> CALLS_ON -> VARIABLE <<bc>>
// CALL <<bc.postMessage({ type: 'refresh' })>> -> PASSES_ARGUMENT -> LITERAL <<{ type: 'refresh' }>>
// PROPERTY_ACCESS <<bc.onmessage>> -> ASSIGNED_FROM -> FUNCTION <<(e) => console.log(e.data)>>
// FUNCTION <<(e) => console.log(e.data)>> -> CONTAINS -> PARAMETER <<e>>
// FUNCTION <<(e) => console.log(e.data)>> -> CONTAINS -> CALL <<console.log(e.data)>>
// CALL <<console.log(e.data)>> -> PASSES_ARGUMENT -> PROPERTY_ACCESS <<e.data>>
// PROPERTY_ACCESS <<e.data>> -> READS_FROM -> PARAMETER <<e>>
// CALL <<bc.close()>> -> CALLS_ON -> VARIABLE <<bc>>
// FUNCTION <<broadcastChannelPattern>> -> CONTAINS -> CALL <<bc.postMessage({ type: 'refresh' })>>
// FUNCTION <<broadcastChannelPattern>> -> CONTAINS -> PROPERTY_ACCESS <<bc.onmessage>>
// FUNCTION <<broadcastChannelPattern>> -> CONTAINS -> CALL <<bc.close()>>
// @end-annotation
function broadcastChannelPattern() {
  const bc = new BroadcastChannel('updates');
  bc.postMessage({ type: 'refresh' });
  bc.onmessage = (e) => console.log(e.data);
  bc.close();
}

// @construct PENDING runtime-transfer-ownership
// @annotation
// FUNCTION <<transferOwnership>> -> HAS_BODY -> PARAMETER <<worker>>
// FUNCTION <<transferOwnership>> -> HAS_BODY -> VARIABLE <<buffer>>
// VARIABLE <<buffer>> -> ASSIGNED_FROM -> CALL <<new ArrayBuffer(1024)>>
// CALL <<new ArrayBuffer(1024)>> -> PASSES_ARGUMENT -> LITERAL <<1024>>
// FUNCTION <<transferOwnership>> -> HAS_BODY -> CALL <<worker.postMessage(buffer, [buffer])>>
// CALL <<worker.postMessage(buffer, [buffer])>> -> CALLS -> PROPERTY_ACCESS <<worker.postMessage>>
// CALL <<worker.postMessage(buffer, [buffer])>> -> PASSES_ARGUMENT -> VARIABLE <<buffer>>
// CALL <<worker.postMessage(buffer, [buffer])>> -> PASSES_ARGUMENT -> EXPRESSION <<[buffer]>>
// PROPERTY_ACCESS <<worker.postMessage>> -> READS_FROM -> PARAMETER <<worker>>
// EXPRESSION <<[buffer]>> -> HAS_ELEMENT -> VARIABLE <<buffer>>
// @end-annotation
function transferOwnership(worker) {
  const buffer = new ArrayBuffer(1024);
  worker.postMessage(buffer, [buffer]); // buffer neutered in sender
}

// --- import.meta Extensions (Plugin: node-modules) ---

// @construct PENDING runtime-import-meta-resolve
// @annotation
// FUNCTION <<importMetaExtensions>> -> CONTAINS -> VARIABLE <<depPath>>
// FUNCTION <<importMetaExtensions>> -> CONTAINS -> VARIABLE <<localPath>>
// VARIABLE <<depPath>> -> ASSIGNED_FROM -> CALL <<import.meta.resolve('lodash')>>
// CALL <<import.meta.resolve('lodash')>> -> CALLS -> META_PROPERTY <<import.meta.resolve>>
// CALL <<import.meta.resolve('lodash')>> -> PASSES_ARGUMENT -> LITERAL <<'lodash'>>
// VARIABLE <<localPath>> -> ASSIGNED_FROM -> CALL <<import.meta.resolve('./utils.js')>>
// CALL <<import.meta.resolve('./utils.js')>> -> CALLS -> META_PROPERTY <<import.meta.resolve2>>
// CALL <<import.meta.resolve('./utils.js')>> -> PASSES_ARGUMENT -> LITERAL <<'./utils.js'>>
// FUNCTION <<importMetaExtensions>> -> RETURNS -> EXPRESSION <<{ depPath, localPath }>>
// EXPRESSION <<{ depPath, localPath }>> -> READS_FROM -> VARIABLE <<depPath>>
// EXPRESSION <<{ depPath, localPath }>> -> READS_FROM -> VARIABLE <<localPath>>
// @end-annotation
function importMetaExtensions() {
  const depPath = import.meta.resolve('lodash');
  const localPath = import.meta.resolve('./utils.js');
  // Node.js 21+:
  // const dir = import.meta.dirname;   // replaces __dirname
  // const file = import.meta.filename; // replaces __filename
  return { depPath, localPath };
}

// --- Global Error Sinks (Plugin: error-flow) ---
// These create implicit edges from ANY uncaught throw/reject to handler.

// @construct PENDING runtime-global-error-handlers
// @annotation
// EXTERNAL <<process>> -> LISTENS_TO -> FUNCTION <<process.unhandledRejection>>
// FUNCTION <<process.unhandledRejection>> -> RECEIVES_ARGUMENT -> PARAMETER <<reason>>
// FUNCTION <<process.unhandledRejection>> -> RECEIVES_ARGUMENT -> PARAMETER <<promise>>
// EXTERNAL <<process>> -> LISTENS_TO -> FUNCTION <<process.uncaughtException>>
// FUNCTION <<process.uncaughtException>> -> RECEIVES_ARGUMENT -> PARAMETER <<error>>
// FUNCTION <<process.uncaughtException>> -> CONTAINS -> CALL <<process.exit(1)>>
// CALL <<process.exit(1)>> -> PASSES_ARGUMENT -> LITERAL <<1>>
// EXTERNAL <<window>> -> LISTENS_TO -> FUNCTION <<window.unhandledrejection>>
// FUNCTION <<window.unhandledrejection>> -> RECEIVES_ARGUMENT -> PARAMETER <<event1>>
// EXTERNAL <<window>> -> LISTENS_TO -> FUNCTION <<window.error>>
// FUNCTION <<window.error>> -> RECEIVES_ARGUMENT -> PARAMETER <<event2>>
// @end-annotation
// Node.js:
process.on('unhandledRejection', (reason, promise) => { });
process.on('uncaughtException', (error) => { process.exit(1); });

// Browser:
window.addEventListener('unhandledrejection', (event1) => { });
window.addEventListener('error', (event2) => { });

// --- ES2025+ API Methods (Plugin: es-builtins) ---

// @construct PENDING runtime-promise-try
// const result = await Promise.try(() => {
//   if (cached) return cachedValue;    // sync return → wrapped in Promise
//   return fetchFromNetwork();          // async return
// });

// @construct PENDING runtime-promise-withresolvers-deferred
function deferredPromise() {
  const { promise, resolve, reject } = Promise.withResolvers();
  // resolve/reject passed to different scopes as callbacks
  setTimeout(() => reject(new Error('timeout')), 5000);
  return { promise, resolve, reject };
}

// @construct PENDING export-named-list
// @annotation
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<sharedMemory>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<atomicsSynchronization>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<workerCommunication>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<messageChannelPattern>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<broadcastChannelPattern>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<transferOwnership>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<importMetaExtensions>>
// EXPORT <<export-named-list>> -> EXPORTS -> VARIABLE <<deferredPromise>>
// @end-annotation
export {
  sharedMemory,
  atomicsSynchronization,
  workerCommunication,
  messageChannelPattern,
  broadcastChannelPattern,
  transferOwnership,
  importMetaExtensions,
  deferredPromise,
};
