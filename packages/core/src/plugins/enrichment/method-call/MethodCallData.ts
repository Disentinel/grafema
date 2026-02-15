/**
 * MethodCallData - Constants, types, and data sets for method call resolution.
 *
 * Extracted from MethodCallResolver.ts (REG-463).
 * Contains all static data used by the resolver: built-in method sets,
 * library method patterns, semantic groups, and type definitions.
 */

import type { BaseNodeRecord } from '@grafema/types';

/**
 * Built-in JavaScript prototype methods that should never error in strict mode.
 * These exist on primitive types and common objects.
 */
export const BUILTIN_PROTOTYPE_METHODS = new Set([
  // Array.prototype
  'concat', 'copyWithin', 'entries', 'every', 'fill', 'filter', 'find',
  'findIndex', 'findLast', 'findLastIndex', 'flat', 'flatMap', 'forEach',
  'includes', 'indexOf', 'join', 'keys', 'lastIndexOf', 'map', 'pop',
  'push', 'reduce', 'reduceRight', 'reverse', 'shift', 'slice', 'some',
  'sort', 'splice', 'toLocaleString', 'toReversed', 'toSorted', 'toSpliced',
  'toString', 'unshift', 'values', 'with', 'at',

  // String.prototype
  'charAt', 'charCodeAt', 'codePointAt', 'endsWith', 'localeCompare',
  'match', 'matchAll', 'normalize', 'padEnd', 'padStart', 'repeat',
  'replace', 'replaceAll', 'search', 'split', 'startsWith', 'substring',
  'toLocaleLowerCase', 'toLocaleUpperCase', 'toLowerCase', 'toUpperCase',
  'trim', 'trimEnd', 'trimStart',

  // Object.prototype (commonly called on objects)
  'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'valueOf',

  // Number.prototype
  'toExponential', 'toFixed', 'toPrecision',

  // Date.prototype
  'getDate', 'getDay', 'getFullYear', 'getHours', 'getMilliseconds',
  'getMinutes', 'getMonth', 'getSeconds', 'getTime', 'getTimezoneOffset',
  'getUTCDate', 'getUTCDay', 'getUTCFullYear', 'getUTCHours',
  'getUTCMilliseconds', 'getUTCMinutes', 'getUTCMonth', 'getUTCSeconds',
  'setDate', 'setFullYear', 'setHours', 'setMilliseconds', 'setMinutes',
  'setMonth', 'setSeconds', 'setTime', 'setUTCDate', 'setUTCFullYear',
  'setUTCHours', 'setUTCMilliseconds', 'setUTCMinutes', 'setUTCMonth',
  'setUTCSeconds', 'toDateString', 'toISOString', 'toJSON',
  'toLocaleDateString', 'toLocaleTimeString', 'toTimeString', 'toUTCString',

  // Map.prototype
  'clear', 'delete', 'get', 'has', 'set', 'size',

  // Set.prototype (same as Map + add)
  'add',

  // Promise.prototype
  'then', 'catch', 'finally',

  // Function.prototype
  'apply', 'bind', 'call',

  // RegExp.prototype
  'exec', 'test',
]);

/**
 * Common library method patterns that should be treated as external.
 * These are methods from well-known npm packages.
 */
