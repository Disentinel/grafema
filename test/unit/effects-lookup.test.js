import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EffectsLookup } from '@grafema/util';
import { join } from 'node:path';

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
});
