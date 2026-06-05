/**
 * Caller-name resolution for the `who` command.
 *
 * Extracted into its own module so it can be unit-tested in isolation without
 * pulling in the rest of the `who` command's dependencies.
 */

/**
 * Minimal backend surface needed to resolve a caller name. Satisfied by both the
 * production RFDBServerBackend and the unit-test harness backend.
 */
export interface CallerLookupBackend {
  getIncomingEdges(
    id: string,
    edgeTypes?: string[] | null
  ): Promise<Array<{ src: string; dst: string; type: string }>>;
  getNode(id: string): Promise<{ type?: string; nodeType?: string; name?: string } | null>;
}

/**
 * Resolve the name of the function/method that encloses a CALL node — i.e. the
 * "caller" reported by `grafema who`.
 *
 * v2 semantic IDs (and their grafema:// URI form, e.g.
 * `grafema://host/src/lib.rs#CALL-%3Efoo%5Bin:bar%5D`) no longer embed the scope
 * chain in the id, so the caller cannot be recovered by string-splitting it on
 * `->`. Instead we resolve it graph-natively by walking up the CONTAINS chain to
 * the nearest enclosing FUNCTION/METHOD.
 *
 * A call directly in a function body is CONTAINS'd by the FUNCTION/METHOD node.
 * A call nested inside an anonymous scope (if/for/while/block) is CONTAINS'd by an
 * intermediate SCOPE node which is itself CONTAINS'd by the function, so we may
 * need to climb more than one level. Returns `<anonymous>` for a top-level call
 * with no enclosing function (e.g. a call in module scope or a class field
 * initializer).
 *
 * The climb is bounded (depth cap + visited set) so a malformed or cyclic
 * CONTAINS graph can never cause an unbounded loop.
 *
 * @param backend - Connected RFDB backend used to look up parent nodes.
 * @param callNodeId - Semantic id of the CALL node.
 * @returns The caller function/method name, or `<anonymous>`.
 */
export async function resolveCallerName(
  backend: CallerLookupBackend,
  callNodeId: string
): Promise<string> {
  let currentId = callNodeId;
  const visited = new Set<string>();

  for (let depth = 0; depth < 64; depth++) {
    if (visited.has(currentId)) break;
    visited.add(currentId);

    const containsEdges = await backend.getIncomingEdges(currentId, ['CONTAINS']);

    let climbTo: string | undefined;
    for (const edge of containsEdges) {
      const parent = await backend.getNode(edge.src);
      if (!parent) continue;
      // Some backends surface the node type as `type`, others as `nodeType`.
      const parentType = parent.type ?? parent.nodeType;
      if ((parentType === 'FUNCTION' || parentType === 'METHOD') && parent.name) {
        return parent.name;
      }
      // Not a named function yet — remember the first container so we can keep
      // climbing through intermediate scopes (SCOPE / block / branch nodes).
      if (climbTo === undefined) climbTo = edge.src;
    }

    if (climbTo === undefined) break;
    currentId = climbTo;
  }

  return '<anonymous>';
}
