import * as THREE from 'three';
import type { GraphNode } from '../store/dataStore';
import type { Route } from '../store/routeStore';

const TUBE_RADIUS = 0.25;
const TUBE_SEGMENTS = 24;
const PARTICLE_COUNT = 6;
const PARTICLE_SPEED = 0.3;
const ROUTE_Y = 1.5;

/**
 * RouteLayer — renders route paths as thick colored spline tubes
 * with animated particles and waypoint markers.
 */
export class RouteLayer {
  private _group = new THREE.Group();
  private _routeObjects = new Map<string, {
    tube: THREE.Mesh;
    particles: THREE.Mesh[];
    curve: THREE.CatmullRomCurve3;
    particleOffsets: number[];
  }>();

  /** All node indices in currently visible routes — for elevation */
  activeNodeIndices = new Set<number>();

  /** Waypoint labels: { nodeIdx, screenX, screenY, name, step } */
  waypointLabels: { nodeIdx: number; worldX: number; worldZ: number; name: string; step: number; routeColor: string; routeLabel: string }[] = [];

  constructor(scene: THREE.Scene) {
    this._group.renderOrder = 15;
    scene.add(this._group);
  }

  update(routes: Route[], nodes: GraphNode[]) {
    this._clear();
    this.activeNodeIndices.clear();
    this.waypointLabels = [];

    for (const route of routes) {
      if (!route.visible) continue;

      const waypoints: THREE.Vector3[] = [];
      const validIndices: number[] = [];
      for (const ni of route.nodeIndices) {
        const node = nodes[ni];
        if (!node) continue;
        waypoints.push(new THREE.Vector3(node.x, ROUTE_Y, node.z));
        validIndices.push(ni);
        this.activeNodeIndices.add(ni);
      }

      if (waypoints.length < 2) continue;

      const curve = new THREE.CatmullRomCurve3(waypoints, false, 'catmullrom', 0.5);
      const color = new THREE.Color(route.color);

      // Tube
      const tubeGeo = new THREE.TubeGeometry(curve, TUBE_SEGMENTS, TUBE_RADIUS, 6, false);
      const tubeMat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.7, depthTest: false,
      });
      const tube = new THREE.Mesh(tubeGeo, tubeMat);
      tube.renderOrder = 15;
      this._group.add(tube);

      // Waypoint markers (small rings) + arrow heads
      for (let i = 0; i < waypoints.length; i++) {
        // Ring marker at waypoint
        const ringGeo = new THREE.TorusGeometry(0.5, 0.1, 6, 12);
        ringGeo.rotateX(Math.PI / 2);
        const ringMat = new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.9, depthTest: false,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.copy(waypoints[i]);
        ring.renderOrder = 16;
        this._group.add(ring);

        // Arrow between waypoints
        if (i > 0) {
          const dir = waypoints[i].clone().sub(waypoints[i - 1]).normalize();
          const arrowGeo = new THREE.ConeGeometry(0.2, 0.5, 4);
          arrowGeo.rotateX(Math.PI / 2);
          const arrowMat = new THREE.MeshBasicMaterial({
            color, transparent: true, opacity: 0.8, depthTest: false,
          });
          const arrow = new THREE.Mesh(arrowGeo, arrowMat);
          arrow.renderOrder = 16;
          const pos = waypoints[i].clone().sub(dir.clone().multiplyScalar(0.5));
          arrow.position.copy(pos);
          arrow.lookAt(pos.clone().add(dir));
          this._group.add(arrow);
        }

        // Store waypoint label info
        const node = nodes[validIndices[i]];
        if (node) {
          this.waypointLabels.push({
            nodeIdx: validIndices[i],
            worldX: node.x,
            worldZ: node.z,
            name: node.name,
            step: i + 1,
            routeColor: route.color,
            routeLabel: route.label,
          });
        }
      }

      // Particles
      const particles: THREE.Mesh[] = [];
      const particleOffsets: number[] = [];
      const particleGeo = new THREE.SphereGeometry(0.3, 6, 6);

      for (let p = 0; p < PARTICLE_COUNT; p++) {
        const pMat = new THREE.MeshBasicMaterial({
          color: color.clone().lerp(new THREE.Color(0xffffff), 0.5),
          transparent: true, opacity: 0.9, depthTest: false,
        });
        const particle = new THREE.Mesh(particleGeo, pMat);
        particle.renderOrder = 17;
        this._group.add(particle);
        particles.push(particle);
        particleOffsets.push(p / PARTICLE_COUNT);
      }

      this._routeObjects.set(route.id, { tube, particles, curve, particleOffsets });
    }
  }

  tick(dt: number) {
    for (const [, obj] of this._routeObjects) {
      for (let i = 0; i < obj.particles.length; i++) {
        obj.particleOffsets[i] = (obj.particleOffsets[i] + PARTICLE_SPEED * dt) % 1;
        const pos = obj.curve.getPointAt(obj.particleOffsets[i]);
        obj.particles[i].position.copy(pos);
      }
    }
  }

  private _clear() {
    while (this._group.children.length) {
      const c = this._group.children[0];
      this._group.remove(c);
      if (c instanceof THREE.Mesh) {
        c.geometry.dispose();
        (c.material as THREE.Material).dispose();
      }
    }
    this._routeObjects.clear();
  }

  dispose() { this._clear(); }
}
