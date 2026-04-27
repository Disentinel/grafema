/**
 * commanderExtractor — SpecedContractExtractor for `cli:command` features
 * produced by `libraryCallbackEnricher` from `effects-db/packages/commander.yaml`.
 *
 * Strategy: walk the RECEIVER_CALL chain backwards from the FEATURE's anchor
 * call (the `.action(handler)` call) to the chain origin (a `new Command(...)`
 * or `program.command(...)` call), reading literal arguments at each step.
 * Each chain step is one of commander's spec-defining calls:
 *
 *   chain origin:
 *     - `program.command('build <input> [output]', 'desc')`
 *     - `new Command('build <input> [output]')`
 *
 *   intermediate:
 *     - `.argument('<arg>', 'desc', defaultValue)`        → positional input
 *     - `.option('-f, --flag <val>', 'desc', defaultValue)` → named input
 *     - `.description('text')`                              → currently ignored
 *
 * The first arg of `.command(...)` and `new Command(...)` is itself a small
 * mini-DSL ("name <arg1> [arg2...]") that we parse with `parseCommandSpec`.
 *
 * Returns null when the FEATURE has no recoverable backing — i.e. metadata
 * lacks `anchorCall`, the anchor doesn't exist, or no chain origin can be
 * located. In those cases the speced contract truly isn't recoverable, and
 * the framework will count the FEATURE in `featuresWithoutSpec`.
 *
 * Path chosen — A (literal-string parse). Path B (add per-arg roles to
 * commander.yaml) was rejected because:
 *   1) Spec strings carry positional info (`'<input>'` vs `'[input]'` vs
 *      `'<files...>'`) that can't be expressed as a simple `role` annotation
 *      without also encoding parsing rules in the enricher anyway.
 *   2) The chain-walk + literal-read machinery already exists for command
 *      naming (see `libraryCallbackEnricher.extractDomainName`) — extending
 *      it to capture `.argument`/`.option` calls is a small generalisation.
 *
 * Like the framework, we read graph nodes via the supplied client; we do not
 * write nodes/edges here — that's the framework's job.
 */

import type { RFDBClient } from '@grafema/rfdb-client';
import type { WireNode } from '@grafema/types';

import type {
  SpecedContractData,
  SpecedContractError,
  SpecedContractExtractor,
  SpecedContractInput,
  SpecedContractOutput,
} from '../specedContractEnricher.js';

/** Maximum receiver-chain depth — guards against pathological cycles. */
const MAX_CHAIN_DEPTH = 64;

export const commanderExtractor: SpecedContractExtractor = {
  category: 'cli:command',
  source: 'commander',
  async extract(
    client: RFDBClient,
    feature: WireNode,
  ): Promise<SpecedContractData | null> {
    const meta = parseMeta(feature);
    const anchorCallId = typeof meta?.anchorCall === 'string' ? meta.anchorCall : null;
    if (!anchorCallId) return null;

    const anchor = await client.getNode(anchorCallId);
    if (!anchor) return null;

    // Collect every CALL on the chain (anchor + each receiver hop). The
    // order is anchor-first → origin-last; we'll process accordingly.
    const chain = await collectReceiverChain(client, anchor);
    if (chain.length === 0) return null;

    const inputs: SpecedContractInput[] = [];
    const outputs: SpecedContractOutput[] = [];
    const errors: SpecedContractError[] = [];
    let description: string | undefined;
    let commandName: string | undefined;
    let foundOrigin = false;

    // Walk the chain in source order (origin → ... → anchor) so positional
    // arguments declared via `.argument()` appear in the order the user
    // would type them on the command line.
    const chainOriginFirst = [...chain].reverse();

    for (const call of chainOriginFirst) {
      const methodName = extractMethodName(call.name ?? '');
      switch (methodName) {
        case 'command':
        case 'Command': {
          // Chain origin. First arg is the spec string.
          // `program.command('build <input> [output]')` / `new Command('build')`
          const specStr = await readLiteralArg(client, call.id, 0);
          if (specStr !== null) {
            const parsed = parseCommandSpec(specStr);
            if (parsed.name && commandName === undefined) commandName = parsed.name;
            for (const positional of parsed.positionals) {
              inputs.push(positional);
            }
          }
          // Optional second arg of `.command(name, desc)` / `new Command(name, desc)`
          // is the description. Both forms accept it.
          const desc = await readLiteralArg(client, call.id, 1);
          if (desc !== null && description === undefined) description = desc;
          foundOrigin = true;
          break;
        }
        case 'argument': {
          // .argument('<arg>', 'desc', defaultValue)
          const specStr = await readLiteralArg(client, call.id, 0);
          if (specStr === null) break;
          const positional = parsePositionalSpec(specStr);
          if (!positional) break;
          const desc = await readLiteralArg(client, call.id, 1);
          if (desc !== null) positional.description = desc;
          const def = await readLiteralArg(client, call.id, 2);
          if (def !== null) positional.default = def;
          inputs.push(positional);
          break;
        }
        case 'option':
        case 'requiredOption': {
          // .option('-f, --flag <val>', 'desc', defaultValue)
          const specStr = await readLiteralArg(client, call.id, 0);
          if (specStr === null) break;
          const opt = parseOptionSpec(specStr);
          if (!opt) break;
          if (methodName === 'requiredOption') opt.optional = false;
          const desc = await readLiteralArg(client, call.id, 1);
          if (desc !== null) opt.description = desc;
          const def = await readLiteralArg(client, call.id, 2);
          if (def !== null) opt.default = def;
          inputs.push(opt);
          break;
        }
        case 'description': {
          const text = await readLiteralArg(client, call.id, 0);
          if (text !== null && description === undefined) description = text;
          break;
        }
        default:
          // .alias(...), .addHelpText(...), .version(...), etc. — not part of
          // the spec contract for now.
          break;
      }
    }

    if (!foundOrigin) return null;

    // The result is the SpecedContract — empty inputs/outputs/errors are
    // legitimate (a CLI command can have no args). v2 schema: command name
    // and description live as top-level fields. The synthetic outputs[0]
    // workaround is dropped.
    return {
      source: 'commander',
      ...(commandName !== undefined ? { name: commandName } : {}),
      ...(description !== undefined ? { description } : {}),
      inputs,
      outputs,
      errors,
    };
  },
};

