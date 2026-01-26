/**
 * Dynamic Import Patterns Test Fixture (REG-268)
 *
 * Contains various dynamic import() patterns for testing:
 * 1. Literal path - fully resolvable
 * 2. With variable assignment (await)
 * 3. With variable assignment (no await)
 * 4. Template literal with static prefix
 * 5. Template literal without static prefix
 * 6. Variable path
 * 7. Side effect import (no assignment)
 */

// Pattern 1: Literal path - isDynamic=true, isResolvable=true
async function loadModule() {
  return import('./module.js');
}

// Pattern 2: Variable assignment with await - local="mod"
async function loadWithAwait() {
  const mod = await import('./module.js');
  return mod;
}

// Pattern 3: Variable assignment without await - local="modPromise"
function loadWithoutAwait() {
  const modPromise = import('./module.js');
  return modPromise;
}

// Pattern 4: Template literal with static prefix - source="./config/", isResolvable=false
async function loadConfig(env) {
  const config = await import(`./config/${env}.js`);
  return config;
}

// Pattern 5: Template literal WITHOUT static prefix - source="<dynamic>"
async function loadFromBase(baseDir) {
  const loader = await import(`${baseDir}/loader.js`);
  return loader;
}

// Pattern 6: Variable path - source="<dynamic>", dynamicPath="modulePath"
async function loadDynamic(modulePath) {
  const dynamicModule = await import(modulePath);
  return dynamicModule;
}

// Pattern 7: Side effect import - no variable assignment, local="*"
async function initSideEffect() {
  await import('./side-effect.js');
  console.log('Side effect loaded');
}

export {
  loadModule,
  loadWithAwait,
  loadWithoutAwait,
  loadConfig,
  loadFromBase,
  loadDynamic,
  initSideEffect
};
