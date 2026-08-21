// kernel_grep.ts — the Phase 3 "kernel grep test", mechanical and in CI.
//
// Contract (START.md §5 Phase 3, §7): no relation name outside the documented
// kernel vocabulary may appear as a string or identifier in kernel source.
// Two checks over every file in src/:
//
//  1. Every identifier-shaped string literal ('foo', "foo") must be in the
//     documented whitelist below (or start with '$', the kernel-internal
//     reification marker, unwritable in ROFL source syntax). A relation name
//     must be identifier-shaped in full to be usable as a store key, so this
//     check is the real protection.
//  2. After stripping comments and string literals, no boot.rofl or appendix
//     program relation name may appear as a code identifier.
//
// The whitelist mirrors the vocabulary table in README.md. Extending it is a
// documented API change, not a convenience.

import * as fs from 'node:fs';
import * as path from 'node:path';

// §2 kernel vocabulary (reserved) + documented reflection-detail extension.
const KERNEL_RELS = [
  'derived_by', 'rule', 'has_premise', 'premise_pos', 'premise_neg',
  'concludes', 'has_conclusion', 'reads_from', 'writes_to', 'mode',
  'reserved', 'authority', 'asserted_by', 'hole', 'edb',
  'bridge_decl', 'in_perspective', 'uses_builtin', 'premise_lit', 'conclusion_lit',
];
// Stratification interface: kernel reads, boot writes (documented in README).
const IFACE_RELS = ['stratum', 'unstratified'];
// Language syntax tokens the parser must know (keywords, not relations).
const SYNTAX = ['init', 'now', 'next', 'async', 'not', 'is', 'mod', 'main'];
// Kernel constants (mode atoms, hole reason).
const CONSTANTS = ['budget_exhausted', 'any', 'in', 'out'];
// Implementation tokens: tokenizer tags, term/premise kind tags, snapshot
// field names, REPL command words. Not relation names; listed exhaustively.
const IMPL = [
  // tokenizer token types / term kinds / body kinds / premise-ref kinds
  'str', 'int', 'var', 'ident', 'eof', 'v', 'i', 's', 'a', 'f',
  'pos', 'neg', 'bi', 'fact',
  // store scopes & snapshot/canonical-state words
  'tick', 'timeless', 'base', 'drv', 'frozen', 'wit', 'true',
  // REPL command words
  'quit', 'exit', 'run', 'facts', 'ok', 'saved', 'restored', 'load', 'utf8',
  // rule id prefix ('r' + content hash)
  'r',
];
const ALLOWED = new Set([...KERNEL_RELS, ...IFACE_RELS, ...SYNTAX, ...CONSTANTS, ...IMPL]);

// Relation names of boot.rofl and the appendix programs: exactly the names a
// cheating kernel would hardcode. None may appear as a kernel identifier.
const FORBIDDEN = [
  'rule_known', 'perspective', 'sees', 'imports', 'dep', 'dep_neg', 'reach',
  'flow', 'malformed', 'breach', 'leak', 'forged', 'unmoded',
  'reading', 'corroborated', 'outlier', 'close', 'temp',
  'counter', 'emit', 'cfg', 'delta', 'step', 'move',
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

interface Violation { file: string; line: number; what: string; }

export function checkKernelVocabulary(rootDir: string): Violation[] {
  const srcDir = path.join(rootDir, 'src');
  const out: Violation[] = [];
  for (const f of fs.readdirSync(srcDir).sort()) {
    if (!f.endsWith('.ts')) continue;
    const full = path.join(srcDir, f);
    const noComments = stripComments(fs.readFileSync(full, 'utf8'));
    const lineOf = (idx: number) => noComments.slice(0, idx).split('\n').length;

    // check 1: identifier-shaped string literals must be whitelisted
    const strRe = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
    let m: RegExpExecArray | null;
    while ((m = strRe.exec(noComments))) {
      const raw = m[1] ?? m[2] ?? m[3] ?? '';
      for (const chunk of raw.split(/\$\{[^}]*\}/)) {
        if (/^[a-z][A-Za-z0-9_]*$/.test(chunk) && !ALLOWED.has(chunk)) {
          out.push({ file: f, line: lineOf(m.index), what: `string '${chunk}' not in kernel vocabulary` });
        }
      }
    }

    // check 2: forbidden boot/appendix relation names as code identifiers
    const codeOnly = noComments.replace(strRe, ' "" ');
    for (const bad of FORBIDDEN) {
      const re = new RegExp(`\\b${bad}\\b`, 'g');
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(codeOnly))) {
        out.push({ file: f, line: lineOf(mm.index), what: `forbidden relation name '${bad}' in kernel source` });
      }
    }
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).includes('kernel_grep');
if (isMain) {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const violations = checkKernelVocabulary(root);
  if (violations.length === 0) {
    console.log('kernel vocabulary check: clean');
  } else {
    for (const v of violations) console.error(`${v.file}:${v.line}: ${v.what}`);
    console.error(`${violations.length} violation(s)`);
    process.exit(1);
  }
}
