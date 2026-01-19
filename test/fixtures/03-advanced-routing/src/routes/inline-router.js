import express from 'express';

// Сценарий #3: Inline router - роутер создаётся в том же файле
const router = express.Router();

router.get('/', (req, res) => {
  res.json({ message: 'Inline router root' });
});

router.post('/', (req, res) => {
  res.json({ message: 'Created via inline router' });
});

router.get('/:id', (req, res) => {
  res.json({ id: req.params.id });
});

export default router;
