import { axialToPixel } from './hex.js';
import { computeHullPolygons } from './hull.js';

/**
 * Palette for link types. Callers can extend; anything not listed
 * falls back to a neutral grey.
 */
export const LINK_COLORS = {
  call:   '#66ddaa',  // teal-green
  import: '#a07bff',  // lavender
  ref:    '#f08a3c',  // orange
  default: '#7a8591',
};

/** Resolve a link's stroke color, respecting user palette + fallback. */
export function linkColor(type) {
  return LINK_COLORS[type] ?? LINK_COLORS.default;
}

/**
 * Canvas2D renderer — intentionally minimal.
 * No animation, no interaction — caller re-renders on change.
 *
 * Order: regions fill → link lines → node outlines → routes on top → labels.
 */

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {import('./map.js').HexMap} map
 * @param {{
 *   hexSize: number,
 *   origin: { x: number, y: number },
 *   showLinks?: boolean,
 *   showRoutes?: boolean,
 *   nodeLabels?: (n: import('./node.js').Node) => string,
 *   regionColor?: (regionId: string | null) => string,
 * }} opts
 */
export function render(ctx, map, opts) {
  const {
    hexSize, origin,
    showLinks = true,
    showRoutes = true,
    fillRegions = false,
    nodeLabels,
    regionColor = defaultRegionColor,
    overlay = null,
    hullLayers = null,
    hideHexes = false,
  } = opts;

  const c = ctx.canvas;
  ctx.fillStyle = '#0a0f14';
  ctx.fillRect(0, 0, c.width, c.height);

  if (fillRegions) {
    // ── Hull mode ─────────────────────────────────────────────
    // Replace each region's set of hex tiles with a single filled
    // polygon traced from the outer boundary (see hull.js).
    // Canvas2D `fill` handles multi-loop regions via non-zero winding.
    ctx.save();
    ctx.translate(origin.x, origin.y);
    for (const region of map.regions.values()) {
      if (region.nodes.size === 0) continue;
      const coords = [];
      for (const n of region.nodes) coords.push(n.coord);
      const loops = computeHullPolygons(coords, hexSize);
      if (loops.length === 0) continue;

      ctx.beginPath();
      for (const loop of loops) {
        for (let i = 0; i < loop.length; i++) {
          const p = loop[i];
          if (i === 0) ctx.moveTo(p.x, p.y);
          else         ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
      }
      ctx.fillStyle = regionColor(region.id);
      ctx.fill('nonzero');
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  } else if (!hideHexes) {
    // ── Per-hex mode ──────────────────────────────────────────
    for (const n of map.nodes.values()) {
      const { x, y } = axialToPixel(n.coord, hexSize);
      drawHex(ctx, origin.x + x, origin.y + y, hexSize * 0.92, regionColor(n.regionId));
    }
  }

  // 2. Links — per-type color + arrowhead at the target end.
  // Each link is its own `stroke` call (colors vary), so batching is
  // unprofitable here. For large graphs you'd precompute per-type
  // path buffers; the sandbox stays simple.
  if (showLinks) {
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    for (const l of map.links) {
      const a = axialToPixel(l.source.coord, hexSize);
      const b = axialToPixel(l.target.coord, hexSize);
      const ax = origin.x + a.x, ay = origin.y + a.y;
      const bx = origin.x + b.x, by = origin.y + b.y;

      // Shorten the segment so the arrow tip sits just inside the
      // target hex, not on top of it — keeps the head readable even
      // when a node is completely enclosed by hull fill.
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      const ux = dx / len, uy = dy / len;
      const inset = hexSize * 0.55;
      const tipX = bx - ux * inset;
      const tipY = by - uy * inset;

      const color = linkColor(l.type);
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();

      // Arrowhead triangle at the tip, facing along (ux, uy).
      const headLen = 8;
      const headHalf = 4;
      const px = -uy, py = ux; // perpendicular
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - ux * headLen + px * headHalf, tipY - uy * headLen + py * headHalf);
      ctx.lineTo(tipX - ux * headLen - px * headHalf, tipY - uy * headLen - py * headHalf);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  // 3. Routes — polyline per segment + numbered waypoint markers
  if (showRoutes) {
    for (const r of map.routes.values()) {
      // Stroke: one continuous polyline per segment, moveTo on segment
      // start so disjoint/branching segments don't auto-connect.
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (const seg of r.segments) {
        if (seg.length === 0) continue;
        for (let i = 0; i < seg.length; i++) {
          const p = axialToPixel(seg[i].coord, hexSize);
          const px = origin.x + p.x, py = origin.y + p.y;
          if (i === 0) ctx.moveTo(px, py);
          else         ctx.lineTo(px, py);
        }
      }
      ctx.stroke();

      // Waypoint markers: filled disc + dark outline + ordinal.
      // Numbering continues across segments within the same route, so a
      // branching/multi-span route still reads as an ordered sequence.
      let order = 1;
      ctx.font = 'bold 11px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const seg of r.segments) {
        for (const node of seg) {
          const p = axialToPixel(node.coord, hexSize);
          const cx = origin.x + p.x;
          const cy = origin.y + p.y;

          // Disc
          ctx.beginPath();
          ctx.arc(cx, cy, 9, 0, Math.PI * 2);
          ctx.fillStyle = r.color;
          ctx.fill();
          ctx.strokeStyle = '#0a0f14';
          ctx.lineWidth = 2;
          ctx.stroke();

          // Ordinal label in dark text
          ctx.fillStyle = '#0a0f14';
          ctx.fillText(String(order), cx, cy + 0.5);

          order++;
        }
      }
    }
  }

  // 3.5 Assembly hull layers — drawn between nodes and overlay.
  // Each layer: { coords: [{q,r}], fillColor, strokeColor?, lineWidth? }
  // Used by ring assembly to show "assembled" folders as hulls on top
  // of the per-hex grid, preserving both the tile detail and the
  // high-level grouping.
  if (hullLayers) {
    ctx.save();
    ctx.translate(origin.x, origin.y);
    for (const layer of hullLayers) {
      if (!layer.coords || layer.coords.length === 0) continue;
      const loops = computeHullPolygons(layer.coords, hexSize);
      if (loops.length === 0) continue;
      ctx.beginPath();
      for (const loop of loops) {
        for (let i = 0; i < loop.length; i++) {
          const p = loop[i];
          if (i === 0) ctx.moveTo(p.x, p.y);
          else         ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
      }
      if (layer.fillColor) { ctx.fillStyle = layer.fillColor; ctx.fill('nonzero'); }
      if (layer.strokeColor) {
        ctx.strokeStyle = layer.strokeColor;
        ctx.lineWidth = layer.lineWidth ?? 1.5;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // 4. Overlay — tectonic debug decorations (desire vectors, chosen dirs)
  if (overlay && overlay.desires) {
    ctx.save();
    ctx.translate(origin.x, origin.y);

    // overlay positions/vectors were built at overlay.hexSize; rescale
    // to current hexSize so zoom works correctly.
    const overlayScale = (overlay.hexSize ? hexSize / overlay.hexSize : 1);
    const DESIRE_SCALE = 1.5;
    const MAX_DESIRE_LEN = hexSize * 6;

    for (const d of overlay.desires) {
      const cx = d.cx * overlayScale;
      const cy = d.cy * overlayScale;
      const rawDx = d.rawDx * overlayScale;
      const rawDy = d.rawDy * overlayScale;

      // 1. Region centroid marker
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = regionColor(d.regionId);
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // 2. Raw desire vector — dashed cyan
      const mag = Math.hypot(rawDx, rawDy);
      if (mag > 0.01) {
        const targetLen = Math.min(mag * DESIRE_SCALE, MAX_DESIRE_LEN);
        const ux = rawDx / mag;
        const uy = rawDy / mag;
        const ex = cx + ux * targetLen;
        const ey = cy + uy * targetLen;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(ex, ey);
        ctx.strokeStyle = '#6ac';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);

        const ah = 7, ahHalf = 4;
        const px = -uy, py = ux;
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - ux * ah + px * ahHalf, ey - uy * ah + py * ahHalf);
        ctx.lineTo(ex - ux * ah - px * ahHalf, ey - uy * ah - py * ahHalf);
        ctx.closePath();
        ctx.fillStyle = '#6ac';
        ctx.fill();

        // Magnitude label is in raw (un-scaled) units to match what
        // tectonic.js logged; otherwise zoom would visually inflate it.
        const rawMag = Math.hypot(d.rawDx, d.rawDy);
        ctx.fillStyle = '#9cf';
        ctx.font = 'bold 10px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`|${rawMag.toFixed(1)}|`, ex + 6, ey);
      }

      // 3. Chosen hex direction — solid yellow arrow
      if (d.chosenDx !== undefined && d.chosenDy !== undefined) {
        const cdx = d.chosenDx * overlayScale;
        const cdy = d.chosenDy * overlayScale;
        const cmag = Math.hypot(cdx, cdy);
        if (cmag > 0.01) {
          const scale = hexSize * 1.8 / cmag;
          const ex2 = cx + cdx * scale;
          const ey2 = cy + cdy * scale;
          const cux = cdx / cmag;
          const cuy = cdy / cmag;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(ex2, ey2);
          ctx.strokeStyle = '#fc6';
          ctx.lineWidth = 3.5;
          ctx.stroke();
          const ah = 10, ahHalf = 6;
          const px2 = -cuy, py2 = cux;
          ctx.beginPath();
          ctx.moveTo(ex2, ey2);
          ctx.lineTo(ex2 - cux * ah + px2 * ahHalf, ey2 - cuy * ah + py2 * ahHalf);
          ctx.lineTo(ex2 - cux * ah - px2 * ahHalf, ey2 - cuy * ah - py2 * ahHalf);
          ctx.closePath();
          ctx.fillStyle = '#fc6';
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  // 5. Labels
  if (nodeLabels) {
    ctx.fillStyle = '#e0e6ec';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    for (const n of map.nodes.values()) {
      const { x, y } = axialToPixel(n.coord, hexSize);
      const label = nodeLabels(n);
      if (label) ctx.fillText(label, origin.x + x, origin.y + y + 3);
    }
  }
}

/**
 * Draw a single flat-top hexagon centered at (cx, cy).
 * Corners at angles 0°, 60°, ..., 300°.
 */
export function drawHex(ctx, cx, cy, size, fill) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    const px = cx + size * Math.cos(a);
    const py = cy + size * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py);
    else         ctx.lineTo(px, py);
  }
  ctx.closePath();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 0.5;
  ctx.stroke();
}

/** Deterministic hue from region id. */
export function defaultRegionColor(regionId) {
  if (!regionId) return '#22272d';
  let h = 0;
  for (let i = 0; i < regionId.length; i++) h = ((h << 5) - h + regionId.charCodeAt(i)) | 0;
  const hue = ((h % 360) + 360) % 360;
  return `hsl(${hue}, 60%, 45%)`;
}