export const COMMON_LIBRARY_METHODS = new Set([
  // Express/HTTP response
  'json', 'status', 'send', 'redirect', 'render', 'sendFile', 'sendStatus',
  'type', 'format', 'attachment', 'download', 'end', 'cookie', 'clearCookie',
  'location', 'links', 'jsonp', 'vary', 'append', 'header', 'setHeader',

  // Express router/app
  'use', 'route', 'param', 'all', 'listen',

  // HTTP methods (router.get, router.post, etc.)
  // Note: 'get' is also in BUILTIN_PROTOTYPE_METHODS (Map.get)
  'post', 'put', 'patch', 'options', 'head',

  // Socket.io
  'on', 'emit', 'to', 'in', 'join', 'leave', 'disconnect', 'broadcast',
  'once', 'off', 'removeListener', 'removeAllListeners',

  // EventEmitter
  'addListener', 'prependListener', 'prependOnceListener', 'listeners',
  'listenerCount', 'eventNames', 'rawListeners', 'setMaxListeners',
  'getMaxListeners',

  // Fetch API / Response
  'text', 'blob', 'arrayBuffer', 'formData', 'clone', 'ok', 'redirected',

  // Node.js streams
  'pipe', 'unpipe', 'read', 'write', 'pause', 'resume', 'destroy', 'cork',
  'uncork', 'setEncoding', 'setDefaultEncoding',

  // Axios
  'request', 'interceptors', 'create',

  // JWT (jsonwebtoken)
  'sign', 'verify', 'decode',

  // Telegram bot API (node-telegram-bot-api)
  'sendMessage', 'sendPhoto', 'sendDocument', 'sendVideo', 'sendAudio',
  'sendSticker', 'sendVoice', 'sendLocation', 'sendVenue', 'sendContact',
  'sendPoll', 'sendDice', 'sendChatAction', 'onText', 'onMessage',
  'answerCallbackQuery', 'editMessageText', 'deleteMessage', 'forwardMessage',
  'copyMessage', 'getUpdates', 'setWebHook', 'deleteWebHook', 'getWebHookInfo',

  // Database (SQLite, better-sqlite3, knex, sequelize)
  'run', 'all', 'prepare', 'exec', 'query', 'transaction', 'pragma',
  'backup', 'serialize', 'parallelize', 'raw', 'select', 'insert', 'update',
  'from', 'where', 'whereIn', 'whereNot', 'orWhere', 'andWhere',
  'orderBy', 'groupBy', 'having', 'limit', 'offset', 'first',

  // Express-validator
  'custom', 'isEmail', 'isLength', 'isNumeric', 'isInt', 'isFloat',
  'isBoolean', 'isDate', 'isURL', 'isUUID', 'isEmpty', 'isNotEmpty',
  'exists', 'optional', 'notEmpty', 'bail', 'withMessage', 'sanitize',
  'trim', 'escape', 'normalizeEmail', 'toInt', 'toFloat', 'toBoolean',
  'toDate', 'check', 'body', 'param', 'validationResult',

  // dotenv
  'config', 'parse',

  // SQLite (statement methods)
  'finalize', 'step', 'bind', 'reset', 'columns', 'safeIntegers',
  'pluck', 'expand', 'iterate', 'reader',

  // Additional Telegram bot methods
  'editMessageReplyMarkup', 'editMessageCaption', 'editMessageMedia',
  'stopPoll', 'sendMediaGroup', 'sendAnimation', 'sendVideoNote',
  'kickChatMember', 'banChatMember', 'unbanChatMember', 'restrictChatMember',
  'promoteChatMember', 'setChatPermissions', 'setChatPhoto', 'deleteChatPhoto',
  'setChatTitle', 'setChatDescription', 'pinChatMessage', 'unpinChatMessage',
  'leaveChat', 'getChat', 'getChatMember', 'getChatMembersCount',
  'getChatAdministrators', 'answerInlineQuery', 'sendInvoice',
  'answerShippingQuery', 'answerPreCheckoutQuery', 'getMe',

  // Crypto
  'digest', 'update', 'hash', 'createHash', 'createHmac', 'createCipheriv',
  'createDecipheriv', 'randomBytes', 'pbkdf2', 'scrypt', 'generateKeyPair',

  // Express factory methods
  'urlencoded', 'static', 'Router',

  // DOM
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'querySelector',
  'querySelectorAll', 'getElementById', 'getElementsByClassName',
  'getElementsByTagName', 'createElement', 'createTextNode', 'appendChild',
  'removeChild', 'insertBefore', 'replaceChild', 'cloneNode', 'getAttribute',
  'setAttribute', 'removeAttribute', 'hasAttribute', 'classList', 'focus',
  'blur', 'click', 'submit', 'reset', 'preventDefault', 'stopPropagation',
  'stopImmediatePropagation',

  // Browser storage
  'getItem', 'setItem', 'removeItem', 'key', 'length',

  // React
  'createRoot', 'render', 'unmount', 'useState', 'useEffect', 'useCallback',
  'useMemo', 'useRef', 'useContext', 'useReducer',
]);

