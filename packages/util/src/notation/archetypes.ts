/**
 * Edge → Archetype Mapping Table
 *
 * Maps every EDGE_TYPE from @grafema/types to a visual archetype + operator + verb.
 * Pure data — no side effects.
 *
 * Archetypes (7 base + 2 structural):
 *   contains (implicit nesting, no operator)
 *   depends   o-   dependency/import
 *   flow_out  >    outward data/call flow
 *   flow_in   <    inward data/type flow
 *   write     =>   persistent side effect
 *   exception >x   error/rejection
 *   publishes ~>>  event/message
 *   gates     ?|   conditional guard
 *   governs   |=   governance/invariant
 *
 * @module notation/archetypes
 */

import type { Archetype, EdgeMapping } from './types.js';

// Sort order by archetype (rendering order within blocks)
const SORT: Record<Archetype, number> = {
  contains: 0,
  depends: 1,
  flow_out: 2,
  flow_in: 3,
  write: 4,
  exception: 5,
  publishes: 6,
  gates: 7,
  governs: 8,
};

function m(archetype: Archetype, operator: string, verb: string): EdgeMapping {
  return { archetype, operator, verb, sortOrder: SORT[archetype] };
}

/**
 * Complete mapping of all edge types to archetypes.
 *
 * Keys match EDGE_TYPE values from @grafema/types/edges.
 */
