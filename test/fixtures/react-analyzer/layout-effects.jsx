/**
 * useLayoutEffect and synchronous patterns
 *
 * IMPORTANT: useLayoutEffect runs SYNCHRONOUSLY after DOM mutations
 * but BEFORE the browser paints. This can cause performance issues!
 *
 * Tests: useLayoutEffect, DOM measurements, animation frame scheduling
 */
import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useInsertionEffect
} from 'react';

// useLayoutEffect - runs before paint
function TooltipWithMeasurement({ targetRect, children }) {
  const tooltipRef = useRef(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  // CORRECT use of useLayoutEffect:
  // Measure tooltip and position it BEFORE user sees it
  useLayoutEffect(() => {
    if (tooltipRef.current && targetRect) {
      const { width, height } = tooltipRef.current.getBoundingClientRect();

      // Position above the target
      setPosition({
        top: targetRect.top - height - 10,
        left: targetRect.left + (targetRect.width - width) / 2
      });
    }
  }, [targetRect]);

  return (
    <div
      ref={tooltipRef}
      style={{
        position: 'absolute',
        top: position.top,
        left: position.left
      }}
    >
      {children}
    </div>
  );
}

// BAD: Heavy computation in useLayoutEffect
function SlowLayoutEffect() {
  const [items, setItems] = useState([]);

  // BAD: This blocks paint!
  useLayoutEffect(() => {
    // Simulating heavy computation
    const result = [];
    for (let i = 0; i < 10000; i++) {
      result.push(Math.random());
    }
    setItems(result);
  }, []);

  return <div>{items.length} items</div>;
}

// Scroll restoration with useLayoutEffect
function ScrollRestoration({ savedScrollY }) {
  useLayoutEffect(() => {
    // Scroll BEFORE paint so user doesn't see the jump
    window.scrollTo(0, savedScrollY);
  }, [savedScrollY]);

  return null;
}

// DOM mutation before paint
function AutoFocus({ shouldFocus }) {
  const inputRef = useRef(null);

  useLayoutEffect(() => {
    if (shouldFocus && inputRef.current) {
      inputRef.current.focus();
    }
  }, [shouldFocus]);

  return <input ref={inputRef} />;
}

// useInsertionEffect - for CSS-in-JS libraries
// Runs before useLayoutEffect, used for style injection
function StyledComponent({ css }) {
  // useInsertionEffect is for library authors (styled-components, emotion)
  useInsertionEffect(() => {
    // Inject styles before any layout effects run
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    return () => {
      document.head.removeChild(style);
    };
  }, [css]);

  return <div className="styled">Content</div>;
}

// Difference between useEffect and useLayoutEffect
function EffectComparison() {
  const [color, setColor] = useState('red');
  const divRef = useRef(null);

  // useEffect: May cause flicker!
  // Browser paints red, then effect runs and changes to blue
  useEffect(() => {
    if (divRef.current) {
      // This runs AFTER paint - user might see red flash
      divRef.current.style.backgroundColor = 'blue';
    }
  }, []);

  // useLayoutEffect: No flicker
  // Effect runs before paint, user only sees blue
  useLayoutEffect(() => {
    if (divRef.current) {
      // This runs BEFORE paint - no flash
      divRef.current.style.color = 'white';
    }
  }, []);

  return (
    <div ref={divRef} style={{ backgroundColor: color, padding: 20 }}>
      Watch for flicker
    </div>
  );
}

// Measuring and adjusting layout
function AutoResizingTextarea() {
  const textareaRef = useRef(null);
  const [value, setValue] = useState('');

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      // Reset height to get correct scrollHeight
      textarea.style.height = 'auto';
      // Set to scrollHeight
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, [value]);

  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={e => setValue(e.target.value)}
      style={{ overflow: 'hidden', resize: 'none' }}
    />
  );
}

// Animation with useLayoutEffect
function AnimatedMount({ children }) {
  const ref = useRef(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element) {
      // Set initial state BEFORE paint
      element.style.opacity = '0';
      element.style.transform = 'translateY(-20px)';

      // Force reflow
      element.offsetHeight;

      // Trigger animation
      element.style.transition = 'all 0.3s ease';
      element.style.opacity = '1';
      element.style.transform = 'translateY(0)';
    }
  }, []);

  return <div ref={ref}>{children}</div>;
}

// Third-party library integration that needs sync DOM access
function D3Integration({ data }) {
  const svgRef = useRef(null);

  useLayoutEffect(() => {
    // D3 manipulates DOM directly
    // Must run before paint to avoid flicker
    const svg = svgRef.current;

    // Clear previous
    while (svg.firstChild) {
      svg.removeChild(svg.firstChild);
    }

    // D3-style DOM manipulation
    data.forEach((d, i) => {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', i * 30);
      rect.setAttribute('y', 100 - d);
      rect.setAttribute('width', 25);
      rect.setAttribute('height', d);
      rect.setAttribute('fill', 'steelblue');
      svg.appendChild(rect);
    });
  }, [data]);

  return <svg ref={svgRef} width={300} height={100} />;
}

export default function App() {
  const [showTooltip, setShowTooltip] = useState(false);
  const buttonRef = useRef(null);
  const [targetRect, setTargetRect] = useState(null);

  return (
    <div>
      <button
        ref={buttonRef}
        onMouseEnter={() => {
          setTargetRect(buttonRef.current.getBoundingClientRect());
          setShowTooltip(true);
        }}
        onMouseLeave={() => setShowTooltip(false)}
      >
        Hover me
      </button>

      {showTooltip && (
        <TooltipWithMeasurement targetRect={targetRect}>
          Tooltip content
        </TooltipWithMeasurement>
      )}

      <EffectComparison />
      <AutoResizingTextarea />
      <AnimatedMount>Animated!</AnimatedMount>
      <D3Integration data={[30, 60, 90, 45, 70]} />
    </div>
  );
}
