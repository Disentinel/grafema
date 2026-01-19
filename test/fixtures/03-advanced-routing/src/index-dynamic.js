import express from 'express';
import dynamicRouter from './routes/dynamic-prefixes.js';

const app = express();

// Сценарий #1: BinaryExpression (уже есть в index.js)
const API_VERSION = '/api/v3';
const resourcesPath = '/resources';
app.use(API_VERSION + resourcesPath, dynamicRouter); // Line 9

// Сценарий #2: TemplateLiteral с переменными
const version = 'v4';
app.use(`/api/${version}/dynamic`, dynamicRouter); // Line 13

// Сценарий #3: Переменная напрямую
const prefix = '/api/v5/dynamic';
app.use(prefix, dynamicRouter); // Line 17

// Сценарий #4: CallExpression (функция)
function getPrefix() {
  return '/api/v6/dynamic';
}
app.use(getPrefix(), dynamicRouter); // Line 23

// Сценарий #5: MemberExpression (объект)
const config = {
  apiPrefix: '/api/v7/dynamic',
  nested: {
    path: '/api/v8/dynamic'
  }
};
app.use(config.apiPrefix, dynamicRouter); // Line 31
app.use(config.nested.path, dynamicRouter); // Line 32

// Сценарий #6: ConditionalExpression (тернарный)
const env = process.env.NODE_ENV || 'development';
app.use(env === 'production' ? '/api/prod' : '/api/dev', dynamicRouter); // Line 36

// Сценарий #7: Array access
const prefixes = ['/api/v9', '/api/v10'];
app.use(prefixes[0], dynamicRouter); // Line 40

// Сценарий #8: Комбинация
app.use(`${config.apiPrefix}/extra`, dynamicRouter); // Line 43

app.listen(3000);
