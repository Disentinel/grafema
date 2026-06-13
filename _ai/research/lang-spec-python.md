# Python resolver → derive packs — migration spec

Branch: `feat/datalog`. Base: origin/main `6e609746`. Round: lang-spec (python), 2026-06-13.
Author-context: read js/rust precedent (`_ai/research/resolve-datalog2-migration-{specs.json,synthesis.md}`),
the live builtin registry (`packages/rfdb-server/src/derive/builtin.rs::registry()` line 1188),
and stdlib pack idioms (`stdlib/{method_calls,rust_imports,js_import_bindings,js_class_inheritance}.dl`).

## 0. GROUNDING / PROBE STATUS

- **Dogfood graph has ZERO Python nodes.** The Grafema corpus (`config.yaml`) is TS/Rust/Haskell only.
  The few `.py` files in the repo (`scripts/*.py`, `_bench/*.py`) are NOT in `include:`. Verified:
  `config.yaml` has no `.py` glob; no python MODULE/CLASS in `.grafema/graph.rfdb`.
  → **No live probe possible. Grounded on resolver source + analyzer emission + package test fixtures**
    (`packages/python-resolve/test/Spec.hs`, `packages/python-analyzer/test/Spec.hs`).
  → **Every shape below is flagged ANALYZER-VERIFIED (read emission source) or FIXTURE-ONLY (test asserts it)
    or UNVERIFIED. No shape is live-probed. Treat the DELTA bounds as source-derived, not measured.**

- Legacy resolver = `packages/python-resolve/src/` (Haskell binary `python-resolve`), 4 commands dispatched
  from `Main.hs:60-71`: `python-imports` (ImportResolution), `python-types` (TypeResolution),
  `python-calls` (CallResolution), `python-classes` (ClassInheritance); plus `python-all` runs all 4.
  Analyzer = `packages/python-analyzer/src/` (binary `python-analyzer`), emission rules in `src/Rules/`.

## 1. ANALYZER EMISSION VOCABULARY (what the resolver consumes)

ANALYZER-VERIFIED from `packages/python-analyzer/src/Rules/{Imports,Declarations,Calls}.hs` +
`packages/grafema-common/src/Grafema/SemanticId.hs`:

### Node types
| Node | Emitted at | Key metadata (ALL via node_attr — NOT first-class) |
|---|---|---|
| `MODULE` | (per file, by orchestrator/walker) | — (file is first-class) |
| `IMPORT` | Imports.hs:65,158 | `path`, `glob`(bool), `relative_level`(int, from-import only), `module`(from-import, present only when module part non-empty) |
| `IMPORT_BINDING` | Imports.hs:93,201 | `imported_name`, `local_name`, **`source_module`** (from-import ONLY; plain `import foo` binding has NO source_module — Imports.hs:103-106 omits it) |
| `FUNCTION` | Declarations.hs:118 | `kind` (function/async_function/method/classmethod/staticmethod/property/lambda), `return_annotation`(opt), `decorator_names`(opt), `paramCount`, `async` |
| `CLASS` | Declarations.hs:189 | `bases`(opt, comma-joined base NAMES via exprToText), `decorator_names`(opt), `has_metaclass`(bool) |
| `VARIABLE` | Declarations.hs (assign/annassign/param) | `kind` (assignment/annotated_assignment/class_variable/instance_variable/parameter/variadic_parameter/keyword_parameter/variadic_keyword_parameter), `annotation`(opt), `mutable` |
| `CALL` | Calls.hs:91 | `receiver`(opt — present iff dotted call), `argCount`, `kwargCount`, `kind`(="constructor" iff name starts uppercase) |
| `PROPERTY_ACCESS` | Calls.hs:137 | `receiver` |
| `REFERENCE` | Calls.hs:172 | — |

### Edge types emitted by ANALYZER (intra-file, the substrate)
| Edge | Source→Target | Emitted at | Notes |
|---|---|---|---|
| `CONTAINS` | scope→decl, IMPORT→IMPORT_BINDING | everywhere | scope-chain substrate |
| `HAS_METHOD` | CLASS→FUNCTION | Declarations.hs:151-156 | **method↔class link — the clean `member_of` substrate** |
| `HAS_PROPERTY` | CLASS→VARIABLE | Declarations.hs:294,335,436,476 | class/instance vars |
| `EXTENDS` (STUB) | CLASS→`file->CLASS->BaseName` (synthesized, Nothing-parent) | Declarations.hs:219-228 | metadata `base_name`. **Target ID is synthesized; correct ONLY for same-file base; cross-file base targets a non-existent node.** Resolver re-emits authoritative ones. |
| `ASSIGNED_FROM` | VARIABLE→(CALL/PROPERTY_ACCESS/REFERENCE) | Declarations.hs:516-542 | forward-ref edge |

