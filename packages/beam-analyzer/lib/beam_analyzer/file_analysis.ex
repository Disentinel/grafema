defmodule BeamAnalyzer.FileAnalysis do
  @moduledoc "Converts analysis context to FileAnalysis JSON-compatible map."

  def to_map(ctx) do
    %{
      file: ctx.file,
      moduleId: ctx.module_id,
      nodes: Enum.reverse(ctx.nodes),
      edges: Enum.reverse(ctx.edges),
      exports: Enum.reverse(ctx.exports)
    }
  end
end
