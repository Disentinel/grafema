defmodule BeamAnalyzer.Rules.Exports do
  @moduledoc "Tracks exported (public) functions."

  alias BeamAnalyzer.{Context, SemanticId}

  def add_export(ctx, name, arity) do
    module_name = ctx.module_name || "unknown"

    export = %{
      name: "#{name}/#{arity}",
      nodeId: SemanticId.function_id(ctx.file, name, arity, module_name),
      kind: "function",
      source: nil
    }

    Context.add_export(ctx, export)
  end
end
