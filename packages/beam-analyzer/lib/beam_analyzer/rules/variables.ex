defmodule BeamAnalyzer.Rules.Variables do
  @moduledoc "Handles variable bindings -> VARIABLE nodes."

  alias BeamAnalyzer.{Context, SemanticId}

  def process_match({name, meta, nil}, ctx) when is_atom(name) do
    add_variable(ctx, name, meta, "variable")
  end

  def process_match({:_, _, _}, ctx), do: ctx

  def process_match({:{}, _, elements}, ctx) do
    Enum.reduce(elements, ctx, &process_match/2)
  end

  def process_match({left, right}, ctx) do
    ctx = process_match(left, ctx)
    process_match(right, ctx)
  end

  def process_match(list, ctx) when is_list(list) do
    Enum.reduce(list, ctx, &process_match/2)
  end

  def process_match({:%, _, [_struct, {:%{}, _, pairs}]}, ctx) do
    Enum.reduce(pairs, ctx, fn {_key, val}, ctx -> process_match(val, ctx) end)
  end

  def process_match({:%{}, _, pairs}, ctx) do
    Enum.reduce(pairs, ctx, fn {_key, val}, ctx -> process_match(val, ctx) end)
  end

  def process_match(_other, ctx), do: ctx

  def add_variable(ctx, name, meta, kind) do
    name_str = Atom.to_string(name)

    # Skip underscore-prefixed variables
    if String.starts_with?(name_str, "_") do
      ctx
    else
      line = Keyword.get(meta, :line, 0)
      col = Keyword.get(meta, :column, 0)
      scope = Context.current_scope(ctx) || "module"

      var_id = SemanticId.variable_id(ctx.file, name_str, scope)

      node = %{
        id: var_id,
        type: "VARIABLE",
        name: name_str,
        file: ctx.file,
        line: line,
        column: col,
        endLine: 0,
        endColumn: 0,
        exported: false,
        metadata: %{language: "elixir", kind: kind}
      }

      Context.add_node(ctx, node)
    end
  end
end
