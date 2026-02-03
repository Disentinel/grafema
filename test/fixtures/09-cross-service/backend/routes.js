/**
 * Test fixture for ExpressResponseAnalyzer (REG-252)
 *
 * Demonstrates various response patterns that should be detected:
 * - res.json(object) - returns object literal
 * - res.send(variable) - returns via variable
 * - res.status(200).json(data) - chained response
 * - Conditional responses (multiple paths)
 */

import express from 'express';

const router = express.Router();

// Pattern 1: res.json with object literal
router.get('/users', (req, res) => {
  res.json({ users: [], total: 0 });
});

// Pattern 2: res.send with variable
router.get('/status', (req, res) => {
  const statusData = { status: 'ok', timestamp: Date.now() };
  res.send(statusData);
});

// Pattern 3: Chained res.status(200).json(data)
router.post('/items', (req, res) => {
  const item = { id: 1, name: 'test' };
  res.status(201).json(item);
});

// Pattern 4: Multiple response paths (conditional)
router.get('/item/:id', (req, res) => {
  const id = req.params.id;
  if (id === '0') {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json({ id, name: 'Found item' });
});

// Pattern 5: Handler as named function
function handleHealth(req, res) {
  res.json({ healthy: true });
}
router.get('/health', handleHealth);

export default router;
