/// <reference types="vite/client" />

// Allow side-effect CSS imports (static or dynamic). Vite handles
// extraction at build time; at type-check time we just need any
// module shape.
declare module '*.css';
