import express from 'express';
import db from '../db.js';

export function getUsersRoute() {
  const router = express.Router();

  // GET /api/users
  router.get('/', async (req, res) => {
    console.log('Fetching all users');
    const users = await db.query('SELECT * FROM users');
    res.json(users);
  });

  // GET /api/users/:id
  router.get('/:id', async (req, res) => {
    const { id } = req.params;
    console.log(`Fetching user ${id}`);
    const user = await db.query('SELECT * FROM users WHERE id = ?', [id]);
    res.json(user);
  });

  // POST /api/users
  router.post('/', async (req, res) => {
    const { name, email } = req.body;
    console.log(`Creating user: ${name}`);
    const result = await db.query('INSERT INTO users (name, email) VALUES (?, ?)', [name, email]);
    res.json({ id: result.insertId });
  });

  return router;
}
