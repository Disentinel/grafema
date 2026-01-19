import express from 'express';
import { getUsersRoute } from './routes/users.js';
import { getOrdersRoute } from './routes/orders.js';
import db from './db.js';

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json());

// Routes
app.use('/api/users', getUsersRoute());
app.use('/api/orders', getOrdersRoute());

// Health check
app.get('/health', (req, res) => {
  console.log('Health check requested');
  res.json({ status: 'ok' });
});

async function start() {
  await db.connect();
  console.log('Database connected');

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

start();
