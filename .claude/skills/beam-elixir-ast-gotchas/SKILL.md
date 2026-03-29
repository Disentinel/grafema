---
name: beam-elixir-ast-gotchas
description: |
  Fix Elixir/Erlang AST processing bugs in Grafema beam-analyzer. Use when:
  (1) Elixir parser returns MODULE node but 0 functions/calls — body nesting issue,
  (2) Erlang parser crashes with "cannot convert list to string" on OTP 26+ — location
  format changed from integer to keyword list, (3) pipe operator |> creates spurious
  CALL nodes instead of desugared function calls — clause ordering bug,
  (4) multi-module .ex files return only the first module — missing __block__ handler,
  (5) installing Erlang/Elixir on macOS with outdated Xcode/Clang.
author: Claude Code
version: 1.0.0
date: 2026-03-13
---

# BEAM/Elixir AST Processing Gotchas

## Problem
When building tools that process Elixir/Erlang ASTs (like Grafema's beam-analyzer),
several non-obvious AST structural issues cause silent failures or crashes.

## Context / Trigger Conditions

### Gotcha 1: Elixir AST Body Double-Nesting
- **Symptom**: MODULE node created correctly, but 0 FUNCTION/CALL/VARIABLE nodes
- **Trigger**: Any Elixir file with functions inside a module
- **Root cause**: `{:defmodule, meta, [alias | body]}` produces `body = [[do: ...]]`,
  NOT `body = [do: ...]`. The body is wrapped in an extra list layer.
- **Same issue for functions**: `{:def, meta, [{name, _, args} | body]}` also gives
  `body = [[do: ...]]`

**Fix**: Always unwrap with `List.first(body) || []` before pattern matching on `[do: ...]`:
```elixir
# WRONG — body is [[do: ...]], not [do: ...]
walk_module_body(body, ctx)

# RIGHT
keyword_body = List.first(body) || []
walk_module_body(keyword_body, ctx)
```

### Gotcha 2: OTP 26+ Erlang AST Location Format
- **Symptom**: `(ArgumentError) cannot convert the given list to a string`
- **Trigger**: Processing Erlang `.erl` files with OTP 26 or newer
- **Root cause**: OTP 26 changed Erlang abstract forms from `{:attribute, LineNumber, ...}`
  to `{:attribute, [text: ~c"...", location: N], ...}`. The second element is now a
  keyword list, not an integer.

**Fix**: Add a location extractor helper:
```elixir
defp extract_line(loc) when is_integer(loc), do: loc
defp extract_line(loc) when is_list(loc), do: Keyword.get(loc, :location, 0)
defp extract_line(_), do: 0
```

Apply to ALL Erlang form handlers: `:module`, `:export`, `:function`, `:type`, `:spec`,
`:import`, `:call`, `:match`, `:case`, etc.

### Gotcha 3: Pipe Operator Clause Ordering
- **Symptom**: CALL nodes with name `|>` instead of desugared function names
- **Trigger**: Elixir pipe chains like `data |> String.trim() |> Enum.map(...)`
- **Root cause**: `{:|>, meta, [left, right]}` matches the general clause
  `{name, meta, args} when is_atom(name) and is_list(args)` because `:|>` is an atom.
  If the general clause is defined before the pipe-specific clause, it catches pipes first.

**Fix**: Always define the `{:|>, ...}` clause BEFORE `{name, meta, args}`:
```elixir
# Pipe clause MUST come first
defp walk_pipe_arg({:|>, _meta, [left, right]}, ctx) do ...
defp walk_pipe_arg({{:., _, _}, meta, args}, ctx) do ...    # dot calls
defp walk_pipe_arg({name, meta, args}, ctx) when is_atom(name) do ...  # general - LAST
```

### Gotcha 4: Multi-Module Files
- **Symptom**: Only first module processed, or 0 nodes if top-level is `__block__`
- **Trigger**: Elixir files with multiple `defmodule` at the top level
- **Root cause**: `Code.string_to_quoted` returns `{:__block__, _, [defmodule1, defmodule2, ...]}`
  for multi-module files, but `{:defmodule, ...}` for single-module files.

**Fix**: Handle both in the walker:
```elixir
defp walk_elixir({:__block__, _, statements}, ctx) do
  Enum.reduce(statements, ctx, fn stmt, ctx -> Rules.Modules.process(stmt, ctx) end)
end
defp walk_elixir(ast, ctx), do: Rules.Modules.process(ast, ctx)
```

### Gotcha 5: `:::` Atom Quoting Warning
- **Symptom**: Elixir 1.16+ warning: `atom ::: must be written between quotes`
- **Trigger**: Pattern matching on typespec AST `{:::, _, [...]}`
- **Fix**: Use `{:"::", _, [...]}` instead of `{:::, _, [...]}`

## Verification
- Run `mix run verify.exs` on comprehensive fixture files
- Check that all expected node types appear (MODULE, FUNCTION, CALL, VARIABLE, etc.)
- Verify Erlang files produce nodes without crashes
- Verify pipe chains produce individual CALL nodes per function

## Notes
- The Elixir AST with `columns: true, token_metadata: true` options adds extra metadata
  to every node — be aware when pattern matching
- OTP version detection: check `:erlang.system_info(:otp_release)` if you need
  conditional handling
- For debugging AST structure, use `Code.string_to_quoted(source) |> IO.inspect(pretty: true)`

## Installing Erlang/Elixir on macOS with Outdated Clang
If `brew install erlang` fails with a clang crash on PCRE2 (Clang 14.x):
1. Install kerl: `brew install kerl`
2. Build with problematic deps disabled:
   ```bash
   KERL_CONFIGURE_OPTIONS="--without-wx --without-odbc --without-javac --disable-jit" \
     kerl build 26.2.5 26.2.5
   kerl install 26.2.5 ~/.kerl/installs/26.2.5
   source ~/.kerl/installs/26.2.5/activate
   ```
3. Install Elixir from pre-built binary (match OTP version):
   ```bash
   curl -fsSL https://github.com/elixir-lang/elixir/releases/download/v1.16.3/elixir-otp-26.zip \
     -o /tmp/elixir.zip
   unzip -q /tmp/elixir.zip -d ~/.elixir
   export PATH="~/.kerl/installs/26.2.5/bin:~/.elixir/bin:$PATH"
   ```
