defmodule BeamAnalyzer.Context do
  @moduledoc "Analysis context that accumulates nodes, edges, and exports."

  defstruct [
    :file,
    :module_id,
    module_name: nil,
    scope_stack: [],
    nodes: [],
    edges: [],
    exports: [],
    next_id: 0
  ]

  def new(file) do
    %__MODULE__{
      file: file,
      module_id: "#{file}->MODULE->unknown"
    }
  end

  def add_node(ctx, node) do
    %{ctx | nodes: [node | ctx.nodes]}
  end

  @doc """
  Merge additional metadata into a node identified by `id`. No-op if the
  node is not found. Used by REG-1098 W5 to attach wrapper info to a
  FUNCTION node after it has already been added.
  """
  def merge_node_metadata(ctx, id, extra) when is_map(extra) do
    nodes =
      Enum.map(ctx.nodes, fn
        %{id: ^id, metadata: meta} = node -> %{node | metadata: Map.merge(meta || %{}, extra)}
        other -> other
      end)

    %{ctx | nodes: nodes}
  end

  def add_edge(ctx, edge) do
    %{ctx | edges: [edge | ctx.edges]}
  end

  def add_export(ctx, export) do
    %{ctx | exports: [export | ctx.exports]}
  end

  def push_scope(ctx, scope) do
    %{ctx | scope_stack: [scope | ctx.scope_stack]}
  end

  def pop_scope(ctx) do
    %{ctx | scope_stack: tl(ctx.scope_stack)}
  end

  def current_scope(ctx) do
    case ctx.scope_stack do
      [scope | _] -> scope
      [] -> nil
    end
  end

  def set_module(ctx, module_name) do
    module_id = "#{ctx.file}->MODULE->#{module_name}"
    %{ctx | module_name: module_name, module_id: module_id}
  end
end
