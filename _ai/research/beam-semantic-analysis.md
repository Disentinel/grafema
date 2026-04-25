# BEAM (Elixir/Erlang) Semantic Analysis

**Status:** Research / Design
**Date:** 2026-03-13
**Origin:** REG-667 design session
**Linear:** REG-667

## Parser Architecture

### Elixir: `Code.string_to_quoted/2`

Long-running Elixir subprocess (escript or Mix task). Receives file path → returns JSON AST.

Elixir AST is uniform tuples: `{atom, metadata, arguments}`

```elixir
# Source
def add(a, b), do: a + b

# AST (Code.string_to_quoted)
{:def, [line: 1],
  [{:add, [line: 1], [{:a, [line: 1], nil}, {:b, [line: 1], nil}]},
   [do: {:+, [line: 1], [{:a, [line: 1], nil}, {:b, [line: 1], nil}]}]]}
```

Key property: no distinct node types like Babel. Everything is `{atom, meta, args}`. The atom determines semantics:
- `:def` / `:defp` → function definition
- `:defmodule` → module definition
- `:.` → remote call (e.g., `Module.function`)
- `:=` → pattern match / assignment
- `:|>` → pipe (desugar to nested calls)

### Erlang: `:erl_parse`

Same subprocess can parse Erlang via `:erl_parse.parse_form/1`. Returns "abstract forms" — also tuple-based but different structure.

```erlang
% Source
add(A, B) -> A + B.

% Abstract form
{function, 1, add, 2,
  [{clause, 1, [{var, 1, 'A'}, {var, 1, 'B'}], [],
    [{op, 1, '+', {var, 1, 'A'}, {var, 1, 'B'}}]}]}
```

### Macro Expansion: `Macro.expand/2`

Second pass on same AST. For each `use`/macro call, expand and return both pre and post versions.

```elixir
# Pre-expansion (what developer wrote)
use GenServer

# Post-expansion (what actually runs)
@behaviour GenServer
def child_spec(init_arg) do
  # ... generated code ...
end
```

Both stored in graph. Pre-expansion = primary CALL node. Post-expansion = subgraph linked via EXPANDS_TO.

## AST → Grafema Node Type Mapping

### Module System

| Elixir construct | AST atom | Grafema node | Notes |
|-----------------|----------|--------------|-------|
| `defmodule M do ... end` | `:defmodule` | MODULE | |
| `alias M` | `:alias` | IMPORT | kind=alias |
| `import M` | `:import` | IMPORT | kind=import |
| `use M` | `:use` | IMPORT + CALL (macro) | dual: import + macro expansion |
| `require M` | `:require` | IMPORT | kind=require (compile-time only) |

### Functions

| Elixir construct | AST atom | Grafema node | Notes |
|-----------------|----------|--------------|-------|
| `def f(args)` | `:def` | FUNCTION | public |
| `defp f(args)` | `:defp` | FUNCTION | private, metadata: visibility=private |
| `def f(pat1)` / `def f(pat2)` | multiple `:def` | ONE FUNCTION | CFG branching via patterns |
| `f/1` vs `f/2` | different arity | SEPARATE FUNCTIONs | semantic ID: `file->FUNCTION->f/1`, `file->FUNCTION->f/2` |
| `fn args -> body end` | `:fn` | FUNCTION | anonymous, like JS arrow |

### Variables & Patterns

| Elixir construct | AST atom | Grafema node | Notes |
|-----------------|----------|--------------|-------|
| `x = value` | `:=` | VARIABLE + ASSIGNED_FROM | immutable rebinding |
| `{:ok, result} = expr` | `:=` with tuple | VARIABLE(result) + PATTERN | destructuring |
| `%User{name: n}` | `:%{}` | PATTERN + VARIABLE(n) | struct destructuring |
| `[h \| t]` | `:\|` in list | PATTERN + VARIABLE(h, t) | list destructuring |

### Control Flow

| Elixir construct | AST atom | Grafema model | Notes |
|-----------------|----------|---------------|-------|
| `case x do ... end` | `:case` | BRANCH + pattern SCOPE per clause | |
| `cond do ... end` | `:cond` | BRANCH (like if/else chain) | |
| `with {:ok, a} <- f(), ...` | `:with` | BRANCH + sequential pattern match | |
| `if cond do ... end` | `:if` | BRANCH | |
| `for x <- list` | `:for` | LOOP | comprehension |
| `try/catch/rescue` | `:try` | TRY_BLOCK + CATCH_BLOCK | |
| Function clause heads | multiple `:def` | CFG branching in ONE FUNCTION | Haskell model |

