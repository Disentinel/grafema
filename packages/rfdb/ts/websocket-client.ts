/**
 * RFDBWebSocketClient - WebSocket client for RFDB server
 *
 * Provides same API as RFDBClient but uses WebSocket transport instead of Unix socket.
 * Designed for browser environments (VS Code web extension, vscode.dev).
 *
 * Key differences from Unix socket client:
 * - No length-prefix framing (WebSocket handles message boundaries)
 * - No streaming support (protocol v2 only, no NodesChunk)
 * - Uses globalThis.WebSocket (works in both Node.js 22+ and browsers)
 */

import { encode, decode } from '@msgpack/msgpack';
import { BaseRFDBClient } from './base-client.js';

import type {
  RFDBCommand,
  RFDBResponse,
  HelloResponse,
} from '@grafema/types';

interface PendingRequest {
  resolve: (value: RFDBResponse) => void;
  reject: (error: Error) => void;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class RFDBWebSocketClient extends BaseRFDBClient {
  readonly socketPath: string;
  readonly clientName: string;
  private ws: WebSocket | null = null;
  connected: boolean = false;
  private pending: Map<number, PendingRequest> = new Map();
  private reqId: number = 0;

  constructor(private url: string, clientName: string = 'unknown') {
    super();
    // socketPath returns the URL to satisfy IRFDBClient interface
    this.socketPath = url;
    this.clientName = clientName;
  }

  /**
   * Connect to RFDB server via WebSocket.
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.connected = true;
        this.emit('connected');
        resolve();
      };

      this.ws.onerror = () => {
        const error = new Error(`WebSocket connection error: ${this.url}`);
        if (!this.connected) {
          reject(error);
        } else {
          this.emit('error', error);
        }
      };

      this.ws.onclose = (event: CloseEvent) => {
        this.connected = false;
        this.emit('disconnected');
        for (const [, { reject: rej }] of this.pending) {
          rej(new Error(`Connection closed (code: ${event.code})`));
        }
        this.pending.clear();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        this._handleMessage(event.data as ArrayBuffer);
      };
    });
  }

  private _handleMessage(data: ArrayBuffer): void {
    try {
      const response = decode(new Uint8Array(data)) as RFDBResponse;
      const id = this._parseRequestId(response.requestId);
      if (id === null) {
        return;
      }

      const pending = this.pending.get(id);
      if (!pending) {
        return;
      }

      this.pending.delete(id);

      if (response.error) {
        pending.reject(new Error(response.error));
      } else {
        pending.resolve(response);
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  private _parseRequestId(requestId: unknown): number | null {
    if (typeof requestId === 'string' && requestId.startsWith('r')) {
      const num = parseInt(requestId.slice(1), 10);
      return isNaN(num) ? null : num;
    }
    return null;
  }

  /**
   * Send a request and wait for response with timeout.
   * No length prefix -- WebSocket handles framing.
   */
  protected async _send(
    cmd: RFDBCommand,
    payload: Record<string, unknown> = {},
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<RFDBResponse> {
    if (!this.connected || !this.ws) {
      throw new Error('Not connected to RFDB server');
    }

    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      const request = { requestId: `r${id}`, cmd, ...payload };
      const msgBytes = encode(request);

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timed out: ${cmd} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      this.ws!.send(msgBytes);
    });
  }

  /**
   * Negotiate protocol version with server.
   * WebSocket client always uses protocol v2 (no streaming support in MVP).
   */
  override async hello(protocolVersion: number = 2): Promise<HelloResponse> {
    const response = await this._send('hello' as RFDBCommand, {
      protocolVersion: 2,
    });
    return response as HelloResponse;
  }

  async close(): Promise<void> {
    if (this.ws) {
      this.ws.close(1000, 'Client closed');
      this.ws = null;
    }
    this.connected = false;
    this.pending.clear();
  }
}
