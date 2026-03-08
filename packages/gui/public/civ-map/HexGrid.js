/**
 * HexGrid — InstancedMesh wrapper with custom shader for per-instance
 * color, opacity, and height.
 *
 * Uses flat-top hex geometry laid on the XZ plane.
 * Supports: bulk tile placement, smooth opacity transitions,
 * ground-plane raycasting, and per-instance height offsets.
 */
import * as THREE from 'three';

/** Create flat-top hex geometry on the XZ plane */
function createHexGeometry(size) {
    const shape = new THREE.Shape();
    for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i;
        const x = size * Math.cos(angle);
        const y = size * Math.sin(angle);
        if (i === 0) shape.moveTo(x, y);
        else shape.lineTo(x, y);
    }
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2); // lay flat on XZ plane
    return geo;
}

const vertexShader = `
    attribute vec3 instanceColor;
    attribute float instanceOpacity;
    attribute float instanceHeight;
    varying vec3 vColor;
    varying float vOpacity;

    void main() {
        vColor = instanceColor;
        vOpacity = instanceOpacity;
        vec3 pos = position;
        pos.y += instanceHeight;
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mvPosition;
    }
`;

const fragmentShader = `
    varying vec3 vColor;
    varying float vOpacity;

    void main() {
        if (vOpacity < 0.01) discard;
        gl_FragColor = vec4(vColor, vOpacity);
    }
`;

export class HexGrid {
    /**
     * @param {number} maxCount - maximum number of hex instances
     * @param {number} tileSize - hex radius (world units)
     * @param {object} [options]
     * @param {number} [options.scale=1.0] - scale factor applied to hex geometry
     */
    constructor(maxCount, tileSize, options = {}) {
        this.maxCount = maxCount;
        this.tileSize = tileSize;
        this.count = 0;

        const scale = options.scale ?? 1.0;
        const geo = createHexGeometry(tileSize * scale);

        // Per-instance attributes
        this._colorArray = new Float32Array(maxCount * 3);
        this._opacityArray = new Float32Array(maxCount);
        this._heightArray = new Float32Array(maxCount);
        this._targetOpacity = new Float32Array(maxCount);

        const colorAttr = new THREE.InstancedBufferAttribute(this._colorArray, 3);
        const opacityAttr = new THREE.InstancedBufferAttribute(this._opacityArray, 1);
        const heightAttr = new THREE.InstancedBufferAttribute(this._heightArray, 1);
        geo.setAttribute('instanceColor', colorAttr);
        geo.setAttribute('instanceOpacity', opacityAttr);
        geo.setAttribute('instanceHeight', heightAttr);

        const material = new THREE.ShaderMaterial({
            vertexShader,
            fragmentShader,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
        });

        this.mesh = new THREE.InstancedMesh(geo, material, maxCount);
        this.mesh.count = 0;
        this.mesh.frustumCulled = false;

        // World position arrays for raycasting
        this.worldX = null;
        this.worldZ = null;

        this._dummy = new THREE.Object3D();
    }

    /**
     * Set all tile positions from pre-computed world coordinate arrays.
     * Initializes instance matrices and default opacity.
     */
    setTiles(worldX, worldZ, count) {
        this.worldX = worldX;
        this.worldZ = worldZ;
        this.count = count;
        this.mesh.count = count;

        for (let i = 0; i < count; i++) {
            this._dummy.position.set(worldX[i], 0, worldZ[i]);
            this._dummy.updateMatrix();
            this.mesh.setMatrixAt(i, this._dummy.matrix);
            this._opacityArray[i] = 1.0;
            this._targetOpacity[i] = 1.0;
        }
        this.mesh.instanceMatrix.needsUpdate = true;
        this.mesh.geometry.attributes.instanceOpacity.needsUpdate = true;
    }

    /** Set RGB color for a single instance (values 0..1) */
    setColor(index, r, g, b) {
        const i3 = index * 3;
        this._colorArray[i3] = r;
        this._colorArray[i3 + 1] = g;
        this._colorArray[i3 + 2] = b;
    }

    /** Set target opacity for smooth transition */
    setOpacity(index, opacity) {
        this._targetOpacity[index] = opacity;
    }

    /** Set height offset for a single instance */
    setHeight(index, height) {
        this._heightArray[index] = height;
    }

    /** Flush color changes to the GPU */
    commitColors() {
        this.mesh.geometry.attributes.instanceColor.needsUpdate = true;
    }

    /** Flush height changes to the GPU */
    commitHeights() {
        this.mesh.geometry.attributes.instanceHeight.needsUpdate = true;
    }

    /**
     * Smooth opacity transition toward target values.
     * Call every frame. Returns true if still animating.
     */
    lerpOpacity(factor = 0.08) {
        let changed = false;
        for (let i = 0; i < this.count; i++) {
            const current = this._opacityArray[i];
            const target = this._targetOpacity[i];
            if (Math.abs(current - target) > 0.01) {
                this._opacityArray[i] = current + (target - current) * factor;
                changed = true;
            }
        }
        if (changed) {
            this.mesh.geometry.attributes.instanceOpacity.needsUpdate = true;
        }
        return changed;
    }

    /**
     * Raycast: find nearest tile to normalized mouse coords.
     * Projects ray onto the ground plane (y=0) and returns the closest
     * tile index, or -1 if none within range.
     */
    raycast(mouse, camera) {
        if (!this.worldX || this.count === 0) return -1;

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, camera);

        // Intersect ground plane y=0
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        const hit = new THREE.Vector3();
        if (!raycaster.ray.intersectPlane(plane, hit)) return -1;

        // Find nearest tile
        let bestIdx = -1;
        let bestDist = this.tileSize * this.tileSize;
        for (let i = 0; i < this.count; i++) {
            const dx = hit.x - this.worldX[i];
            const dz = hit.z - this.worldZ[i];
            const d2 = dx * dx + dz * dz;
            if (d2 < bestDist) {
                bestDist = d2;
                bestIdx = i;
            }
        }
        return bestIdx;
    }

    /** Add the instanced mesh to a Three.js scene */
    addTo(scene) {
        scene.add(this.mesh);
    }

    /** Release GPU resources */
    dispose() {
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
    }
}
