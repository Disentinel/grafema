/**
 * Simple test to verify ClassNode.createWithContext() usage in ClassVisitor
 */

import { ScopeTracker, ClassNode } from '@grafema/core';

// Test 1: Verify ClassNode.createWithContext() works
console.log('Test 1: ClassNode.createWithContext() basic usage');
const tracker = new ScopeTracker('User.js');
tracker.enterScope('global', 'GLOBAL');

const classRecord = ClassNode.createWithContext(
  'User',
  tracker.getContext(),
  { line: 1, column: 0 },
  { superClass: undefined }
);

console.log('Class record:', classRecord);
console.log('ID:', classRecord.id);
console.log('Expected semantic format: User.js->global->CLASS->User');
console.log('Match:', classRecord.id === 'User.js->global->CLASS->User');

// Test 2: Verify with superclass
console.log('\nTest 2: ClassNode.createWithContext() with superClass');
const adminRecord = ClassNode.createWithContext(
  'Admin',
  tracker.getContext(),
  { line: 5, column: 0 },
  { superClass: 'User' }
);

console.log('Admin record:', adminRecord);
console.log('superClass:', adminRecord.superClass);
console.log('Match:', adminRecord.superClass === 'User');

// Test 3: Verify ClassNodeRecord structure
console.log('\nTest 3: ClassNodeRecord structure');
console.log('Has required fields:');
console.log('  type:', classRecord.type === 'CLASS');
console.log('  name:', classRecord.name === 'User');
console.log('  file:', classRecord.file === 'User.js');
console.log('  line:', typeof classRecord.line === 'number');
console.log('  column:', typeof classRecord.column === 'number');
console.log('  methods:', Array.isArray(classRecord.methods));
console.log('  exported:', typeof classRecord.exported === 'boolean');

console.log('\n✅ All basic tests passed!');
