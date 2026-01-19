import express from 'express';

const router = express.Router();

// Endpoints внутри nested child router
router.get('/', (req, res) => {
  res.json({ message: 'Nested child root' });
});

router.post('/action', (req, res) => {
  res.json({ message: 'Nested child action' });
});

export default router;
