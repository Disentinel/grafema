/**
 * TCP socket server patterns - test fixture
 *
 * Patterns:
 * - net.createServer().listen(port) -> net:tcp-server
 * - net.createServer().listen({ port, host }) -> net:tcp-server
 */

const net = require('net');

// Pattern 1: createServer with chained listen on port
const server1 = net.createServer((socket) => {
  socket.write('Hello from TCP server');
  socket.end();
}).listen(3000);

// Pattern 2: createServer with options object listen
const server2 = net.createServer((socket) => {
  socket.on('data', (data) => {
    console.log('Received:', data.toString());
  });
}).listen({ port: 8080, host: '0.0.0.0' });

server1.on('listening', () => {
  console.log('TCP server 1 listening on port 3000');
});

server2.on('listening', () => {
  console.log('TCP server 2 listening on port 8080');
});
