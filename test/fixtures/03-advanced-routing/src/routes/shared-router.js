import express from 'express';

const router = express.Router();

// Сценарий #5: Multiple mount points - этот роутер будет смонтирован дважды
router.get('/', (req, res) => {
  res.json({ message: 'Shared router root' });
});

router.get('/:id', (req, res) => {
  res.json({ id: req.params.id });
});

export default router;
