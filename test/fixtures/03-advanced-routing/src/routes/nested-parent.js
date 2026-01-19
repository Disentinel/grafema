import express from 'express';
import nestedChild from './nested-child.js';

const router = express.Router();

// Сценарий #2: Nested routers - роутер монтирует другой роутер
router.use('/child', nestedChild);

router.get('/', (req, res) => {
  res.json({ message: 'Nested parent root' });
});

export default router;
