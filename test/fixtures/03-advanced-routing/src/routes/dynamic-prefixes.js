import express from 'express';

const router = express.Router();

// Простые endpoints для тестирования динамических префиксов
router.get('/', (req, res) => {
  res.json({ message: 'Dynamic prefix root' });
});

router.get('/:id', (req, res) => {
  res.json({ id: req.params.id });
});

export default router;
