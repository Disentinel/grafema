defmodule BeamAnalyzer.Rules.ControlFlow do
  @moduledoc "Handles case/cond/if/with -> BRANCH nodes, for -> LOOP nodes."

  alias BeamAnalyzer.{Context, SemanticId}

  def process({:case, meta, _args}, ctx) do
    add_branch(ctx, "case", meta)
  end

  def process({:cond, meta, _args}, ctx) do
    add_branch(ctx, "cond", meta)
  end

  def process({:if, meta, _args}, ctx) do
    add_branch(ctx, "if", meta)
  end

  def process({:unless, meta, _args}, ctx) do
    add_branch(ctx, "unless", meta)
  end

  def process({:with, meta, _args}, ctx) do
    add_branch(ctx, "with", meta)
  end

  def process({:for, meta, _args}, ctx) do
    add_loop(ctx, meta)
  end

  def process(_ast, ctx), do: ctx

  defp add_branch(ctx, kind, meta) do
    line = Keyword.get(meta, :line, 0)
    col = Keyword.get(meta, :column, 0)
    scope = Context.current_scope(ctx) || "module"

    branch_id = SemanticId.branch_id(ctx.file, kind, scope, line, col)

    node = %{
      id: branch_id,
      type: "BRANCH",
      name: kind,
      file: ctx.file,
      line: line,
      column: col,
      endLine: 0,
      endColumn: 0,
      exported: false,
      metadata: %{kind: kind}
    }

    Context.add_node(ctx, node)
  end

  defp add_loop(ctx, meta) do
    line = Keyword.get(meta, :line, 0)
    col = Keyword.get(meta, :column, 0)
    scope = Context.current_scope(ctx) || "module"

    loop_id = SemanticId.loop_id(ctx.file, scope, line, col)

    node = %{
      id: loop_id,
      type: "LOOP",
      name: "for",
      file: ctx.file,
      line: line,
      column: col,
      endLine: 0,
      endColumn: 0,
      exported: false,
      metadata: %{}
    }

    Context.add_node(ctx, node)
  end
end
