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
  Walk an AST fragment and return `%{writes, writes_truthy, writes_falsy,
  guards, guards_truthy}` where each entry is a sorted, deduplicated
  list of field-name strings.

  * `:writes` — every field written against the `state` variable, any
    value. Use this for "does anything write X at all?" questions.
  * `:writes_truthy` — subset of `:writes` where the RHS is a literal
    value Elixir would treat as truthy (any atom except `false` and
    `nil`, any number, binary, list, tuple — anything that isn't
    `false`/`nil`). Only literals we can syntactically confirm are
    truthy land here; dynamic expressions stay in `:writes`.
  * `:writes_falsy` — subset of `:writes` where the RHS is a literal
    `false` or `nil`.
  * `:writes_dynamic` — subset of `:writes` where the RHS is NOT a
    compile-time literal — a variable, a function-call result, an
    expression. A Datalog rule can use the absence of this set to
    conclude "every writer is literal-classified," which is a
    prerequisite for "always falsy / always truthy" analysis.
  * `:uses` — every field read anywhere in the body, including
    guards, call arguments, return values, and string interpolations
    (`"tag: \#{state.foo}"`). Superset of `:guards`. Lets a rule
    distinguish "field is written but never read at all" (dead
    ballast) from "field is read, just not gated on".
  * `:guards` — every field read in a conditional scrutinee
    (`if`/`unless`/`case`). Use this for "does anything gate on X?".
  * `:guards_truthy` — subset of `:guards` where the guard is an
    explicit truthy test (`if state.X do` / `unless state.X`).
    Needed for the "always-falsy / always-truthy" Datalog rules
    because those tests can only be judged dead when paired with
    literal-value writers.
  """
  def extract(nil), do: empty_result()

  def extract(ast) do
    acc0 = %{
      writes: MapSet.new(),
      writes_truthy: MapSet.new(),
      writes_falsy: MapSet.new(),
      writes_dynamic: MapSet.new(),
      guards: MapSet.new(),
      guards_truthy: MapSet.new(),
      uses: MapSet.new()
    }

    {_, acc} =
      Macro.prewalk(ast, acc0, fn node, acc ->
        {node, check_node(node, acc)}
      end)

    finalize(acc)
  end

  defp empty_result do
    %{
      writes: [],
      writes_truthy: [],
      writes_falsy: [],
      writes_dynamic: [],
      guards: [],
      guards_truthy: [],
      uses: []
    }
  end

  defp finalize(%{} = acc) do
    acc
    |> Map.new(fn {k, set} -> {k, sorted(set)} end)
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
    extract_init(ast) |> Map.fetch!(:writes)
  end

  @doc """
  Like `extract/1` but for an `init/1` body. The result shape is
  `%{writes, writes_truthy, writes_falsy}` — guards are not
  applicable for init. Walks every map / struct *literal* (keys
  and their RHS values) to classify each initial field as truthy
  or falsy when the RHS is a compile-time literal.
  """
  def extract_init(nil) do
    %{writes: [], writes_truthy: [], writes_falsy: [], writes_dynamic: []}
  end

  def extract_init(ast) do
    acc0 = %{
      writes: MapSet.new(),
      writes_truthy: MapSet.new(),
      writes_falsy: MapSet.new(),
      writes_dynamic: MapSet.new()
    }

    {_, acc} =
      Macro.prewalk(ast, acc0, fn node, acc ->
        {node, check_init_node(node, acc)}
      end)

    %{
      writes: sorted(acc.writes),
      writes_truthy: sorted(acc.writes_truthy),
      writes_falsy: sorted(acc.writes_falsy),
      writes_dynamic: sorted(acc.writes_dynamic)
    }
  end

  # Map literal `%{k: v, ...}` but NOT an update `%{state | k: v}`
  defp check_init_node({:%{}, _, kv_list}, acc) when is_list(kv_list) do
    if map_update?(kv_list) do
      acc
    else
      record_literal_kv_writes(acc, kv_list)
    end
  end

  # Struct literal `%Struct{k: v, ...}` but NOT an update `%Struct{state | k: v}`
  defp check_init_node({:%, _, [_name, {:%{}, _, kv_list}]}, acc) when is_list(kv_list) do
    if map_update?(kv_list) do
      acc
    else
      record_literal_kv_writes(acc, kv_list)
    end
  end

  defp check_init_node(_, acc), do: acc

  defp map_update?([{:|, _, _} | _]), do: true
  defp map_update?(_), do: false

  defp record_literal_kv_writes(acc, kv_list) do
    Enum.reduce(kv_list, acc, fn
      {k, v}, a when is_atom(k) ->
        field = Atom.to_string(k)

        case classify_value(v) do
          :truthy -> a |> put_one(:writes, field) |> put_one(:writes_truthy, field)
          :falsy -> a |> put_one(:writes, field) |> put_one(:writes_falsy, field)
          :unknown -> a |> put_one(:writes, field) |> put_one(:writes_dynamic, field)
        end

      _, a ->
        a
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
    record_kv_writes(acc, kv_list)
  end

  # %Struct{state | key: value, ...}
  defp check_node(
         {:%, _, [_struct_name, {:%{}, _, [{:|, _, [{:state, _, ctx}, kv_list]}]}]},
         acc
       )
       when is_atom(ctx) and is_list(kv_list) do
    record_kv_writes(acc, kv_list)
  end

  # Map.put(state, :field, value) / Map.put_new / Map.replace!
  defp check_node(
         {{:., _, [{:__aliases__, _, [:Map]}, op]}, _, [{:state, _, ctx}, key, value]},
         acc
       )
       when is_atom(ctx) and is_atom(key) and
              op in [:put, :put_new, :replace!] do
    record_value_write(acc, Atom.to_string(key), value)
  end

  # Map.delete(state, :field) — field becomes absent; a subsequent
  # `state.field` / `Map.get(state, :field)` returns `nil`, which
  # Elixir treats as falsy. Classify accordingly so "always-falsy"
  # analysis sees deletes as falsy writes.
  defp check_node(
         {{:., _, [{:__aliases__, _, [:Map]}, :delete]}, _, [{:state, _, ctx}, key]},
         acc
       )
       when is_atom(ctx) and is_atom(key) do
    field = Atom.to_string(key)
    acc |> put_one(:writes, field) |> put_one(:writes_falsy, field)
  end

  # Map.update / Map.update! — writer whose new value comes from a
  # fn applied to the old; conservatively :dynamic.
  defp check_node(
         {{:., _, [{:__aliases__, _, [:Map]}, op]}, _, [{:state, _, ctx}, key | _]},
         acc
       )
       when is_atom(ctx) and is_atom(key) and op in [:update, :update!] do
    field = Atom.to_string(key)
    acc |> put_one(:writes, field) |> put_one(:writes_dynamic, field)
  end

  # ── GUARDS ─────────────────────────────────────────────────────────

  # if / unless — first arg is the condition. These are truthy-tests
  # (except when the condition is a full expression like `state.X == :foo`).
  defp check_node({kind, _, [cond_ast | _rest]}, acc) when kind in [:if, :unless] do
    maybe_record_guard(cond_ast, acc, :truthy)
  end

  # case — first arg is the scrutinee. Not a pure truthy test.
  defp check_node({:case, _, [scrutinee | _]}, acc) do
    maybe_record_guard(scrutinee, acc, :plain)
  end

  # Any bare `state.field` access anywhere in the body — captures
  # reads used as data (call arguments, return values, string
  # interpolations) in addition to the guard-position reads above.
  # Matches the Elixir AST of `state.field`:
  #   {{:., _, [{:state, _, ctx}, field]}, _, []}
  # Excludes the `state` variable itself (no method name).
  defp check_node({{:., _, [{:state, _, ctx}, field]}, _, []}, acc)
       when is_atom(ctx) and is_atom(field) do
    put_one(acc, :uses, Atom.to_string(field))
  end

  # `Map.get(state, :field, ...)` — also a read, even outside a
  # guard scrutinee.
  defp check_node(
         {{:., _, [{:__aliases__, _, [:Map]}, :get]}, _, [{:state, _, ctx}, key | _]},
         acc
       )
       when is_atom(ctx) and is_atom(key) do
    put_one(acc, :uses, Atom.to_string(key))
  end

  # `Map.fetch!(state, :field)` / `Map.fetch(state, :field)`
  defp check_node(
         {{:., _, [{:__aliases__, _, [:Map]}, op]}, _, [{:state, _, ctx}, key]},
         acc
       )
       when is_atom(ctx) and is_atom(key) and op in [:fetch, :fetch!, :has_key?] do
    put_one(acc, :uses, Atom.to_string(key))
  end

  defp check_node(_, acc), do: acc

  # `state.field` directly in guard position — this IS a truthy test
  # when seen under `if/unless`.
  defp maybe_record_guard({{:., _, [{:state, _, ctx}, field]}, _, []}, acc, kind)
       when is_atom(ctx) and is_atom(field) do
    record_guard(acc, Atom.to_string(field), kind)
  end

  # `Map.get(state, :field)` — common alternative.
  defp maybe_record_guard(
         {{:., _, [{:__aliases__, _, [:Map]}, :get]}, _, [{:state, _, ctx}, key | _]},
         acc,
         kind
       )
       when is_atom(ctx) and is_atom(key) do
    record_guard(acc, Atom.to_string(key), kind)
  end

  defp maybe_record_guard(_, acc, _kind), do: acc

  defp record_guard(acc, field, :truthy) do
    acc |> put_one(:guards, field) |> put_one(:guards_truthy, field)
  end

  defp record_guard(acc, field, :plain), do: put_one(acc, :guards, field)

  # ── Helpers ────────────────────────────────────────────────────────

  # Map-update keyword list: record each `key: value` write.
  defp record_kv_writes(acc, kv_list) do
    Enum.reduce(kv_list, acc, fn
      {k, v}, a when is_atom(k) -> record_value_write(a, Atom.to_string(k), v)
      _, a -> a
    end)
  end

  defp record_value_write(acc, field, value_ast) do
    case classify_value(value_ast) do
      :truthy -> acc |> put_one(:writes, field) |> put_one(:writes_truthy, field)
      :falsy -> acc |> put_one(:writes, field) |> put_one(:writes_falsy, field)
      :unknown -> acc |> put_one(:writes, field) |> put_one(:writes_dynamic, field)
    end
  end

  # Classify the RHS of a write as syntactically truthy, falsy, or
  # unknown. A value is provably truthy/falsy only when it's a
  # compile-time literal with an unambiguous truthiness. Anything
  # computed — function calls, variable refs, arithmetic — lands in
  # :unknown so the Datalog rules can't false-positive on a dynamic
  # writer that happens to produce a falsy value at runtime.
  defp classify_value(nil), do: :falsy
  defp classify_value(false), do: :falsy
  defp classify_value(true), do: :truthy
  defp classify_value(atom) when is_atom(atom), do: :truthy
  defp classify_value(n) when is_integer(n) or is_float(n), do: :truthy
  defp classify_value(s) when is_binary(s), do: :truthy
  defp classify_value([]), do: :truthy    # [] is truthy in Elixir
  defp classify_value([_ | _]), do: :truthy
  defp classify_value({:{}, _, _}), do: :truthy      # tuple literal >2
  defp classify_value({_, _}), do: :truthy           # 2-tuple literal
  defp classify_value({:%{}, _, _}), do: :truthy     # map literal
  defp classify_value({:%, _, _}), do: :truthy       # struct literal
  defp classify_value({:<<>>, _, _}), do: :truthy    # binary literal
  # `&capture/arity`, `fn -> ... end` — always a function, truthy.
  defp classify_value({:&, _, _}), do: :truthy
  defp classify_value({:fn, _, _}), do: :truthy
  defp classify_value(_), do: :unknown

  defp put_one(acc, key, field) when is_map_key(acc, key) do
    Map.update!(acc, key, &MapSet.put(&1, field))
  end
end
