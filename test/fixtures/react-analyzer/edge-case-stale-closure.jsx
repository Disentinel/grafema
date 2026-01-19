/**
 * EDGE CASE: Stale closure bug
 *
 * BUG PATTERN: setInterval callback captures initial count value
 * The callback closes over `count` but doesn't have it in deps,
 * so it always sees count=0.
 *
 * Tests: Detecting stale closures in callbacks
 */
import React, { useState, useEffect } from 'react';

function BuggyTimer() {
  const [count, setCount] = useState(0);
  const [running, setRunning] = useState(false);

  // BUG: Stale closure - count is captured at mount time
  useEffect(() => {
    if (running) {
      const id = setInterval(() => {
        // BUG: `count` is stale here! Always 0
        console.log('count is:', count);
        setCount(count + 1);  // Always sets to 1
      }, 1000);

      return () => clearInterval(id);
    }
  }, [running]);  // Missing `count` in deps!

  // FIX would be: setCount(c => c + 1) or add count to deps

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setRunning(!running)}>
        {running ? 'Stop' : 'Start'}
      </button>
    </div>
  );
}

export default BuggyTimer;
