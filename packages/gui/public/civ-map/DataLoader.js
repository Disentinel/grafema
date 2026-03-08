/**
 * DataLoader — binary stream parser for hex topology data.
 *
 * Handles batch types:
 *   0 — metadata (JSON)
 *   1 — region tiles + edges (binary)
 *   2 — hierarchy (binary)
 *
 * Wire format: repeating [batchType:u8][batchLen:u32LE][payload...]
 *
 * Region tiles (batch type 1):
 *   [regionIdx:u16LE][tileCount:u32LE]
 *   tiles x 20 bytes:
 *     [globalIdx:u32LE][typeIdx:u8][q:i16LE][r:i16LE]
 *     [degree:u16LE][flags:u8][lodLevel:u8]
 *     [pkgIdx:u8][dirIdx:u8][fileIdx:u16LE][fnIdx:u16LE][isFiller:u8]
 *   [edgeCount:u32LE]
 *   edges x 9 bytes: [src:u32LE][dst:u32LE][type:u8]
 *
 * Hierarchy (batch type 2):
 *   [count:u32LE]
 *   per entry:
 *     [idLen:u16LE][id:utf8][level:u8][kind:u8][parentIdx:u32LE]
 *     [allTileCount:u32LE][borderPtCount:u16LE]
 *     border x [x:f32LE][z:f32LE]
 *     [cx:f32LE][cz:f32LE][hue:f32LE][sat:f32LE][light:f32LE]
 */

export class DataLoader {
    constructor() {
        this.metadata = null;      // From batch type 0
        this.hierarchy = [];       // From batch type 2
        // Typed arrays for tile data
        this.tileGlobalIdx = null; // Uint32Array
        this.tileTypeIdx = null;   // Uint8Array
        this.tileQ = null;         // Int16Array
        this.tileR = null;         // Int16Array
        this.tileDegree = null;    // Uint16Array
        this.tileFlags = null;     // Uint8Array
        this.tileLodLevel = null;  // Uint8Array
        // Hierarchy indices per tile (from extended format)
        this.tilePkgIdx = null;    // Uint8Array
        this.tileDirIdx = null;    // Uint8Array
        this.tileFileIdx = null;   // Uint16Array
        this.tileFnIdx = null;     // Uint16Array
        this.tileIsFiller = null;  // Uint8Array
        this.tileRegionIdx = null; // Uint16Array
        // Edge data
        this.edgeSrc = null;       // Uint32Array
        this.edgeDst = null;       // Uint32Array
        this.edgeType = null;      // Uint8Array
        // Computed
        this.tileCount = 0;
        this.edgeCount = 0;
        this.worldX = null;        // Float32Array
        this.worldZ = null;        // Float32Array
        // Sequential -> global index map
        this.globalToSeq = null;   // Map<number, number>
    }

