/**
 * Socket.IO Client - test fixture
 * Паттерны: socket.on, socket.emit, useEffect hooks
 */

const socket = io('http://localhost:3000');

// Event listeners
socket.on('connect', () => {
  console.log('Connected to server');
});

socket.on('slot:booked', (data) => {
  console.log('Slot booked:', data);
  updateUI(data);
});

socket.on('message:received', (msg) => {
  displayMessage(msg);
});

socket.on('user:typing', (data) => {
  showTypingIndicator(data.userId);
});

socket.on('disconnect', () => {
  console.log('Disconnected from server');
});

// Emitting events
function bookSlot(slotId) {
  socket.emit('slot:book', { slotId, userId: getCurrentUser() });
}

function sendMessage(text) {
  socket.emit('message', { text, timestamp: Date.now() });
}

// React hook example
function useSocket(event, handler) {
  useEffect(() => {
    socket.on(event, handler);
    return () => socket.off(event, handler);
  }, [event, handler]);
}

// Component usage
function GigView({ gigId }) {
  useSocket('slot:booked', (data) => {
    setSlots(prev => updateSlots(prev, data));
  });

  useSocket('user:joined', (data) => {
    setParticipants(prev => [...prev, data.user]);
  });

  return null;
}
