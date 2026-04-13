defmodule BeamAnalyzer.Rules.Effects do
  @moduledoc """
  Scans a function body AST for two counters used by REG-1098 W8:

    * `total_calls` — any function call node in the body (local or remote)
    * `effects`    — names of calls that match a known effect allowlist

  Used for the `silent_handler` finding in W9: a handle_cast/info clause
  with `total_calls == 0` on a non-trivial tagged message is a black
  hole for that message.

  Local helper functions called from the body do NOT propagate their
  effects transitively — this is a deliberate simplification. W9 keys
  off `total_calls` not `effects`, so undetected transitive effects
  only inflate `total_calls`, never falsely mark a handler as silent.
  """

  @effect_calls [
    "GenServer.call", "GenServer.cast", "GenServer.reply", "GenServer.multi_call",
    "Process.send", "Process.send_after",
    "Phoenix.PubSub.broadcast", "Phoenix.PubSub.broadcast!",
    "Phoenix.PubSub.broadcast_from", "Phoenix.PubSub.local_broadcast",
    "Logger.debug", "Logger.info", "Logger.warning", "Logger.warn", "Logger.error",
    "IO.puts", "IO.write", "IO.inspect", "IO.binwrite",
    "File.write", "File.write!", "File.read", "File.read!", "File.mkdir_p",
    "File.mkdir_p!", "File.rm", "File.rm!", "File.touch", "File.cp", "File.cp_r",
    "Task.start", "Task.start_link", "Task.async", "Task.async_stream",
    "Process.exit",
    "Req.get", "Req.get!", "Req.post", "Req.post!", "Req.request", "Req.request!"
  ]

  @effect_bare [:send, :spawn, :spawn_link, :spawn_monitor, :raise, :throw, :exit]

  @doc """
  Walk a body AST and return `{total_calls, effects}` where effects is a
  deduplicated sorted list of effect call names.
  """
  @spec scan(any()) :: {non_neg_integer(), [String.t()]}
  def scan(nil), do: {0, []}

  def scan(body) do
    {_, {total, effects}} =
      Macro.prewalk(body, {0, []}, fn
        {{:., _, [{:__aliases__, _, parts}, fname]}, _, _args} = node, {c, eff}
        when is_atom(fname) and is_list(parts) ->
          name =
            (parts |> Enum.map(&Atom.to_string/1) |> Enum.join(".")) <>
              "." <> Atom.to_string(fname)

          new_eff = if name in @effect_calls, do: [name | eff], else: eff
          {node, {c + 1, new_eff}}

        {name, _, args} = node, {c, eff}
        when is_atom(name) and is_list(args) ->
          cond do
            not callable?(name) ->
              {node, {c, eff}}

            name in @effect_bare ->
              {node, {c + 1, [Atom.to_string(name) | eff]}}

            true ->
              {node, {c + 1, eff}}
          end

        node, acc ->
          {node, acc}
      end)

    {total, effects |> Enum.uniq() |> Enum.sort()}
  end

  # Duplicated from `BeamAnalyzer.Rules.Calls.callable?/1` to avoid a
  # circular rule-module dependency. Keep the two lists in sync if Calls
  # gains new entries. REG-1098 W8 — deduplication deferred to follow-up.
  @non_callable MapSet.new([
    :., :{}, :%{}, :%, :__aliases__, :__block__, :__MODULE__, :__ENV__, :__CALLER__,
    :fn, :&, :quote, :unquote, :unquote_splicing, :alias, :require, :import,
    :def, :defp, :defmodule, :defmacro, :defmacrop, :defguard, :defguardp,
    :defprotocol, :defimpl, :defstruct, :defexception, :defdelegate, :defoverridable,
    :case, :cond, :if, :unless, :with, :for, :receive, :try, :rescue, :catch,
    :else, :after, :do, :end, :=, :^, :when, :->, :|, :|>,
    :+, :-, :*, :/, :div, :rem,
    :==, :!=, :===, :!==, :=~, :<, :>, :<=, :>=,
    :and, :or, :not, :&&, :||, :!, :in,
    :<>, :++, :--, :<<>>, :@, :"::"
  ])

  defp callable?(name) when is_atom(name) do
    cond do
      MapSet.member?(@non_callable, name) -> false
      String.starts_with?(Atom.to_string(name), "sigil_") -> false
      true -> true
    end
  end
end
