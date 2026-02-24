import type { ScopeTracker } from '../../../../core/ScopeTracker.js';

export function generateSemanticId(
  scopeType: string,
  scopeTracker: ScopeTracker | undefined
): string | undefined {
  if (!scopeTracker) return undefined;

  const scopePath = scopeTracker.getScopePath();
  const siblingIndex = scopeTracker.getItemCounter(`semanticId:${scopeType}`);
  return `${scopePath}:${scopeType}[${siblingIndex}]`;
}

export function generateAnonymousName(scopeTracker: ScopeTracker | undefined): string {
  if (!scopeTracker) return 'anonymous';
  const index = scopeTracker.getSiblingIndex('anonymous');
  return `anonymous[${index}]`;
}
