/**
 * Refs patterns - mutable escape hatch
 *
 * Tests: useRef, forwardRef, useImperativeHandle, callback refs
 *
 * IMPORTANT: Refs are MUTABLE and don't trigger re-renders!
 * This is a source of bugs when mixing refs with state.
 */
import React, {
  useRef,
  forwardRef,
  useImperativeHandle,
  useState,
  useEffect
} from 'react';

// Basic useRef for DOM element
function FocusInput() {
  const inputRef = useRef(null);

  function handleClick() {
    inputRef.current.focus();
    inputRef.current.select();
  }

  return (
    <div>
      <input ref={inputRef} type="text" />
      <button onClick={handleClick}>Focus</button>
    </div>
  );
}

// useRef for mutable value (not DOM)
function Timer() {
  const [count, setCount] = useState(0);
  const intervalRef = useRef(null);
  const countRef = useRef(count);  // Mirror state in ref

  // Keep ref in sync with state
  useEffect(() => {
    countRef.current = count;
  }, [count]);

  function start() {
    intervalRef.current = setInterval(() => {
      // Use ref to get current value without closure issue
      console.log('Current count:', countRef.current);
      setCount(c => c + 1);
    }, 1000);
  }

  function stop() {
    clearInterval(intervalRef.current);
  }

  return (
    <div>
      <p>{count}</p>
      <button onClick={start}>Start</button>
      <button onClick={stop}>Stop</button>
    </div>
  );
}

// BUG PATTERN: Reading stale ref
function BuggyRefReader() {
  const [value, setValue] = useState('');
  const valueRef = useRef(value);

  // BUG: ref not updated, will always log initial value
  function logValue() {
    console.log('Ref value:', valueRef.current);  // Always ''
    console.log('State value:', value);  // Current value
  }

  return (
    <div>
      <input value={value} onChange={e => setValue(e.target.value)} />
      <button onClick={logValue}>Log</button>
    </div>
  );
}

// forwardRef - passing ref to child
const FancyInput = forwardRef((props, ref) => {
  return (
    <input
      ref={ref}
      className="fancy"
      {...props}
    />
  );
});

// useImperativeHandle - custom ref API
const CustomInput = forwardRef((props, ref) => {
  const inputRef = useRef(null);

  useImperativeHandle(ref, () => ({
    focus: () => {
      inputRef.current.focus();
    },
    clear: () => {
      inputRef.current.value = '';
    },
    getValue: () => {
      return inputRef.current.value;
    }
  }));

  return <input ref={inputRef} {...props} />;
});

// Callback ref - called when ref changes
function MeasuredBox() {
  const [height, setHeight] = useState(0);

  // Callback ref - called with element or null
  const measuredRef = (node) => {
    if (node !== null) {
      setHeight(node.getBoundingClientRect().height);
    }
  };

  return (
    <div ref={measuredRef}>
      <p>My height is: {height}px</p>
    </div>
  );
}

// Ref to store previous value
function usePrevious(value) {
  const ref = useRef();

  useEffect(() => {
    ref.current = value;
  });

  return ref.current;
}

function ShowPrevious() {
  const [count, setCount] = useState(0);
  const prevCount = usePrevious(count);

  return (
    <div>
      <p>Now: {count}, Before: {prevCount}</p>
      <button onClick={() => setCount(c => c + 1)}>+</button>
    </div>
  );
}

// Parent using imperative handle
function ParentWithCustomRef() {
  const inputRef = useRef(null);

  function handleClick() {
    inputRef.current.focus();
    inputRef.current.clear();
    const val = inputRef.current.getValue();
    console.log('Got value:', val);
  }

  return (
    <div>
      <CustomInput ref={inputRef} placeholder="Type here" />
      <button onClick={handleClick}>Do Stuff</button>
    </div>
  );
}

export default function App() {
  return (
    <div>
      <FocusInput />
      <Timer />
      <MeasuredBox />
      <ShowPrevious />
      <ParentWithCustomRef />
    </div>
  );
}
