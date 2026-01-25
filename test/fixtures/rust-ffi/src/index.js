// JS code that calls Rust NAPI functions

const { GraphEngine, computeHash } = require('../../../../packages/rfdb-server/navi.node');

// Create engine instance
const engine = new GraphEngine();

// Call NAPI methods
engine.addNode('first');
engine.addNode('second');

const nodes = engine.getNodes();
const count = engine.nodeCount;

// Direct function call
const hash = computeHash('test data');

console.log('Nodes:', nodes);
console.log('Count:', count);
console.log('Hash:', hash);

module.exports = { engine };
