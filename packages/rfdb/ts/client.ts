/**
 * RFDBClient - Unix socket client for RFDB server
 *
 * Provides the same API as GraphEngine NAPI binding but communicates
 * with a separate rfdb-server process over Unix socket + MessagePack.
 */

import { createConnection, Socket } from 'net';
import { encode, decode } from '@msgpack/msgpack';
import { StreamQueue } from './stream-queue.js';
import { BaseRFDBClient } from './base-client.js';

import type {
  RFDBCommand,
  WireNode,
  RFDBResponse,
  AttrQuery,
  HelloResponse,
  NodesChunkResponse,
  CommitDelta,
} from '@grafema/types';

interface PendingRequest {
  resolve: (value: RFDBResponse) => void;
  reject: (error: Error) => void;
}

export class RFDBClient extends BaseRFDBClient {
  readonly socketPath: string;
  private socket: Socket | null;
  connected: boolean;
  private pending: Map<number, PendingRequest>;
  private reqId: number;
  private buffer: Buffer;

  // Streaming state
  private _supportsStreaming: boolean = false;
  private _pendingStreams: Map<number, StreamQueue<WireNode>> = new Map();
  private _streamTimers: Map<number, ReturnType<typeof setTimeout>> = new Map();

  constructor(socketPath: string = '/tmp/rfdb.sock') {
    super();
    this.socketPath = socketPath;
    this.socket = null;
    this.connected = false;
    this.pending = new Map();
    this.reqId = 0;
    this.buffer = Buffer.alloc(0);
  }

  /**
   * Whether the connected server supports streaming responses.
   * Set after calling hello(). Defaults to false.
   */
  override get supportsStreaming(): boolean {
    return this._supportsStreaming;
  }

  /**
   * Connect to RFDB server
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    return new Promise((resolve, reject) => {
      this.socket = createConnection(this.socketPath);

      this.socket.on('connect', () => {
        this.connected = true;
        this.emit('connected');
        resolve();
      });

      this.socket.on('error', (err: NodeJS.ErrnoException) => {
        const enhancedError = this._enhanceConnectionError(err);
        if (!this.connected) {
          reject(enhancedError);
        } else {
          this.emit('error', enhancedError);
        }
      });

      this.socket.on('close', () => {
        this.connected = false;
        this.emit('disconnected');
        // Reject all pending requests
        for (const [, { reject }] of this.pending) {
          reject(new Error('Connection closed'));
        }
        this.pending.clear();
        // Fail all pending streams
        for (const [, stream] of this._pendingStreams) {
          stream.fail(new Error('Connection closed'));
        }
        this._pendingStreams.clear();
        for (const [, timer] of this._streamTimers) {
          clearTimeout(timer);
        }
        this._streamTimers.clear();
      });

      this.socket.on('data', (chunk: Buffer) => {
        this._handleData(chunk);
      });
    });
  }

  /**
   * Enhance connection errors with helpful messages about --auto-start
   */
  private _enhanceConnectionError(err: NodeJS.ErrnoException): Error {
    const code = err.code;

    if (code === 'EPIPE' || code === 'ECONNRESET') {
      return new Error(
        `RFDB server connection lost (${code}). The server may have crashed or been stopped.\n` +
        `Try running with --auto-start flag to automatically start the server, or manually start it with:\n` +
        `  rfdb-server start`
      );
    }

    if (code === 'ENOENT') {
      return new Error(
        `RFDB server socket not found at ${this.socketPath}.\n` +
        `The server is not running. Use --auto-start flag to automatically start it, or manually start with:\n` +
        `  rfdb-server start`
      );
    }

    if (code === 'ECONNREFUSED') {
      return new Error(
        `Cannot connect to RFDB server at ${this.socketPath} (connection refused).\n` +
        `The server may not be running. Use --auto-start flag to automatically start it, or manually start with:\n` +
        `  rfdb-server start`
      );
    }

    return err;
  }

