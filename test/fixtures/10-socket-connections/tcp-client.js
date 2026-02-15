/**
 * TCP socket client patterns - test fixture
 *
 * Patterns:
 * - net.connect({ port: N, host: '...' }) -> net:tcp-connection
 * - net.connect(port) -> net:tcp-connection
 */

const net = require('net');

// Pattern 1: net.connect with options object
function connectToServer() {
  const client = net.connect({ port: 3000, host: 'localhost' });
  client.on('connect', () => {
    console.log('Connected to TCP server');
  });
  return client;
}

// Pattern 2: net.connect with port number only
function connectToBackup() {
  const client = net.connect(8080);
  client.on('data', (data) => {
    console.log('Received:', data.toString());
  });
  return client;
}