### Semantic ID format (SemanticId.hs:21-29) — ANALYZER-VERIFIED
`file->TYPE->name`, `file->TYPE->name[in:parent]`, `file->TYPE->name[in:parent,h:hhhh]`.
- **Methods**: `semanticId file "FUNCTION" name parent Nothing` → `file->FUNCTION->save[in:User]` (NO hash;
  parent = `askNamedParent` = enclosing class name, set by `withNamedParent name` on ClassDef body, Declarations.hs:239).
  ⚠ **FIXTURE-vs-ANALYZER MISMATCH:** the resolver test (`python-resolve/test/Spec.hs:210`) uses
  `...->save[in:User,h:y]` (artificial hash). Real analyzer emits `[in:User]` with no `,h:`. `extractClassName`
  (`CallResolution.hs:138-159`) strips both `,h:` and the closing bracket, so it parses both — but a migration
  pack that string-matches `[in:Cls,h:` would silently drop ALL real methods. **Use HAS_METHOD edges, not SID parsing.**
- Methods nested under a function-in-class get `[in:functionName]`, not the class — a precision corner the SID
  approach gets wrong and HAS_METHOD gets right (the class still HAS_METHOD only its direct defs).

## 2. RESOLVE-STEP INVENTORY (legacy → pack)

### STEP A — python-imports (ImportResolution.hs)
Builds `ModuleIndex: file → (moduleNodeId, dottedModulePath)` and
`NameIndex: (modulePath, exportedName) → (file, nodeId)`. Then:
- **A1** Resolve each `IMPORT_BINDING` to its declaration via `IMPORTS_FROM` edge:
  - `imported_name` defaults to `gnName` when metadata absent.
  - `source_module` present (from-import): `resolveRelativeImport` → look up `(modPath, importedName)` in NameIndex
    → `IMPORTS_FROM` to that decl. Fallback: `(modPath ++ "." ++ importedName)` as a submodule → `IMPORTS_FROM` to MODULE.
  - `source_module` ABSENT (plain `import foo`): look up `importedName` as a module path → `IMPORTS_FROM` to MODULE.
- **A2** Resolve glob `IMPORT` (`glob=True`): `resolveRelativeImport(gnName)` → `IMPORTS_FROM` to MODULE node,
  metadata `glob=True`. (`gnName` of a from-import IMPORT = the full dotted path incl. leading dots, e.g. `.models`.)

`fileToModulePath` (ImportResolution.hs:62-73): strip `.pyi`/`.py`, strip `src/`|`lib/`|`source/` prefix,
`/`→`.`, drop trailing `.__init__`.

`resolveRelativeImport` (ImportResolution.hs:126-148): count leading dots = `level`; drop `level` components
from the importer's module path; append the rest. `level=0` → return absolute as-is.

### STEP B — python-types (TypeResolution.hs)
ClassIndex: `name → (file, classId)` (GLOBAL by name, last-write-wins — no file scoping). Then:
- **B1** FUNCTION `return_annotation` → `TYPE_OF` (FUNCTION→CLASS), metadata `annotation`.
- **B2** VARIABLE `annotation` → `TYPE_OF` (VARIABLE→CLASS), metadata `annotation`.
- **B3** PARAMETER `annotation` → `TYPE_OF`. ⚠ **DEAD CODE**: matches `gnType=="PARAMETER"`, but the analyzer
  emits parameters as `VARIABLE kind=parameter` (Declarations.hs:629-654, `gnType="VARIABLE"`). There are NO
  PARAMETER nodes. Param annotations are actually resolved by B2 (they're VARIABLEs). **Do not port B3 as a
  PARAMETER rule.** (FIXTURE-ONLY: Spec.hs:137-145 fabricates a PARAMETER node that the real graph never has.)
- **B4** CLASS `bases` (comma-split) → `TYPE_OF`... no: → `EXTENDS` (TypeResolution.hs:152-164), name lookup in
  ClassIndex, builtins skipped. **This DUPLICATES ClassInheritance's EXTENDS** but with GLOBAL-by-name lookup
  (no import-awareness) and no `resolvedVia` tag.
- `normalizeType`: strip generic `X[...]`→`X`; skip builtins (`str,int,float,bool,bytes,complex,list,dict,set,
  tuple,frozenset,None,type,object,property`). `parseAnnotation`/`stripGeneric` only strip the OUTER `[...]`;
  inner type of `Optional[User]` is NOT recursed (Optional itself isn't a class → 0 edges; FIXTURE Spec.hs:184
  asserts `Optional[User]`→1 edge, which only fires if a class named `Optional` exists — a corner).

### STEP C — python-calls (CallResolution.hs)
Indexes: FunctionIndex `(file,name)→[ids]`, MethodIndex `(class,method)→[ids]` (class from SID `[in:]` parse,
gated on `kind∈{method,classmethod,staticmethod}`), TypeIndex `(file,var)→class` (from VARIABLE `annotation`
matching a known class name), HierarchyIndex `parent→[children]` (from CLASS `bases`). Then per CALL:
- **C1** receiver present → resolve receiver's type via TypeIndex (trying name variants: exact, strip leading
  `_`, strip `self.`/`self._`); expand the class + all transitive subclasses via HierarchyIndex; emit `CALLS`
  to every matching `(class,method)` in MethodIndex, metadata `dispatch=virtual`. Fallback C2.
