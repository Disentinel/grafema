/**
 * Basic hooks usage
 * Tests: react:state, react:effect, UPDATES_STATE, DEPENDS_ON
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';

function Counter() {
  const [count, setCount] = useState(0);
  const [name, setName] = useState('');

  // Effect with dependency
  useEffect(() => {
    document.title = `Count: ${count}`;
  }, [count]);

  // Effect without deps (runs every render)
  useEffect(() => {
    console.log('rendered');
  });

  // Effect with empty deps (mount only)
  useEffect(() => {
    console.log('mounted');
    return () => {
      console.log('cleanup on unmount');
    };
  }, []);

  // useCallback with deps
  const increment = useCallback(() => {
    setCount(c => c + 1);
  }, []);

  // useMemo with deps
  const doubled = useMemo(() => count * 2, [count]);

  return (
    <div>
      <p>Count: {count}</p>
      <p>Doubled: {doubled}</p>
      <input value={name} onChange={e => setName(e.target.value)} />
      <button onClick={increment}>+</button>
    </div>
  );
}

export default Counter;
