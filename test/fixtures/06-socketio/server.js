/**
 * Socket.IO Server - test fixture
 * Паттерны: emit, on, to, join, broadcast
 */

const io = require('socket.io')(httpServer);
const socketService = require('./services/socketService');

// Simple emit
io.emit('server:ready', { status: 'online' });

// Room-based emit
io.to('gig:123').emit('slot:booked', { slotId: 1, user: 'John' });

// Namespace emit
io.of('/admin').emit('user:joined', { userId: 42 });

// Connection handler
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join room
  socket.join('gig:123');
  socket.join(`user:${socket.userId}`);

  // Listen to events
  socket.on('slot:book', async (data) => {
    const result = await bookSlot(data);
    socket.emit('slot:booked', result);
    socket.to('gig:123').emit('slot:updated', result);
  });

  socket.on('message', (msg) => {
    io.to('gig:123').emit('message:received', msg);
  });

  // Broadcast (to all except sender)
  socket.on('user:typing', () => {
    socket.broadcast.emit('user:typing', { userId: socket.userId });
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    io.emit('user:left', { userId: socket.userId });
  });
});

// Service-based emit
function notifySlotBooked(gigId, data) {
  socketService.emitToGig(gigId, 'slot:booked', data);
}

// Scheduled emit
setInterval(() => {
  io.emit('heartbeat', { timestamp: Date.now() });
}, 30000);