- **C2** receiver present but no type / no virtual hit → imprecise: first METHOD anywhere with matching name → `CALLS`.
- **C3** receiver absent → same-file FUNCTION by `(file,name)` → `CALLS` (first match). Else C4.
- **C4** cross-file: first FUNCTION anywhere with matching name → `CALLS`.

### STEP D — python-classes (ClassInheritance.hs)
The authoritative EXTENDS resolver (tags `resolvedVia="python-class-inheritance"`). Per CLASS with `bases`:
- **D1** same-file: base name in ClassIndex `(file,base)` → `EXTENDS`.
- **D2** cross-file: base name in ImportBindingIndex `(file,base)` → `resolveRelativeImport(source_module)` →
  NameIndex `(modPath, importedName)` → `EXTENDS`, metadata `importedFrom=source_module`.

## 3. DRAFT .dl RULES (today's builtin set)

Shared prelude (textual include, per synthesis §1a). File gate: `py(F) :- ends_with(F, ".py").` plus
`py(F) :- ends_with(F, ".pyi").`

```prolog
% ── module path of a file (fileToModulePath) ──
% strip .py / .pyi, strip src/|lib/|source/ prefix, /→., drop trailing .__init__
% (each transform an arm; pyi handled symmetrically)
mod_noext(M, R) :- node(M, "MODULE"), attr(M, "file", F), strip_suffix(F, ".py", R).
mod_noext(M, R) :- node(M, "MODULE"), attr(M, "file", F), strip_suffix(F, ".pyi", R).
% prefix strip (3 arms + identity-when-no-prefix via \+ better)
mod_pfx(M, R)  :- mod_noext(M, S), strip_prefix(S, "src/", R).
mod_pfx(M, R)  :- mod_noext(M, S), strip_prefix(S, "lib/", R).
mod_pfx(M, R)  :- mod_noext(M, S), strip_prefix(S, "source/", R).
mod_pfx(M, S)  :- mod_noext(M, S), \+ starts_with(S, "src/"),
                  \+ starts_with(S, "lib/"), \+ starts_with(S, "source/").
% init drop + /→.
mod_initdrop(M, P) :- mod_pfx(M, R), strip_suffix(R, "/__init__", Q), replace_all(Q, "/", ".", P).
mod_initdrop(M, P) :- mod_pfx(M, R), \+ ends_with(R, "/__init__"), replace_all(R, "/", ".", P).
module_path(M, P)  :- mod_initdrop(M, P).
```

```prolog
% ── name index: a decl exported by its module's dotted path ──
% decl_at(D, ModPath, Name): a FUNCTION/CLASS/VARIABLE D in file F, F's module ModPath.
file_module(F, P) :- module_path(M, P), node(M, "MODULE"), attr(M, "file", F).
decl_at(D, P, N) :- node(D, "FUNCTION"), attr(D, "file", F), file_module(F, P), attr(D, "name", N).
decl_at(D, P, N) :- node(D, "CLASS"),    attr(D, "file", F), file_module(F, P), attr(D, "name", N).
decl_at(D, P, N) :- node(D, "VARIABLE"), attr(D, "file", F), file_module(F, P), attr(D, "name", N).
% re-export via IMPORT_BINDING (lower priority; only if no decl owns (P,N))
reexport_at(B, P, N) :- node(B, "IMPORT_BINDING"), attr(B, "file", F), file_module(F, P), attr(B, "name", N).
```