/** ---------------------------------------------------------------------------
 *  Chain walk
 *  ------------------------------------------------------------------------ */

/**
 * Collect the full RECEIVER_CALL chain starting at `anchor` (which is the
 * `.action(handler)` call recorded by `libraryCallbackEnricher`). The first
 * element is `anchor`; each subsequent element is the inner call reached via
 * a single RECEIVER_CALL edge.
 */
async function collectReceiverChain(
  client: RFDBClient,
  anchor: WireNode,
): Promise<WireNode[]> {
  const chain: WireNode[] = [anchor];
  let current = anchor;
  for (let i = 0; i < MAX_CHAIN_DEPTH; i++) {
    const recv = await client.getOutgoingEdges(current.id, ['RECEIVER_CALL'] as never);
    if (recv.length === 0) break;
    const inner = await client.getNode(String(recv[0].dst));
    if (!inner) break;
    chain.push(inner);
    current = inner;
  }
  return chain;
}

/**
 * Strip the receiver prefix from a CALL `name` to get just the method.
 *
 * The JS analyzer records call names as one of:
 *   - "Command"             (NewExpression: `new Command(...)`)
 *   - "<obj>.action"        (chained method on a runtime object)
 *   - "program.command"     (method on a named identifier)
 *
 * For the purposes of dispatching by method, we always want the segment after
 * the last dot — and for the bare-`Command` NewExpression we treat the whole
 * name as the method name (it's the chain origin).
 */
function extractMethodName(callName: string): string {
  const dot = callName.lastIndexOf('.');
  if (dot < 0) return callName;
  return callName.substring(dot + 1);
}

/** ---------------------------------------------------------------------------
 *  Argument readers
 *  ------------------------------------------------------------------------ */

/**
 * Read the literal value of the n-th positional argument of a CALL node.
 * Returns null when the argument doesn't exist, isn't a literal-shaped node,
 * or carries no readable value.
 */
async function readLiteralArg(
  client: RFDBClient,
  callId: string,
  index: number,
): Promise<string | null> {
  const edges = await client.getOutgoingEdges(callId, ['PASSES_ARGUMENT'] as never);
  for (const e of edges) {
    const idx = (e as Record<string, unknown>).index;
    const idxNum =
      typeof idx === 'number'
        ? idx
        : typeof idx === 'string' && idx.length > 0
          ? Number(idx)
          : NaN;
    if (idxNum !== index) continue;
    const argNode = await client.getNode(String(e.dst));
    if (!argNode) return null;
    return readLiteralValue(argNode);
  }
  return null;
}

/**
 * Read the underlying string value of a literal-shaped node. Mirrors
 * `libraryCallbackEnricher.readLiteralName` but kept private here to avoid a
 * cross-file dependency between sibling enrichers.
 */
function readLiteralValue(node: WireNode): string | null {
  const meta = parseMeta(node);
  if (meta && typeof meta.value === 'string' && meta.value.length > 0) {
    return stripQuotes(meta.value);
  }
  if (node.name && node.name.length > 0 && node.name !== '<call>') {
    return stripQuotes(node.name);
  }
  return null;
}

function stripQuotes(s: string): string {
  if (s.length < 2) return s;
  const first = s.charCodeAt(0);
  const last = s.charCodeAt(s.length - 1);
  // 0x27 ', 0x22 ", 0x60 `
  if ((first === 0x27 || first === 0x22 || first === 0x60) && first === last) {
    return s.slice(1, -1);
  }
  return s;
}

