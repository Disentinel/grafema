/**
 * GrafemaUri -- conversion between compact semantic IDs and grafema:// URIs.
 *
 * URI format: grafema://{authority}/{file}#{encoded_fragment}
 * Virtual nodes: grafema://{authority}/_/{encoded_full_id}
 * Module nodes: grafema://{authority}/{file}#MODULE
 *
 * Fragment encoding: only > [ ] # need percent-encoding.
 */

const GRAFEMA_SCHEME = 'grafema://';

/**
 * Check if a string is a grafema:// URI.
 */
export function isGrafemaUri(str: string): boolean {
  return str.startsWith(GRAFEMA_SCHEME);
}

/**
 * Encode a fragment string for grafema:// URIs.
 * Only 4 chars need percent-encoding: > [ ] #
 */
export function encodeFragment(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    switch (ch) {
      case '>': out += '%3E'; break;
      case '[': out += '%5B'; break;
      case ']': out += '%5D'; break;
      case '#': out += '%23'; break;
      default: out += ch;
    }
  }
  return out;
}

/**
 * Decode a percent-encoded fragment back to raw string.
 */
export function decodeFragment(encoded: string): string {
  return encoded
    .replaceAll('%3E', '>')
    .replaceAll('%3e', '>')
    .replaceAll('%5B', '[')
    .replaceAll('%5b', '[')
    .replaceAll('%5D', ']')
    .replaceAll('%5d', ']')
    .replaceAll('%23', '#');
}

/**
 * Convert a compact semantic ID to a grafema:// URI.
 *
 * @param compactId - Compact format: "file->TYPE->name[in:p,h:x]#N", "MODULE#file", "EXTERNAL_MODULE->x"
 * @param authority - URI authority: "github.com/owner/repo" or "localhost/project"
 * @returns grafema:// URI string
 */
export function toGrafemaUri(compactId: string, authority: string): string {
  // Case 1: MODULE#file
  if (compactId.startsWith('MODULE#')) {
    const file = compactId.slice(7); // len("MODULE#") = 7
    return `${GRAFEMA_SCHEME}${authority}/${file}#MODULE`;
  }

  // Case 2 & 3: Check for file->REST pattern
  const firstArrow = compactId.indexOf('->');
  if (firstArrow !== -1) {
    const beforeArrow = compactId.slice(0, firstArrow);

    // Heuristic: file paths contain '/' or '.'
    const isFilePath = beforeArrow.includes('/') || beforeArrow.includes('.');

    if (isFilePath) {
      // Standard node: file->REST
      const file = beforeArrow;
      const rest = compactId.slice(firstArrow + 2);
      return `${GRAFEMA_SCHEME}${authority}/${file}#${encodeFragment(rest)}`;
    } else {
      // Virtual node: encode the whole ID
      return `${GRAFEMA_SCHEME}${authority}/_/${encodeFragment(compactId)}`;
    }
  }

  // No arrow -- virtual node
  return `${GRAFEMA_SCHEME}${authority}/_/${encodeFragment(compactId)}`;
}

/**
 * Parsed grafema:// URI components.
 */
export interface ParsedGrafemaUri {
  /** URI authority, e.g. "github.com/owner/repo" */
  authority: string;
  /** File path within the project, or empty for virtual nodes */
  filePath: string;
  /** Decoded symbol part (the fragment, decoded) */
  symbolPart: string;
  /** Reconstructed compact semantic ID */
  semanticId: string;
  /** Whether this is a virtual node (uses _/ path) */
  isVirtual: boolean;
}

/**
 * Parse a grafema:// URI into components.
 *
 * @returns Parsed components or null if not a valid grafema:// URI
 */
export function parseGrafemaUri(uri: string): ParsedGrafemaUri | null {
  if (!uri.startsWith(GRAFEMA_SCHEME)) return null;

  const rest = uri.slice(GRAFEMA_SCHEME.length); // "authority/file#fragment"

  // Find the authority: everything up to the first '/' after the host
  // Authority format: "host/project" (e.g., "github.com/owner/repo" or "localhost/project")
  // We need to find where authority ends and file path begins.
  // Convention: authority is "host/path" where host has no '/', so we split on first '/' after host.
  // Actually, authority can be multi-segment (github.com/owner/repo = 3 segments).
  // Strategy: find '#' first (fragment delimiter), then split the path part.

  const hashPos = rest.indexOf('#');
  const slashUnderscoreSlash = rest.indexOf('/_/');

  if (slashUnderscoreSlash !== -1 && (hashPos === -1 || slashUnderscoreSlash < hashPos)) {
    // Virtual node: authority/_/encoded_id
    const authority = rest.slice(0, slashUnderscoreSlash);
    const encodedId = rest.slice(slashUnderscoreSlash + 3); // after "/_/"
    const decodedId = decodeFragment(encodedId);

    // Reconstruct compact ID -- it's just the decoded full ID
    return {
      authority,
      filePath: '',
      symbolPart: decodedId,
      semanticId: decodedId,
      isVirtual: true,
    };
  }

  if (hashPos === -1) return null; // No fragment = invalid

  const pathPart = rest.slice(0, hashPos); // "authority/file/path"
  const fragment = rest.slice(hashPos + 1); // "TYPE-%3Ename..."
  const decodedFragment = decodeFragment(fragment);

  // Split pathPart into authority and filePath.
  // The authority is the first N segments that represent the host+project.
  // Problem: we don't know where authority ends and file begins.
  // Convention from the plan: authority = "host/project" (e.g., "localhost/grafema")
  //   or "github.com/owner/repo" (3 segments).
  // The file path typically starts with src/, lib/, etc.
  //
  // Better approach: find the file path by working backward from the fragment.
  // The fragment's decoded form tells us the type. The module_id for MODULE# format
  // means filePath = pathPart minus authority.
  //
  // Simplest reliable approach: the authority is stored separately or we use a heuristic.
  // For now: authority = first 2 segments for "host/project" format,
  // first 3 segments for known hosts (github.com, gitlab.com, bitbucket.org).

  const segments = pathPart.split('/');
  let authoritySegments: number;

  const host = segments[0];
  if (host === 'github.com' || host === 'gitlab.com' || host === 'bitbucket.org') {
    authoritySegments = 3; // host/owner/repo
  } else {
    authoritySegments = 2; // host/project (localhost/grafema)
  }

  if (segments.length < authoritySegments) return null;

  const authority = segments.slice(0, authoritySegments).join('/');
  const filePath = segments.slice(authoritySegments).join('/');

  // Reconstruct compact semantic ID
  let semanticId: string;
  if (decodedFragment === 'MODULE') {
    semanticId = `MODULE#${filePath}`;
  } else {
    semanticId = `${filePath}->${decodedFragment}`;
  }

  return {
    authority,
    filePath,
    symbolPart: decodedFragment,
    semanticId,
    isVirtual: false,
  };
}

/**
 * Convert a grafema:// URI to compact semantic ID format.
 * Convenience wrapper around parseGrafemaUri.
 *
 * @returns Compact semantic ID or the input unchanged if not a grafema:// URI
 */
export function toCompactSemanticId(uri: string): string {
  if (!isGrafemaUri(uri)) return uri;
  const parsed = parseGrafemaUri(uri);
  if (!parsed) return uri;
  return parsed.semanticId;
}

/**
 * Normalize a semantic ID input -- accepts either URI or compact format.
 * If it's a URI, converts to compact. If already compact, returns as-is.
 *
 * Useful in MCP handlers that need to accept both formats.
 */
export function normalizeSemanticId(input: string): string {
  return toCompactSemanticId(input);
}
