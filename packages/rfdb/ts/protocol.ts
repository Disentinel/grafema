/**
 * RFDB Protocol Types - re-export from @grafema/types
 *
 * This module provides wire format types for RFDB client-server communication.
 */

export type {
  // Commands
  RFDBCommand,

  // Wire formats
  WireNode,
  WireEdge,

  // Request types
  RFDBRequest,
  AddNodesRequest,
  AddEdgesRequest,
  DeleteNodeRequest,
  DeleteEdgeRequest,
  GetNodeRequest,
  NodeExistsRequest,
  FindByTypeRequest,
  FindByAttrRequest,
  NeighborsRequest,
  BfsRequest,
  GetOutgoingEdgesRequest,
  GetIncomingEdgesRequest,
  CountNodesByTypeRequest,
  CountEdgesByTypeRequest,

  // Response types
  RFDBResponse,
  AddNodesResponse,
  AddEdgesResponse,
  GetNodeResponse,
  NodeExistsResponse,
  FindByTypeResponse,
  FindByAttrResponse,
  NeighborsResponse,
  BfsResponse,
  GetEdgesResponse,
  CountResponse,
  CountsByTypeResponse,
  PingResponse,

  // Query types
  AttrQuery,
  DatalogBinding,
  DatalogResult,

  // Client interface
  IRFDBClient,
} from '@grafema/types';
