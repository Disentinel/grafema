/**
 * EDGE CASE: Canvas rendering with requestAnimationFrame
 *
 * BUG PATTERNS:
 * 1. RAF loop not cancelled on unmount
 * 2. Stale data in RAF callback (closure over old state)
 * 3. Canvas context state not saved/restored
 * 4. Drawing with stale node positions
 * 5. Multiple RAF loops accumulating
 *
 * Tests: Detecting Canvas/RAF rendering issues
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';

function GraphRenderer({ nodes, edges, selectedNode }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const [zoom, setZoom] = useState(1);

  // BUG 1: RAF without proper cleanup - loop keeps running after unmount
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    function render() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // BUG 2: `nodes` might be stale in this closure!
      // If nodes prop changes, we still render old nodes
      nodes.forEach(node => {
        ctx.fillStyle = node.color;
        ctx.fillRect(node.x, node.y, 50, 50);

        // Canvas text rendering
        ctx.fillStyle = 'black';
        ctx.font = '12px Arial';
        ctx.fillText(node.label, node.x, node.y + 60);
      });

      // BUG 3: selectedNode is stale - always shows initial selection
      if (selectedNode) {
        ctx.strokeStyle = 'red';
        ctx.lineWidth = 3;
        ctx.strokeRect(selectedNode.x - 5, selectedNode.y - 5, 60, 60);
      }

      rafRef.current = requestAnimationFrame(render);
    }

    render();
    // BUG: Missing cleanup!
    // Should be: return () => cancelAnimationFrame(rafRef.current);
  }, []);  // BUG: Empty deps but uses nodes, selectedNode!

  // BUG 4: Multiple RAF loops - each zoom change starts NEW loop
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    function zoomRender() {
      ctx.save();
      ctx.scale(zoom, zoom);
      // ... render ...
      ctx.restore();
      requestAnimationFrame(zoomRender);  // BUG: No ref, can't cancel!
    }

    zoomRender();  // Starts another loop!
  }, [zoom]);  // Every zoom change = new loop

  // BUG 5: Context state leak
  function drawNode(ctx, node) {
    ctx.save();  // Good
    ctx.fillStyle = node.color;
    ctx.translate(node.x, node.y);
    ctx.fillRect(0, 0, 50, 50);
    // Missing ctx.restore()! State leaks to next node
  }

  // CORRECT pattern for reference
  const drawNodeCorrect = useCallback((ctx, node) => {
    ctx.save();
    ctx.fillStyle = node.color;
    ctx.translate(node.x, node.y);
    ctx.fillRect(0, 0, 50, 50);
    ctx.restore();  // Properly restored
  }, []);

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={800}
        height={600}
        onClick={(e) => {
          // BUG 6: Using stale nodes in click handler
          const rect = canvasRef.current.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;

          // This `nodes` might be stale!
          const clicked = nodes.find(n =>
            x >= n.x && x <= n.x + 50 &&
            y >= n.y && y <= n.y + 50
          );
        }}
      />
      <button onClick={() => setZoom(z => z + 0.1)}>Zoom In</button>
    </div>
  );
}

export default GraphRenderer;