    async load(url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`DataLoader fetch failed: ${response.status}`);
        const buffer = await response.arrayBuffer();
        this._parse(new DataView(buffer));
        this._computeWorldPositions();
        return this;
    }

    _parse(view) {
        let offset = 0;
        const batches = { tiles: [], edges: [] };

        while (offset < view.byteLength) {
            const batchType = view.getUint8(offset); offset += 1;
            const batchLen = view.getUint32(offset, true); offset += 4;

            if (batchType === 0) {
                // JSON metadata
                const text = new TextDecoder().decode(
                    new Uint8Array(view.buffer, view.byteOffset + offset, batchLen),
                );
                this.metadata = JSON.parse(text);
            } else if (batchType === 1) {
                // Region tiles + edges (binary)
                const payload = new DataView(view.buffer, view.byteOffset + offset, batchLen);
                this._parseRegionBatch(payload, batches);
            } else if (batchType === 2) {
                // Hierarchy metadata (binary)
                const payload = new DataView(view.buffer, view.byteOffset + offset, batchLen);
                this._parseHierarchyBatch(payload);
            }
            offset += batchLen;
        }

        this.tileCount = batches.tiles.length;
        this.edgeCount = batches.edges.length;
        this._consolidate(batches);
    }

    _parseRegionBatch(view, batches) {
        let off = 0;
        const regionIdx = view.getUint16(off, true); off += 2;
        const tileCount = view.getUint32(off, true); off += 4;

        // Each tile: 20 bytes (13 original + 7 hierarchy)
        const TILE_SIZE = 20;
        for (let i = 0; i < tileCount; i++) {
            const base = off + i * TILE_SIZE;
            batches.tiles.push({
                globalIdx: view.getUint32(base, true),
                typeIdx: view.getUint8(base + 4),
                q: view.getInt16(base + 5, true),
                r: view.getInt16(base + 7, true),
                degree: view.getUint16(base + 9, true),
                flags: view.getUint8(base + 11),
                lodLevel: view.getUint8(base + 12),
                pkgIdx: view.getUint8(base + 13),
                dirIdx: view.getUint8(base + 14),
                fileIdx: view.getUint16(base + 15, true),
                fnIdx: view.getUint16(base + 17, true),
                isFiller: view.getUint8(base + 19),
                regionIdx,
            });
        }
        off += tileCount * TILE_SIZE;

        const edgeCount = view.getUint32(off, true); off += 4;
        for (let i = 0; i < edgeCount; i++) {
            const base = off + i * 9;
            batches.edges.push({
                src: view.getUint32(base, true),
                dst: view.getUint32(base + 4, true),
                type: view.getUint8(base + 8),
            });
        }
    }

    _parseHierarchyBatch(view) {
        let off = 0;
        const count = view.getUint32(off, true); off += 4;
        this.hierarchy = [];

        for (let i = 0; i < count; i++) {
            const idLen = view.getUint16(off, true); off += 2;
            const id = new TextDecoder().decode(
                new Uint8Array(view.buffer, view.byteOffset + off, idLen),
            );
            off += idLen;

            const level = view.getUint8(off); off += 1;
            const kind = view.getUint8(off); off += 1;
            const parentIdx = view.getUint32(off, true); off += 4;
            const allTileCount = view.getUint32(off, true); off += 4;
            const borderPtCount = view.getUint16(off, true); off += 2;

            const border = [];
            for (let b = 0; b < borderPtCount; b++) {
                border.push([
                    view.getFloat32(off, true),
                    view.getFloat32(off + 4, true),
                ]);
                off += 8;
            }

            const cx = view.getFloat32(off, true); off += 4;
            const cz = view.getFloat32(off, true); off += 4;
            const hue = view.getFloat32(off, true); off += 4;
            const sat = view.getFloat32(off, true); off += 4;
            const light = view.getFloat32(off, true); off += 4;

            this.hierarchy.push({
                id, level, kind, border,
                parentIdx: parentIdx === 0xFFFFFFFF ? null : parentIdx,
                allTileCount,
                center: [cx, cz],
                hue, saturation: sat, lightness: light,
            });
        }
    }

    _consolidate(batches) {
        const n = batches.tiles.length;
        this.tileGlobalIdx = new Uint32Array(n);
        this.tileTypeIdx = new Uint8Array(n);
        this.tileQ = new Int16Array(n);
        this.tileR = new Int16Array(n);
        this.tileDegree = new Uint16Array(n);
        this.tileFlags = new Uint8Array(n);
        this.tileLodLevel = new Uint8Array(n);
        this.tilePkgIdx = new Uint8Array(n);
        this.tileDirIdx = new Uint8Array(n);
        this.tileFileIdx = new Uint16Array(n);
        this.tileFnIdx = new Uint16Array(n);
        this.tileIsFiller = new Uint8Array(n);
        this.tileRegionIdx = new Uint16Array(n);

        this.globalToSeq = new Map();
        for (let i = 0; i < n; i++) {
            const t = batches.tiles[i];
            this.tileGlobalIdx[i] = t.globalIdx;
            this.tileTypeIdx[i] = t.typeIdx;
            this.tileQ[i] = t.q;
            this.tileR[i] = t.r;
            this.tileDegree[i] = t.degree;
            this.tileFlags[i] = t.flags;
            this.tileLodLevel[i] = t.lodLevel;
            this.tilePkgIdx[i] = t.pkgIdx;
            this.tileDirIdx[i] = t.dirIdx;
            this.tileFileIdx[i] = t.fileIdx;
            this.tileFnIdx[i] = t.fnIdx;
            this.tileIsFiller[i] = t.isFiller;
            this.tileRegionIdx[i] = t.regionIdx;
            this.globalToSeq.set(t.globalIdx, i);
        }

        const e = batches.edges.length;
        this.edgeSrc = new Uint32Array(e);
        this.edgeDst = new Uint32Array(e);
        this.edgeType = new Uint8Array(e);
        for (let i = 0; i < e; i++) {
            this.edgeSrc[i] = batches.edges[i].src;
            this.edgeDst[i] = batches.edges[i].dst;
            this.edgeType[i] = batches.edges[i].type;
        }
    }

    _computeWorldPositions() {
        const n = this.tileCount;
        const ts = this.metadata?.tile_size ?? 1.0;
        this.worldX = new Float32Array(n);
        this.worldZ = new Float32Array(n);
        const sqrt3 = Math.sqrt(3);
        for (let i = 0; i < n; i++) {
            const q = this.tileQ[i], r = this.tileR[i];
            this.worldX[i] = ts * (1.5 * q);
            this.worldZ[i] = ts * (sqrt3 / 2 * q + sqrt3 * r);
        }
    }

    /** Get kind name from enum value */
    kindName(kindValue) {
        return ['Root', 'Package', 'Directory', 'File', 'Function', 'Block'][kindValue] ?? 'Unknown';
    }
}