```prolog
% ── STEP A1: from-import binding → IMPORTS_FROM (ABSOLUTE source_module only) ──
% binding's source_module + imported_name; imported_name defaults to name.
b_imported(B, IN) :- node(B, "IMPORT_BINDING"), node_attr(B, "imported_name", IN).
b_src(B, S)       :- node(B, "IMPORT_BINDING"), node_attr(B, "source_module", S).
@materialize(edge_type = "IMPORTS_FROM", mode = "additive")
imp_from_decl(B, D) :-
    b_src(B, S), \+ starts_with(S, "."),          % ABSOLUTE only (relative = blocker §4)
    b_imported(B, IN),
    decl_at(D, S, IN).
% submodule fallback: source_module ++ "." ++ imported_name names a MODULE
@materialize(edge_type = "IMPORTS_FROM", mode = "additive")
imp_from_submod(B, M) :-
    b_src(B, S), \+ starts_with(S, "."),
    b_imported(B, IN),
    concat(S, ".", SDot), concat(SDot, IN, SubPath),   % concat is arity-3 (A,B,Out)
    module_path(M, SubPath),
    \+ decl_at(_, S, IN).
% plain `import foo` (NO source_module): imported_name IS the module path
@materialize(edge_type = "IMPORTS_FROM", mode = "additive")
imp_plain(B, M) :-
    node(B, "IMPORT_BINDING"), \+ b_src(B, _),
    b_imported(B, IN),
    module_path(M, IN).
```

```prolog
% ── STEP B1/B2: annotation → TYPE_OF (FUNCTION return + VARIABLE annotation) ──
% class index by NAME (global, mirrors legacy global ClassIndex). generic strip + builtin skip.
class_named(C, N) :- node(C, "CLASS"), attr(C, "name", N).
% raw annotation, then strip outer generic [...] via last_segment? NO — need PREFIX before "[".
% strip_suffix can't drop "[...]" (variable tail). Use: annotation with no "[" matches directly;
% the generic-strip arm is a BLOCKER (§4, "prefix-before-delim" builtin missing).
fn_ann(Fn, A)  :- node(Fn, "FUNCTION"), node_attr(Fn, "return_annotation", A).
var_ann(V, A)  :- node(V, "VARIABLE"),  node_attr(V, "annotation", A).
@materialize(edge_type = "TYPE_OF", mode = "additive", meta(annotation))
type_of_fn(Fn, C, A) :- fn_ann(Fn, A), \+ string_contains(A, "["), class_named(C, A), \+ builtin_type(A).
@materialize(edge_type = "TYPE_OF", mode = "additive", meta(annotation))
type_of_var(V, C, A) :- var_ann(V, A), \+ string_contains(A, "["), class_named(C, A), \+ builtin_type(A).
% builtin_type/1 = generated ground facts (str,int,...) — same pattern as rt_global facts.
```

```prolog
% ── STEP C: CALL → CALLS ──
% C3 same-file function call (no receiver)
call_no_recv(C) :- node(C, "CALL"), \+ node_attr(C, "receiver", _).
call_name(C, N) :- node(C, "CALL"), attr(C, "name", N).
@materialize(edge_type = "CALLS", mode = "additive")
call_samefile(C, Fn) :-
    call_no_recv(C), call_name(C, N), attr(C, "file", F),
    node(Fn, "FUNCTION"), attr(Fn, "file", F), attr(Fn, "name", N).
% C1 method via declared receiver type → HAS_METHOD (member_of substrate, mirrors method_calls.dl)
% receiver_type via TYPE_OF on the receiver VARIABLE; HAS_METHOD on the class + subclasses (EXTENDS*).
recv_var(C, V)   :- node(C, "CALL"), node_attr(C, "receiver", R),
                    node(V, "VARIABLE"), attr(V, "file", F), attr(C, "file", F), attr(V, "name", R).
recv_class(C, Cls) :- recv_var(C, V), edge(V, Cls, "TYPE_OF").
% subclass expansion via EXTENDS (resolved edges, child -EXTENDS-> parent)
sub_or_self(Base, Base) :- node(Base, "CLASS").
sub_or_self(Base, Sub)  :- sub_or_self(Base, Mid), edge(Sub, Mid, "EXTENDS").
@materialize(edge_type = "CALLS", mode = "additive", meta(dispatch))
call_virtual(C, M) :-
    recv_class(C, Base), sub_or_self(Base, Cls),
    edge(Cls, M, "HAS_METHOD"), node(M, "FUNCTION"),
    call_name(C, MN), attr(M, "name", MN),
    eq_const(Dispatch, "virtual").   % ⚠ no eq_const builtin — see §4
```

