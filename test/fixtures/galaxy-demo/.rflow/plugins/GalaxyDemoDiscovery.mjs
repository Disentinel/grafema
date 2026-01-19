/**
 * GalaxyDemoDiscovery - discovery plugin for galaxy-demo fixture
 *
 * Finds services by scanning subdirectories (auth, payments, notifications)
 * Each subdirectory with .js files = 1 service
 */

import { readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

export default class GalaxyDemoDiscovery {
  constructor(config = {}) {
    this.config = config;
  }

  get metadata() {
    return {
      name: 'GalaxyDemoDiscovery',
      phase: 'DISCOVERY',
      priority: 100, // Higher priority than SimpleProjectDiscovery
      creates: {
        nodes: ['SERVICE'],
        edges: []
      },
      dependencies: []
    };
  }

  async execute(context) {
    const { projectPath, graph } = context;
    const services = [];

    try {
      // Scan subdirectories
      const entries = readdirSync(projectPath);

      for (const entry of entries) {
        const fullPath = join(projectPath, entry);

        // Skip hidden dirs and .rflow
        if (entry.startsWith('.')) continue;

        // Check if directory
        if (!statSync(fullPath).isDirectory()) continue;

        // Check if has .js files
        const hasJsFiles = readdirSync(fullPath).some(f => f.endsWith('.js'));
        if (!hasJsFiles) continue;

        // Found a service!
        const serviceName = entry;
        const serverFile = join(fullPath, 'server.js');

        // Require server.js as entrypoint
        if (!existsSync(serverFile)) {
          console.warn(`[GalaxyDemoDiscovery] Skipping ${serviceName}: no server.js found`);
          continue;
        }

        // Create SERVICE node with server.js as entrypoint
        const serviceNode = {
          id: `service:${serviceName}`,
          type: 'SERVICE',
          name: serviceName,
          path: serverFile, // <- IMPORTANT: path должен быть файл, не директория!
          entrypoint: serverFile,
          discoveryMethod: 'galaxy-demo',
        };

        await graph.addNode(serviceNode);

        services.push({
          id: serviceNode.id,
          name: serviceName,
          path: serverFile, // <- path = entrypoint файл
          type: 'galaxy-demo',
          metadata: {
            entrypoint: serverFile,
          }
        });
      }

      console.log(`[GalaxyDemoDiscovery] Found ${services.length} services:`, services.map(s => s.name));

      return {
        success: true,
        stats: { nodes: services.length, edges: 0 },
        metadata: { services }
      };
    } catch (error) {
      return {
        success: false,
        error
      };
    }
  }
}