/**
 * Semantic groups for library coverage reporting.
 * Maps library namespaces to their semantic category and suggested plugin.
 */
export const LIBRARY_SEMANTIC_GROUPS: Record<string, { semantic: string; suggestedPlugin: string; description: string }> = {
  // HTTP Clients
  axios: { semantic: 'http-client', suggestedPlugin: 'FetchAnalyzer', description: 'HTTP requests not tracked' },
  got: { semantic: 'http-client', suggestedPlugin: 'FetchAnalyzer', description: 'HTTP requests not tracked' },
  superagent: { semantic: 'http-client', suggestedPlugin: 'FetchAnalyzer', description: 'HTTP requests not tracked' },
  request: { semantic: 'http-client', suggestedPlugin: 'FetchAnalyzer', description: 'HTTP requests not tracked' },
  ky: { semantic: 'http-client', suggestedPlugin: 'FetchAnalyzer', description: 'HTTP requests not tracked' },

  // HTTP Response (Express-like)
  res: { semantic: 'http-response', suggestedPlugin: 'ExpressResponseAnalyzer', description: 'Response data flow not tracked' },
  ctx: { semantic: 'http-response', suggestedPlugin: 'KoaResponseAnalyzer', description: 'Response data flow not tracked' },
  reply: { semantic: 'http-response', suggestedPlugin: 'FastifyResponseAnalyzer', description: 'Response data flow not tracked' },

  // Routers
  router: { semantic: 'http-router', suggestedPlugin: 'ExpressRouteAnalyzer', description: 'Routes may not be tracked' },
  app: { semantic: 'http-router', suggestedPlugin: 'ExpressRouteAnalyzer', description: 'Routes may not be tracked' },

  // WebSocket
  socket: { semantic: 'websocket', suggestedPlugin: 'SocketIOAnalyzer', description: 'WebSocket events not tracked' },
  io: { semantic: 'websocket', suggestedPlugin: 'SocketIOAnalyzer', description: 'WebSocket events not tracked' },
  ws: { semantic: 'websocket', suggestedPlugin: 'WebSocketAnalyzer', description: 'WebSocket events not tracked' },

  // Database
  knex: { semantic: 'database', suggestedPlugin: 'KnexAnalyzer', description: 'Database queries not tracked' },
  sequelize: { semantic: 'database', suggestedPlugin: 'SequelizeAnalyzer', description: 'Database queries not tracked' },
  prisma: { semantic: 'database', suggestedPlugin: 'PrismaAnalyzer', description: 'Database queries not tracked' },
  mongoose: { semantic: 'database', suggestedPlugin: 'MongooseAnalyzer', description: 'Database queries not tracked' },
  db: { semantic: 'database', suggestedPlugin: 'DatabaseAnalyzer', description: 'Database queries not tracked' },
  pool: { semantic: 'database', suggestedPlugin: 'DatabaseAnalyzer', description: 'Database queries not tracked' },

  // Auth
  jwt: { semantic: 'auth', suggestedPlugin: 'AuthAnalyzer', description: 'Auth flow not visible' },
  jsonwebtoken: { semantic: 'auth', suggestedPlugin: 'AuthAnalyzer', description: 'Auth flow not visible' },
  passport: { semantic: 'auth', suggestedPlugin: 'PassportAnalyzer', description: 'Auth strategies not tracked' },
  bcrypt: { semantic: 'auth', suggestedPlugin: 'AuthAnalyzer', description: 'Password handling not tracked' },

  // Validation
  validator: { semantic: 'validation', suggestedPlugin: 'ValidationAnalyzer', description: 'Validation rules not tracked' },
  joi: { semantic: 'validation', suggestedPlugin: 'JoiAnalyzer', description: 'Validation schemas not tracked' },
  yup: { semantic: 'validation', suggestedPlugin: 'YupAnalyzer', description: 'Validation schemas not tracked' },
  zod: { semantic: 'validation', suggestedPlugin: 'ZodAnalyzer', description: 'Validation schemas not tracked' },

  // Logging
  logger: { semantic: 'logging', suggestedPlugin: 'LoggingAnalyzer', description: 'Log statements not tracked' },
  winston: { semantic: 'logging', suggestedPlugin: 'LoggingAnalyzer', description: 'Log statements not tracked' },
  pino: { semantic: 'logging', suggestedPlugin: 'LoggingAnalyzer', description: 'Log statements not tracked' },
  bunyan: { semantic: 'logging', suggestedPlugin: 'LoggingAnalyzer', description: 'Log statements not tracked' },

  // Telegram bot
  bot: { semantic: 'telegram-bot', suggestedPlugin: 'TelegramBotAnalyzer', description: 'Bot commands not tracked' },
};

