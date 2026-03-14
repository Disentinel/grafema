defmodule BeamAnalyzer.Rules.Types do
  @moduledoc "Handles @type/@spec → TYPESPEC nodes."

  alias BeamAnalyzer.{Context, SemanticId}

  def process({:@, _meta, [{:type, tmeta, [{:"::", _, [{name, _, _} | _]}]}]}, ctx) when is_atom(name) do
    add_typespec(ctx, Atom.to_string(name), tmeta, "type")
  end

  def process({:@, _meta, [{:spec, smeta, [{:"::", _, [{name, _, _} | _]}]}]}, ctx) when is_atom(name) do
    add_typespec(ctx, Atom.to_string(name), smeta, "spec")
  end

  def process({:@, _meta, [{:callback, cmeta, [{:"::", _, [{name, _, _} | _]}]}]}, ctx) when is_atom(name) do
    add_typespec(ctx, Atom.to_string(name), cmeta, "callback")
  end

  def process(_ast, ctx), do: ctx

  defp add_typespec(ctx, name, meta, kind) do
    line = Keyword.get(meta, :line, 0)
    col = Keyword.get(meta, :column, 0)
    module_name = ctx.module_name || "unknown"

    ts_id = SemanticId.typespec_id(ctx.file, name, module_name)

    node = %{
      id: ts_id,
      type: "TYPESPEC",
      name: name,
      file: ctx.file,
      line: line,
      column: col,
      endLine: 0,
      endColumn: 0,
      exported: false,
      metadata: %{kind: kind, language: "elixir"}
    }

    Context.add_node(ctx, node)
  end

  def process_erlang_type(ctx, name, line) do
    module_name = ctx.module_name || "unknown"
    ts_id = SemanticId.typespec_id(ctx.file, name, module_name)

    node = %{
      id: ts_id,
      type: "TYPESPEC",
      name: name,
      file: ctx.file,
      line: line,
      column: 0,
      endLine: 0,
      endColumn: 0,
      exported: false,
      metadata: %{kind: "type", language: "erlang"}
    }

    Context.add_node(ctx, node)
  end

  def process_erlang_spec(ctx, name, arity, line) do
    module_name = ctx.module_name || "unknown"
    ts_id = SemanticId.typespec_id(ctx.file, "#{name}/#{arity}", module_name)

    node = %{
      id: ts_id,
      type: "TYPESPEC",
      name: "#{name}/#{arity}",
      file: ctx.file,
      line: line,
      column: 0,
      endLine: 0,
      endColumn: 0,
      exported: false,
      metadata: %{kind: "spec", language: "erlang"}
    }

    Context.add_node(ctx, node)
  end
end
