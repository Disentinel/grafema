/**
 * EDGE CASE: Missing cleanup functions
 *
 * BUG PATTERNS:
 * 1. setInterval without clearInterval
 * 2. addEventListener without removeEventListener
 * 3. WebSocket/EventSource without close
 * 4. Subscription without unsubscribe
 *
 * Tests: Detecting missing cleanup in useEffect
 */
import React, { useState, useEffect, useRef } from 'react';

function LeakyComponent() {
  const [data, setData] = useState(null);
  const [windowSize, setWindowSize] = useState({ w: 0, h: 0 });
  const socketRef = useRef(null);

  // BUG 1: setInterval without cleanup
  useEffect(() => {
    const id = setInterval(() => {
      console.log('polling...');
    }, 5000);
    // Missing: return () => clearInterval(id);
  }, []);

  // BUG 2: addEventListener without cleanup
  useEffect(() => {
    function handleResize() {
      setWindowSize({ w: window.innerWidth, h: window.innerHeight });
    }
    window.addEventListener('resize', handleResize);
    // Missing: return () => window.removeEventListener('resize', handleResize);
  }, []);

  // BUG 3: WebSocket without cleanup
  useEffect(() => {
    socketRef.current = new WebSocket('ws://example.com');
    socketRef.current.onmessage = (e) => setData(e.data);
    // Missing: return () => socketRef.current.close();
  }, []);

  // BUG 4: setTimeout can cause setState after unmount
  useEffect(() => {
    setTimeout(() => {
      setData('loaded');  // BUG: might fire after unmount
    }, 5000);
    // Missing: cleanup with clearTimeout
  }, []);

  // GOOD: Proper cleanup example
  useEffect(() => {
    const controller = new AbortController();

    fetch('/api/data', { signal: controller.signal })
      .then(r => r.json())
      .then(setData)
      .catch(() => {});

    return () => controller.abort();  // Proper cleanup!
  }, []);

  return <div>Data: {JSON.stringify(data)}</div>;
}

export default LeakyComponent;
