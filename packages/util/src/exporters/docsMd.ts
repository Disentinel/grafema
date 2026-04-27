/**
 * Markdown documentation renderer for `grafema export --as docs-md`
 * (REG-1116, REG-1118).
 *
 * Handles all FEATURE categories. Output structure:
 *   - Single feature (REG-1118 path): just that feature's section, no TOC.
 *   - Multiple features (REG-1116 path): top-level header + TOC + sections.
 *
 * Sections present per feature:
 *   - File / Modality header
 *   - One Contract block per contract with an inputs table + outputs list +
 *     errors list (omits sub-sections that are empty so cards stay compact).
 *   - Behavior block — only when the feature carries a BEHAVIOR.
 *   - Shared-with block — only when the feature has SHARES_BEHAVIOR_WITH
 *     siblings.
 */
import type { Renderer, FeatureExportSnapshot, SharedFeatureRef } from './types.js';
import type {
  SpecedContractData,
  SpecedContractInput,
  SpecedContractOutput,
  SpecedContractError,
} from '../enrichers/specedContractEnricher.js';

export const docsMdRenderer: Renderer = {
  format: 'docs-md',
  supports(_category: string): boolean {
    return true;
  },
  render(snapshots: FeatureExportSnapshot[]): string {
    if (snapshots.length === 0) {
      return '# Grafema feature catalogue\n\n_No features matched the supplied pattern._\n';
    }
    if (snapshots.length === 1) {
      // REG-1118 single-feature path: render just the section.
      return renderFeatureSection(snapshots[0]).trimEnd() + '\n';
    }
    return renderCatalogue(snapshots);
  },
};

function renderCatalogue(snapshots: FeatureExportSnapshot[]): string {
  const lines: string[] = [];
  lines.push('# Grafema feature catalogue');
  lines.push('');
  lines.push(`_${snapshots.length} feature${snapshots.length === 1 ? '' : 's'} exported._`);
  lines.push('');

  // Table of contents.
  lines.push('## Contents');
  lines.push('');
  for (const f of snapshots) {
    const anchor = makeAnchor(`${f.category} ${f.name}`);
    lines.push(`- [\`${f.category}\` \`${f.name}\`](#${anchor})`);
  }
  lines.push('');

  for (const f of snapshots) {
    lines.push(renderFeatureSection(f));
  }

  return lines.join('\n').trimEnd() + '\n';
}

function renderFeatureSection(feature: FeatureExportSnapshot): string {
  const lines: string[] = [];
  lines.push(`## \`${feature.category}\` \`${feature.name}\``);
  lines.push('');
  lines.push(`**File**: \`${feature.file || '(unknown)'}\``);
  lines.push(`**Modality**: \`${feature.category}\``);
  lines.push('');

  if (feature.contracts.length === 0) {
    lines.push('_No speced contract recovered for this feature._');
    lines.push('');
  } else {
    for (const c of feature.contracts) {
      renderContract(lines, c);
    }
  }

  if (feature.behavior) {
    lines.push('### Behavior');
    lines.push('');
    const eff = feature.behavior.effects.length === 0 ? '_(none)_' : feature.behavior.effects.join(', ');
    lines.push(`- Effects: ${eff}`);
    lines.push(`- Transitive calls: ${feature.behavior.coreNodeCount}`);
    lines.push(`- Depth: ${feature.behavior.depth}`);
    lines.push('');
  }

  if (feature.sharedBehaviorWith.length > 0) {
    lines.push('### Shared with (`SHARES_BEHAVIOR_WITH`)');
    lines.push('');
    for (const s of feature.sharedBehaviorWith) {
      lines.push(`- \`${s.category}\` \`${s.name}\` (\`${s.file || '(unknown)'}\`)`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderContract(lines: string[], c: SpecedContractData): void {
  lines.push(`### Contract — ${c.source}`);
  lines.push('');

  if (c.inputs.length > 0) {
    lines.push('| Input | Type | Optional | Default | Description |');
    lines.push('|-------|------|----------|---------|-------------|');
    for (const inp of c.inputs) {
      lines.push(renderInputRow(inp));
    }
    lines.push('');
  }

  if (c.outputs.length > 0) {
    lines.push('**Outputs**:');
    lines.push('');
    for (const out of c.outputs) {
      lines.push(`- ${renderOutput(out)}`);
    }
    lines.push('');
  }

  if (c.errors.length > 0) {
    lines.push('**Errors**:');
    lines.push('');
    for (const err of c.errors) {
      lines.push(`- ${renderError(err)}`);
    }
    lines.push('');
  }
}

function renderInputRow(inp: SpecedContractInput): string {
  const cells = [
    backtick(inp.name),
    inp.type ? backtick(inp.type) : '',
    inp.optional ? 'yes' : 'no',
    inp.default !== undefined ? backtick(String(inp.default)) : '',
    escapeCell(inp.description ?? ''),
  ];
  return `| ${cells.join(' | ')} |`;
}

function renderOutput(out: SpecedContractOutput): string {
  const parts: string[] = [];
  if (out.name) parts.push(backtick(out.name));
  if (out.type) parts.push(`(${backtick(out.type)})`);
  if (out.description) parts.push(out.description);
  return parts.length > 0 ? parts.join(' ') : '_(unnamed output)_';
}

function renderError(err: SpecedContractError): string {
  const parts: string[] = [backtick(err.type)];
  if (err.description) parts.push(`— ${err.description}`);
  return parts.join(' ');
}

function backtick(s: string): string {
  if (s.length === 0) return '';
  return `\`${s.replace(/`/g, '\\`')}\``;
}

function escapeCell(s: string): string {
  // Pipes and newlines break Markdown table rows; escape them.
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * Produce a GitHub-flavoured Markdown anchor from a heading. Lower-cases,
 * strips backticks, replaces non-alphanumerics with '-', collapses runs of
 * '-'. Mirrors the rough behaviour of GitHub's anchor generator — close
 * enough for the per-document TOC.
 */
function makeAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/**
 * Mostly for the SharedFeatureRef formatting used by other modules — exposed
 * for the action's "no matches" stderr fallback.
 */
export function formatSharedFeatureRef(ref: SharedFeatureRef): string {
  return `${ref.category} ${ref.name}${ref.file ? ` (${ref.file})` : ''}`;
}
