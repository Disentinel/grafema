/**
 * Exporters — barrel for `grafema export` (REG-1116, REG-1118).
 *
 * Provides:
 *   - Renderer abstraction (types.ts)
 *   - Snapshot collection (snapshot.ts)
 *   - openapi-3.1 renderer (openapi.ts) — http:route only
 *   - docs-md renderer (docsMd.ts) — all categories
 */
export type {
  FeatureBehaviorSummary,
  FeatureExportSnapshot,
  SharedFeatureRef,
  Renderer,
} from './types.js';

export {
  collectFeatureSnapshots,
  parseFeaturePattern,
  resolveCategories,
  FEATURE_CATEGORIES,
} from './snapshot.js';
export type { ExportBackendLike } from './snapshot.js';

export { openapiRenderer } from './openapi.js';
export { docsMdRenderer } from './docsMd.js';

import { openapiRenderer } from './openapi.js';
import { docsMdRenderer } from './docsMd.js';
import type { Renderer } from './types.js';

/** All shipped renderers, keyed by --as format value. */
export const RENDERERS: Record<string, Renderer> = {
  [openapiRenderer.format]: openapiRenderer,
  [docsMdRenderer.format]: docsMdRenderer,
};
