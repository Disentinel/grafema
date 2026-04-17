/**
 * MapController — unified command API for controlling the visualization.
 *
 * Used by: PostMessageAdapter (VS Code webview), WebSocketAdapter (CLI),
 * and directly from the browser console (`window.grafema`).
 *
 * All commands return { ok: true } or { ok: false, error: string }.
 *
 * Renderer decoupling: the controller holds a lazily-injected `SceneApi`
 * (see `./SceneApi`) rather than a Three.js-specific scene ref. Callers
 * wire the api in when the scene mounts via `setScene(sceneApi)`; before
 * that, scene-touching commands (flyTo) still resolve state lookups but
 * are no-ops on the camera itself. This keeps the controller testable
 * in Node without a renderer.
 */

import { useDataStore } from '../store/dataStore';
import { useViewStore } from '../store/viewStore';
import { useRouteStore } from '../store/routeStore';
import { useDiffStore, type NodeChange } from '../store/diffStore';
import { useMapStore } from '../store/mapStore';
import type { SceneApi } from './SceneApi';

export interface CommandResult {
  ok: boolean;
  error?: string;
  data?: unknown;
}

export type CommandHandler = (params: Record<string, unknown>) => CommandResult;

class MapControllerImpl {
  private _sceneApi: SceneApi | null = null;

  /** Set by Canvas once the scene is constructed. `null` detaches. */
  setScene(api: SceneApi | null) {
    this._sceneApi = api;
  }

  /** Fly camera to a node by name or ID. Silent no-op on camera when no
   *  scene is attached; the node lookup still runs so the ok/err result
   *  reflects whether the target exists. */
  flyTo(params: { nodeId?: string; nodeName?: string }): CommandResult {
    const nodes = useDataStore.getState().nodes;
    const target = nodes.find(
      (n) => n.id === params.nodeId || n.name === params.nodeName,
    );
    if (!target) return { ok: false, error: `Node not found: ${params.nodeId ?? params.nodeName}` };
    this._sceneApi?.flyTo(target.x, target.z, 800);
    return { ok: true };
  }

  /** Set active lens */
  setLens(params: { name: string }): CommandResult {
    useViewStore.getState().setLens(params.name);
    return { ok: true };
  }

  /** Toggle a flow preset */
  toggleFlow(params: { name: string }): CommandResult {
    useViewStore.getState().toggleFlow(params.name);
    return { ok: true };
  }

  /** Add a route */
  addRoute(params: { id: string; label: string; color: string; nodeNames: string[] }): CommandResult {
    const nodes = useDataStore.getState().nodes;
    const nameToIdx = new Map(nodes.map((n, i) => [n.name, i]));
    const idToIdx = new Map(nodes.map((n, i) => [n.id, i]));

    const indices = params.nodeNames
      .map((name) => nameToIdx.get(name) ?? idToIdx.get(name))
      .filter((idx): idx is number => idx !== undefined);

    if (indices.length < 2) return { ok: false, error: 'Need at least 2 valid nodes' };

    useRouteStore.getState().addRoute({
      id: params.id,
      label: params.label,
      color: params.color,
      nodeIndices: indices,
    });
    return { ok: true };
  }

  /** Remove a route */
  removeRoute(params: { id: string }): CommandResult {
    useRouteStore.getState().removeRoute(params.id);
    return { ok: true };
  }

  /** Toggle route visibility */
  toggleRoute(params: { id: string }): CommandResult {
    useRouteStore.getState().toggleRoute(params.id);
    return { ok: true };
  }

  /** Get current state snapshot */
  getState(): CommandResult {
    const { nodes, edges, regions } = useDataStore.getState();
    const { lens, enabledFlows } = useViewStore.getState();
    const { routes } = useRouteStore.getState();
    const { cameraDistance } = useMapStore.getState();

    return {
      ok: true,
      data: {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        regionCount: regions.length,
        lens,
        enabledFlows: [...enabledFlows],
        routes: routes.map((r) => ({ id: r.id, label: r.label, visible: r.visible })),
        cameraDistance,
      },
    };
  }

  /** Pin a node */
  pin(params: { nodeId?: string; nodeName?: string; color?: string }): CommandResult {
    const nodes = useDataStore.getState().nodes;
    const target = nodes.find(
      (n) => n.id === params.nodeId || n.name === params.nodeName,
    );
    if (!target) return { ok: false, error: `Node not found` };
    useViewStore.getState().addPin(target.id, params.color ?? '#ff2222', target.name);
    return { ok: true };
  }

  /** Unpin a node */
  unpin(params: { nodeId?: string; nodeName?: string }): CommandResult {
    const nodes = useDataStore.getState().nodes;
    const target = nodes.find(
      (n) => n.id === params.nodeId || n.name === params.nodeName,
    );
    if (!target) return { ok: false, error: `Node not found` };
    useViewStore.getState().removePin(target.id);
    return { ok: true };
  }

  /** Enter diff mode */
  enterDiff(params: { removed?: string[]; changed?: { id: string; changes: Record<string, [number, number]> }[] }): CommandResult {
    const nodes = useDataStore.getState().nodes;
    const idToIdx = new Map(nodes.map((n, i) => [n.id, i]));

    const removedIdx = (params.removed ?? [])
      .map((id) => idToIdx.get(id))
      .filter((idx): idx is number => idx !== undefined);

    const changedMap = new Map<number, NodeChange[]>();
    for (const c of (params.changed ?? [])) {
      const idx = idToIdx.get(c.id);
      if (idx === undefined) continue;
      changedMap.set(idx, Object.entries(c.changes).map(([field, [from, to]]) => ({ field, from, to })));
    }

    useDiffStore.getState().enterDiff([], removedIdx, changedMap);
    return { ok: true };
  }

  /** Exit diff mode */
  exitDiff(): CommandResult {
    useDiffStore.getState().exitDiff();
    return { ok: true };
  }

  /** Handle a JSON-RPC request */
  handleRPC(request: { method: string; params?: Record<string, unknown> }): CommandResult {
    const { method, params = {} } = request;
    switch (method) {
      case 'flyTo': return this.flyTo(params as { nodeId?: string; nodeName?: string });
      case 'setLens': return this.setLens(params as { name: string });
      case 'toggleFlow': return this.toggleFlow(params as { name: string });
      case 'addRoute': return this.addRoute(params as { id: string; label: string; color: string; nodeNames: string[] });
      case 'removeRoute': return this.removeRoute(params as { id: string });
      case 'toggleRoute': return this.toggleRoute(params as { id: string });
      case 'getState': return this.getState();
      case 'pin': return this.pin(params as { nodeId?: string; nodeName?: string; color?: string });
      case 'unpin': return this.unpin(params as { nodeId?: string; nodeName?: string });
      case 'enterDiff': return this.enterDiff(params as { removed?: string[]; changed?: { id: string; changes: Record<string, [number, number]> }[] });
      case 'exitDiff': return this.exitDiff();
      default: return { ok: false, error: `Unknown method: ${method}` };
    }
  }
}

/** Singleton */
export const mapController = new MapControllerImpl();