/**
 * Library call statistics for coverage reporting
 */
export interface LibraryCallStats {
  object: string;
  methods: Map<string, number>; // method -> count
  totalCalls: number;
  semantic?: string;
  suggestedPlugin?: string;
  description?: string;
}

/**
 * Extended call node with method properties
 */
export interface MethodCallNode extends BaseNodeRecord {
  object?: string;
  method?: string;
  /** REG-332: Annotation to suppress strict mode errors */
  grafemaIgnore?: { code: string; reason?: string };
}

/**
 * Class entry in method index
 */
export interface ClassEntry {
  classNode: BaseNodeRecord;
  methods: Map<string, BaseNodeRecord>;
}

/**
 * Known global objects (console, Math, etc.) and common npm package namespaces.
 * Used by isExternalMethod() to identify calls that should not be resolved.
 */
export const EXTERNAL_OBJECTS = new Set([
  'console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number',
  'Boolean', 'Date', 'RegExp', 'Error', 'Promise', 'Set', 'Map',
  'WeakSet', 'WeakMap', 'Symbol', 'Proxy', 'Reflect', 'Intl',
  'process', 'global', 'window', 'document', 'Buffer',
  'fs', 'path', 'http', 'https', 'crypto', 'os', 'url', 'util',
  'localStorage', 'sessionStorage', 'navigator', 'location', 'history',
  'performance', 'fetch', 'XMLHttpRequest', 'WebSocket',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame',
  'Atomics', 'SharedArrayBuffer', 'DataView', 'ArrayBuffer',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array',
  'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array',
  'Float64Array', 'BigInt64Array', 'BigUint64Array',
  // Common npm package namespaces
  'dotenv', 'express', 'axios', 'lodash', '_', 'moment', 'dayjs',
  'sqlite3', 'pg', 'mysql', 'mysql2', 'mongodb', 'mongoose', 'sequelize',
  'knex', 'typeorm', 'prisma', 'jwt', 'jsonwebtoken', 'bcrypt', 'bcryptjs',
  'passport', 'multer', 'nodemailer', 'winston', 'bunyan', 'pino',
  'chalk', 'colors', 'yargs', 'commander', 'inquirer', 'ora', 'figlet',
  'uuid', 'nanoid', 'shortid', 'validator', 'joi', 'yup', 'zod',
  'cheerio', 'puppeteer', 'playwright', 'selenium', 'sharp', 'jimp',
  'socket', 'io', 'ws', 'Redis', 'redis', 'ioredis', 'amqp', 'amqplib',
  'aws', 'AWS', 's3', 'sqs', 'sns', 'lambda', 'dynamodb',
  'React', 'ReactDOM', 'Vue', 'vue', 'angular', 'Angular',
]);

/**
 * Built-in JavaScript global objects (not library namespaces).
 * Used to distinguish built-in objects from library calls for coverage reporting.
 */
export const BUILTIN_OBJECTS = new Set([
  'console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number',
  'Boolean', 'Date', 'RegExp', 'Error', 'Promise', 'Set', 'Map',
  'WeakSet', 'WeakMap', 'Symbol', 'Proxy', 'Reflect', 'Intl',
  'process', 'global', 'window', 'document', 'Buffer',
  'fs', 'path', 'http', 'https', 'crypto', 'os', 'url', 'util',
  'localStorage', 'sessionStorage', 'navigator', 'location', 'history',
  'performance', 'fetch', 'XMLHttpRequest', 'WebSocket',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame',
  'Atomics', 'SharedArrayBuffer', 'DataView', 'ArrayBuffer',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array',
  'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array',
  'Float64Array', 'BigInt64Array', 'BigUint64Array',
]);