function parseMeta(node: WireNode): Record<string, unknown> | null {
  if (!node.metadata) return null;
  try {
    return JSON.parse(node.metadata) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** ---------------------------------------------------------------------------
 *  Spec string parsers
 *  ------------------------------------------------------------------------ */

/**
 * Parse a `program.command()` / `new Command()` spec string of the form
 * `"build <input> [output]"` into a command name + positional inputs list.
 *
 * Commander accepts either the bare command name or a name followed by
 * positional argument tokens. Whitespace is the separator. Each positional
 * token is one of:
 *   <name>      — required
 *   [name]      — optional
 *   <name...>   — variadic required
 *   [name...]   — variadic optional
 */
function parseCommandSpec(spec: string): {
  name: string | undefined;
  positionals: SpecedContractInput[];
} {
  const tokens = spec.trim().split(/\s+/).filter(Boolean);
  const positionals: SpecedContractInput[] = [];
  let name: string | undefined;

  for (const tok of tokens) {
    const positional = parsePositionalSpec(tok);
    if (positional) {
      positionals.push(positional);
    } else if (name === undefined) {
      // First non-positional token is the command name.
      name = tok;
    }
    // Subsequent unrecognised tokens are silently ignored — commander itself
    // would reject them, so they shouldn't appear in well-formed source.
  }

  return { name, positionals };
}

/**
 * Parse a single positional-argument token like `<input>`, `[output]`,
 * `<files...>`. Returns null if the token isn't a positional spec.
 */
function parsePositionalSpec(token: string): SpecedContractInput | null {
  const trimmed = token.trim();
  if (trimmed.length < 3) return null;
  const first = trimmed.charAt(0);
  const last = trimmed.charAt(trimmed.length - 1);

  let optional: boolean;
  if (first === '<' && last === '>') optional = false;
  else if (first === '[' && last === ']') optional = true;
  else return null;

  let inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return null;

  let variadic = false;
  if (inner.endsWith('...')) {
    variadic = true;
    inner = inner.slice(0, -3).trim();
    if (inner.length === 0) return null;
  }

  const result: SpecedContractInput = {
    name: inner,
    type: variadic ? 'string[]' : 'string',
    optional,
  };
  if (variadic) {
    result.variadic = true;
  }
  return result;
}

/**
 * Parse an option spec string like `'-w, --watch'`, `'--depth <n>'`,
 * `'--depth [n]'`, `'--filter <pat...>'`. Returns null if the spec doesn't
 * start with at least one flag.
 *
 * Commander accepts comma- or pipe-separated flags. Long flags may carry an
 * optional value placeholder (the same `<x>` / `[x]` mini-DSL as positional
 * arguments).
 */
function parseOptionSpec(spec: string): SpecedContractInput | null {
  const trimmed = spec.trim();
  if (trimmed.length === 0) return null;

  // Split into flag tokens + optional value-placeholder. The value
  // placeholder is whatever comes after the last flag (a `<>` / `[]` token).
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;

  const flags: string[] = [];
  let valuePlaceholder: SpecedContractInput | null = null;

  for (const part of parts) {
    // A part may end with a comma (flag list separator) — strip and keep.
    const cleaned = part.replace(/,$/, '');
    if (cleaned.startsWith('-')) {
      // Could be e.g. `-w,` then next iteration `--watch`, or `-w,--watch`.
      // Handle the comma-glued form by splitting on commas inside.
      for (const subPart of cleaned.split(',')) {
        const f = subPart.trim();
        if (f.length > 0 && f.startsWith('-')) flags.push(f);
      }
    } else if (cleaned.startsWith('<') || cleaned.startsWith('[')) {
      const positional = parsePositionalSpec(cleaned);
      if (positional) valuePlaceholder = positional;
    }
    // Anything else (description text leaking into the spec by mistake) is
    // ignored; callers pass description as a separate argument.
  }

  if (flags.length === 0) return null;

  // Pick the canonical name: the long flag if present (`--name`), otherwise
  // the first short flag (`-n`). Commander stores option values keyed off
  // the long name when one exists.
  const longFlag = flags.find(f => f.startsWith('--')) ?? flags[0];
  const name = longFlag;

  // A boolean option has no value placeholder. A `<x>` placeholder makes the
  // value required (the option itself remains user-optional). A `[x]`
  // placeholder makes the value optional.
  const isBoolean = valuePlaceholder === null;
  const result: SpecedContractInput = {
    name,
    type: isBoolean ? 'boolean' : (valuePlaceholder?.type ?? 'string'),
    // Options are always optional from the user's perspective unless they
    // were declared via `requiredOption(...)` (handled at the call site).
    optional: true,
  };
  if (valuePlaceholder?.variadic) {
    result.variadic = true;
    result.type = 'string[]';
  }
  return result;
}
