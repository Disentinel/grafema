/**
 * Unix domain socket server patterns - test fixture
 *
 * Patterns:
 * - net.createServer().listen('/path') -> os:unix-server
 */

const net = require('net');

// Pattern 1: createServer with chained listen on path
const server = net.createServer((socket) => {
  socket.on('data', (data) => {
    console.log('Server received:', data.toString());
    socket.write('OK');
  });
}).listen('/tmp/app.sock');

server.on('listening', () => {
  console.log('Unix socket server listening on /tmp/app.sock');
});
