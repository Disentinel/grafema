defmodule BeamAnalyzer.Rules.Infrastructure do
  @moduledoc """
  Detects BEAM infrastructure patterns in code.

  New node types:
  - PROCESS — from GenServer.start_link, Agent.start_link, Task.start, etc.
  - SUPERVISION_TREE — from Supervisor.init(children, strategy:)
  - MESSAGE_TYPE — from handle_call/cast/info pattern heads

  New edge types:
  - SPAWNS: CALL(start_link) → PROCESS
  - HANDLES_IN: FUNCTION(handle_*) → PROCESS
  - SENDS_TO: CALL(GenServer.call/cast) → PROCESS
  - SUPERVISES: PROCESS(supervisor) → PROCESS(child)
  """

  alias BeamAnalyzer.Context

  @process_starters [
    "GenServer.start_link",
    "GenServer.start",
    "Agent.start_link",
    "Agent.start",
    "Task.start",
    "Task.start_link",
    "Task.async",
    "Task.Supervisor.start_child",
    "Supervisor.start_link",
    "DynamicSupervisor.start_child",
    "DynamicSupervisor.start_link"
  ]

  @message_senders [
    "GenServer.call",
    "GenServer.cast",
    "Process.send",
    "send"
  ]

  @doc """
  Process a CALL node to detect infrastructure patterns.
  Called from the walker after a CALL node is created.
  """
  def process_call(ctx, call_name, call_id, line, col) do
    ctx = detect_process_spawn(ctx, call_name, call_id, line, col)
    ctx = detect_message_send(ctx, call_name, call_id)
    ctx
  end

  @doc """
  Process a FUNCTION node to detect handle_* callbacks.
  Called after a FUNCTION node is created.
  """
  def process_function(ctx, func_name, func_id) do
    detect_handler(ctx, func_name, func_id)
  end

  @doc """
  Process supervisor init to detect supervision tree.
  Looks for Supervisor.init(children, strategy:) calls.
  """
  def process_supervisor_init(ctx, _call_id, line, col) do
    module_name = ctx.module_name || "unknown"

    tree_id = "#{ctx.file}->SUPERVISION_TREE->#{module_name}[h:#{line}:#{col}]"

    node = %{
      id: tree_id,
      type: "SUPERVISION_TREE",
      name: module_name,
      file: ctx.file,
      line: line,
      column: col,
      endLine: 0,
      endColumn: 0,
      exported: false,
      metadata: %{language: "elixir"}
    }

    ctx = Context.add_node(ctx, node)

    # CONTAINS edge from MODULE to SUPERVISION_TREE
    Context.add_edge(ctx, %{
      src: ctx.module_id,
      dst: tree_id,
      type: "CONTAINS",
      metadata: %{}
    })
  end

  # -- Private helpers --

  defp detect_process_spawn(ctx, call_name, call_id, line, col) do
    base_call = extract_base_call(call_name)

    if base_call in @process_starters do
      # Try to resolve the process name
      process_name = resolve_process_name(ctx, call_name)
      process_id = "#{ctx.file}->PROCESS->#{process_name}[h:#{line}:#{col}]"

      node = %{
        id: process_id,
        type: "PROCESS",
        name: process_name,
        file: ctx.file,
        line: line,
        column: col,
        endLine: 0,
        endColumn: 0,
        exported: false,
        metadata: %{
          language: "elixir",
          starter: base_call,
          resolution: if(process_name == "dynamic", do: "dynamic_pid", else: "static_name")
        }
      }

      ctx = Context.add_node(ctx, node)

      # SPAWNS edge from the call to the process
      ctx = Context.add_edge(ctx, %{
        src: call_id,
        dst: process_id,
        type: "SPAWNS",
        metadata: %{}
      })

      # If this is a Supervisor.start_link, it's also a supervision tree root
      if String.contains?(base_call, "Supervisor") do
        process_supervisor_init(ctx, call_id, line, col)
      else
        ctx
      end
    else
      ctx
    end
  end

  defp detect_message_send(ctx, call_name, call_id) do
    base_call = extract_base_call(call_name)

    if base_call in @message_senders do
      # Try to resolve target process
      target = resolve_message_target(ctx)

      if target != nil do
        # SENDS_TO edge from call to target process
        Context.add_edge(ctx, %{
          src: call_id,
          dst: target,
          type: "SENDS_TO",
          metadata: %{via: base_call}
        })
      else
        ctx
      end
    else
      ctx
    end
  end

  defp detect_handler(ctx, func_name, func_id) do
    # Detect handle_call, handle_cast, handle_info callbacks
    cond do
      String.starts_with?(func_name, "handle_call/") ->
        add_handler_edge(ctx, func_id, "call")

      String.starts_with?(func_name, "handle_cast/") ->
        add_handler_edge(ctx, func_id, "cast")

      String.starts_with?(func_name, "handle_info/") ->
        add_handler_edge(ctx, func_id, "info")

      String.starts_with?(func_name, "handle_continue/") ->
        add_handler_edge(ctx, func_id, "continue")

      String.starts_with?(func_name, "handle_event/") ->
        add_handler_edge(ctx, func_id, "event")

      true ->
        ctx
    end
  end

  defp add_handler_edge(ctx, func_id, handler_type) do
    module_name = ctx.module_name || "unknown"

    # Look for a PROCESS node in this module
    process_nodes =
      Enum.filter(ctx.nodes, fn node ->
        node.type == "PROCESS" and node.file == ctx.file
      end)

    case process_nodes do
      [process | _] ->
        # HANDLES_IN edge from handler function to process
        ctx = Context.add_edge(ctx, %{
          src: func_id,
          dst: process.id,
          type: "HANDLES_IN",
          metadata: %{handler_type: handler_type}
        })

        # Create MESSAGE_TYPE node for the handler pattern
        msg_id = "#{ctx.file}->MESSAGE_TYPE->#{handler_type}[in:#{module_name}]"

        msg_node = %{
          id: msg_id,
          type: "MESSAGE_TYPE",
          name: handler_type,
          file: ctx.file,
          line: 0,
          column: 0,
          endLine: 0,
          endColumn: 0,
          exported: false,
          metadata: %{handler_function: func_id}
        }

        ctx = Context.add_node(ctx, msg_node)

        # RECEIVES edge from process to message type
        Context.add_edge(ctx, %{
          src: process.id,
          dst: msg_id,
          type: "RECEIVES",
          metadata: %{}
        })

      [] ->
        ctx
    end
  end

  defp extract_base_call(call_name) do
    # Remove arity info if present: "GenServer.start_link/3" -> "GenServer.start_link"
    case String.split(call_name, "/") do
      [base | _] -> base
      _ -> call_name
    end
  end

  defp resolve_process_name(ctx, call_name) do
    # Convention-based resolution:
    # 1. If call includes __MODULE__, use current module name
    # 2. Otherwise, default to module name for self-registering GenServers
    # 3. Fallback to "dynamic"
    cond do
      String.contains?(call_name, "__MODULE__") ->
        ctx.module_name || "unknown"

      true ->
        ctx.module_name || "dynamic"
    end
  end

  defp resolve_message_target(ctx) do
    # Convention-based: GenServer.call(__MODULE__, ...) -> self module's process
    # Look for a PROCESS node in this module
    process = Enum.find(ctx.nodes, fn node ->
      node.type == "PROCESS" and node.file == ctx.file
    end)

    case process do
      nil -> nil
      p -> p.id
    end
  end
end
