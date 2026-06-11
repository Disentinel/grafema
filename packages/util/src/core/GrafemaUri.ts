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

  // Determine the authority boundary first. The authority is "host/project"
  // (2 segments, e.g. "localhost/grafema") or "host/owner/repo" (3 segments)
  // for known forge hosts. Everything after the authority is either the
  // reserved virtual marker "_/..." or a "file/path#fragment".
  const segments = rest.split('/');
  const host = segments[0];
  const authoritySegments =
    host === 'github.com' || host === 'gitlab.com' || host === 'bitbucket.org'
      ? 3 // host/owner/repo
      : 2; // host/project (localhost/grafema)

  if (segments.length < authoritySegments) return null;

  const authority = segments.slice(0, authoritySegments).join('/');
  const afterAuthority = rest.slice(authority.length + 1); // skip the '/' after authority

  // Virtual node: the segment immediately after the authority is exactly "_".
  // This MUST be anchored to the authority boundary — a "_" path segment deeper
  // in a real file path (e.g. src/_/util.ts) is NOT a virtual marker, so we
  // cannot scan the whole string for the substring "/_/".
  if (afterAuthority === '_' || afterAuthority.startsWith('_/')) {
    const encodedId = afterAuthority.slice(2); // after "_/"
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

  // Standard node: afterAuthority = "file/path#fragment"
  const hashPos = afterAuthority.indexOf('#');
  if (hashPos === -1) return null; // No fragment = invalid

  const filePath = afterAuthority.slice(0, hashPos);
  const fragment = afterAuthority.slice(hashPos + 1); // "TYPE-%3Ename..."
  const decodedFragment = decodeFragment(fragment);

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
