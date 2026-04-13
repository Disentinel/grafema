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
  def process_call(ctx, call_name, call_id, line, col, args \\ nil) do
    ctx = detect_process_spawn(ctx, call_name, call_id, line, col)
    ctx = detect_message_send(ctx, call_name, call_id, args)
    ctx
  end

  @doc """
  Process a FUNCTION node to detect handle_* callbacks.
  Called after a FUNCTION node is created.

  `first_arg` is the first parameter AST fragment (the message pattern for
  handle_call/cast/info clauses). Used by REG-1098 W2 to extract per-clause
  MESSAGE_TYPE nodes with `pattern_shape` metadata. `meta` carries the
  clause's line/column for unique node IDs.
  """
  def process_function(ctx, func_name, func_id, first_arg \\ nil, meta \\ [], body \\ nil) do
    detect_handler(ctx, func_name, func_id, first_arg, meta, body)
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

  defp detect_message_send(ctx, call_name, call_id, args) do
    base_call = extract_base_call(call_name)

    if base_call in @message_senders do
      # Try to resolve target process
      target = resolve_message_target(ctx)

      if target != nil do
        # REG-1098 W3: extract normalized shape of the message argument.
        # For GenServer.call/cast/Process.send/send: message is the 2nd arg.
        message_shape_meta = extract_message_shape(args)

        metadata =
          if message_shape_meta do
            %{via: base_call, message_shape: message_shape_meta}
          else
            %{via: base_call}
          end

        Context.add_edge(ctx, %{
          src: call_id,
          dst: target,
          type: "SENDS_TO",
          metadata: metadata
        })
      else
        ctx
      end
    else
      ctx
    end
  end

  defp extract_message_shape(args) when is_list(args) do
    case Enum.at(args, 1) do
      nil -> nil
      msg_ast ->
        msg_ast
        |> BeamAnalyzer.Rules.Patterns.normalize()
        |> BeamAnalyzer.Rules.Patterns.shape_to_meta()
    end
  end

  defp extract_message_shape(_), do: nil

  defp detect_handler(ctx, func_name, func_id, first_arg, meta, body) do
    # Detect handle_call, handle_cast, handle_info callbacks
    cond do
      String.starts_with?(func_name, "handle_call/") ->
        add_handler_edge(ctx, func_id, "call", first_arg, meta, body)

      String.starts_with?(func_name, "handle_cast/") ->
        add_handler_edge(ctx, func_id, "cast", first_arg, meta, body)

      String.starts_with?(func_name, "handle_info/") ->
        add_handler_edge(ctx, func_id, "info", first_arg, meta, body)

      String.starts_with?(func_name, "handle_continue/") ->
        add_handler_edge(ctx, func_id, "continue", first_arg, meta, body)

      String.starts_with?(func_name, "handle_event/") ->
        add_handler_edge(ctx, func_id, "event", first_arg, meta, body)

      true ->
        ctx
    end
  end

  defp add_handler_edge(ctx, func_id, handler_type, first_arg, meta, body) do
    module_name = ctx.module_name || "unknown"
    line = Keyword.get(meta, :line, 0)
    col = Keyword.get(meta, :column, 0)

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

        # Per-clause MESSAGE_TYPE node — id includes line/column so multi-clause
        # handlers produce distinct nodes (REG-1098 W2).
        shape = BeamAnalyzer.Rules.Patterns.normalize(first_arg)
        shape_meta = BeamAnalyzer.Rules.Patterns.shape_to_meta(shape)
        catchall? = catchall_pattern?(first_arg)

        # REG-1098 W8: per-clause body scanning for silent_handler finding.
        {body_total_calls, body_effects} = BeamAnalyzer.Rules.Effects.scan(body)

        msg_id =
          "#{ctx.file}->MESSAGE_TYPE->#{handler_type}[in:#{module_name}][L:#{line}:#{col}]"

        msg_node = %{
          id: msg_id,
          type: "MESSAGE_TYPE",
          name: handler_type,
          file: ctx.file,
          line: line,
          column: col,
          endLine: 0,
          endColumn: 0,
          exported: false,
          metadata: %{
            handler_function: func_id,
            pattern_shape: shape_meta,
            catchall: catchall?,
            handler_line: line,
            body_total_calls: body_total_calls,
            body_effects: body_effects
          }
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

  # Catch-all pattern: bare variable, wildcard, or guarded bare variable.
  # Note: guarded catchalls (e.g. `msg when is_atom(msg)`) are conservatively
  # marked catchall=true — the guard narrows but we don't evaluate guards.
  defp catchall_pattern?(nil), do: false
  defp catchall_pattern?({:_, _, _}), do: true
  defp catchall_pattern?({name, _, ctx}) when is_atom(name) and is_atom(ctx), do: true
  defp catchall_pattern?({:when, _, [inner, _]}), do: catchall_pattern?(inner)
  defp catchall_pattern?({:=, _, [l, r]}), do: catchall_pattern?(l) or catchall_pattern?(r)
  defp catchall_pattern?(_), do: false

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
