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
    next_id: 0,
    # Variable names that are bound to `self()` in the current scope.
    # Used to promote `send(me, msg)` / `Process.send_after(me, ...)`
    # into self-directed sends when `me = self()` was seen earlier in
    # the same function body. Reset on every function-body entry.
    self_aliases: MapSet.new()
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

  @doc """
  Mark a variable name as a `self()` alias for the remainder of the
  current function body. Used by the walker when it sees
  `me = self()` so later `send(me, ...)` sites know their target is
  this process.
  """
  def add_self_alias(ctx, name) when is_atom(name) do
    %{ctx | self_aliases: MapSet.put(ctx.self_aliases, name)}
  end

  def add_self_alias(ctx, _), do: ctx

  def self_alias?(ctx, name) when is_atom(name) do
    MapSet.member?(ctx.self_aliases, name)
  end

  def self_alias?(_, _), do: false

  @doc """
  Drop every tracked self-alias. Called on function-body entry so one
  function's `me = self()` binding doesn't leak into a sibling.
  """
  def reset_self_aliases(ctx) do
    %{ctx | self_aliases: MapSet.new()}
  end
end