```prolog
% ── STEP D: class inheritance EXTENDS ──
% D1 same-file base
class_base(Sub, BaseName) :- node(Sub, "CLASS"), node_attr(Sub, "bases", Bases) ... % ⚠ comma-split blocker §4
@materialize(edge_type = "EXTENDS", mode = "additive", meta(resolvedVia))
extends_samefile(Sub, Base) :-
    class_base(Sub, BN), attr(Sub, "file", F),
    node(Base, "CLASS"), attr(Base, "file", F), attr(Base, "name", BN).
% D2 cross-file base via import binding (ABSOLUTE source only)
@materialize(edge_type = "EXTENDS", mode = "additive", meta(resolvedVia, importedFrom))
extends_crossfile(Sub, Base) :-
    class_base(Sub, BN), attr(Sub, "file", F),
    node(B, "IMPORT_BINDING"), attr(B, "file", F), attr(B, "name", BN),
    b_src(B, S), \+ starts_with(S, "."),
    b_imported(B, IN), decl_at(Base, S, IN), node(Base, "CLASS").
```

## 4. MISSING CAPABILITIES (blockers — ordered by impact)

1. **`relative_import_resolve(ImporterModPath, RawSpec, Out)` builtin — THE dominant blocker.**
   `resolveRelativeImport` (ImportResolution.hs:126-148) counts leading dots, drops that many components from
   the importer's dotted module path, appends the rest. No existing builtin counts a leading-dot run nor drops
   N path components. `path_resolve` is filesystem-`./..`-on-slash-paths, not dotted-module-with-dot-prefix.
   **Without it, ALL relative imports (`from .base import X`, `from ..pkg import Y`) are unresolvable** — and in
   real Python packages relative imports are the MAJORITY of intra-package imports. This blocks A1 (relative
   arm), A2 (glob, whose `gnName` like `.models` is relative), and D2 (cross-file inheritance via relative import).
   ABSOLUTE imports (`from pkg.mod import X`) ARE expressible today (drafted above).
   *Mitigation options:* (a) add the builtin; or (b) materialize an `absolute_module(BindingId, AbsPath)` helper
   in a Rust pre-pass / analyzer enrichment so the pack joins against a first-class fact. Recommend (b)-via-analyzer:
   the analyzer already knows `relative_level` (Imports.hs:171) and the importer file — it could stamp the resolved
   absolute `source_module` at emit time, making the pack trivially `node_attr`-join. **This is the single
   highest-leverage change.**

2. **Comma-split of a multi-value metadata string (`bases`, and generally).** `bases="User,Auditable"` must split
   into individual base names (Python multiple inheritance). No `split`/`nth`/`first_segment` builtin exists
   (`last_segment` returns only the LAST segment; `method_suffix` is rfind-`.`-only). One-base classes work
   (`bases="User"` → whole string is the name); **multi-inheritance is unresolvable** for B4/D1/D2.
   *Mitigation:* analyzer should emit one `BASE_OF`/per-base metadata node OR emit the stub `EXTENDS` edges with
   per-base `base_name` (it ALREADY does — Declarations.hs:219-228, one edge per base, `base_name` metadata!).
   **Recommend: drive D off the analyzer's stub EXTENDS edges + their `edge_attr(... "base_name" ...)`**, not the
   `bases` string. That sidesteps the split entirely and is the same move js/rust packs made (edges over strings).

3. **Generic-annotation outer-strip `X[...]` → `X` (a "prefix-before-first-delimiter" function).** `normalizeType`
   (TypeResolution.hs:53-56) takes everything before the first `[`. No builtin extracts a prefix before a
   delimiter (`strip_suffix` needs a fixed literal tail; `method_suffix` gives the SUFFIX after last `.`).
   *Impact:* annotations like `List[str]`, `Optional[User]` are SKIPPED in the draft (`\+ string_contains(A,"[")`).
   Legacy resolves the OUTER name only (`List`, `Optional`) which rarely matches a project class anyway, so the
   real-edge loss is small — but `dict[str, MyClass]` inner types were never resolved by legacy either. **Low impact;
   acceptable to defer.** A `prefix_before(S, Delim, Out)` builtin would close it.

