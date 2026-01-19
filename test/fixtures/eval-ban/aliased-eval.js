// Aliased eval - should be detected via AliasTracker

// Simple alias
const e = eval;
e('1 + 1');

// Chain alias
const evaluator = eval;
const run = evaluator;
run('2 + 2');

// Destructuring alias (edge case)
const { eval: myEval } = globalThis;
// myEval('3 + 3'); // This would be harder to detect