export const EDGE_ARCHETYPE_MAP: Record<string, EdgeMapping> = {
  // === Containment (operator='', defines { } nesting) ===
  CONTAINS:       m('contains', '', 'contains'),
  HAS_SCOPE:      m('contains', '', 'scopes'),
  HAS_MEMBER:     m('contains', '', 'has'),
  HAS_BODY:       m('contains', '', 'body'),
  HAS_PROPERTY:   m('contains', '', 'property'),
  HAS_ELEMENT:    m('contains', '', 'element'),
  HAS_INIT:       m('contains', '', 'init'),
  HAS_UPDATE:     m('contains', '', 'update'),
  HAS_CALLBACK:   m('contains', '', 'callback'),
  HAS_CATCH:      m('contains', '', 'catch'),
  HAS_FINALLY:    m('contains', '', 'finally'),
  DECLARES:       m('contains', '', 'declares'),
  DEFINES:        m('contains', '', 'defines'),
  MOUNTS:         m('contains', '', 'mounts'),
  PROPERTY_KEY:   m('contains', '', 'key'),
  PROPERTY_VALUE: m('contains', '', 'value'),

  // === Depends (o-) ===
  DEPENDS_ON:     m('depends', 'o-', 'depends on'),
  IMPORTS:        m('depends', 'o-', 'imports'),
  IMPORTS_FROM:   m('depends', 'o-', 'imports from'),
  EXPORTS:        m('depends', 'o-', 'exports'),
  USES:           m('depends', 'o-', 'uses'),
  USES_CONFIG:    m('depends', 'o-', 'uses config'),
  USES_SECRET:    m('depends', 'o-', 'uses secret'),
  DEPLOYED_TO:    m('depends', 'o-', 'deployed to'),
  SCHEDULED_BY:   m('depends', 'o-', 'scheduled by'),

  // === Flow Out (>) ===
  CALLS:              m('flow_out', '>', 'calls'),
  DELEGATES_TO:       m('flow_out', '>', 'delegates to'),
  ROUTES_TO:          m('flow_out', '>', 'routes to'),
  HANDLED_BY:         m('flow_out', '>', 'handled by'),
  MAKES_REQUEST:      m('flow_out', '>', 'requests'),
  CALLS_API:          m('flow_out', '>', 'calls API'),
  INVOKES_FUNCTION:   m('flow_out', '>', 'invokes'),
  PASSES_ARGUMENT:    m('flow_out', '>', 'passes'),
  RETURNS:            m('flow_out', '>', 'returns'),
  CALL_RETURNS:       m('flow_out', '>', 'call returns'),
  YIELDS:             m('flow_out', '>', 'yields'),
  RESPONDS_WITH:      m('flow_out', '>', 'responds with'),
  INTERACTS_WITH:     m('flow_out', '>', 'interacts with'),
  ITERATES_OVER:      m('flow_out', '>', 'iterates'),
  ASSIGNS_TO:         m('flow_out', '>', 'assigns to'),
  MODIFIES:           m('flow_out', '>', 'modifies'),
  CAPTURES:           m('flow_out', '>', 'captures'),
  FLOWS_INTO:         m('flow_out', '>', 'flows into'),

  // === Flow In (<) ===
  READS_FROM:         m('flow_in', '<', 'reads'),
  RECEIVES_ARGUMENT:  m('flow_in', '<', 'receives'),
  ASSIGNED_FROM:      m('flow_in', '<', 'assigned from'),
  DERIVES_FROM:       m('flow_in', '<', 'derives from'),
  SPREADS_FROM:       m('flow_in', '<', 'spreads from'),
  ELEMENT_OF:         m('flow_in', '<', 'element of'),
  KEY_OF:             m('flow_in', '<', 'key of'),
  DESTRUCTURED_FROM:  m('flow_in', '<', 'destructured from'),
  HTTP_RECEIVES:      m('flow_in', '<', 'receives HTTP'),
  EXTENDS:            m('flow_in', '<', 'extends'),
  IMPLEMENTS:         m('flow_in', '<', 'implements'),
  INSTANCE_OF:        m('flow_in', '<', 'instance of'),

  // === Write (=>) ===
  WRITES_TO:          m('write', '=>', 'writes'),
  LOGS_TO:            m('write', '=>', 'logs to'),
  PERFORMS_REDIS:      m('write', '=>', 'redis'),

  // === Exception (>x) ===
  THROWS:             m('exception', '>x', 'throws'),
  REJECTS:            m('exception', '>x', 'rejects'),
  CATCHES_FROM:       m('exception', '>x', 'catches from'),

  // === Publishes (~>>) ===
  EMITS_EVENT:        m('publishes', '~>>', 'emits'),
  LISTENS_TO:         m('publishes', '~>>', 'listens to'),
  PUBLISHES_TO:       m('publishes', '~>>', 'publishes to'),
  SUBSCRIBES_TO:      m('publishes', '~>>', 'subscribes to'),
  EXPOSED_VIA:        m('publishes', '~>>', 'exposed via'),
  EXPOSES:            m('publishes', '~>>', 'exposes'),
  JOINS_ROOM:         m('publishes', '~>>', 'joins room'),

  // === Gates (?|) ===
  HAS_CONDITION:      m('gates', '?|', 'guards'),
  HAS_CONSEQUENT:     m('gates', '?|', 'then'),
  HAS_ALTERNATE:      m('gates', '?|', 'else'),
  HAS_CASE:           m('gates', '?|', 'case'),
  HAS_DEFAULT:        m('gates', '?|', 'default'),

  // === Governs (|=) ===
  GOVERNS:            m('governs', '|=', 'governs'),
  VIOLATES:           m('governs', '|=', 'violates'),
  AFFECTS:            m('governs', '|=', 'affects'),
  MONITORED_BY:       m('governs', '|=', 'monitored by'),
  MEASURED_BY:        m('governs', '|=', 'measured by'),
  PROVISIONED_BY:     m('governs', '|=', 'provisioned by'),
  REGISTERS_VIEW:     m('governs', '|=', 'registers view'),

  // === Fallback ===
  UNKNOWN:            m('flow_out', '>', 'unknown'),
};

/**
 * Look up edge mapping. Returns a fallback for unmapped types.
 */
export function lookupEdge(edgeType: string): EdgeMapping {
  return EDGE_ARCHETYPE_MAP[edgeType] ?? {
    archetype: 'flow_out',
    operator: '>',
    verb: edgeType.toLowerCase().replace(/_/g, ' '),
    sortOrder: SORT.flow_out,
  };
}
