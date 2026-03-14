const { chmodSync, readdirSync } = require('fs');
const { join } = require('path');

const binDir = join(__dirname, 'bin');
try {
  for (const f of readdirSync(binDir)) {
    if (f === '.gitkeep') continue;
    chmodSync(join(binDir, f), 0o755);
  }
} catch (_) {}
