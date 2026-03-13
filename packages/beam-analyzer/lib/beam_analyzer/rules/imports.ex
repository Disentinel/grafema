defmodule BeamAnalyzer.Rules.Imports do
  @moduledoc "Handles alias/import/use/require -> IMPORT nodes."

  alias BeamAnalyzer.{Context, SemanticId}

  def process({:alias, meta, [{:__aliases__, _, parts}]}, ctx) do
    add_import(ctx, parts, "alias", meta)
  end

  def process({:alias, meta, [{:__aliases__, _, parts}, _opts]}, ctx) do
    add_import(ctx, parts, "alias", meta)
  end

  def process({:import, meta, [{:__aliases__, _, parts}]}, ctx) do
    add_import(ctx, parts, "import", meta)
  end

  def process({:import, meta, [{:__aliases__, _, parts}, _opts]}, ctx) do
    add_import(ctx, parts, "import", meta)
  end

  def process({:use, meta, [{:__aliases__, _, parts}]}, ctx) do
    process_use(ctx, parts, meta)
  end

  def process({:use, meta, [{:__aliases__, _, parts}, _opts]}, ctx) do
    process_use(ctx, parts, meta)
  end

  def process({:require, meta, [{:__aliases__, _, parts}]}, ctx) do
    add_import(ctx, parts, "require", meta)
  end

  def process({:require, meta, [{:__aliases__, _, parts}, _opts]}, ctx) do
    add_import(ctx, parts, "require", meta)
  end

  def process(_ast, ctx), do: ctx

  def process_behaviour({:@, _meta, [{:behaviour, bmeta, [{:__aliases__, _, parts}]}]}, ctx) do
    add_import(ctx, parts, "behaviour", bmeta)
  end

  def process_behaviour(_ast, ctx), do: ctx

  defp process_use(ctx, parts, meta) do
    target = parts |> Enum.map(&Atom.to_string/1) |> Enum.join(".")
    line = Keyword.get(meta, :line, 0)
    col = Keyword.get(meta, :column, 0)
    scope = ctx.module_name || "module"

    import_id = SemanticId.import_id(ctx.file, target, scope)

    node = %{
      id: import_id,
      type: "IMPORT",
      name: target,
      file: ctx.file,
      line: line,
      column: col,
      endLine: 0,
      endColumn: 0,
      exported: false,
      metadata: %{kind: "use", language: "elixir"}
    }

    ctx = Context.add_node(ctx, node)

    # Expand macros for use directive
    BeamAnalyzer.MacroExpander.expand(ctx, import_id, target)
  end

  defp add_import(ctx, parts, kind, meta) do
    target = parts |> Enum.map(&Atom.to_string/1) |> Enum.join(".")
    line = Keyword.get(meta, :line, 0)
    col = Keyword.get(meta, :column, 0)
    scope = ctx.module_name || "module"

    import_id = SemanticId.import_id(ctx.file, target, scope)

    node = %{
      id: import_id,
      type: "IMPORT",
      name: target,
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

  def add_erlang_import(ctx, module_name, fun_name, arity, line) do
    scope = ctx.module_name || "module"
    target = "#{module_name}.#{fun_name}/#{arity}"
    import_id = SemanticId.import_id(ctx.file, target, scope)

    node = %{
      id: import_id,
      type: "IMPORT",
      name: target,
      file: ctx.file,
      line: line,
      column: 0,
      endLine: 0,
      endColumn: 0,
      exported: false,
      metadata: %{kind: "import", language: "erlang", module: module_name}
    }

    Context.add_node(ctx, node)
  end
end
