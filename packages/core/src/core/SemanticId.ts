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
