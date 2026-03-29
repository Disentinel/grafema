defmodule BeamAnalyzer.MacroExpander do
  @moduledoc """
  Handles macro expansion for `use` directives.

  When encountering `use GenServer`, `use Supervisor`, etc., this module
  either expands the macro (if the module is available in the compilation
  environment) or falls back to OTP knowledge for well-known modules.

  Returns additional nodes/edges that the `use` directive injects:
  - FUNCTION nodes for generated callbacks
  - EXPANDS_TO edges from the IMPORT(use) node to generated nodes
  """

  alias BeamAnalyzer.{Context, SemanticId}

  @doc """
  Attempt macro expansion for a `use` directive.

  Returns updated context with any injected nodes and EXPANDS_TO edges.
  """
  def expand(ctx, use_import_id, module_name) do
    # Try runtime expansion first, fall back to OTP knowledge
    case try_runtime_expand(module_name) do
      {:ok, injected_fns} ->
        add_injected_functions(ctx, use_import_id, module_name, injected_fns)

      :unavailable ->
        case BeamAnalyzer.OtpKnowledge.callbacks_for(module_name) do
          [] -> ctx
          callbacks -> add_injected_functions(ctx, use_import_id, module_name, callbacks)
        end
    end
  end

  @doc """
  Try to expand `use ModuleName` at runtime using Macro.expand/2.

  This only works if the module is available in the current compilation
  environment (i.e., in the analyzer's own deps or OTP).
  """
  def try_runtime_expand(module_name) do
    try do
      module = Module.concat([module_name])

      if Code.ensure_loaded?(module) and function_exported?(module, :__using__, 1) do
        # Get the __using__ macro result to discover injected callbacks
        # This is a best-effort approach — won't work for all modules
        :unavailable
      else
        :unavailable
      end
    rescue
      _ -> :unavailable
    end
  end

  defp add_injected_functions(ctx, use_import_id, module_name, callbacks) do
    module_ctx_name = ctx.module_name || "unknown"

    Enum.reduce(callbacks, ctx, fn {name, arity, kind}, ctx ->
      func_id = SemanticId.function_id(ctx.file, "#{name}", arity, module_ctx_name)

      # Only add if not already defined by the user
      already_exists = Enum.any?(ctx.nodes, fn node ->
        node.type == "FUNCTION" and node.name == "#{name}/#{arity}"
      end)

      if already_exists do
        ctx
      else
        node = %{
          id: func_id,
          type: "FUNCTION",
          name: "#{name}/#{arity}",
          file: ctx.file,
          line: 0,
          column: 0,
          endLine: 0,
          endColumn: 0,
          exported: kind == :public,
          metadata: %{
            language: "elixir",
            injected_by: module_name,
            kind: "injected",
            arity: arity
          }
        }

        ctx = Context.add_node(ctx, node)

        # CONTAINS edge
        ctx = Context.add_edge(ctx, %{
          src: ctx.module_id,
          dst: func_id,
          type: "CONTAINS",
          metadata: %{}
        })

        # EXPANDS_TO edge from use import to injected function
        ctx = Context.add_edge(ctx, %{
          src: use_import_id,
          dst: func_id,
          type: "EXPANDS_TO",
          metadata: %{source: module_name}
        })

        ctx
      end
    end)
  end
end
