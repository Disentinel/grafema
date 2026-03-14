defmodule BeamAnalyzer.Rules.Patterns do
  @moduledoc "Handles pattern matching -> PATTERN nodes."

  alias BeamAnalyzer.{Context, SemanticId}

  def process_pattern(pattern, meta, ctx) do
    line = Keyword.get(meta, :line, 0)
    col = Keyword.get(meta, :column, 0)
    scope = Context.current_scope(ctx) || "module"

    pattern_id = SemanticId.pattern_id(ctx.file, scope, line, col)

    node = %{
      id: pattern_id,
      type: "PATTERN",
      name: describe_pattern(pattern),
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

  defp describe_pattern({:{}, _, _}), do: "tuple"
  defp describe_pattern({:%{}, _, _}), do: "map"
  defp describe_pattern({:%, _, _}), do: "struct"
  defp describe_pattern(list) when is_list(list), do: "list"
  defp describe_pattern({:<<>>, _, _}), do: "binary"
  defp describe_pattern(_), do: "match"
end
