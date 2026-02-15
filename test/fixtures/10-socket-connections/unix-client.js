/**
 * Unix domain socket client patterns - test fixture
 *
 * Patterns:
 * - net.connect({ path: '...' }) -> os:unix-socket
 * - net.createConnection('...') -> os:unix-socket
 */

const net = require('net');

// Pattern 1: net.connect with options object containing path
function connectToAppSocket() {
  const client = net.connect({ path: '/tmp/app.sock' });
  client.on('connect', () => {
    console.log('Connected to app socket');
  });
  return client;
}

// Pattern 2: net.createConnection with path string
function connectToRfdb() {
  const client = net.createConnection('/var/run/rfdb.sock');
  client.on('data', (data) => {
    console.log('Received:', data.toString());
  });
  return client;
}
