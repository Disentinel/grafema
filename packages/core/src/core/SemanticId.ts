/**
 * SemanticId - Stable identifiers for code elements
 *
 * Semantic IDs provide stable identifiers for code elements that don't change
 * when unrelated code is added/removed (no line numbers in IDs).
 *
 * Format: {file}->{scope_path}->{type}->{name}[#discriminator]
 *
 * Examples:
 *   src/app.js->global->FUNCTION->processData
 *   src/app.js->UserService->METHOD->login
 *   src/app.js->getUser->if#0->CALL->console.log#0
 *
 * Special formats:
 *   Singletons: net:stdio->__stdio__
 *   External modules: EXTERNAL_MODULE->lodash
 */

/**
 * Location in source file
 */
export interface Location {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

/**
 * Scope context for semantic ID generation
 */
export interface ScopeContext {
  /** Source file path */
  file: string;
  /** Array of scope names, e.g. ['MyClass', 'myMethod', 'if#1'] */
  scopePath: string[];
}

/**
 * Options for semantic ID generation
 */
export interface SemanticIdOptions {
  /** Counter for disambiguation (#N) */
  discriminator?: number;
  /** Context string for special cases ([context]) */
  context?: string;
}

/**
 * Parsed semantic ID components
 */
export interface ParsedSemanticId {
  file: string;
  scopePath: string[];
  type: string;
  name: string;
  discriminator?: number;
  context?: string;
}

/**
 * Item with name and location for discriminator computation
 */
export interface LocatedItem {
  name: string;
  location: Location;
}

// =============================================================================
// Semantic ID v2
// =============================================================================

/**
 * Parsed v2 semantic ID components.
 *
 * v2 format: file->TYPE->name[in:namedParent,h:xxxx]#N
 *
 * Key difference from v1: no scope path in ID. Only nearest named ancestor
 * (namedParent) is encoded. Anonymous scopes (if, for, try) are invisible.
 */
export interface ParsedSemanticIdV2 {
  file: string;
  type: string;
  name: string;
  namedParent?: string;
  contentHash?: string;
  counter?: number;
}

/**
 * Content hint data for computing content hash.
 * Each node type supplies different hints for disambiguation.
 */
export interface ContentHashHints {
  /** Number of arguments (CALL) or parameters (FUNCTION) */
  arity?: number;
  /** First literal argument value (CALL) */
  firstLiteralArg?: string;
  /** First parameter name (FUNCTION) */
  firstParamName?: string;
  /** RHS expression type (VARIABLE/CONSTANT) */
  rhsType?: string;
  /** First significant token of RHS (VARIABLE/CONSTANT) */
  rhsToken?: string;
  /** Object expression chain (PROPERTY_ACCESS) */
  objectChain?: string;
}

/**
 * Compute semantic ID for any node type.
 *
 * @param type - Node type (FUNCTION, CALL, VARIABLE, etc.)
 * @param name - Node name
 * @param context - Scope context from ScopeTracker
 * @param options - Optional discriminator or context
 * @returns Semantic ID string
 */
export function computeSemanticId(
  type: string,
  name: string,
  context: ScopeContext,
  options?: SemanticIdOptions
): string {
  const { file, scopePath } = context;
  const scope = scopePath.length > 0 ? scopePath.join('->') : 'global';

  let id = `${file}->${scope}->${type}->${name}`;

  if (options?.discriminator !== undefined) {
    id += `#${options.discriminator}`;
  } else if (options?.context) {
    id += `[${options.context}]`;
  }

  return id;
}

/**
 * Parse semantic ID back to components.
 *
 * @param id - Semantic ID to parse
 * @returns Parsed components or null if invalid
 */
export function parseSemanticId(id: string): ParsedSemanticId | null {
  // Handle singletons
  if (id.startsWith('net:stdio') || id.startsWith('net:request')) {
    const [prefix, name] = id.split('->');
    return {
      file: '',
      scopePath: [prefix],
      type: 'SINGLETON',
      name,
      discriminator: undefined
    };
  }

  if (id.startsWith('EXTERNAL_MODULE')) {
    const [, name] = id.split('->');
    return {
      file: '',
      scopePath: [],
      type: 'EXTERNAL_MODULE',
      name,
      discriminator: undefined
    };
  }

  const parts = id.split('->');
  if (parts.length < 4) return null;

  const file = parts[0];
  const type = parts[parts.length - 2];
  let name = parts[parts.length - 1];
  const scopePath = parts.slice(1, -2);

  // Parse discriminator or context
  let discriminator: number | undefined;
  let context: string | undefined;

  const hashMatch = name.match(/^(.+)#(\d+)$/);
  if (hashMatch) {
    name = hashMatch[1];
    discriminator = parseInt(hashMatch[2], 10);
  }

  const bracketMatch = name.match(/^(.+)\[(.+)\]$/);
  if (bracketMatch) {
    name = bracketMatch[1];
    context = bracketMatch[2];
  }

  return { file, scopePath, type, name, discriminator, context };
}

/**
 * Compute discriminator for items with same name in same scope.
 * Uses line/column for stable ordering.
 *
 * @param items - All items in scope
 * @param targetName - Name to find discriminator for
 * @param targetLocation - Location of target item
 * @returns Discriminator (0-based index among same-named items)
 */
export function computeDiscriminator(
  items: LocatedItem[],
  targetName: string,
  targetLocation: Location
): number {
  // Filter items with same name
  const sameNameItems = items.filter(item => item.name === targetName);

  if (sameNameItems.length <= 1) {
    return 0;
  }

  // Sort by line, then by column for stable ordering
  sameNameItems.sort((a, b) => {
    if (a.location.line !== b.location.line) {
      return a.location.line - b.location.line;
    }
    return a.location.column - b.location.column;
  });

  // Find index of target
  const index = sameNameItems.findIndex(
    item =>
      item.location.line === targetLocation.line &&
      item.location.column === targetLocation.column
  );

  return index >= 0 ? index : 0;
}

// =============================================================================
// Semantic ID v2 Functions
// =============================================================================

/**
 * Compute v2 semantic ID.
 *
 * Format: file->TYPE->name                           (top-level, no collision)
 * Format: file->TYPE->name[in:parent]                (nested, no collision)
 * Format: file->TYPE->name[in:parent,h:xxxx]         (collision, hash disambiguates)
 * Format: file->TYPE->name[in:parent,h:xxxx]#N       (hash collision, counter)
 *
 * @param type - Node type (FUNCTION, CALL, VARIABLE, etc.)
 * @param name - Node name
 * @param file - Source file path
 * @param namedParent - Nearest named ancestor (undefined for top-level)
 * @param contentHash - 4-hex content hash (set by CollisionResolver)
 * @param counter - Counter for hash collisions (set by CollisionResolver)
 */
export function computeSemanticIdV2(
  type: string,
  name: string,
  file: string,
  namedParent?: string,
  contentHash?: string,
  counter?: number
): string {
  const brackets: string[] = [];
  if (namedParent) brackets.push(`in:${namedParent}`);
  if (contentHash) brackets.push(`h:${contentHash}`);

  let id = `${file}->${type}->${name}`;
  if (brackets.length > 0) {
    id += `[${brackets.join(',')}]`;
  }
  if (counter !== undefined && counter > 0) {
    id += `#${counter}`;
  }
  return id;
}

/**
 * Parse v2 semantic ID back to components.
 *
 * Handles v2 format: file->TYPE->name[in:parent,h:xxxx]#N
 * and special formats: net:stdio->__stdio__, EXTERNAL_MODULE->lodash
 *
 * @returns Parsed components or null if not a valid v2 ID
 */
export function parseSemanticIdV2(id: string): ParsedSemanticIdV2 | null {
  // Handle singletons
  if (id.startsWith('net:stdio') || id.startsWith('net:request')) {
    const arrowIdx = id.indexOf('->');
    if (arrowIdx === -1) return null;
    return { file: '', type: 'SINGLETON', name: id.slice(arrowIdx + 2) };
  }

  if (id.startsWith('EXTERNAL_MODULE')) {
    const arrowIdx = id.indexOf('->');
    if (arrowIdx === -1) return null;
    return { file: '', type: 'EXTERNAL_MODULE', name: id.slice(arrowIdx + 2) };
  }

  // v2 format: file->TYPE->name[in:parent,h:xxxx]#N
  // Exactly two '->' delimiters: file->TYPE->rest
  const firstArrow = id.indexOf('->');
  if (firstArrow === -1) return null;

  const secondArrow = id.indexOf('->', firstArrow + 2);
  if (secondArrow === -1) return null;

  const file = id.slice(0, firstArrow);
  const type = id.slice(firstArrow + 2, secondArrow);
  let rest = id.slice(secondArrow + 2);

  // Check this isn't a v1 ID (v1 has 4+ parts, meaning rest contains '->')
  // v2 names don't contain '->' in practice
  if (rest.includes('->')) return null;

  // Parse counter suffix: #N (only at the very end, after brackets)
  let counter: number | undefined;
  const counterMatch = rest.match(/#(\d+)$/);
  if (counterMatch) {
    counter = parseInt(counterMatch[1], 10);
    rest = rest.slice(0, -counterMatch[0].length);
  }

  // Parse bracket content: [in:parent,h:xxxx]
  let namedParent: string | undefined;
  let contentHash: string | undefined;
  let name = rest;

  const bracketStart = rest.indexOf('[');
  const bracketEnd = rest.lastIndexOf(']');
  if (bracketStart !== -1 && bracketEnd === rest.length - 1) {
    name = rest.slice(0, bracketStart);
    const bracketContent = rest.slice(bracketStart + 1, bracketEnd);

    for (const part of bracketContent.split(',')) {
      const colonIdx = part.indexOf(':');
      if (colonIdx === -1) continue;
      const key = part.slice(0, colonIdx);
      const value = part.slice(colonIdx + 1);
      if (key === 'in') namedParent = value;
      else if (key === 'h') contentHash = value;
    }
  }

  return { file, type, name, namedParent, contentHash, counter };
}

/**
 * FNV-1a hash function, returns 4-hex-char string.
 *
 * FNV-1a is simple, fast, and has good distribution for short strings.
 * 4 hex chars = 16 bits = 65536 buckets.
 *
 * @param hints - Content data to hash
 * @returns 4-char hex string (e.g., "a1b2")
 */
export function computeContentHash(hints: ContentHashHints): string {
  const parts: string[] = [];
  if (hints.arity !== undefined) parts.push(`a:${hints.arity}`);
  if (hints.firstLiteralArg !== undefined) parts.push(`l:${hints.firstLiteralArg}`);
  if (hints.firstParamName !== undefined) parts.push(`p:${hints.firstParamName}`);
  if (hints.rhsType !== undefined) parts.push(`r:${hints.rhsType}`);
  if (hints.rhsToken !== undefined) parts.push(`t:${hints.rhsToken}`);
  if (hints.objectChain !== undefined) parts.push(`o:${hints.objectChain}`);

  const input = parts.join('|');

  // FNV-1a 32-bit
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }

  // Truncate to 16 bits, format as 4-hex
  const truncated = (hash >>> 0) & 0xffff;
  return truncated.toString(16).padStart(4, '0');
}
