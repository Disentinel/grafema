/**
 * `grafema export` action (REG-1116, REG-1118).
 *
 * Pure orchestration logic — connects feature glob → renderer, with all I/O
 * surfaced as inputs (backend) and effects (writeText / log / exit). The
 * Commander shell in `export.ts` plugs in concrete implementations; tests
 * supply mocks.
 */
import {
  collectFeatureSnapshots,
  parseFeaturePattern,
  resolveCategories,
  RENDERERS,
  type ExportBackendLike,
  type FeatureExportSnapshot,
  type Renderer,
} from '@grafema/util';

export interface ExportActionOptions {
  /** Feature glob — required. */
  feature: string;
  /** Output format — required. Must be a key of RENDERERS. */
  as: string;
  /** Optional output file path. When unset, stdout. */
  output?: string;
}

export interface ExportActionDeps {
  backend: ExportBackendLike;
  /** Write file/stdout content. Receives `null` for path → stdout. */
  writeText: (path: string | null, text: string) => Promise<void> | void;
  /** Print to stderr (for diagnostic notes that should not contaminate stdout). */
  warn: (msg: string) => void;
  /** Reported when an unrecoverable error happens — caller decides exit code. */
  fail: (msg: string, code: number) => never;
  /** Renderers map — defaults to the package-shipped RENDERERS. */
  renderers?: Record<string, Renderer>;
}

/**
 * Run the export action. Returns the rendered text on success — convenient
 * for tests that don't want to mock writeText. The deps' writeText is also
 * invoked so production callers don't need to handle the return value.
 */
export async function runExport(
  options: ExportActionOptions,
  deps: ExportActionDeps,
): Promise<string> {
  const renderers = deps.renderers ?? RENDERERS;
  const renderer = renderers[options.as];
  if (!renderer) {
    const known = Object.keys(renderers).sort().join(', ');
    deps.fail(
      `Unknown format '${options.as}'. Known formats: ${known}.`,
      2,
    );
  }

  const parsed = parseFeaturePattern(options.feature);
  if (!parsed) {
    deps.fail(`Invalid --feature pattern: '${options.feature}'.`, 2);
  }

  // Validate format-category compatibility before doing any graph work.
  const categories = resolveCategories(parsed.categoryGlob);
  if (categories.length === 0) {
    deps.fail(
      `Feature pattern '${options.feature}' matches no known category.`,
      2,
    );
  }
  const unsupported = categories.filter(c => !renderer.supports(c));
  if (unsupported.length > 0 && unsupported.length === categories.length) {
    deps.fail(
      `Format '${options.as}' does not support category '${unsupported[0]}'. ` +
      `Try '--as docs-md' or narrow the pattern.`,
      2,
    );
  }

  const snapshots = await collectFeatureSnapshots(deps.backend, options.feature);

  // If the renderer rejects some categories, drop those snapshots before
  // rendering. Warn so the user sees the gap.
  const accepted: FeatureExportSnapshot[] = [];
  let droppedForCategory = 0;
  for (const s of snapshots) {
    if (renderer.supports(s.category)) accepted.push(s);
    else droppedForCategory++;
  }
  if (droppedForCategory > 0) {
    deps.warn(
      `Skipping ${droppedForCategory} feature${droppedForCategory === 1 ? '' : 's'} ` +
      `unsupported by --as ${options.as}.`,
    );
  }

  if (accepted.length === 0) {
    deps.warn(
      `No features matched '${options.feature}' for format '${options.as}'.`,
    );
  }

  const text = renderer.render(accepted);
  await deps.writeText(options.output ?? null, text);
  return text;
}
