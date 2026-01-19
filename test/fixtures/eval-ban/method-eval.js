// Method eval calls - should be detected

// window.eval (browser context)
// Note: This is a method call pattern obj.eval()
const obj = { eval: (x) => x };
obj.eval('test');

// globalThis.eval pattern (simulated)
const global = { eval: (x) => x };
global.eval('code');
