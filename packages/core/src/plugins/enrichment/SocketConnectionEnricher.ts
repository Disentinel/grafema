/**
 * SocketConnectionEnricher - links socket clients to servers
 *
 * Creates INTERACTS_WITH edges by matching:
 * - Unix sockets: os:unix-socket -> os:unix-server by path equality
 * - TCP sockets: net:tcp-connection -> net:tcp-server by port + host equality
 *
 * V1 limitations:
 * - Dynamic paths (template literals with variables) are skipped
 * - Only matches static, resolvable paths and ports
 */

import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { BaseNodeRecord } from '@grafema/types';

/** Unix socket node (client or server) */
interface UnixSocketNode extends BaseNodeRecord {
  protocol?: string;
  path?: string;
}

/** TCP socket node (client or server) */
interface TcpSocketNode extends BaseNodeRecord {
  protocol?: string;
  host?: string;
  port?: number;
}

/** Connection info for logging */
interface ConnectionInfo {
  client: string;
  server: string;
  clientFile?: string;
  serverFile?: string;
}

export class SocketConnectionEnricher extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'SocketConnectionEnricher',
      phase: 'ENRICHMENT',
      creates: {
        nodes: [],
        edges: ['INTERACTS_WITH']
      },
      dependencies: ['SocketAnalyzer']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const { graph, onProgress } = context;
    const factory = this.getFactory(context);
    const logger = this.log(context);

    try {
      if (onProgress) {
        onProgress({
          phase: 'enrichment',
          currentPlugin: 'SocketConnectionEnricher',
          message: 'Collecting unix socket clients',
          totalFiles: 0,
          processedFiles: 0,
        });
      }
      const unixClients = await this.collectNodes<UnixSocketNode>(graph, 'os:unix-socket');

      if (onProgress) {
        onProgress({
          phase: 'enrichment',
          currentPlugin: 'SocketConnectionEnricher',
          message: 'Collecting unix socket servers',
          totalFiles: 0,
          processedFiles: 0,
        });
      }
      const unixServers = await this.collectNodes<UnixSocketNode>(graph, 'os:unix-server');

      if (onProgress) {
        onProgress({
          phase: 'enrichment',
          currentPlugin: 'SocketConnectionEnricher',
          message: 'Collecting TCP clients',
          totalFiles: 0,
          processedFiles: 0,
        });
      }
      const tcpClients = await this.collectNodes<TcpSocketNode>(graph, 'net:tcp-connection');

      if (onProgress) {
        onProgress({
          phase: 'enrichment',
          currentPlugin: 'SocketConnectionEnricher',
          message: 'Collecting TCP servers',
          totalFiles: 0,
          processedFiles: 0,
        });
      }
      const tcpServers = await this.collectNodes<TcpSocketNode>(graph, 'net:tcp-server');

      logger.info('Socket nodes found', {
        unixClients: unixClients.length,
        unixServers: unixServers.length,
        tcpClients: tcpClients.length,
        tcpServers: tcpServers.length
      });

      let edgesCreated = 0;
      const connections: ConnectionInfo[] = [];

      // Match Unix socket clients to servers by path
      if (onProgress) {
        onProgress({
          phase: 'enrichment',
          currentPlugin: 'SocketConnectionEnricher',
          message: `Matching unix sockets ${unixClients.length} clients x ${unixServers.length} servers`,
          totalFiles: unixClients.length,
          processedFiles: 0,
        });
      }
      edgesCreated += await this.matchUnixSockets(
        unixClients, unixServers, graph, connections, factory
      );

      // Match TCP clients to servers by port/host
      if (onProgress) {
        onProgress({
          phase: 'enrichment',
          currentPlugin: 'SocketConnectionEnricher',
          message: `Matching TCP sockets ${tcpClients.length} clients x ${tcpServers.length} servers`,
          totalFiles: tcpClients.length,
          processedFiles: 0,
        });
      }
      edgesCreated += await this.matchTcpSockets(
        tcpClients, tcpServers, graph, connections, factory
      );

      if (connections.length > 0) {
        logger.info('Socket connections found', {
          count: connections.length,
          examples: connections.slice(0, 5).map(c => `${c.client} -> ${c.server}`)
        });
      }

      return createSuccessResult(
        { nodes: 0, edges: edgesCreated },
        {
          connections: connections.length,
          unixMatches: connections.filter(c => c.client.startsWith('unix:')).length,
          tcpMatches: connections.filter(c => c.client.startsWith('tcp:')).length
        }
      );
    } catch (error) {
      logger.error('Socket enrichment failed', { error });
      return createErrorResult(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Collect all nodes of a given type from the graph.
   */
  private async collectNodes<T extends BaseNodeRecord>(
    graph: PluginContext['graph'],
    type: string
  ): Promise<T[]> {
    const nodes: T[] = [];
    for await (const node of graph.queryNodes({ type })) {
      nodes.push(node as T);
    }
    return nodes;
  }

  /**
   * Match Unix socket clients to servers by normalized path.
   * Creates INTERACTS_WITH edges for matches.
   */
  private async matchUnixSockets(
    clients: UnixSocketNode[],
    servers: UnixSocketNode[],
    graph: PluginContext['graph'],
    connections: ConnectionInfo[],
    factory: PluginContext['factory'],
  ): Promise<number> {
    let edgesCreated = 0;

    for (const client of clients) {
      const clientPath = this.normalizePath(client.path);
      if (!clientPath) continue;

      for (const server of servers) {
        const serverPath = this.normalizePath(server.path);
        if (!serverPath) continue;

        if (clientPath === serverPath) {
          await factory!.link({
            type: 'INTERACTS_WITH',
            src: client.id,
            dst: server.id,
            metadata: { matchType: 'path', path: clientPath }
          });
          edgesCreated++;

          connections.push({
            client: `unix:${clientPath}`,
            server: `unix-server:${serverPath}`,
            clientFile: client.file,
            serverFile: server.file
          });

          break; // One client -> one server
        }
      }
    }

    return edgesCreated;
  }

  /**
   * Match TCP clients to servers by port and host.
   * Creates INTERACTS_WITH edges for matches.
   */
  private async matchTcpSockets(
    clients: TcpSocketNode[],
    servers: TcpSocketNode[],
    graph: PluginContext['graph'],
    connections: ConnectionInfo[],
    factory: PluginContext['factory'],
  ): Promise<number> {
    let edgesCreated = 0;

    for (const client of clients) {
      if (client.port == null) continue;

      const clientHost = this.normalizeHost(client.host);

      for (const server of servers) {
        if (server.port == null) continue;
        if (client.port !== server.port) continue;

        const serverHost = this.normalizeHost(server.host);
        if (clientHost !== serverHost) continue;

        await factory!.link({
          type: 'INTERACTS_WITH',
          src: client.id,
          dst: server.id,
          metadata: { matchType: 'port', port: client.port, host: clientHost }
        });
        edgesCreated++;

        connections.push({
          client: `tcp:${clientHost}:${client.port}`,
          server: `tcp-server:${serverHost}:${server.port}`,
          clientFile: client.file,
          serverFile: server.file
        });

        break; // One client -> one server
      }
    }

    return edgesCreated;
  }

  /**
   * Normalize a Unix socket path for comparison.
   * Returns null for dynamic or empty paths.
   */
  private normalizePath(path: string | undefined): string | null {
    if (!path) return null;
    // Skip dynamic paths (template literal placeholders)
    if (path.includes('${')) return null;
    // Strip trailing slashes
    return path.replace(/\/+$/, '');
  }

  /**
   * Normalize host for comparison.
   * Defaults to 'localhost' if not specified.
   */
  private normalizeHost(host: string | undefined): string {
    return host ?? 'localhost';
  }
}
