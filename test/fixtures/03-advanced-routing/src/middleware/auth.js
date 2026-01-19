// Сценарий #1: Middleware без префикса
export function authMiddleware(req, res, next) {
  // Проверка авторизации
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

export function loggingMiddleware(req, res, next) {
  console.log(`${req.method} ${req.path}`);
  next();
}
