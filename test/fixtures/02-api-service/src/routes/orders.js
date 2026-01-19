import express from 'express';
import db from '../db.js';

export function getOrdersRoute() {
  const router = express.Router();

  // GET /api/orders
  router.get('/', async (req, res) => {
    console.log('Fetching all orders');
    const orders = await db.query('SELECT * FROM orders');
    res.json(orders);
  });

  // POST /api/orders
  router.post('/', async (req, res) => {
    const { userId, items } = req.body;
    console.log(`Creating order for user ${userId}`);
    const result = await db.query('INSERT INTO orders (user_id, items) VALUES (?, ?)', [userId, JSON.stringify(items)]);
    res.json({ id: result.insertId });
  });

  return router;
}
