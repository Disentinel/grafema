/**
 * Observer APIs and advanced browser APIs
 *
 * Tests: IntersectionObserver, ResizeObserver, MutationObserver,
 *        matchMedia, Geolocation, Notifications, Web Workers
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';

// IntersectionObserver - visibility detection
function LazyImage({ src, alt }) {
  const [isVisible, setIsVisible] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const imgRef = useRef(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();  // Stop observing once visible
        }
      },
      { threshold: 0.1, rootMargin: '100px' }
    );

    if (imgRef.current) {
      observer.observe(imgRef.current);
    }

    return () => observer.disconnect();
  }, []);

  return (
    <div ref={imgRef}>
      {isVisible ? (
        <img
          src={src}
          alt={alt}
          onLoad={() => setHasLoaded(true)}
        />
      ) : (
        <div className="placeholder">Loading...</div>
      )}
    </div>
  );
}

// ResizeObserver - element size changes
function ResizeAware({ children }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const containerRef = useRef(null);

  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        const { width, height } = entry.contentRect;
        setSize({ width, height });
      }
    });

    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef}>
      <div>Size: {size.width}x{size.height}</div>
      {children}
    </div>
  );
}

// MutationObserver - DOM changes
function DOMWatcher() {
  const [mutations, setMutations] = useState([]);
  const containerRef = useRef(null);

  useEffect(() => {
    const observer = new MutationObserver((mutationsList) => {
      const changes = mutationsList.map(m => ({
        type: m.type,
        target: m.target.nodeName,
        addedNodes: m.addedNodes.length,
        removedNodes: m.removedNodes.length
      }));
      setMutations(prev => [...prev, ...changes]);
    });

    if (containerRef.current) {
      observer.observe(containerRef.current, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
    }

    return () => observer.disconnect();
  }, []);

  return (
    <div ref={containerRef}>
      <pre>{JSON.stringify(mutations, null, 2)}</pre>
    </div>
  );
}

// matchMedia - responsive queries in JS
function useMediaQuery(query) {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    setMatches(mediaQuery.matches);

    const handler = (e) => setMatches(e.matches);
    mediaQuery.addEventListener('change', handler);

    return () => mediaQuery.removeEventListener('change', handler);
  }, [query]);

  return matches;
}

function ResponsiveComponent() {
  const isMobile = useMediaQuery('(max-width: 768px)');
  const isDarkMode = useMediaQuery('(prefers-color-scheme: dark)');
  const isReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  return (
    <div>
      <p>Mobile: {isMobile ? 'Yes' : 'No'}</p>
      <p>Dark Mode: {isDarkMode ? 'Yes' : 'No'}</p>
      <p>Reduced Motion: {isReducedMotion ? 'Yes' : 'No'}</p>
    </div>
  );
}

// Geolocation API
function LocationTracker() {
  const [position, setPosition] = useState(null);
  const [error, setError] = useState(null);
  const watchIdRef = useRef(null);

  useEffect(() => {
    // One-time position
    navigator.geolocation.getCurrentPosition(
      (pos) => setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => setError(err.message)
    );

    // Continuous tracking
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => setError(err.message),
      { enableHighAccuracy: true }
    );

    return () => {
      if (watchIdRef.current) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, []);

  return (
    <div>
      {position && <p>Location: {position.lat}, {position.lng}</p>}
      {error && <p>Error: {error}</p>}
    </div>
  );
}

// Notification API
function NotificationSender() {
  const [permission, setPermission] = useState(Notification.permission);

  async function requestPermission() {
    const result = await Notification.requestPermission();
    setPermission(result);
  }

  function sendNotification() {
    if (permission === 'granted') {
      new Notification('Hello!', {
        body: 'This is a notification',
        icon: '/icon.png'
      });
    }
  }

  return (
    <div>
      <p>Permission: {permission}</p>
      <button onClick={requestPermission}>Request Permission</button>
      <button onClick={sendNotification} disabled={permission !== 'granted'}>
        Send Notification
      </button>
    </div>
  );
}

// Web Worker
function WorkerComponent() {
  const [result, setResult] = useState(null);
  const workerRef = useRef(null);

  useEffect(() => {
    // Create inline worker (for demo)
    const workerCode = `
      self.onmessage = function(e) {
        const result = e.data * 2;
        self.postMessage(result);
      };
    `;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    workerRef.current = new Worker(URL.createObjectURL(blob));

    workerRef.current.onmessage = (e) => {
      setResult(e.data);
    };

    return () => {
      workerRef.current.terminate();
    };
  }, []);

  function calculate(value) {
    workerRef.current.postMessage(value);
  }

  return (
    <div>
      <button onClick={() => calculate(21)}>Calculate 21 * 2</button>
      {result && <p>Result: {result}</p>}
    </div>
  );
}

// Fullscreen API
function FullscreenToggle() {
  const elementRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    function handleFullscreenChange() {
      setIsFullscreen(!!document.fullscreenElement);
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  async function toggleFullscreen() {
    if (!document.fullscreenElement) {
      await elementRef.current.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  }

  return (
    <div ref={elementRef}>
      <button onClick={toggleFullscreen}>
        {isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
      </button>
    </div>
  );
}

// PerformanceObserver
function PerformanceMonitor() {
  const [metrics, setMetrics] = useState([]);

  useEffect(() => {
    const observer = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      setMetrics(prev => [...prev, ...entries.map(e => ({
        name: e.name,
        duration: e.duration,
        type: e.entryType
      }))]);
    });

    observer.observe({ entryTypes: ['measure', 'navigation', 'resource'] });

    return () => observer.disconnect();
  }, []);

  return <pre>{JSON.stringify(metrics, null, 2)}</pre>;
}

export default function App() {
  return (
    <div>
      <LazyImage src="/image.png" alt="Lazy" />
      <ResizeAware>Resize me</ResizeAware>
      <ResponsiveComponent />
      <LocationTracker />
      <NotificationSender />
      <WorkerComponent />
      <FullscreenToggle />
      <PerformanceMonitor />
    </div>
  );
}
