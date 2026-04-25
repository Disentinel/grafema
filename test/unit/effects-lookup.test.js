import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EffectsLookup } from '@grafema/util';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const EFFECTS_DB_PATH = join(import.meta.dirname, '..', '..', 'effects-db');

describe('EffectsLookup', () => {
  describe('load()', () => {
    it('loads effects-db from project root', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      assert.equal(lookup.isLoaded, true);
    });

    it('lookup node:fs readFileSync returns array containing IO', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('node:fs', 'readFileSync');
      assert.ok(effects, 'Expected effects for node:fs readFileSync');
      assert.ok(effects.includes('IO'), `Expected IO in effects, got: ${effects}`);
    });

    it('lookup node:path join returns array containing PURE', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('node:path', 'join');
      assert.ok(effects, 'Expected effects for node:path join');
      assert.ok(effects.includes('PURE'), `Expected PURE in effects, got: ${effects}`);
    });
  });

  describe('empty()', () => {
    it('returns empty lookup with no data', () => {
      const lookup = EffectsLookup.empty();
      assert.equal(lookup.isLoaded, false);
    });

    it('lookup returns null for any module/function', () => {
      const lookup = EffectsLookup.empty();
      assert.equal(lookup.lookup('node:fs', 'readFileSync'), null);
    });
  });

  describe('lookup() with npm packages', () => {
    it('graphql parse returns array containing THROW', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('graphql', 'parse');
      assert.ok(effects, 'Expected effects for graphql parse');
      assert.ok(effects.includes('THROW'), `Expected THROW in effects, got: ${effects}`);
    });

    it('nonexistent package returns null', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      assert.equal(lookup.lookup('nonexistent', 'foo'), null);
    });
  });

  describe('lookupByCallName()', () => {
    it('returns null for names without dot', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      assert.equal(lookup.lookupByCallName('readFileSync'), null);
    });

    it('splits qualified name and resolves via node: prefix', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      // lookupByCallName("fs.readFileSync") → lookup("fs", "readFileSync")
      // lookup() tries "node:fs" prefix automatically, so this resolves
      const effects = lookup.lookupByCallName('fs.readFileSync');
      assert.ok(effects, 'Expected effects for fs.readFileSync via lookupByCallName');
      assert.ok(effects.includes('IO'), `Expected IO in effects, got: ${effects}`);
    });
  });

  describe('lookup() with ecma:global builtins', () => {
    it('Error constructor is PURE', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('Error', '');
      assert.ok(effects, 'Expected effects for Error');
      assert.ok(effects.includes('PURE'), `Expected PURE in effects, got: ${effects}`);
    });

    it('JSON.parse returns THROW', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('JSON', 'parse');
      assert.ok(effects, 'Expected effects for JSON.parse');
      assert.ok(effects.includes('THROW'), `Expected THROW in effects, got: ${effects}`);
    });

    it('Math.random returns NONDETERMINISTIC', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('Math', 'random');
      assert.ok(effects, 'Expected effects for Math.random');
      assert.ok(effects.includes('NONDETERMINISTIC'), `Expected NONDETERMINISTIC, got: ${effects}`);
    });

    it('Object.assign returns MUTATION', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('Object', 'assign');
      assert.ok(effects, 'Expected effects for Object.assign');
      assert.ok(effects.includes('MUTATION'), `Expected MUTATION, got: ${effects}`);
    });

    it('Array.prototype.push returns MUTATION', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('Array', 'prototype.push');
      assert.ok(effects, 'Expected effects for Array.prototype.push');
      assert.ok(effects.includes('MUTATION'), `Expected MUTATION, got: ${effects}`);
    });

    it('Promise.resolve returns ASYNC', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('Promise', 'resolve');
      assert.ok(effects, 'Expected effects for Promise.resolve');
      assert.ok(effects.includes('ASYNC'), `Expected ASYNC, got: ${effects}`);
    });

    it('parseInt is PURE (bare global function)', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookupEcmaGlobal('parseInt');
      assert.ok(effects, 'Expected effects for parseInt');
      assert.ok(effects.includes('PURE'), `Expected PURE, got: ${effects}`);
    });
  });

  describe('lookup() with ecma:web', () => {
    it('fetch returns IO and ASYNC', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookupEcmaGlobal('fetch');
      assert.ok(effects, 'Expected effects for fetch');
      assert.ok(effects.includes('IO'), `Expected IO, got: ${effects}`);
      assert.ok(effects.includes('ASYNC'), `Expected ASYNC, got: ${effects}`);
    });

    it('URL constructor is PURE', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookupEcmaGlobal('URL');
      assert.ok(effects, 'Expected effects for URL');
      assert.ok(effects.includes('PURE'), `Expected PURE, got: ${effects}`);
    });
  });

  describe('lookupByCallName() with ecma builtins', () => {
    it('bare Error returns PURE via ecma:global', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookupByCallName('Error');
      assert.ok(effects, 'Expected effects for bare Error');
      assert.ok(effects.includes('PURE'), `Expected PURE, got: ${effects}`);
    });

    it('JSON.parse returns THROW via ecma:global', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookupByCallName('JSON.parse');
      assert.ok(effects, 'Expected effects for JSON.parse via lookupByCallName');
      assert.ok(effects.includes('THROW'), `Expected THROW, got: ${effects}`);
    });

    it('Math.floor returns PURE via ecma:global', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookupByCallName('Math.floor');
      assert.ok(effects, 'Expected effects for Math.floor');
      assert.ok(effects.includes('PURE'), `Expected PURE, got: ${effects}`);
    });

    it('bare fetch returns IO via ecma:web', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookupByCallName('fetch');
      assert.ok(effects, 'Expected effects for bare fetch');
      assert.ok(effects.includes('IO'), `Expected IO, got: ${effects}`);
    });

    it('unknown bare name still returns null', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      assert.equal(lookup.lookupByCallName('totallyUnknownGlobal'), null);
    });
  });

  describe('lookup() with Haskell stdlib', () => {
    it('loads Haskell stdlib from haskell.yaml', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('haskell:prelude', 'Just');
      assert.ok(effects, 'Expected effects for haskell:prelude Just');
      assert.deepEqual(effects, ['PURE']);
    });

    it('lookupByCallName resolves bare Haskell names from prelude', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookupByCallName('mapM_');
      assert.ok(effects, 'Expected effects for bare mapM_');
      assert.deepEqual(effects, ['PURE']);
    });

    it('lookupByCallName resolves IO functions from system.io', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookupByCallName('hPutStrLn');
      assert.ok(effects, 'Expected effects for hPutStrLn');
      assert.ok(effects.includes('IO'), `Expected IO in effects, got: ${effects}`);
    });

    it('lookupByCallName resolves qualified Map.lookup', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookupByCallName('Map.lookup');
      assert.ok(effects, 'Expected effects for Map.lookup');
      assert.deepEqual(effects, ['PURE']);
    });

    it('lookupByCallName resolves qualified T.pack from data.text', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookupByCallName('T.pack');
      assert.ok(effects, 'Expected effects for T.pack');
      assert.deepEqual(effects, ['PURE']);
    });

    it('lookupByCallName resolves BS.readFile as IO', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookupByCallName('BS.readFile');
      assert.ok(effects, 'Expected effects for BS.readFile');
      assert.ok(effects.includes('IO'), `Expected IO in effects, got: ${effects}`);
    });

    it('lookup haskell:control.exception throwIO returns THROW and IO', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('haskell:control.exception', 'throwIO');
      assert.ok(effects, 'Expected effects for throwIO');
      assert.ok(effects.includes('THROW'), `Expected THROW, got: ${effects}`);
      assert.ok(effects.includes('IO'), `Expected IO, got: ${effects}`);
    });
  });

  describe('lookup() with IO subtypes', () => {
    it('node:fs readFile includes IO:FILE:READ', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('node:fs', 'readFile');
      assert.ok(effects, 'Expected effects for node:fs readFile');
      assert.ok(
        effects.includes('IO:FILE:READ'),
        `Expected IO:FILE:READ in effects, got: ${effects}`,
      );
    });

    it('node:fs readFile includes ASYNC', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('node:fs', 'readFile');
      assert.ok(effects, 'Expected effects for node:fs readFile');
      assert.ok(
        effects.includes('ASYNC'),
        `Expected ASYNC in effects, got: ${effects}`,
      );
    });

    it('node:fs readFileSync includes IO:FILE:READ but not ASYNC', () => {
      const lookup = EffectsLookup.load(EFFECTS_DB_PATH);
      const effects = lookup.lookup('node:fs', 'readFileSync');
      assert.ok(effects, 'Expected effects for node:fs readFileSync');
      assert.ok(
        effects.includes('IO:FILE:READ'),
        `Expected IO:FILE:READ in effects, got: ${effects}`,
      );
      assert.ok(
        !effects.includes('ASYNC'),
        `Expected no ASYNC in effects for sync call, got: ${effects}`,
      );
    });
  });

  describe('normalizeEffectValue() — args and returns', () => {
    it('simple array form parses with no args/returns (backward compat)', () => {
      const entry = EffectsLookup.normalizeEffectValue(['IO', 'MUTATION']);
      assert.deepEqual(entry.effects, ['IO', 'MUTATION']);
      assert.equal(entry.args, undefined);
      assert.equal(entry.returns, undefined);
      assert.equal(entry.channel, undefined);
    });

    it('object form preserves args and returns', () => {
      const entry = EffectsLookup.normalizeEffectValue({
        effects: ['MUTATION'],
        args: [{ index: 0, role: 'ENTRY_POINT_CALLBACK' }],
        returns: { type: 'Command' },
      });
      assert.deepEqual(entry.effects, ['MUTATION']);
      assert.ok(entry.args, 'Expected args to be present');
      assert.equal(entry.args.length, 1);
      assert.equal(entry.args[0].index, 0);
      assert.equal(entry.args[0].role, 'ENTRY_POINT_CALLBACK');
      assert.ok(entry.returns, 'Expected returns to be present');
      assert.equal(entry.returns.type, 'Command');
    });

    it('object form without args/returns leaves them undefined', () => {
      const entry = EffectsLookup.normalizeEffectValue({
        effects: ['IO'],
        channel: { kind: 'fs' },
      });
      assert.deepEqual(entry.effects, ['IO']);
      assert.deepEqual(entry.channel, { kind: 'fs' });
      assert.equal(entry.args, undefined);
      assert.equal(entry.returns, undefined);
    });

    it('object form with only args (no returns) parses correctly', () => {
      const entry = EffectsLookup.normalizeEffectValue({
        effects: ['MUTATION'],
        args: [
          { index: 0, role: 'TOOL_SCHEMA' },
          { index: 1, role: 'ENTRY_POINT_CALLBACK' },
        ],
      });
      assert.equal(entry.args.length, 2);
      assert.equal(entry.args[1].role, 'ENTRY_POINT_CALLBACK');
      assert.equal(entry.returns, undefined);
    });

    it('object form with only returns (no args) parses correctly', () => {
      const entry = EffectsLookup.normalizeEffectValue({
        effects: ['PURE'],
        returns: { type: 'Command' },
      });
      assert.equal(entry.args, undefined);
      assert.equal(entry.returns.type, 'Command');
    });
  });

  describe('load() — args and returns from YAML', () => {
    let tmpDir;

    before(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'grafema-effects-test-'));
      mkdirSync(join(tmpDir, 'packages'), { recursive: true });
      mkdirSync(join(tmpDir, 'runtimes'), { recursive: true });

      // Mixed YAML: simple-array form for one method, full object form for another
      const yaml = `commander:
  Command.parse:
    - IO
    - MUTATION
  Command.action:
    effects: [MUTATION]
    args:
      - index: 0
        role: ENTRY_POINT_CALLBACK
    returns:
      type: Command
  Command.command:
    effects: [PURE]
    args:
      - index: 0
        role: COMMAND_NAME
    returns:
      type: Command
`;
      writeFileSync(join(tmpDir, 'packages', 'commander.yaml'), yaml);
    });

    after(() => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    it('simple array form loads as effects-only entry (backward compat)', () => {
      const lookup = EffectsLookup.load(tmpDir);
      const effects = lookup.lookup('commander', 'Command.parse');
      assert.deepEqual(effects, ['IO', 'MUTATION']);
    });

    it('full object form loads with args and returns accessible via getEntry', () => {
      const lookup = EffectsLookup.load(tmpDir);
      const entry = lookup.getEntry('commander', 'Command.action');
      assert.ok(entry, 'Expected entry for Command.action');
      assert.deepEqual(entry.effects, ['MUTATION']);
      assert.ok(entry.args, 'Expected args[] on Command.action');
      assert.equal(entry.args.length, 1);
      assert.equal(entry.args[0].index, 0);
      assert.equal(entry.args[0].role, 'ENTRY_POINT_CALLBACK');
      assert.ok(entry.returns, 'Expected returns on Command.action');
      assert.equal(entry.returns.type, 'Command');
    });

    it('simple array form has no args/returns when retrieved via getEntry', () => {
      const lookup = EffectsLookup.load(tmpDir);
      const entry = lookup.getEntry('commander', 'Command.parse');
      assert.ok(entry, 'Expected entry for Command.parse');
      assert.deepEqual(entry.effects, ['IO', 'MUTATION']);
      assert.equal(entry.args, undefined);
      assert.equal(entry.returns, undefined);
    });

    it('getEntry returns null for unknown module/function', () => {
      const lookup = EffectsLookup.load(tmpDir);
      assert.equal(lookup.getEntry('commander', 'nonexistent'), null);
      assert.equal(lookup.getEntry('nonexistent', 'whatever'), null);
    });

    it('mixed YAML: both simple and object forms parse without errors', () => {
      const lookup = EffectsLookup.load(tmpDir);
      assert.deepEqual(lookup.lookup('commander', 'Command.parse'), ['IO', 'MUTATION']);
      assert.deepEqual(lookup.lookup('commander', 'Command.action'), ['MUTATION']);
      assert.deepEqual(lookup.lookup('commander', 'Command.command'), ['PURE']);
    });
  });
});
