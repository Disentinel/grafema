defmodule BeamAnalyzer.Rules.StateDFG do
  @moduledoc """
  Extract GenServer state field reads/writes from a handler-clause or
  `init/1` body.

  Gives the graph enough structure to answer semantic-state questions
  that message-shape analysis alone cannot:
  - which fields can a handler mutate?
  - which fields are read by a guard that gates work?
  - are there fields only written by `init/1` and then used as a
    conditional elsewhere (permanent-state trap)?

  Recognised write forms (the state variable is conservatively matched
  by name; the common convention `def handle_*(msg, _from, state)` is
  assumed):
    %{state | field: value}                 # map update
    %StructName{state | field: value}       # struct update
    Map.put(state, :field, value)
    Map.put_new(state, :field, value)
    Map.delete(state, :field)
    Map.update(state, :field, default, fun)
    Map.update!(state, :field, fun)
    Map.replace!(state, :field, value)

  Recognised guard-read forms (field access in a position that drives
  control flow):
    if state.field do / if state.field, do: ...
    unless state.field do
    case state.field do
    case Map.get(state, :field) do

  Tuple-shaped updates returned from a handler
  (`{:reply, _, %{state | field: _}}`, `{:noreply, %{state | ...}}`)
  are walked transparently because the outer Macro.prewalk descends
  into every sub-term.

  What's intentionally out of scope for v1:
    - Value tracking. We record only field *names*, not what they're
      set to. A follow-up can attach a Patterns.normalize/1 shape per
      (field, write-site).
    - State variable aliasing (`new_state = %{state | ...}`).
    - Nested field paths (`state.inner.field`).
    - `for`/`reduce` accumulators that rebuild the map.
  """

  @doc """
  Walk an AST fragment and return `{writes, guards}` where each entry
  is a sorted, deduplicated list of field-name strings.
  """
  def extract(nil), do: {[], []}

  def extract(ast) do
    {_, acc} =
      Macro.prewalk(ast, {MapSet.new(), MapSet.new()}, fn node, acc ->
        {node, check_node(node, acc)}
      end)

    {writes, guards} = acc
    {sorted(writes), sorted(guards)}
  end

  @doc """
  Extract the set of state fields set by an `init/1` body. Unlike a
  handler body, `init/1` builds state from scratch — the initial
  state is a *literal* map or struct (`%{...}`, `%__MODULE__{...}`,
  `%Other{...}`) — not an update against an existing `state` var.

  We collect the keys of every map/struct literal we find during a
  prewalk. This can over-capture if init calls a helper that builds
  auxiliary maps, but init bodies are usually short and single-
  purpose, so the noise is acceptable. The alternative — walking
  only the init return position — misses the common
  `state = %{...}; ...; {:ok, state}` pattern.

  Returns a sorted, deduplicated list of field-name strings.
  """
  def extract_init_writes(nil), do: []

  def extract_init_writes(ast) do
    {_, writes} =
      Macro.prewalk(ast, MapSet.new(), fn node, acc ->
        {node, check_init_node(node, acc)}
      end)

    sorted(writes)
  end

  # Map literal `%{k: v, ...}` but NOT an update `%{state | k: v}`
  defp check_init_node({:%{}, _, kv_list}, acc) when is_list(kv_list) do
    if map_update?(kv_list) do
      acc
    else
      put_keys(acc, kv_list)
    end
  end

  # Struct literal `%Struct{k: v, ...}` but NOT an update `%Struct{state | k: v}`
  defp check_init_node({:%, _, [_name, {:%{}, _, kv_list}]}, acc) when is_list(kv_list) do
    if map_update?(kv_list) do
      acc
    else
      put_keys(acc, kv_list)
    end
  end

  defp check_init_node(_, acc), do: acc

  defp map_update?([{:|, _, _} | _]), do: true
  defp map_update?(_), do: false

  defp put_keys(acc, kv_list) do
    Enum.reduce(kv_list, acc, fn
      {k, _v}, a when is_atom(k) -> MapSet.put(a, Atom.to_string(k))
      _, a -> a
    end)
  end

  defp sorted(set), do: set |> MapSet.to_list() |> Enum.sort()

  # ── WRITES ─────────────────────────────────────────────────────────

  # %{state | key: value, ...}
  defp check_node(
         {:%{}, _, [{:|, _, [{:state, _, ctx}, kv_list]}]},
         acc
       )
       when is_atom(ctx) and is_list(kv_list) do
    put_many(acc, :writes, kv_keys(kv_list))
  end

  # %Struct{state | key: value, ...}
  defp check_node(
         {:%, _, [_struct_name, {:%{}, _, [{:|, _, [{:state, _, ctx}, kv_list]}]}]},
         acc
       )
       when is_atom(ctx) and is_list(kv_list) do
    put_many(acc, :writes, kv_keys(kv_list))
  end

  # Map.<op>(state, :field, ...)
  defp check_node(
         {{:., _, [{:__aliases__, _, [:Map]}, op]}, _, [{:state, _, ctx}, key | _]},
         acc
       )
       when is_atom(ctx) and is_atom(key) and
              op in [:put, :put_new, :delete, :update, :update!, :replace!] do
    put_one(acc, :writes, Atom.to_string(key))
  end

  # ── GUARDS ─────────────────────────────────────────────────────────

  # if / unless — first arg is the condition
  defp check_node({kind, _, [cond_ast | _rest]}, acc) when kind in [:if, :unless] do
    maybe_record_guard(cond_ast, acc)
  end

  # case — first arg is the scrutinee
  defp check_node({:case, _, [scrutinee | _]}, acc) do
    maybe_record_guard(scrutinee, acc)
  end

  defp check_node(_, acc), do: acc

  # Direct `state.field` field access in guard position
  defp maybe_record_guard({{:., _, [{:state, _, ctx}, field]}, _, []}, acc)
       when is_atom(ctx) and is_atom(field) do
    put_one(acc, :guards, Atom.to_string(field))
  end

  # `Map.get(state, :field)` — common alternative to state.field
  defp maybe_record_guard(
         {{:., _, [{:__aliases__, _, [:Map]}, :get]}, _, [{:state, _, ctx}, key | _]},
         acc
       )
       when is_atom(ctx) and is_atom(key) do
    put_one(acc, :guards, Atom.to_string(key))
  end

  defp maybe_record_guard(_, acc), do: acc

  # ── Helpers ────────────────────────────────────────────────────────

  defp kv_keys(kv_list) do
    for {k, _v} <- kv_list, is_atom(k), do: Atom.to_string(k)
  end

  defp put_one({w, g}, :writes, field), do: {MapSet.put(w, field), g}
  defp put_one({w, g}, :guards, field), do: {w, MapSet.put(g, field)}

  defp put_many(acc, tag, fields), do: Enum.reduce(fields, acc, &put_one(&2, tag, &1))
end
