/**
 * Demo script for WorkspaceDiscovery
 * Tests the feature on Grafema itself (which uses pnpm workspaces)
 */

import { WorkspaceDiscovery, detectWorkspaceType, parsePnpmWorkspace, resolveWorkspacePackages } from '@grafema/core';
import { join } from 'path';

const GRAFEMA_ROOT = '/Users/vadimr/grafema';

/**
 * Mock GraphBackend for testing
 */
class MockGraphBackend {
  constructor() {
    this.nodes = new Map();
    this.edges = [];
  }

  async addNode(node) {
    this.nodes.set(node.id, node);
  }

  async getAllNodes() {
    return Array.from(this.nodes.values());
  }
}

console.log('='.repeat(60));
console.log('WORKSPACE DISCOVERY DEMO');
console.log('='.repeat(60));
console.log();

// Step 1: Detect workspace type
console.log('STEP 1: Detecting workspace type...');
console.log('-'.repeat(40));
const detection = detectWorkspaceType(GRAFEMA_ROOT);
console.log('Workspace type:', detection.type);
console.log('Config path:', detection.configPath);
console.log('Root path:', detection.rootPath);
console.log();

if (!detection.type) {
  console.error('ERROR: No workspace detected!');
  process.exit(1);
}

// Step 2: Parse workspace configuration
console.log('STEP 2: Parsing workspace configuration...');
console.log('-'.repeat(40));
const config = parsePnpmWorkspace(detection.configPath);
console.log('Patterns:', config.patterns);
console.log('Negative patterns:', config.negativePatterns);
console.log();

// Step 3: Resolve packages
console.log('STEP 3: Resolving workspace packages...');
console.log('-'.repeat(40));
const packages = resolveWorkspacePackages(GRAFEMA_ROOT, config);
console.log('Found', packages.length, 'packages:');
for (const pkg of packages) {
  console.log(`  - ${pkg.name} (${pkg.relativePath})`);
}
console.log();

// Step 4: Run full plugin
console.log('STEP 4: Running WorkspaceDiscovery plugin...');
console.log('-'.repeat(40));
const graph = new MockGraphBackend();
const plugin = new WorkspaceDiscovery();
const context = {
  graph,
  projectPath: GRAFEMA_ROOT,
  phase: 'DISCOVERY',
};

const result = await plugin.execute(context);

console.log('Result success:', result.success);
console.log('Nodes created:', result.created.nodes);
console.log('Workspace type:', result.metadata.workspaceType);
console.log();

// Step 5: Inspect created SERVICE nodes
console.log('STEP 5: Inspecting created SERVICE nodes...');
console.log('-'.repeat(40));
const nodes = await graph.getAllNodes();

for (const node of nodes) {
  console.log(`SERVICE: ${node.name}`);
  console.log(`  ID: ${node.id}`);
  console.log(`  Path: ${node.filePath || node.file}`);
  console.log(`  Version: ${node.version}`);
  console.log(`  Description: ${node.description || 'N/A'}`);
  console.log(`  Entrypoint: ${node.entrypoint}`);
  console.log(`  Dependencies: ${JSON.stringify(node.dependencies?.slice(0, 5) || [])}`);
  console.log(`  Workspace metadata:`, JSON.stringify(node.metadata, null, 4));
  console.log();
}

console.log('='.repeat(60));
console.log('DEMO COMPLETE');
console.log('='.repeat(60));
