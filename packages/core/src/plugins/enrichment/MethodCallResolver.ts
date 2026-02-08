/**
 * MethodCallResolver - обогащает METHOD_CALL ноды связями CALLS к определениям методов
 *
 * Находит вызовы методов (CALL с "object" атрибутом) и пытается связать их с:
 * 1. Методами классов в том же файле
 * 2. Методами классов в импортированных модулях
 * 3. Методами объектов переменных
 *
 * СОЗДАЁТ РЁБРА:
 * - METHOD_CALL -> CALLS -> METHOD (для методов классов)
 * - METHOD_CALL -> CALLS -> FUNCTION (для методов объектов)
 */

import { Plugin, createSuccessResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';
import { StrictModeError, type ResolutionStep, type ResolutionFailureReason } from '../../errors/GrafemaError.js';

/**
 * Built-in JavaScript prototype methods that should never error in strict mode.
 * These exist on primitive types and common objects.
 */
const BUILTIN_PROTOTYPE_METHODS = new Set([
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
const COMMON_LIBRARY_METHODS = new Set([
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
interface MethodCallNode extends BaseNodeRecord {
  object?: string;
  method?: string;
  /** REG-332: Annotation to suppress strict mode errors */
  grafemaIgnore?: { code: string; reason?: string };
}

/**
 * Class entry in method index
 */
interface ClassEntry {
  classNode: BaseNodeRecord;
  methods: Map<string, BaseNodeRecord>;
}

export class MethodCallResolver extends Plugin {
  private _containingClassCache?: Map<string, BaseNodeRecord | null>;

  get metadata(): PluginMetadata {
    return {
      name: 'MethodCallResolver',
      phase: 'ENRICHMENT',
      priority: 50,
      creates: {
        nodes: [],
        edges: ['CALLS']
      }
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const logger = this.log(context);

    logger.info('Starting method call resolution');

    let methodCallsProcessed = 0;
    let edgesCreated = 0;
    let unresolved = 0;
    let externalSkipped = 0;
    let suppressedByIgnore = 0;  // REG-332: Count of errors suppressed by grafema-ignore
    const errors: Error[] = [];

    // Track library calls for coverage reporting
    const libraryCallStats = new Map<string, LibraryCallStats>();

    // Собираем все METHOD_CALL ноды (CALL с object атрибутом)
    // REG-332: Deduplicate by (object, method, file, line), preferring nodes with grafemaIgnore
    const methodCallMap = new Map<string, MethodCallNode>();
    for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
      const callNode = node as MethodCallNode;
      if (callNode.object) {
        // REG-332: Extract grafemaIgnore from metadata if present
        if (callNode.metadata) {
          try {
            const meta = typeof callNode.metadata === 'string'
              ? JSON.parse(callNode.metadata)
              : callNode.metadata;
            if (meta.grafemaIgnore) {
              callNode.grafemaIgnore = meta.grafemaIgnore;
            }
          } catch {
            // Ignore parse errors
          }
        }

        // Deduplicate: prefer node with grafemaIgnore if one exists
        const key = `${callNode.object}.${callNode.method}:${callNode.file}:${callNode.line}`;
        const existing = methodCallMap.get(key);
        if (!existing || (callNode.grafemaIgnore && !existing.grafemaIgnore)) {
          methodCallMap.set(key, callNode);
        }
      }
    }
    const methodCalls = Array.from(methodCallMap.values());

    logger.info('Found method calls to resolve', { count: methodCalls.length });

    // Собираем все классы и их методы для быстрого поиска
    const classMethodIndex = await this.buildClassMethodIndex(graph, logger);
    logger.info('Indexed classes', { count: classMethodIndex.size });

    // Собираем переменные и их типы (если известны)
    const variableTypes = await this.buildVariableTypeIndex(graph, logger);

    const startTime = Date.now();

    for (const methodCall of methodCalls) {
      methodCallsProcessed++;

      // Report progress every 50 calls
      if (onProgress && methodCallsProcessed % 50 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        onProgress({
          phase: 'enrichment',
          currentPlugin: 'MethodCallResolver',
          message: `Resolving method calls ${methodCallsProcessed}/${methodCalls.length} (${elapsed}s)`,
          totalFiles: methodCalls.length,
          processedFiles: methodCallsProcessed
        });
      }

      // Log every 10 calls with timing
      if (methodCallsProcessed % 10 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const avgTime = ((Date.now() - startTime) / methodCallsProcessed).toFixed(0);
        logger.debug('Progress', {
          processed: methodCallsProcessed,
          total: methodCalls.length,
          elapsed: `${elapsed}s`,
          avgTime: `${avgTime}ms/call`
        });
      }

      // Пропускаем внешние методы (console, Array.prototype, etc.)
      if (this.isExternalMethod(methodCall.object!, methodCall.method!)) {
        externalSkipped++;

        // Track library calls for coverage reporting (skip built-in objects)
        const obj = methodCall.object!;
        const method = methodCall.method!;
        if (!this.isBuiltInObject(obj) && !BUILTIN_PROTOTYPE_METHODS.has(method)) {
          this.trackLibraryCall(libraryCallStats, obj, method);
        }

        continue;
      }

      // Проверяем есть ли уже CALLS ребро
      const existingEdges = await graph.getOutgoingEdges(methodCall.id, ['CALLS']);
      if (existingEdges.length > 0) {
        continue; // Уже есть связь
      }

      // Пытаемся найти определение метода
      const targetMethod = await this.resolveMethodCall(
        methodCall,
        classMethodIndex,
        variableTypes,
        graph
      );

      if (targetMethod) {
        await graph.addEdge({
          src: methodCall.id,
          dst: targetMethod.id,
          type: 'CALLS'
        });
        edgesCreated++;
      } else {
        unresolved++;

        // In strict mode, collect error with context-aware analysis (REG-332)
        if (context.strictMode) {
          // REG-332: Check for grafema-ignore suppression
          if (methodCall.grafemaIgnore?.code === 'STRICT_UNRESOLVED_METHOD') {
            suppressedByIgnore++;
            logger.debug('Suppressed by grafema-ignore', {
              call: `${methodCall.object}.${methodCall.method}`,
              reason: methodCall.grafemaIgnore.reason,
            });
            continue;
          }

          // Analyze WHY resolution failed
          const { reason, chain } = this.analyzeResolutionFailure(
            methodCall,
            classMethodIndex,
            variableTypes
          );

          // Generate context-aware suggestion based on failure reason
          const suggestion = this.generateContextualSuggestion(
            methodCall.object!,
            methodCall.method!,
            reason,
            chain
          );

          const error = new StrictModeError(
            `Cannot resolve method call: ${methodCall.object}.${methodCall.method}`,
            'STRICT_UNRESOLVED_METHOD',
            {
              filePath: methodCall.file,
              lineNumber: methodCall.line as number | undefined,
              phase: 'ENRICHMENT',
              plugin: 'MethodCallResolver',
              object: methodCall.object,
              method: methodCall.method,
              resolutionChain: chain,
              failureReason: reason,
            },
            suggestion
          );
          errors.push(error);
        }
      }
    }

    // Convert library stats to array for reporting
    const libraryStats = Array.from(libraryCallStats.values())
      .sort((a, b) => b.totalCalls - a.totalCalls);

    const summary = {
      methodCallsProcessed,
      edgesCreated,
      unresolved,
      externalSkipped,
      suppressedByIgnore,  // REG-332
      classesIndexed: classMethodIndex.size,
      libraryStats
    };

    logger.info('Summary', {
      methodCallsProcessed,
      edgesCreated,
      unresolved,
      externalSkipped,
      suppressedByIgnore,  // REG-332
      libraryCallsTracked: libraryStats.length
    });

    // Log library coverage report if there are tracked calls
    if (libraryStats.length > 0) {
      logger.info('Library coverage report', {
        libraries: libraryStats.map(s => ({
          library: s.object,
          calls: s.totalCalls,
          semantic: s.semantic,
          suggestion: s.suggestedPlugin
        }))
      });
    }

    return createSuccessResult({ nodes: 0, edges: edgesCreated }, summary, errors);
  }

  /**
   * Строит индекс классов и их методов
   */
  private async buildClassMethodIndex(graph: PluginContext['graph'], logger: ReturnType<typeof this.log>): Promise<Map<string, ClassEntry>> {
    const index = new Map<string, ClassEntry>();
    const startTime = Date.now();
    let classCount = 0;

    for await (const classNode of graph.queryNodes({ nodeType: 'CLASS' })) {
      classCount++;
      if (classCount % 50 === 0) {
        logger.debug('Indexing classes', { count: classCount });
      }

      const className = classNode.name as string;
      if (!className) continue;

      const classEntry: ClassEntry = {
        classNode,
        methods: new Map()
      };

      const containsEdges = await graph.getOutgoingEdges(classNode.id, ['CONTAINS']);
      for (const edge of containsEdges) {
        const childNode = await graph.getNode(edge.dst);
        if (childNode && (childNode.type === 'METHOD' || childNode.type === 'FUNCTION')) {
          if (childNode.name) {
            classEntry.methods.set(childNode.name as string, childNode);
          }
        }
      }

      index.set(className, classEntry);

      // Также индексируем по файлу для локального резолвинга
      const fileKey = `${classNode.file}:${className}`;
      index.set(fileKey, classEntry);
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.debug('Indexed class entries', { count: index.size, time: `${totalTime}s` });

    return index;
  }

  /**
   * Строит индекс переменных и их типов (из INSTANCE_OF рёбер)
   */
  private async buildVariableTypeIndex(graph: PluginContext['graph'], logger: ReturnType<typeof this.log>): Promise<Map<string, string>> {
    const startTime = Date.now();
    const index = new Map<string, string>();

    for await (const classNode of graph.queryNodes({ nodeType: 'CLASS' })) {
      if (!classNode.name) continue;

      const incomingEdges = await graph.getIncomingEdges(classNode.id, ['INSTANCE_OF']);
      for (const edge of incomingEdges) {
        index.set(edge.src.toString(), classNode.name as string);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.debug('Built variable type index', { entries: index.size, time: `${elapsed}s` });
    return index;
  }

  /**
   * Пытается найти определение метода
   */
  private async resolveMethodCall(
    methodCall: MethodCallNode,
    classMethodIndex: Map<string, ClassEntry>,
    variableTypes: Map<string, string>,
    graph: PluginContext['graph']
  ): Promise<BaseNodeRecord | null> {
    const { object, method, file } = methodCall;

    if (!object || !method) return null;

    // 1. Проверяем если object - это имя класса напрямую (статический вызов)
    if (classMethodIndex.has(object)) {
      const classEntry = classMethodIndex.get(object)!;
      if (classEntry.methods.has(method)) {
        return classEntry.methods.get(method)!;
      }
    }

    // 2. Проверяем локальный класс в том же файле
    const localKey = `${file}:${object}`;
    if (classMethodIndex.has(localKey)) {
      const classEntry = classMethodIndex.get(localKey)!;
      if (classEntry.methods.has(method)) {
        return classEntry.methods.get(method)!;
      }
    }

    // 3. Проверяем если object - это "this" (ссылка на текущий класс)
    if (object === 'this') {
      if (!this._containingClassCache) this._containingClassCache = new Map();

      let containingClass = this._containingClassCache.get(methodCall.id);
      if (containingClass === undefined) {
        containingClass = await this.findContainingClass(methodCall, graph);
        this._containingClassCache.set(methodCall.id, containingClass);
      }

      if (containingClass && classMethodIndex.has(containingClass.name as string)) {
        const classEntry = classMethodIndex.get(containingClass.name as string)!;
        if (classEntry.methods.has(method)) {
          return classEntry.methods.get(method)!;
        }
      }
    }

    // 4. Используем variableTypes индекс
    for (const [, className] of variableTypes.entries()) {
      if (className && classMethodIndex.has(className)) {
        const classEntry = classMethodIndex.get(className)!;
        if (classEntry.methods.has(method)) {
          return classEntry.methods.get(method)!;
        }
      }
    }

    return null;
  }

  /**
   * Находит класс, содержащий данный method call
   */
  private async findContainingClass(
    methodCall: MethodCallNode,
    graph: PluginContext['graph']
  ): Promise<BaseNodeRecord | null> {
    const incomingEdges = await graph.getIncomingEdges(methodCall.id, ['CONTAINS']);

    for (const edge of incomingEdges) {
      const parentNode = await graph.getNode(edge.src);
      if (!parentNode) continue;

      if (parentNode.type === 'CLASS') {
        return parentNode;
      }

      const found = await this.findContainingClassRecursive(parentNode, graph, new Set());
      if (found) return found;
    }

    return null;
  }

  private async findContainingClassRecursive(
    node: BaseNodeRecord,
    graph: PluginContext['graph'],
    visited: Set<string>
  ): Promise<BaseNodeRecord | null> {
    if (visited.has(node.id.toString())) return null;
    visited.add(node.id.toString());

    const incomingEdges = await graph.getIncomingEdges(node.id, ['CONTAINS']);

    for (const edge of incomingEdges) {
      const parentNode = await graph.getNode(edge.src);
      if (!parentNode) continue;

      if (parentNode.type === 'CLASS') {
        return parentNode;
      }

      const found = await this.findContainingClassRecursive(parentNode, graph, visited);
      if (found) return found;
    }

    return null;
  }

  /**
   * Checks if a method call is external (built-in or well-known library).
   * In strict mode, external methods are skipped (no error if unresolved).
   */
  private isExternalMethod(object: string, method: string): boolean {
    // Known global objects (console, Math, etc.)
    const externalObjects = new Set([
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

    // Check if object is a known global
    if (externalObjects.has(object)) {
      return true;
    }

    // Check if method is a built-in prototype method
    if (BUILTIN_PROTOTYPE_METHODS.has(method)) {
      return true;
    }

    // Check if method is a common library method
    if (COMMON_LIBRARY_METHODS.has(method)) {
      return true;
    }

    return false;
  }

  /**
   * Check if object is a built-in JavaScript global (not a library namespace)
   */
  private isBuiltInObject(object: string): boolean {
    const builtInObjects = new Set([
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
    return builtInObjects.has(object);
  }

  /**
   * Track a library method call for coverage reporting
   */
  private trackLibraryCall(
    stats: Map<string, LibraryCallStats>,
    object: string,
    method: string
  ): void {
    if (!stats.has(object)) {
      const semanticInfo = LIBRARY_SEMANTIC_GROUPS[object];
      stats.set(object, {
        object,
        methods: new Map(),
        totalCalls: 0,
        semantic: semanticInfo?.semantic,
        suggestedPlugin: semanticInfo?.suggestedPlugin,
        description: semanticInfo?.description
      });
    }

    const libStats = stats.get(object)!;
    libStats.totalCalls++;
    libStats.methods.set(method, (libStats.methods.get(method) || 0) + 1);
  }

  /**
   * Analyze why method resolution failed (REG-332).
   * Returns the failure reason and resolution chain for context-aware suggestions.
   */
  private analyzeResolutionFailure(
    methodCall: MethodCallNode,
    classMethodIndex: Map<string, ClassEntry>,
    _variableTypes: Map<string, string>
  ): { reason: ResolutionFailureReason; chain: ResolutionStep[] } {
    const { object, method, file } = methodCall;
    const chain: ResolutionStep[] = [];

    if (!object || !method) {
      return { reason: 'unknown', chain };
    }

    // Check if object is a known class name (static call)
    if (classMethodIndex.has(object)) {
      const classEntry = classMethodIndex.get(object)!;
      chain.push({
        step: `${object} class lookup`,
        result: 'found',
        file: classEntry.classNode.file as string | undefined,
        line: classEntry.classNode.line as number | undefined,
      });

      if (!classEntry.methods.has(method)) {
        chain.push({
          step: `${object}.${method} method`,
          result: 'NOT FOUND in class',
        });
        return { reason: 'method_not_found', chain };
      }
    }

    // Check for local class in same file
    const localKey = `${file}:${object}`;
    if (classMethodIndex.has(localKey)) {
      const classEntry = classMethodIndex.get(localKey)!;
      chain.push({
        step: `${object} local class`,
        result: 'found in same file',
      });

      if (!classEntry.methods.has(method)) {
        chain.push({
          step: `${object}.${method} method`,
          result: 'NOT FOUND',
        });
        return { reason: 'method_not_found', chain };
      }
    }

    // Check if this is a library call
    if (LIBRARY_SEMANTIC_GROUPS[object]) {
      const libInfo = LIBRARY_SEMANTIC_GROUPS[object];
      chain.push({
        step: `${object} lookup`,
        result: `external library (${libInfo.semantic})`,
      });
      return { reason: 'external_dependency', chain };
    }

    // Object type is unknown
    chain.push({
      step: `${object} type lookup`,
      result: 'unknown (not in class index)',
    });
    chain.push({
      step: `${object}.${method}`,
      result: 'FAILED (no type information)',
    });

    return { reason: 'unknown_object_type', chain };
  }

  /**
   * Generate context-aware suggestion based on failure reason (REG-332).
   */
  private generateContextualSuggestion(
    object: string,
    method: string,
    reason: ResolutionFailureReason,
    chain: ResolutionStep[]
  ): string {
    switch (reason) {
      case 'unknown_object_type': {
        // Find the source in chain that shows "unknown"
        const sourceStep = chain.find(s => s.result.includes('unknown'));
        const sourceDesc = sourceStep?.step || 'the source';
        return `Variable "${object}" has unknown type from ${sourceDesc}. ` +
               `Add JSDoc: /** @type {${object}Class} */ or check imports.`;
      }

      case 'class_not_imported':
        return `Class "${object}" is not imported. Check your imports or ensure the class is defined.`;

      case 'method_not_found':
        return `Class "${object}" exists but has no method "${method}". ` +
               `Check spelling or verify the method is defined in the class.`;

      case 'external_dependency': {
        const libInfo = LIBRARY_SEMANTIC_GROUPS[object];
        if (libInfo?.suggestedPlugin) {
          return `This call is to external library "${object}" (${libInfo.semantic}). ` +
                 `Consider using ${libInfo.suggestedPlugin} for semantic analysis.`;
        }
        return `This call is to external library "${object}". ` +
               `Consider adding type stubs or a dedicated analyzer plugin.`;
      }

      case 'circular_reference':
        return `Alias chain for "${object}" is too deep (possible cycle). ` +
               `Simplify variable assignments or check for circular references.`;

      default:
        return `Check if class "${object}" is imported and has method "${method}".`;
    }
  }
}