  /**
   * Handle incoming data, parse framed messages
   */
  private _handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 4) {
      // Read length prefix (4 bytes, big-endian)
      const msgLen = this.buffer.readUInt32BE(0);

      if (this.buffer.length < 4 + msgLen) {
        // Not enough data yet
        break;
      }

      // Extract message
      const msgBytes = this.buffer.subarray(4, 4 + msgLen);
      this.buffer = this.buffer.subarray(4 + msgLen);

      // Decode and dispatch
      try {
        const response = decode(msgBytes) as RFDBResponse;
        this._handleResponse(response);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.emit('error', new Error(`Failed to decode response: ${message}`));
      }
    }
  }

  /**
   * Handle decoded response -- match by requestId, route streaming chunks
   * to StreamQueue or resolve single-response Promise.
   */
  private _handleResponse(response: RFDBResponse): void {
    if (this.pending.size === 0 && this._pendingStreams.size === 0) {
      this.emit('error', new Error('Received response with no pending request'));
      return;
    }

    let id: number;

    if (response.requestId) {
      const parsed = this._parseRequestId(response.requestId);
      if (parsed === null) {
        this.emit('error', new Error(`Received response for unknown requestId: ${response.requestId}`));
        return;
      }
      id = parsed;
    } else {
      // FIFO fallback for servers that don't echo requestId
      if (this.pending.size > 0) {
        id = (this.pending.entries().next().value as [number, PendingRequest])[0];
      } else {
        this.emit('error', new Error('Received response with no pending request'));
        return;
      }
    }

    // Route to streaming handler if this requestId has a StreamQueue
    const streamQueue = this._pendingStreams.get(id);
    if (streamQueue) {
      this._handleStreamingResponse(id, response, streamQueue);
      return;
    }

    // Non-streaming response -- existing behavior
    if (!this.pending.has(id)) {
      this.emit('error', new Error(`Received response for unknown requestId: ${response.requestId}`));
      return;
    }

    const { resolve, reject } = this.pending.get(id)!;
    this.pending.delete(id);

    if (response.error) {
      reject(new Error(response.error));
    } else {
      resolve(response);
    }
  }

  /**
   * Handle a response for a streaming request.
   */
  private _handleStreamingResponse(
    id: number,
    response: RFDBResponse,
    streamQueue: StreamQueue<WireNode>,
  ): void {
    if (response.error) {
      this._cleanupStream(id);
      streamQueue.fail(new Error(response.error));
      return;
    }

    if ('done' in response) {
      const chunk = response as unknown as NodesChunkResponse;
      const nodes = chunk.nodes || [];
      for (const node of nodes) {
        streamQueue.push(node);
      }

      if (chunk.done) {
        this._cleanupStream(id);
        streamQueue.end();
      } else {
        this._resetStreamTimer(id, streamQueue);
      }
      return;
    }

    // Auto-fallback: server sent a non-streaming Nodes response
    const nodesResponse = response as unknown as { nodes?: WireNode[] };
    const nodes = nodesResponse.nodes || [];
    for (const node of nodes) {
      streamQueue.push(node);
    }
    this._cleanupStream(id);
    streamQueue.end();
  }

  private _resetStreamTimer(id: number, streamQueue: StreamQueue<WireNode>): void {
    const existing = this._streamTimers.get(id);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this._cleanupStream(id);
      streamQueue.fail(new Error(
        `RFDB queryNodesStream timed out after ${RFDBClient.DEFAULT_TIMEOUT_MS}ms (no chunk received)`
      ));
    }, RFDBClient.DEFAULT_TIMEOUT_MS);

    this._streamTimers.set(id, timer);
  }

  private _cleanupStream(id: number): void {
    this._pendingStreams.delete(id);
    this.pending.delete(id);
    const timer = this._streamTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this._streamTimers.delete(id);
    }
  }

  private _parseRequestId(requestId: string): number | null {
    if (!requestId.startsWith('r')) return null;
    const num = parseInt(requestId.slice(1), 10);
    return Number.isNaN(num) ? null : num;
  }

  private static readonly DEFAULT_TIMEOUT_MS = 60_000;

  /**
   * Send a request and wait for response with timeout
   */
  protected async _send(
    cmd: RFDBCommand,
    payload: Record<string, unknown> = {},
    timeoutMs: number = RFDBClient.DEFAULT_TIMEOUT_MS,
  ): Promise<RFDBResponse> {
    if (!this.connected || !this.socket) {
      throw new Error('Not connected to RFDB server');
    }

    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      const request = { requestId: `r${id}`, cmd, ...payload };
      const msgBytes = encode(request);

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RFDB ${cmd} timed out after ${timeoutMs}ms. Server may be unresponsive or dbPath may be invalid.`));
      }, timeoutMs);

      const errorHandler = (err: NodeJS.ErrnoException) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(this._enhanceConnectionError(err));
      };
      this.socket!.once('error', errorHandler);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          this.socket?.removeListener('error', errorHandler);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.socket?.removeListener('error', errorHandler);
          reject(error);
        },
      });

      // Write length prefix + message
      const header = Buffer.alloc(4);
      header.writeUInt32BE(msgBytes.length);
      this.socket!.write(Buffer.concat([header, Buffer.from(msgBytes)]));
    });
  }

  // ===========================================================================
  // Streaming Overrides (Unix socket supports streaming)
  // ===========================================================================

  /**
   * Negotiate protocol version with server.
   * Overrides base to set streaming flag.
   */
  override async hello(protocolVersion: number = 3): Promise<HelloResponse> {
    const response = await this._send('hello' as RFDBCommand, { protocolVersion });
    const hello = response as HelloResponse;
    this._supportsStreaming = hello.features?.includes('streaming') ?? false;
    return hello;
  }

  /**
   * Query nodes (async generator).
   * Overrides base to support streaming for protocol v3+.
   */
  override async *queryNodes(query: AttrQuery): AsyncGenerator<WireNode, void, unknown> {
    if (this._supportsStreaming) {
      yield* this.queryNodesStream(query);
      return;
    }

    const serverQuery = this._buildServerQuery(query);
    const response = await this._send('queryNodes', { query: serverQuery });
    const nodes = (response as { nodes?: WireNode[] }).nodes || [];

    for (const node of nodes) {
      yield node;
    }
  }

  /**
   * Stream nodes matching query with true streaming support.
   * Overrides base to use StreamQueue for protocol v3+.
   */
  override async *queryNodesStream(query: AttrQuery): AsyncGenerator<WireNode, void, unknown> {
    if (!this._supportsStreaming) {
      yield* super.queryNodes(query);
      return;
    }

    if (!this.connected || !this.socket) {
      throw new Error('Not connected to RFDB server');
    }

    const serverQuery = this._buildServerQuery(query);
    const id = this.reqId++;
    const streamQueue = new StreamQueue<WireNode>();
    this._pendingStreams.set(id, streamQueue);

    const request = { requestId: `r${id}`, cmd: 'queryNodes', query: serverQuery };
    const msgBytes = encode(request);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(msgBytes.length);

    this.pending.set(id, {
      resolve: () => { this._cleanupStream(id); },
      reject: (error) => {
        this._cleanupStream(id);
        streamQueue.fail(error);
      },
    });

    this._resetStreamTimer(id, streamQueue);
    this.socket!.write(Buffer.concat([header, Buffer.from(msgBytes)]));

    try {
      for await (const node of streamQueue) {
        yield node;
      }
    } finally {
      this._cleanupStream(id);
    }
  }

  /**
   * Create an isolated batch handle for concurrent-safe batching.
   */
  createBatch(): BatchHandle {
    return new BatchHandle(this);
  }

  /**
   * Unref the socket so it doesn't keep the process alive.
   */
  unref(): void {
    if (this.socket) {
      this.socket.unref();
    }
  }

  /**
   * Close connection
   */
  async close(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
    }
  }
}

/**
 * Isolated batch handle for concurrent-safe batching (REG-487).
 */
export class BatchHandle {
  private _nodes: WireNode[] = [];
  private _edges: import('@grafema/types').WireEdge[] = [];
  private _files: Set<string> = new Set();

  constructor(private client: RFDBClient) {}

  addNode(node: WireNode, file?: string): void {
    this._nodes.push(node);
    if (file) this._files.add(file);
    else if (node.file) this._files.add(node.file);
  }

  addEdge(edge: import('@grafema/types').WireEdge): void {
    this._edges.push(edge);
  }

  addFile(file: string): void {
    this._files.add(file);
  }

  async commit(tags?: string[], deferIndex?: boolean, protectedTypes?: string[]): Promise<CommitDelta> {
    const nodes = this._nodes;
    const edges = this._edges;
    const changedFiles = [...this._files];
    this._nodes = [];
    this._edges = [];
    this._files = new Set();
    return this.client._sendCommitBatch(changedFiles, nodes, edges, tags, deferIndex, protectedTypes);
  }

  abort(): void {
    this._nodes = [];
    this._edges = [];
    this._files = new Set();
  }
}

export default RFDBClient;