4. **No `eq_const` / literal-binding builtin for `meta(...)` constant columns.** The draft `call_virtual` wants
   `dispatch="virtual"` as edge metadata. `meta(col)` projects a HEAD column, so the rule head needs a column
   already bound to the literal `"virtual"`. There is no builtin binding a free var to a constant. *Mitigation:*
   use a 1-row ground fact `dispatch_virtual("virtual").` and join it (`dispatch_virtual(Dispatch)`), or omit the
   `dispatch` metadata (it's informational, not edge-identity). **Low impact** — drop the meta or use a ground fact.

5. **`builtin_type/1` ground-fact set** (str,int,float,…). Trivially generated as facts (same as `rt_global`
   in js packs). Not a real blocker — just must be generated into the pack. Gated on facts-e2e (synthesis Wave 0).

6. **C2/C4 "first match anywhere" (imprecise fallbacks).** Datalog set-semantics emits an edge to EVERY matching
   target, not the FIRST. Legacy C2 (first METHOD with name) and C4 (first FUNCTION with name) take `head`.
   *Impact:* SUPERSET delta — the pack emits all same-named targets where legacy picked one arbitrarily. For C4
   cross-file same-named functions this is arguably MORE correct (legacy's "first" is nondeterministic), matching
   the js-resolve precedent which accepted superset CALLS. **Expressible, but DELTA = SUPERSET (see §5).**

7. **`node_attr` MAINTAIN ENVELOPE.** Every pack rule using `node_attr` (imports, types, calls-with-receiver,
   inheritance-via-bases) **refuses incremental maintenance and forces full recompute** (verified: js_import_bindings.dl:91).
   Not a correctness blocker; a perf note — the python packs will be recompute-only until metadata moves to the row surface.

## 5. PREDICTED DELTAS (vs legacy, per step) — SOURCE-DERIVED, NOT MEASURED

| Step | Pack | Delta class | Bound / rationale |
|---|---|---|---|
| A1 absolute from-import | imp_from_decl/submod | **EXACT** (on absolute-import subset) | same NameIndex/ModuleIndex join; set-semantics dedups. Legacy "declaration takes priority over re-export" (ImportResolution.hs:101-104) — draft must add `\+ decl_at(_,P,N)` guard to reexport arm to match (TODO in draft). |
| A1 relative from-import | — | **SUBSET (→0 until blocker #1)** | 0 relative imports resolved. In a real package this could be the MAJORITY of IMPORTS_FROM. **Hard SUBSET, large.** |
| A2 glob | (relative) | **SUBSET (→0)** | glob targets are relative (`gnName=".models"`) → blocker #1. |
| B1/B2 annotation TYPE_OF | type_of_fn/var | **SUBSET (small)** + EXACT on non-generic | drops `X[...]` annotations (blocker #3); those rarely match a project class. Bound: ≤ (count of generic-annotated decls whose OUTER name is a project class). |
| B3 PARAMETER TYPE_OF | (not ported) | **EXACT (0=0)** | dead code in legacy too (no PARAMETER nodes); params resolved via B2 as VARIABLEs. |
| B4 vs D EXTENDS | (use D) | **n/a** | B4 duplicates D with worse (global, import-blind) lookup; do NOT port B4 — D supersedes it. |
| C1 virtual dispatch | call_virtual | **EXACT to SUPERSET** | subclass expansion via EXTENDS* mirrors HierarchyIndex; superset only if a base/sub pair has same-named methods legacy's traversal also hit (it does — `nub $ concatMap` over allClasses). Likely EXACT. **Depends on resolved EXTENDS existing (blocker #1 for cross-file bases).** |
| C2 imprecise method | (fallback) | **SUPERSET** | emits all same-named METHODs; legacy takes head. Bounded by Σ(name-collision multiplicity). |
| C3 same-file function | call_samefile | **EXACT to SUPERSET** | same-file (file,name); superset only on duplicate-named same-file funcs (rare). Legacy takes head of `(file,name)` list. |
| C4 cross-file function | (fallback) | **SUPERSET** | emits all same-named funcs project-wide; legacy head. Largest superset risk for CALLS — accept per js precedent, or gate with uniqueness `\+ ambiguous`. |
| D1 same-file inheritance | extends_samefile | **EXACT** (single base) / SUBSET (multi-base via `bases` string) | use edge-driven (blocker #2 mitigation) → EXACT. |
| D2 cross-file inheritance | extends_crossfile | **EXACT on absolute import** / SUBSET on relative | blocker #1 for relative; otherwise EXACT. |

**Net honest verdict:** absolute-import + same-file slices are EXACT-expressible today. The relative-import family
(A1-rel, A2, D2-rel) is a HARD ZERO without blocker #1, and that family is structurally the bulk of real Python
intra-package edges. **Python migration is NOT viable for a clean differential until blocker #1 (relative-import
resolution) lands** — ideally as analyzer-stamped absolute `source_module`, which also unblocks #2 (drive D off
EXTENDS stub edges). Recommend sequencing: (1) analyzer enrichment for absolute source_module + keep per-base EXTENDS
stubs → (2) pack absolute-imports + same-file calls + inheritance-via-edges (EXACT) → (3) defer generics + imprecise
fallbacks (small/superset) → (4) differential.

## 6. HONESTY SECTION (unverified / risk register)

- **NO LIVE PROBE.** Zero Python nodes in the dogfood graph. All shapes are read from analyzer SOURCE and/or
  package test fixtures, never from a real materialized Python graph. The DELTA bounds are reasoned, not measured.
  A real probe requires analyzing an actual Python project (none in-repo in config).
- **FIXTURE-vs-ANALYZER mismatches found (both flagged inline):**
  (a) method SID `[in:Cls,h:y]` in resolver test vs real `[in:Cls]` no-hash — `extractClassName` survives, naive
  string-match packs would not; (b) PARAMETER nodes in type-resolver test that the analyzer never emits (B3 dead).
- **`attr` reads ONLY first-class columns** {name,file,type,id} (builtin.rs:547-553). EVERY python metadata key
  (`source_module`, `imported_name`, `bases`, `annotation`, `return_annotation`, `receiver`, `kind`, `glob`,
  `relative_level`, `base_name`) needs `node_attr`/`edge_attr`. Verified against builtin source; not a guess.
- **`extractClassName`/SID-`[in:]` approach intentionally NOT used in the draft** — replaced by HAS_METHOD edges
  per the js/rust precedent (synthesis §1a `member_of`). This is a deliberate divergence from legacy mechanism;
  it is MORE correct (handles nested-in-function methods) but must be verified to produce the same MethodIndex
  membership on a real graph before claiming EXACT for C1/C2.
- **`sub_or_self`/EXTENDS* recursion** assumes RESOLVED EXTENDS edges exist (child→parent). On a fresh graph the
  only EXTENDS edges pre-pack are the analyzer STUBS (correct same-file, wrong cross-file target). So C1's
  subclass expansion depends on the inheritance pack (D) running FIRST in the pack-order, OR on the stubs being
  same-file-correct. **Pack-order dependency: D before C.** (Synthesis warns pack-order is load-bearing.)
- **Re-export priority** (decl over IMPORT_BINDING in NameIndex, ImportResolution.hs:101-104) is NOT yet in the
  draft reexport arm — needs `\+ decl_at(_,P,N)` guard to avoid a double IMPORTS_FROM. Flagged as draft TODO.
- **`concat` arity-3** `(A, B, Out)` verified (builtin.rs:1296). The submodule-path build uses two concats; could
  also be one rule if a 3-arg-join concat existed (it doesn't). Minor.
- I did NOT run the python-analyzer or python-resolve binaries (no Python corpus to feed). I did NOT verify the
  orchestrator's python resolve dispatch wiring (`grafema-orchestrator` python_parser.rs) — out of scope for the
  rule draft, but the skip-flag/pack-runner integration must mirror js/rust (`GRAFEMA_SKIP_RESOLVE_STEPS`).

---

## ADVERSARIAL VERDICT (independent review, 2026-06-13)

Reviewer re-read the resolver modules (`ImportResolution.hs`, `TypeResolution.hs`,
`CallResolution.hs`, `ClassInheritance.hs`), the analyzer emission
(`python-analyzer/src/Rules/{Imports,Declarations,Calls}.hs`, `Analysis/Types.hs`), the live
`derive/builtin.rs` registry + mode tables. No Python nodes in the dogfood graph (confirmed —
`config.yaml` has no `.py` glob), so all shapes are SOURCE-grounded; general builtins live-checked.

### CONFIRMED by independent evidence
- `node_attr` is `[B,B,F]`/`[B,B,B]`, no generator (builtin.rs:1186); `concat/3`, `replace_all/4`,
  `strip_prefix/strip_suffix/3` exist with no-row-on-non-match; no `first_segment`, no `eq_const`,
  no `split` (registry verified). Every metadata key the spec lists (`source_module`, `bases`,
  `annotation`, etc.) genuinely needs `node_attr` (not `attr`) — `attr` reads only first-class
  {name,file,type,id}. Correct.
- from-import IMPORT_BINDING carries `source_module = fullPath` where
  `fullPath = dots <> modulePart` (Imports.hs:146-148, 214) — i.e. source_module INCLUDES the
  leading-dot prefix for relative imports (`from .base` → `".base"`). The spec's `\+ starts_with(S,".")`
  ABSOLUTE-only guard is therefore CORRECT, and blocker #1 (relative-import resolution = dominant
  blocker) is real and correctly the single highest-leverage gap.
- plain-import IMPORT_BINDING has NO `source_module` (Imports.hs:88-114, only imported_name+local_name)
  — the spec's `\+ b_src(B,_)` plain-import arm is correct.
- CLASS `bases = MetaText (T.intercalate "," baseNames)` (Declarations.hs:209) — comma-joined string;
  the split blocker #2 is REAL. The analyzer ALSO emits one EXTENDS stub edge per base with
  `base_name` metadata (Declarations.hs:218-228) — the spec's recommended mitigation (drive D off the
  stub EXTENDS + `edge_attr base_name`, not the `bases` string) is sound and sidesteps the split.
- HAS_METHOD (CLASS→FUNCTION, Declarations.hs:151-156) exists — the spec's use of HAS_METHOD as the
  `member_of` substrate (over SID `[in:]` parsing) is verified and is MORE correct (the spec's
  nested-method observation holds).
- B3 PARAMETER dead-code: analyzer emits parameters as VARIABLE (no PARAMETER node) — the spec's
  "do not port B3" is correct.

### ⚠ ONE REALITY TO FLAG (the round's lesson) — analyzer-stamped mitigation is under-specified
The spec's recommended fix for blocker #1 is "(b)-via-analyzer: stamp the resolved absolute
`source_module` at emit time". Independent read shows the analyzer ALSO stamps `relative_level`
(MetaInt) on BOTH the IMPORT node (Imports.hs:171) AND the from-import IMPORT_BINDING
(Imports.hs:240, `[("relative_level", MetaInt level) | level > 0]`) — the spec only mentions it on
the IMPORT. So the binding already carries (source_module-with-dots, relative_level, importer file) —
enough for a Rust pre-pass or analyzer enrichment to compute the absolute path WITHOUT a new builtin.
This STRENGTHENS the spec's recommendation (b) and should be stated: the enrichment input already
exists on the binding node; it is purely a dotted-path arithmetic, not new analyzer extraction.

### ⚠ SECOND FLAG — deferred-ref baseline not accounted for
The analyzer emits a `DeferredRef ImportResolve` with `drSource = fullPath`, `drEdgeType =
"IMPORTS_FROM"` for every from-import binding (Imports.hs:225-235). The IMPORTS_FROM the differential
compares against is produced by the python-resolve binary consuming/re-deriving these — but the spec
does not state whether ANY IMPORTS_FROM are produced by an orchestrator deferred-ref pass independent
of python-resolve. If the orchestrator resolves some deferred refs itself, the legacy baseline is not
"python-resolve output" alone. The executing wave MUST confirm the IMPORTS_FROM baseline source on a
real Python corpus before classifying A1 deltas as EXACT (the round's deferred-ref-drop lesson).

### CONFIRMED — correctly classified
- C2/C4 "first match anywhere" → SUPERSET (set-semantics emits all same-named): correct, matches js
  precedent. `eq_const` gap for `meta(dispatch)` is real (no such builtin) — the ground-fact
  mitigation or dropping the informational meta is the right call.
- Pack-order D-before-C dependency (C1 subclass expansion needs resolved EXTENDS): correctly flagged.
- `sub_or_self`/EXTENDS* recursion is expressible (datalog supports recursion); the spec is right that
  it depends on resolved (not stub) EXTENDS edges, hence the D-before-C ordering.

### READY FOR PACKS: **NO — and the spec says so.** The relative-import family (A1-rel, A2-glob,
D2-rel) is a HARD ZERO without blocker #1, and that family is the bulk of real Python intra-package
edges. Absolute-import + same-file slices ARE expressible today (EXACT, drafted correctly). The spec's
honest net verdict — "not viable for a clean differential until blocker #1 lands, ideally as
analyzer-stamped absolute source_module" — is correct and the right sequencing. The two flags above
(enrichment input already on the binding; deferred-ref baseline) tighten but do not overturn it.
