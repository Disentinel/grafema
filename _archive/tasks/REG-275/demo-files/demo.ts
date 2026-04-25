/**
 * Demo script for REG-275: SwitchStatement as BRANCH nodes
 * This script demonstrates the feature by analyzing a reducer file
 * and querying the resulting graph.
 */
import { createTestBackend } from '/Users/vadimr/grafema-worker-2/test/helpers/TestRFDB.js';
import { createTestOrchestrator } from '/Users/vadimr/grafema-worker-2/test/helpers/createTestOrchestrator.js';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

async function demo() {
  console.log('='.repeat(60));
  console.log('REG-275 Demo: SwitchStatement as BRANCH nodes');
  console.log('='.repeat(60));
  console.log('');

  // Create test backend
  const backend = createTestBackend();
  await backend.connect();

  // Create test directory with reducer file
  const testDir = join(tmpdir(), `grafema-demo-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });

  // The exact code from Linear issue
  const reducerCode = `
function reducer(state, action) {
  switch (action.type) {
    case 'ADD': return add(action.payload);
    case 'REMOVE': return remove(action.id);
    default: return state;
  }
}
module.exports = { reducer };
`;

  writeFileSync(join(testDir, 'package.json'), JSON.stringify({
    name: 'demo-switch',
    type: 'module',
    main: 'reducer.js'
  }));

  writeFileSync(join(testDir, 'reducer.js'), reducerCode);

  console.log('Input code:');
  console.log('-'.repeat(40));
  console.log(reducerCode.trim());
  console.log('-'.repeat(40));
  console.log('');

  // Run analysis
  console.log('Running analysis...');
  const orchestrator = createTestOrchestrator(backend, { forceAnalysis: true });
  await orchestrator.run(testDir);
  console.log('Analysis complete.');
  console.log('');

  // Query for BRANCH nodes
  const allNodes = await backend.getAllNodes();
  const branchNodes = allNodes.filter(n => n.type === 'BRANCH');
  const caseNodes = allNodes.filter(n => n.type === 'CASE');

  console.log('='.repeat(60));
  console.log('GRAPH STRUCTURE');
  console.log('='.repeat(60));
  console.log('');

  console.log(`BRANCH nodes found: ${branchNodes.length}`);
  for (const branch of branchNodes) {
    console.log(`  - ID: ${branch.id}`);
    console.log(`    branchType: ${(branch as any).branchType}`);
    console.log(`    line: ${branch.line}`);
    console.log('');
  }

  console.log(`CASE nodes found: ${caseNodes.length}`);
  for (const caseNode of caseNodes) {
    console.log(`  - ID: ${caseNode.id}`);
    console.log(`    value: ${(caseNode as any).value}`);
    console.log(`    isDefault: ${(caseNode as any).isDefault}`);
    console.log(`    fallsThrough: ${(caseNode as any).fallsThrough}`);
    console.log(`    isEmpty: ${(caseNode as any).isEmpty}`);
    console.log('');
  }

  // Query edges
  let allEdges: any[] = [];
  for (const node of allNodes) {
    const outgoing = await backend.getOutgoingEdges(node.id);
    allEdges.push(...outgoing);
  }

  const hasConditionEdges = allEdges.filter(e => e.type === 'HAS_CONDITION');
  const hasCaseEdges = allEdges.filter(e => e.type === 'HAS_CASE');
  const hasDefaultEdges = allEdges.filter(e => e.type === 'HAS_DEFAULT');

  console.log('='.repeat(60));
  console.log('EDGES');
  console.log('='.repeat(60));
  console.log('');

  console.log(`HAS_CONDITION edges: ${hasConditionEdges.length}`);
  for (const edge of hasConditionEdges) {
    console.log(`  ${edge.src} --[HAS_CONDITION]--> ${edge.dst}`);
  }

  console.log(`HAS_CASE edges: ${hasCaseEdges.length}`);
  for (const edge of hasCaseEdges) {
    const dstNode = await backend.getNode(edge.dst);
    console.log(`  ${edge.src} --[HAS_CASE]--> CASE(${(dstNode as any)?.value || 'unknown'})`);
  }

  console.log(`HAS_DEFAULT edges: ${hasDefaultEdges.length}`);
  for (const edge of hasDefaultEdges) {
    console.log(`  ${edge.src} --[HAS_DEFAULT]--> ${edge.dst}`);
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('VERIFICATION');
  console.log('='.repeat(60));

  const pass =
    branchNodes.length >= 1 &&
    caseNodes.length >= 3 &&
    hasConditionEdges.length >= 1 &&
    hasCaseEdges.length >= 2 &&
    hasDefaultEdges.length >= 1;

  console.log(`BRANCH node created: ${branchNodes.length >= 1 ? 'YES' : 'NO'}`);
  console.log(`CASE nodes created (expected 3): ${caseNodes.length >= 3 ? 'YES' : 'NO'} (got ${caseNodes.length})`);
  console.log(`HAS_CONDITION edge: ${hasConditionEdges.length >= 1 ? 'YES' : 'NO'}`);
  console.log(`HAS_CASE edges (expected 2): ${hasCaseEdges.length >= 2 ? 'YES' : 'NO'} (got ${hasCaseEdges.length})`);
  console.log(`HAS_DEFAULT edge: ${hasDefaultEdges.length >= 1 ? 'YES' : 'NO'}`);
  console.log('');
  console.log(`OVERALL: ${pass ? 'PASS' : 'FAIL'}`);

  await (backend as any).cleanup();
  process.exit(pass ? 0 : 1);
}

demo().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});
