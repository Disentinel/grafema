/**
 * React analysis types and constants.
 *
 * Shared interfaces for nodes, edges, and analysis results used
 * across all react-internal modules.
 *
 * @module react-internal/types
 */

// React event handlers mapping
export const REACT_EVENTS: Record<string, string> = {
  // Mouse events
  onClick: 'click', onDoubleClick: 'dblclick', onContextMenu: 'contextmenu',
  onMouseDown: 'mousedown', onMouseUp: 'mouseup', onMouseEnter: 'mouseenter',
  onMouseLeave: 'mouseleave', onMouseMove: 'mousemove', onMouseOver: 'mouseover',
  onMouseOut: 'mouseout',
  // Keyboard events
  onKeyDown: 'keydown', onKeyUp: 'keyup', onKeyPress: 'keypress',
  // Focus events
  onFocus: 'focus', onBlur: 'blur', onFocusCapture: 'focus:capture',
  // Form events
  onSubmit: 'submit', onReset: 'reset', onChange: 'change', onInput: 'input',
  onInvalid: 'invalid',
  // Touch events
  onTouchStart: 'touchstart', onTouchMove: 'touchmove', onTouchEnd: 'touchend',
  onTouchCancel: 'touchcancel',
  // Drag events
  onDragStart: 'dragstart', onDrag: 'drag', onDragEnd: 'dragend',
  onDragEnter: 'dragenter', onDragOver: 'dragover', onDragLeave: 'dragleave',
  onDrop: 'drop',
  // Scroll/Wheel events
  onScroll: 'scroll', onWheel: 'wheel',
  // Clipboard events
  onCopy: 'copy', onCut: 'cut', onPaste: 'paste',
  // Composition events
  onCompositionStart: 'compositionstart', onCompositionUpdate: 'compositionupdate',
  onCompositionEnd: 'compositionend',
  // Media events
  onPlay: 'play', onPause: 'pause', onEnded: 'ended', onTimeUpdate: 'timeupdate',
  onLoadedData: 'loadeddata', onLoadedMetadata: 'loadedmetadata',
  onCanPlay: 'canplay', onWaiting: 'waiting', onSeeking: 'seeking',
  onSeeked: 'seeked', onError: 'error', onVolumeChange: 'volumechange',
  // Image events
  onLoad: 'load',
  // Animation events
  onAnimationStart: 'animationstart', onAnimationEnd: 'animationend',
  onAnimationIteration: 'animationiteration',
  // Transition events
  onTransitionEnd: 'transitionend',
  // Pointer events
  onPointerDown: 'pointerdown', onPointerUp: 'pointerup', onPointerMove: 'pointermove',
  onPointerEnter: 'pointerenter', onPointerLeave: 'pointerleave',
  onPointerCancel: 'pointercancel', onGotPointerCapture: 'gotpointercapture',
  onLostPointerCapture: 'lostpointercapture'
};

// React hooks that need tracking
export const REACT_HOOKS = [
  'useState', 'useEffect', 'useLayoutEffect', 'useInsertionEffect',
  'useCallback', 'useMemo', 'useRef', 'useReducer', 'useContext',
  'useImperativeHandle', 'useDebugValue', 'useDeferredValue',
  'useTransition', 'useId', 'useSyncExternalStore'
];

// Browser APIs that create side effects
export const BROWSER_APIS = {
  timers: ['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback'],
  cleanup: {
    setTimeout: 'clearTimeout',
    setInterval: 'clearInterval',
    requestAnimationFrame: 'cancelAnimationFrame',
    requestIdleCallback: 'cancelIdleCallback'
  } as Record<string, string>,
  observers: ['IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'PerformanceObserver'],
  storage: ['localStorage', 'sessionStorage'],
  async: ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'],
  dom: ['document', 'getElementById', 'querySelector', 'querySelectorAll'],
  workers: ['Worker', 'SharedWorker', 'ServiceWorker'],
  geolocation: ['grafemagator.geolocation'],
  notifications: ['Notification'],
  fullscreen: ['requestFullscreen', 'exitFullscreen'],
  clipboard: ['grafemagator.clipboard'],
  history: ['history.pushState', 'history.replaceState'],
  blocking: ['alert', 'confirm', 'prompt']
};

/**
 * Component node
 */
export interface ComponentNode {
  id: string;
  type: 'react:component';
  name: string;
  file: string;
  line: number;
  column: number;
  kind: 'arrow' | 'function' | 'forwardRef';
}

/**
 * Hook node
 */
export interface HookNode {
  id: string;
  type: string;
  file: string;
  line: number;
  column: number;
  hookName: string;
  [key: string]: unknown;
}

/**
 * Event node
 */
export interface EventNode {
  id: string;
  type: 'dom:event';
  eventType: string;
  reactProp: string;
  handler: string;
  file: string;
  line: number;
}

/**
 * Browser API node
 */
export interface BrowserAPINode {
  id: string;
  type: string;
  file: string;
  line: number;
  [key: string]: unknown;
}

/**
 * Issue node
 */
export interface IssueNode {
  id: string;
  type: string;
  file: string;
  line: number;
  [key: string]: unknown;
}

/**
 * Edge info
 */
export interface EdgeInfo {
  edgeType: string;
  src: string;
  dst: string;
  file: string;
  line: number;
  [key: string]: unknown;
}

/**
 * Analysis result
 */
export interface AnalysisResult {
  components: ComponentNode[];
  hooks: HookNode[];
  events: EventNode[];
  browserAPIs: BrowserAPINode[];
  issues: IssueNode[];
  edges: EdgeInfo[];
}

/**
 * Analysis stats
 */
export interface AnalysisStats {
  components: number;
  hooks: number;
  events: number;
  browserAPIs: number;
  issues: number;
  edges: number;
  [key: string]: unknown;
}
