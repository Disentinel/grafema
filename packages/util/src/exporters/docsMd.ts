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

  // Intent — when to use comes first if present, so readers see semantics
  // before mechanics.
  if (feature.intent?.whenToUse) {
    lines.push('### When to use');
    lines.push('');
    lines.push(feature.intent.whenToUse);
    lines.push('');
  }

  if (feature.contracts.length === 0) {
    lines.push('_No speced contract recovered for this feature._');
    lines.push('');
  } else {
    for (const c of feature.contracts) {
      renderContract(lines, c);
    }
  }

  // Examples — handwritten input, optional captured output.
  if (feature.intent?.examples && feature.intent.examples.length > 0) {
    lines.push('### Examples');
    lines.push('');
    for (const ex of feature.intent.examples) {
      if (ex.title) lines.push(`**${ex.title}**`);
      lines.push('');
      lines.push(`\`\`\`${ex.inputLanguage ?? 'sh'}`);
      lines.push(ex.input);
      lines.push('```');
      if (ex.output !== undefined) {
        lines.push('');
        lines.push('```');
        lines.push(ex.output);
        lines.push('```');
        if (ex.capturedAt) {
          lines.push(`*Captured ${ex.capturedAt}${ex.fixture ? ` against \`${ex.fixture}\`` : ''}.*`);
        }
      }
      lines.push('');
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

  if (feature.intent?.gotchas && feature.intent.gotchas.length > 0) {
    lines.push('### Gotchas');
    lines.push('');
    for (const g of feature.intent.gotchas) {
      lines.push(`- ${g}`);
    }
    lines.push('');
  }

  if (feature.intent?.seeAlso && feature.intent.seeAlso.length > 0) {
    lines.push('### See also');
    lines.push('');
    for (const s of feature.intent.seeAlso) {
      lines.push(`- \`${s}\``);
    }
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

  // v2: top-level description is rendered as a paragraph above the contract
  // table for readability. Fields like enum and validation constraints stay
  // off the bulk view (json-schema renders them).
  if (c.description) {
    lines.push(c.description);
    lines.push('');
  }

  if (c.inputs.length > 0) {
    lines.push('| Input | Type | Optional | Default | Description |');
    lines.push('|-------|------|----------|---------|-------------|');
    for (const inp of c.inputs) {
      lines.push(renderInputRow(inp));
    }
    lines.push('');
    // Per-input enum lines come after the table — keeps the table compact
    // and lets multi-value enums wrap naturally.
    for (const inp of c.inputs) {
      if (Array.isArray(inp.enum) && inp.enum.length > 0) {
        lines.push(`- Allowed for \`${inp.name}\`: [${inp.enum.map((v) => String(v)).join(', ')}]`);
      }
    }
    if (c.inputs.some((i) => Array.isArray(i.enum) && i.enum.length > 0)) {
      lines.push('');
    }
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
  // v2: append a trailing ellipsis to the name when variadic so readers can
  // see at a glance that it accepts multiple values without the verbose
  // 'string[]' type leaking that detail.
  const displayName = inp.variadic ? `${inp.name}…` : inp.name;
  const cells = [
    backtick(displayName),
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
