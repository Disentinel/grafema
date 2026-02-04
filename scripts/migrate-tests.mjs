#!/usr/bin/env node
/**
 * Migrate test files from createTestBackend() to createTestDatabase()
 *
 * Usage: node scripts/migrate-tests.mjs [file1] [file2] ...
 *        node scripts/migrate-tests.mjs --all
 */

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

function migrateFile(filePath) {
  let content = readFileSync(filePath, 'utf-8');
  const originalContent = content;

  // Skip if already migrated
  if (content.includes('createTestDatabase')) {
    console.log(`  SKIP: ${filePath} (already migrated)`);
    return false;
  }

  // Skip if doesn't use createTestBackend
  if (!content.includes('createTestBackend')) {
    console.log(`  SKIP: ${filePath} (no createTestBackend)`);
    return false;
  }

  // 1. Update import
  content = content.replace(
    /import\s*\{\s*createTestBackend\s*\}\s*from/g,
    'import { createTestDatabase } from'
  );
  content = content.replace(
    /import\s*\{\s*createTestBackend,\s*TestBackend\s*\}\s*from/g,
    'import { createTestDatabase } from'
  );

  // 2. Change "let backend;" to "let db;\n  let backend;"
  content = content.replace(
    /^(\s*)let backend;$/gm,
    '$1let db;\n$1let backend;'
  );

  // 3. Replace backend = createTestBackend() pattern
  content = content.replace(
    /backend\s*=\s*createTestBackend\(\);/g,
    'db = await createTestDatabase();\n    backend = db.backend;'
  );

  // 4. Replace await backend.connect() - not needed anymore
  content = content.replace(
    /\s*await\s+backend\.connect\(\);\s*\/\/[^\n]*/g,
    ''
  );
  content = content.replace(
    /\s*await\s+backend\.connect\(\);/g,
    ''
  );

  // 5. Replace backend.cleanup() with db.cleanup()
  content = content.replace(
    /await\s+backend\.cleanup\(\)/g,
    'await db.cleanup()'
  );
  content = content.replace(
    /backend\.cleanup\(\)/g,
    'db.cleanup()'
  );

  // 6. Handle cleanup checks: if (backend) await ... -> if (db) await ...
  content = content.replace(
    /if\s*\(\s*backend\s*\)\s*await\s+db\.cleanup\(\)/g,
    'if (db) await db.cleanup()'
  );
  content = content.replace(
    /if\s*\(\s*backend\s*\)\s*\{\s*\n\s*await\s+db\.cleanup\(\);\s*\n\s*\}/g,
    'if (db) await db.cleanup();'
  );

  if (content === originalContent) {
    console.log(`  SKIP: ${filePath} (no changes needed)`);
    return false;
  }

  writeFileSync(filePath, content);
  console.log(`  DONE: ${filePath}`);
  return true;
}

// Get files to migrate
let files;
if (process.argv.includes('--all')) {
  const result = execSync(
    'grep -rl "createTestBackend" test/unit --include="*.js" --include="*.ts" 2>/dev/null || true',
    { encoding: 'utf-8' }
  );
  files = result.trim().split('\n').filter(f => f && !f.includes('TestRFDB.js'));
} else {
  files = process.argv.slice(2);
}

if (files.length === 0) {
  console.log('Usage: node scripts/migrate-tests.mjs [file1] [file2] ...');
  console.log('       node scripts/migrate-tests.mjs --all');
  process.exit(1);
}

console.log(`Migrating ${files.length} files...`);
let migrated = 0;
for (const file of files) {
  if (migrateFile(file)) {
    migrated++;
  }
}
console.log(`\nMigrated ${migrated}/${files.length} files`);
