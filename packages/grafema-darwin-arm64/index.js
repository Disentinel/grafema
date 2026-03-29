const path = require('path');
const bin = (...p) => path.join(__dirname, 'bin', ...p);

exports.rfdbServerPath = bin('rfdb-server');
exports.orchestratorPath = bin('grafema-orchestrator');
exports.binDir = path.join(__dirname, 'bin');
