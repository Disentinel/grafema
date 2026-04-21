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
    "Process.send_after",
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
      # REG-1098 W3: extract normalized shape of the message argument.
      # For GenServer.call/cast/Process.send/Process.send_after/send: msg is
      # the 2nd arg; target is the 1st.
      message_shape_meta = extract_message_shape(args)
      target_is_self = self_target?(args, ctx)
      target_hint = explicit_target_hint(args, ctx)
      sender_via = sender_handler_type(base_call)

      # Enrich CALL node metadata so the cross-file resolver can match
      # this send-site against MESSAGE_TYPE nodes without needing to
      # read edges (resolver API is nodes-only). The SENDS_TO edge
      # itself still points at the PROCESS for coarse linking.
      call_extras =
        %{
          sender_via: sender_via,
          sender_base: base_call,
          target_is_self: target_is_self
        }
        |> maybe_put(:message_shape, message_shape_meta)
        |> maybe_put(:target_hint, target_hint)

      ctx = Context.merge_node_metadata(ctx, call_id, call_extras)

      target = resolve_message_target(ctx)

      if target != nil do
        edge_metadata =
          %{via: base_call, target_is_self: target_is_self}
          |> maybe_put(:message_shape, message_shape_meta)

        Context.add_edge(ctx, %{
          src: call_id,
          dst: target,
          type: "SENDS_TO",
          metadata: edge_metadata
        })
      else
        ctx
      end
    else
      ctx
    end
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  # GenServer.call/cast correspond to handle_call / handle_cast.
  # send / Process.send / Process.send_after all land in handle_info.
  defp sender_handler_type("GenServer.call"), do: "call"
  defp sender_handler_type("GenServer.cast"), do: "cast"
  defp sender_handler_type(_), do: "info"

  # The first argument of every message sender is the target. We flag
  # sends whose target is statically knowable to be the current module —
  # `self()`, `__MODULE__`, or a literal alias matching `ctx.module_name`.
  # This powers SELF_SCHEDULE classification in the resolver.
  defp self_target?(args, ctx) when is_list(args) do
    case Enum.at(args, 0) do
      # `self()` — zero-arg Kernel call, AST is `{:self, meta, []}`.
      {:self, _, []} -> true
      # Bare `self` variable (unusual but legal) — 3rd elem is the ctx atom.
      {:self, _, ctx_atom} when is_atom(ctx_atom) -> true
      {:__MODULE__, _, _} -> true
      {:__aliases__, _, parts} when is_list(parts) ->
        alias_matches_module?(parts, ctx.module_name)

      # Bare variable whose binding is `self()` earlier in the body —
      # e.g. `me = self(); send(me, :tick)`. Covered by the walker's
      # self-alias tracking in `track_self_binding/3`.
      {name, _, ctx_atom} when is_atom(name) and is_atom(ctx_atom) ->
        Context.self_alias?(ctx, name)

      _ ->
        false
    end
  end

  defp self_target?(_, _), do: false

  defp alias_matches_module?(_parts, nil), do: false

  defp alias_matches_module?(parts, module_name) do
    joined = parts |> Enum.map(&Atom.to_string/1) |> Enum.join(".")
    joined == module_name
  end

  # Returns the fully-qualified module name a send is addressed to when
  # we can read it from the AST (`OtherModule` / `__MODULE__`). Returns
  # nil for dynamic PIDs (bare variables, function-call results) — the
  # resolver cannot match those statically.
  defp explicit_target_hint(args, ctx) when is_list(args) do
    case Enum.at(args, 0) do
      {:__MODULE__, _, _} -> ctx.module_name
      {:__aliases__, _, parts} when is_list(parts) ->
        parts |> Enum.map(&Atom.to_string/1) |> Enum.join(".")

      _ ->
        nil
    end
  end

  defp explicit_target_hint(_, _), do: nil

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
        shape_label = BeamAnalyzer.Rules.Patterns.describe_shape(shape)
        catchall? = catchall_pattern?(first_arg)

        # REG-1098 W8: per-clause body scanning for silent_handler finding.
        {body_total_calls, body_effects} = BeamAnalyzer.Rules.Effects.scan(body)

        msg_id =
          "#{ctx.file}->MESSAGE_TYPE->#{handler_type}[in:#{module_name}][L:#{line}:#{col}]"

        msg_node = %{
          id: msg_id,
          type: "MESSAGE_TYPE",
          name: "#{handler_type}:#{shape_label}",
          file: ctx.file,
          line: line,
          column: col,
          endLine: 0,
          endColumn: 0,
          exported: false,
          metadata: %{
            handler_type: handler_type,
            handler_function: func_id,
            pattern_shape: shape_meta,
            shape_label: shape_label,
            catchall: catchall?,
            handler_line: line,
            body_total_calls: body_total_calls,
            body_effects: body_effects
          }
        }

        ctx = Context.add_node(ctx, msg_node)

        # RECEIVES edge from process to message type
        ctx = Context.add_edge(ctx, %{
          src: process.id,
          dst: msg_id,
          type: "RECEIVES",
          metadata: %{}
        })

        # Activate handler-clause scope so CALL / BRANCH / LOOP nodes
        # emitted by the walker while descending into this def's body
        # are automatically CONTAINed by this MESSAGE_TYPE. The caller
        # (Rules.Functions.process_function/6) clears the scope after
        # walk_body so the next sibling def starts fresh.
        Context.set_handler_clause(ctx, msg_id)

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