### Calls

| Elixir construct | AST atom | Grafema node | Notes |
|-----------------|----------|--------------|-------|
| `f(args)` | `{:f, meta, args}` | CALL | local call |
| `M.f(args)` | `{{:., meta, [M, :f]}, meta, args}` | CALL | remote call, receiver=M |
| `x \|> f()` | `{:\|>, meta, [x, {:f, ...}]}` | CALL to f with x as first arg | desugar |
| `x \|> f() \|> g()` | nested `:\|>` | CALL g(CALL f(x)) | chain desugar |

### Pipe Desugaring Detail

```elixir
# Source
data
|> transform()
|> validate(opts)
|> save()

# Desugared (what we model)
save(validate(transform(data), opts))

# Graph edges
CALL transform ← PASSES_ARGUMENT ← VARIABLE data
CALL validate ← PASSES_ARGUMENT ← CALL transform
CALL validate ← PASSES_ARGUMENT ← VARIABLE opts  (2nd arg)
CALL save ← PASSES_ARGUMENT ← CALL validate
```

## Infrastructure Layer Extraction

### Process Detection

```elixir
# Pattern: GenServer.start_link(__MODULE__, init_arg, name: Name)
# Creates: PROCESS node with registered_name=Name, module=__MODULE__

# Pattern: Supervisor.init(children, strategy: :one_for_one)
# Creates: SUPERVISION_TREE node + SUPERVISES edges to each child PROCESS

# Pattern: Task.start(fn -> ... end)
# Creates: PROCESS node (ephemeral, no registered name)

# Pattern: Agent.start_link(fn -> initial_state end, name: Name)
# Creates: PROCESS node with registered_name=Name
```

### Message Type Detection

```elixir
# Pattern: handle_call(pattern, _from, state)
# Creates: MESSAGE_TYPE node with pattern extracted, direction=call

# Pattern: handle_cast(pattern, state)
# Creates: MESSAGE_TYPE node with direction=cast

# Pattern: handle_info(pattern, state)
# Creates: MESSAGE_TYPE node with direction=info
```

### Bridge Edge Creation

```elixir
defmodule MyApp.Worker do
  use GenServer

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
    #                    ↑ SPAWNS edge to PROCESS MyApp.Worker
  end

  def get_state do
    GenServer.call(__MODULE__, :get_state)
    #              ↑ SENDS_TO edge to PROCESS MyApp.Worker
  end

  def handle_call(:get_state, _from, state) do
    #              ↑ MESSAGE_TYPE :get_state
    #              ↑ RECEIVES edge from MESSAGE_TYPE
    #              ↑ HANDLES_IN edge to PROCESS MyApp.Worker
    {:reply, state, state}
  end
end
```

## Erlang-Specific

Erlang abstract forms map similarly but with different syntax:

| Erlang | Elixir equivalent | Grafema mapping |
|--------|-------------------|-----------------|
| `-module(Name).` | `defmodule` | MODULE |
| `-export([f/1]).` | `def` (public) | metadata on FUNCTION |
| `-behaviour(gen_server).` | `use GenServer` (partially) | IMPORT + behaviour metadata |
| `-record(name, {fields}).` | `defstruct` (partially) | TYPE/INTERFACE |
| `gen_server:start_link(...)` | `GenServer.start_link(...)` | PROCESS + SPAWNS |

## Semantic ID Format

```
# Elixir
lib/my_app/worker.ex->MODULE->MyApp.Worker
lib/my_app/worker.ex->FUNCTION->start_link/1[in:MyApp.Worker]
lib/my_app/worker.ex->FUNCTION->handle_call/3[in:MyApp.Worker]
lib/my_app/worker.ex->FUNCTION->get_state/0[in:MyApp.Worker]

# Erlang
src/my_worker.erl->MODULE->my_worker
src/my_worker.erl->FUNCTION->start_link/1[in:my_worker]
src/my_worker.erl->FUNCTION->handle_call/3[in:my_worker]

# Infrastructure
lib/my_app/worker.ex->PROCESS->MyApp.Worker
lib/my_app/supervisor.ex->SUPERVISION_TREE->MyApp.Supervisor
```

## Related

- [Infrastructure Layer Model](./infrastructure-layer.md) — general infrastructure model
- [Haskell Semantic Analysis](./haskell-semantic-analysis.md) — pattern matching precedent
- [Theoretical Foundations](./theoretical-foundations.md) — L1-L5 theory
- [Declarative Semantic Rules](./declarative-semantic-rules.md) — completeness matrix approach
