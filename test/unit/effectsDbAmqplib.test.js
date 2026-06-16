/**
 * effects-db annotation coverage for `amqplib` (AMQP 0-9-1 / RabbitMQ client).
 *
 * amqplib is the FIRST npm package in effects-db to carry MESSAGE_PASSING
 * (taxonomy v2, until now exercised only by the elixir/erlang runtimes) and
 * the first package on `main` to use the IO:SOCKET:* subtypes. A message-broker
 * client is a bridge sender (publish/sendToQueue) and receiver (consume/get),
 * feeding cross-service contract matching (REG-1145).
 *
 * Every assertion below is grounded in a live probe of amqplib@2.0.1 source +
 * behaviour (see PR body for the file:line evidence), not memory:
 *   - connect()              → Promise, rejects async on unreachable broker
 *                              (channel_api.js: promisify(raw_connect))
 *   - Channel.publish/sendToQueue → SYNCHRONOUS boolean, throws TypeError on
 *                              non-Buffer content (connection.js:481)
 *   - Channel.consume/get    → Promise, registers/pulls a message (receiver)
 *   - Channel.assertQueue/…  → RPC Promise to broker (control, not a message)
 *   - Channel.ack/nack/reject → sendImmediately(), synchronous control frame
 *   - credentials.plain/…    → pure credential factories
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EffectsLookup } from '@grafema/util';
import { join } from 'node:path';

const EFFECTS_DB_PATH = join(import.meta.dirname, '..', '..', 'effects-db');
const lookup = EffectsLookup.load(EFFECTS_DB_PATH);

/** Assert that `actual` contains every effect in `expected`. */
function hasAll(actual, expected, label) {
  assert.ok(actual, `Expected effects for ${label}, got null`);
  for (const e of expected) {
    assert.ok(actual.includes(e), `Expected ${e} in ${label}, got: ${JSON.stringify(actual)}`);
  }
}

/** Assert that `actual` contains NONE of `forbidden`. */
function hasNone(actual, forbidden, label) {
  assert.ok(actual, `Expected effects for ${label}, got null`);
  for (const e of forbidden) {
    assert.ok(!actual.includes(e), `Did NOT expect ${e} in ${label}, got: ${JSON.stringify(actual)}`);
  }
}

describe('effects-db: amqplib', () => {
  it('connect() opens a socket asynchronously and may reject', () => {
    const fx = lookup.lookup('amqplib', 'connect');
    hasAll(fx, ['IO', 'IO:SOCKET:CONNECT', 'ASYNC', 'THROW'], 'amqplib.connect');
  });

  it('credentials factories are pure', () => {
    hasAll(lookup.lookup('amqplib', 'credentials.plain'), ['PURE'], 'credentials.plain');
    hasAll(lookup.lookup('amqplib', 'credentials.amqplain'), ['PURE'], 'credentials.amqplain');
    hasAll(lookup.lookup('amqplib', 'credentials.external'), ['PURE'], 'credentials.external');
  });

  it('ChannelModel.createChannel does broker RPC asynchronously', () => {
    const fx = lookup.lookup('amqplib', 'ChannelModel.createChannel');
    hasAll(fx, ['IO', 'IO:SOCKET:WRITE', 'ASYNC', 'THROW'], 'ChannelModel.createChannel');
  });

  // --- The MESSAGE_PASSING send side (bridge sender) ---
  it('Channel.publish is a SYNCHRONOUS MESSAGE_PASSING send that throws on non-Buffer content', () => {
    const fx = lookup.lookup('amqplib', 'Channel.publish');
    hasAll(fx, ['IO', 'IO:SOCKET:WRITE', 'MESSAGE_PASSING', 'THROW'], 'Channel.publish');
    // connection.sendMessage writes synchronously and returns a boolean — not a Promise.
    hasNone(fx, ['ASYNC'], 'Channel.publish');
  });

  it('Channel.sendToQueue mirrors publish (send side)', () => {
    const fx = lookup.lookup('amqplib', 'Channel.sendToQueue');
    hasAll(fx, ['IO', 'IO:SOCKET:WRITE', 'MESSAGE_PASSING', 'THROW'], 'Channel.sendToQueue');
    hasNone(fx, ['ASYNC'], 'Channel.sendToQueue');
  });

  // --- The MESSAGE_PASSING receive side (bridge receiver) ---
  it('Channel.consume subscribes and receives messages asynchronously', () => {
    const fx = lookup.lookup('amqplib', 'Channel.consume');
    hasAll(fx, ['IO', 'IO:SOCKET:READ', 'MESSAGE_PASSING', 'ASYNC', 'THROW'], 'Channel.consume');
  });

  it('Channel.get pulls a single message asynchronously (rejects on error)', () => {
    const fx = lookup.lookup('amqplib', 'Channel.get');
    hasAll(fx, ['IO', 'IO:SOCKET:READ', 'MESSAGE_PASSING', 'ASYNC', 'THROW'], 'Channel.get');
  });

  // --- Control RPCs are socket writes, NOT message passing ---
  it('Channel.assertQueue is an async control RPC, not a MESSAGE_PASSING send', () => {
    const fx = lookup.lookup('amqplib', 'Channel.assertQueue');
    hasAll(fx, ['IO', 'IO:SOCKET:WRITE', 'ASYNC', 'THROW'], 'Channel.assertQueue');
    hasNone(fx, ['MESSAGE_PASSING'], 'Channel.assertQueue');
  });

  // --- Acknowledgements: synchronous control frames ---
  it('Channel.ack is a synchronous socket write (no ASYNC, no MESSAGE_PASSING)', () => {
    const fx = lookup.lookup('amqplib', 'Channel.ack');
    hasAll(fx, ['IO', 'IO:SOCKET:WRITE'], 'Channel.ack');
    hasNone(fx, ['ASYNC', 'MESSAGE_PASSING'], 'Channel.ack');
  });

  it('ConfirmChannel.waitForConfirms awaits broker acks and may reject on nack', () => {
    const fx = lookup.lookup('amqplib', 'ConfirmChannel.waitForConfirms');
    hasAll(fx, ['IO', 'ASYNC', 'THROW'], 'ConfirmChannel.waitForConfirms');
  });

  it('amqplib is the first npm package carrying MESSAGE_PASSING in effects-db', () => {
    // Regression guard: the send/receive carriers must surface MESSAGE_PASSING.
    const publish = lookup.lookup('amqplib', 'Channel.publish');
    assert.ok(publish.includes('MESSAGE_PASSING'), 'Channel.publish must carry MESSAGE_PASSING');
  });
});
