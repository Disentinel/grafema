import * as THREE from 'three';
import type { GraphNode } from '../store/dataStore';
import type { Route } from '../store/routeStore';

const TUBE_RADIUS = 0.25;
const TUBE_SEGMENTS = 24;
const PARTICLE_COUNT = 6;
const PARTICLE_SPEED = 0.3; // fraction of path per second
const ROUTE_Y = 1.5; // float above tiles

/**
 * RouteLayer — renders route paths as thick colored spline tubes
 * with animated particles flowing along them.
 */
export class RouteLayer {
  private _group = new THREE.Group();
  private _routeObjects = new Map<string, {
    tube: THREE.Mesh;
    particles: THREE.Mesh[];
    curve: THREE.CatmullRomCurve3;
    particleOffsets: number[];
  }>();

  constructor(scene: THREE.Scene) {
    this._group.renderOrder = 15; // above flow edges (10)
    scene.add(this._group);
  }

  /**
   * Build/rebuild all routes from current data.
   */
  update(routes: Route[], nodes: GraphNode[]) {
    // Remove old
    this._clear();

    for (const route of routes) {
      if (!route.visible) continue;

      // Get world positions of route nodes
      const waypoints: THREE.Vector3[] = [];
      for (const ni of route.nodeIndices) {
        const node = nodes[ni];
        if (!node) continue;
        waypoints.push(new THREE.Vector3(node.x, ROUTE_Y, node.z));
      }

      if (waypoints.length < 2) continue;

      // Catmull-Rom spline through waypoints
      const curve = new THREE.CatmullRomCurve3(waypoints, false, 'catmullrom', 0.5);

      // Tube
      const tubeGeo = new THREE.TubeGeometry(curve, TUBE_SEGMENTS, TUBE_RADIUS, 6, false);
      const color = new THREE.Color(route.color);
      const tubeMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.7,
        depthTest: false,
      });
      const tube = new THREE.Mesh(tubeGeo, tubeMat);
      tube.renderOrder = 15;
      this._group.add(tube);

      // Arrow heads at each waypoint (except first)
      for (let i = 1; i < waypoints.length; i++) {
        const dir = waypoints[i].clone().sub(waypoints[i - 1]).normalize();
        const arrowGeo = new THREE.ConeGeometry(0.3, 0.7, 4);
        arrowGeo.rotateX(Math.PI / 2);
        const arrowMat = new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.8,
          depthTest: false,
        });
        const arrow = new THREE.Mesh(arrowGeo, arrowMat);
        arrow.renderOrder = 16;
        // Position slightly before the waypoint
        const pos = waypoints[i].clone().sub(dir.clone().multiplyScalar(0.5));
        arrow.position.copy(pos);
        arrow.lookAt(pos.clone().add(dir));
        this._group.add(arrow);
      }

      // Animated particles (small glowing spheres)
      const particles: THREE.Mesh[] = [];
      const particleOffsets: number[] = [];
      const particleGeo = new THREE.SphereGeometry(0.3, 6, 6);

      for (let p = 0; p < PARTICLE_COUNT; p++) {
        const pMat = new THREE.MeshBasicMaterial({
          color: color.clone().lerp(new THREE.Color(0xffffff), 0.5),
          transparent: true,
          opacity: 0.9,
          depthTest: false,
        });
        const particle = new THREE.Mesh(particleGeo, pMat);
        particle.renderOrder = 17;
        this._group.add(particle);
        particles.push(particle);
        particleOffsets.push(p / PARTICLE_COUNT); // evenly spaced
      }

      this._routeObjects.set(route.id, { tube, particles, curve, particleOffsets });
    }
  }

  /**
   * Call in render loop — animate particles along routes.
   */
  tick(dt: number) {
    for (const [, obj] of this._routeObjects) {
      for (let i = 0; i < obj.particles.length; i++) {
        obj.particleOffsets[i] = (obj.particleOffsets[i] + PARTICLE_SPEED * dt) % 1;
        const t = obj.particleOffsets[i];
        const pos = obj.curve.getPointAt(t);
        obj.particles[i].position.copy(pos);
      }
    }
  }

  private _clear() {
    for (const [, obj] of this._routeObjects) {
      obj.tube.geometry.dispose();
      (obj.tube.material as THREE.Material).dispose();
      for (const p of obj.particles) {
        p.geometry.dispose();
        (p.material as THREE.Material).dispose();
      }
    }
    // Remove all children
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
