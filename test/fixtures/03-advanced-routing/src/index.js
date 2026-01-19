import express from 'express';
import inlineRouter from './routes/inline-router.js';
import nestedParent from './routes/nested-parent.js';
import sharedRouter from './routes/shared-router.js';
import { authMiddleware, loggingMiddleware } from './middleware/auth.js';

const app = express();

// Сценарий #1: app.use() без префикса - middleware
app.use(authMiddleware);
app.use(loggingMiddleware);

// Сценарий #3: Inline router
// Expected endpoints: GET /api/inline/, POST /api/inline/, GET /api/inline/:id
app.use('/api/inline', inlineRouter);

// Сценарий #2: Nested routers
// Expected endpoints:
//   GET /api/nested/ (from nested-parent)
//   GET /api/nested/child/ (from nested-child)
//   POST /api/nested/child/action (from nested-child)
app.use('/api/nested', nestedParent);

// Сценарий #5: Multiple mount points для одного роутера
// Expected endpoints:
//   GET /api/v1/shared/, GET /api/v1/shared/:id
//   GET /api/v2/shared/, GET /api/v2/shared/:id
app.use('/api/v1/shared', sharedRouter);
app.use('/api/v2/shared', sharedRouter);

// Сценарий #4: Variable-based prefix
const API_VERSION = '/api/v3';
const resourcesPath = '/resources';
app.use(API_VERSION + resourcesPath, sharedRouter);

// Простой endpoint для health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(3000, () => {
  console.log('Server running on port 3000');
});
