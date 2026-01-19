/**
 * @grafema/rfdb-client - High-performance graph database for code analysis
 *
 * This package provides:
 * - RFDBClient: Socket-based client for out-of-process communication
 * - Protocol types: Wire format types for RFDB communication
 *
 * For NAPI bindings (in-process), see the platform-specific packages.
 */

// Client
export { RFDBClient } from './client.js';

// Protocol types (re-exported from @grafema/types for convenience)
export type {
  RFDBCommand,
  WireNode,
  WireEdge,
  RFDBRequest,
  RFDBResponse,
  AttrQuery,
  DatalogResult,
  IRFDBClient,
} from './protocol.js';
