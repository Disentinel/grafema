defmodule BeamAnalyzer.Rules.Patterns do
  @moduledoc """
  Pattern normalization and unification for BEAM message patterns.

  Input:  raw Elixir AST fragments from handler clause args or send-site
          message expressions.
  Output: canonical Shape terms comparable via `unify?/2`.

  Used by MessageFlow extraction (REG-1098): handlers, SENDS_TO edges,
  PubSub broadcasts. Pure functions, no graph side effects.

  Also hosts the legacy `process_pattern/3` helper used by
  `BeamAnalyzer.Rules.Functions` to emit PATTERN nodes during walking.
  """

  alias BeamAnalyzer.{Context, SemanticId}

  @type shape ::
          :_
          | :unknown
          | :number
          | {:atom, atom()}
          | {:str, String.t()}
          | {:tuple, [shape()]}
          | {:list, [shape()]}
          | {:cons, shape(), shape()}
          | {:map, [{shape() | atom() | String.t(), shape()}]}
          | {:struct, module(), [{atom() | String.t(), shape()}]}

  # ====================================================================
  # NORMALIZATION
  # ====================================================================

  @doc """
  Normalize an Elixir AST fragment to a canonical `shape` term.

  Variables, wildcards, and pinned vars collapse to `:_`. Atoms, numbers,
  and binaries become tagged leaves. Tuples, lists, maps, and structs
  recurse. Bindings (`left = right`) and guards (`pat when g`) keep only
  the pattern side. Anything unrecognized becomes `:unknown`.
  """
  @spec normalize(any()) :: shape()
  def normalize({:_, _, _}), do: :_
  def normalize({name, _, ctx}) when is_atom(name) and is_atom(ctx), do: :_
  def normalize({:^, _, [_]}), do: :_
  def normalize({:=, _, [l, _]}), do: normalize(l)
  def normalize({:when, _, [pat, _]}), do: normalize(pat)
  def normalize(atom) when is_atom(atom), do: {:atom, atom}
  def normalize(n) when is_number(n), do: :number
  def normalize(s) when is_binary(s), do: {:str, s}
  def normalize({a, b}), do: {:tuple, [normalize(a), normalize(b)]}
  def normalize({:{}, _, elems}), do: {:tuple, Enum.map(elems, &normalize/1)}
  def normalize({:%{}, _, pairs}), do: {:map, norm_pairs(pairs)}

  def normalize({:%, _, [{:__aliases__, _, parts}, {:%{}, _, pairs}]}),
    do: {:struct, Module.concat(parts), norm_pairs(pairs)}

  def normalize([{:|, _, [h, t]}]), do: {:cons, normalize(h), normalize(t)}
  def normalize(list) when is_list(list), do: {:list, Enum.map(list, &normalize/1)}
  def normalize(_), do: :unknown

  defp norm_pairs(pairs) do
    pairs
    |> Enum.map(fn {k, v} -> {normalize_key(k), normalize(v)} end)
    |> Enum.sort()
  end

  defp normalize_key(k) when is_atom(k), do: k
  defp normalize_key(k) when is_binary(k), do: k
  defp normalize_key(other), do: inspect(other)

  # ====================================================================
  # JSON-SAFE SHAPE SERIALIZATION
  # ====================================================================

  @doc """
  Convert a canonical `shape()` term to a JSON-safe nested list form.

  Tuples in shape terms break Jason encoding, so metadata that travels
  through the analyzer wire protocol must use this lowered form.
  """
  @spec shape_to_meta(shape() | any()) :: list()
  def shape_to_meta(:_), do: ["wildcard"]
  def shape_to_meta(:unknown), do: ["unknown"]
  def shape_to_meta(:number), do: ["number"]
  def shape_to_meta({:atom, a}), do: ["atom", Atom.to_string(a)]
  def shape_to_meta({:str, s}), do: ["str", s]
  def shape_to_meta({:tuple, elems}), do: ["tuple", Enum.map(elems, &shape_to_meta/1)]
  def shape_to_meta({:list, elems}), do: ["list", Enum.map(elems, &shape_to_meta/1)]
  def shape_to_meta({:cons, h, t}), do: ["cons", shape_to_meta(h), shape_to_meta(t)]
  def shape_to_meta({:map, pairs}), do: ["map", Enum.map(pairs, &pair_to_meta/1)]

  def shape_to_meta({:struct, mod, pairs}),
    do: ["struct", Atom.to_string(mod), Enum.map(pairs, &pair_to_meta/1)]

  def shape_to_meta(_), do: ["unknown"]

  defp pair_to_meta({k, v}) when is_atom(k), do: [Atom.to_string(k), shape_to_meta(v)]
  defp pair_to_meta({k, v}) when is_binary(k), do: [k, shape_to_meta(v)]
  defp pair_to_meta({k, v}), do: [inspect(k), shape_to_meta(v)]

  # ====================================================================
  # HUMAN-READABLE LABEL
  # ====================================================================

  @label_max 64

  @doc """
  Derive a short human-readable label from a `shape()` term.

  Used as the distinguishing part of a MESSAGE_TYPE node's `name`, so
  `grafema ls -t MESSAGE_TYPE` can show concrete clause heads instead of
  only the generic callback kind. Labels are collision-stable for equal
  shapes but not round-trippable — use the full `pattern_shape` metadata
  for structural equality checks.

  Examples:
    {:atom, :tick}                                          -> "tick"
    {:tuple, [{:atom, :reflect}, {:atom, :post_commit}, :_]} -> "reflect/post_commit/_"
    {:map, [{:source, ...}, {:type, ...}]}                  -> "map{source,type}"
    :_ / :unknown                                           -> "_"
  """
  @spec describe_shape(shape() | any()) :: String.t()
  def describe_shape(shape) do
    shape |> do_describe() |> cap()
  end

  defp do_describe(:_), do: "_"
  defp do_describe(:unknown), do: "_"
  defp do_describe(:number), do: "num"
  defp do_describe({:atom, a}) when is_atom(a), do: Atom.to_string(a)
  defp do_describe({:str, _}), do: "str"
  defp do_describe({:tuple, elems}), do: Enum.map_join(elems, "/", &do_describe/1)
  defp do_describe({:list, _}), do: "list"
  defp do_describe({:cons, _, _}), do: "list"

  defp do_describe({:map, pairs}) do
    keys = pairs |> Enum.map(fn {k, _} -> key_to_string(k) end) |> Enum.sort() |> Enum.join(",")
    "map{#{keys}}"
  end

  defp do_describe({:struct, mod, pairs}) do
    mod_short = mod |> Module.split() |> List.last()
    keys = pairs |> Enum.map(fn {k, _} -> key_to_string(k) end) |> Enum.sort() |> Enum.join(",")
    "%#{mod_short}{#{keys}}"
  end

  defp do_describe(_), do: "_"

  defp key_to_string(k) when is_atom(k), do: Atom.to_string(k)
  defp key_to_string(k) when is_binary(k), do: k
  defp key_to_string(k), do: inspect(k)

  defp cap(s) when byte_size(s) <= @label_max, do: s
  defp cap(s), do: binary_part(s, 0, @label_max - 3) <> "..."

  # ====================================================================
  # UNIFICATION
  # ====================================================================

  @doc """
  Return true if a message with shape `send_shape` could possibly match a
  handler clause with shape `handler_shape`.

  Non-strict: `:_` and `:unknown` unify with anything; maps ignore
  non-overlapping keys (pattern says "must have these, may have more");
  structs unify with plain maps because structs are maps at runtime.
  Atoms do NOT unify with strings — this is the Mamori regression guard.
  """
  @spec unify?(shape(), shape()) :: boolean()
  def unify?(:_, _), do: true
  def unify?(_, :_), do: true
  def unify?(:unknown, _), do: true
  def unify?(_, :unknown), do: true
  def unify?({:atom, a}, {:atom, a}), do: true
  def unify?({:str, s}, {:str, s}), do: true
  def unify?(:number, :number), do: true

  def unify?({:tuple, a}, {:tuple, b}) when length(a) == length(b),
    do: Enum.zip(a, b) |> Enum.all?(fn {x, y} -> unify?(x, y) end)

  def unify?({:list, a}, {:list, b}) when length(a) == length(b),
    do: Enum.zip(a, b) |> Enum.all?(fn {x, y} -> unify?(x, y) end)

  def unify?({:cons, h1, t1}, {:cons, h2, t2}), do: unify?(h1, h2) and unify?(t1, t2)
  def unify?({:list, _}, {:cons, _, _}), do: true
  def unify?({:cons, _, _}, {:list, _}), do: true
  def unify?({:map, a}, {:map, b}), do: compat_map?(a, b)
  def unify?({:struct, m, a}, {:struct, m, b}), do: compat_map?(a, b)
  def unify?({:struct, _, _}, {:map, _}), do: true
  def unify?({:map, _}, {:struct, _, _}), do: true
  def unify?(_, _), do: false

  defp compat_map?(a, b) do
    am = Map.new(a)
    bm = Map.new(b)
    common = MapSet.intersection(MapSet.new(Map.keys(am)), MapSet.new(Map.keys(bm)))
    Enum.all?(common, fn k -> unify?(Map.get(am, k), Map.get(bm, k)) end)
  end

  # ====================================================================
  # SHAPE-TREE GRAPH EMISSION (REG-1098 W-shape)
  # ====================================================================
  #
  # Lowers a `shape()` term into a first-class subgraph: one `SHAPE` node
  # per shape constructor + structural edges (HAS_ELEMENT / HAS_HEAD /
  # HAS_TAIL / HAS_FIELD), rooted at an owner node (a MESSAGE_TYPE's
  # pattern or a send-site CALL's message) via `root_edge_type`.
  #
  # WHY: the `pattern_shape` / `message_shape` metadata is a non-scalar
  # nested list that the derive engine's `node_attr` builtin CANNOT read
  # (it returns no row on non-scalar values). Materializing the shape as
  # nodes+edges turns structural unification (send-shape vs handler-pattern)
  # from data-structure recursion — impossible in Datalog — into a
  # recursive edge-walk, which the derive engine does natively. This is
  # purely ADDITIVE: the metadata is still emitted for the native Haskell
  # resolvers (BeamShape / BeamMessageFindings) that consume it today.
  #
  # Node `metadata.kind` is the discriminator (wildcard|unknown|number|
  # atom|str|tuple|list|cons|map|struct), all top-level scalars so
  # `node_attr(S,"kind",K)` / `node_attr(S,"value",V)` work. Map/struct
  # field keys and tuple/list element indices live on the EDGE metadata
  # (`key` / `index`), readable via `edge_attr`.

  @doc """
  Emit the `shape()` tree rooted at `owner_id` as SHAPE nodes + structural
  edges, plus an `owner -root_edge_type-> root` edge. Returns the updated
  context. Additive: callers keep emitting the `*_shape` metadata too.
  """
  @spec emit_shape_tree(Context.t(), shape() | any(), String.t(), String.t(), String.t()) ::
          Context.t()
  def emit_shape_tree(ctx, shape, owner_id, file, root_edge_type)
      when is_binary(owner_id) and is_binary(file) and is_binary(root_edge_type) do
    root_id = shape_node_id(owner_id, "root")
    ctx = emit_shape_node(ctx, shape, root_id, file)
    Context.add_edge(ctx, shape_edge(owner_id, root_id, root_edge_type, %{}))
  end

  defp shape_node_id(owner_id, path), do: "#{owner_id}->SHAPE->#{path}"

  defp shape_edge(src, dst, type, meta), do: %{src: src, dst: dst, type: type, metadata: meta}

  defp shape_node(id, file, kind, name, extra) do
    %{
      id: id,
      type: "SHAPE",
      name: name,
      file: file,
      line: 0,
      column: 0,
      endLine: 0,
      endColumn: 0,
      exported: false,
      metadata: Map.merge(%{kind: kind}, extra)
    }
  end

  # Leaves.
  defp emit_shape_node(ctx, :_, id, file),
    do: Context.add_node(ctx, shape_node(id, file, "wildcard", "_", %{}))

  defp emit_shape_node(ctx, :unknown, id, file),
    do: Context.add_node(ctx, shape_node(id, file, "unknown", "?", %{}))

  defp emit_shape_node(ctx, :number, id, file),
    do: Context.add_node(ctx, shape_node(id, file, "number", "num", %{}))

  defp emit_shape_node(ctx, {:atom, a}, id, file) do
    v = Atom.to_string(a)
    Context.add_node(ctx, shape_node(id, file, "atom", v, %{value: v}))
  end

  defp emit_shape_node(ctx, {:str, s}, id, file) when is_binary(s),
    do: Context.add_node(ctx, shape_node(id, file, "str", "str", %{value: s}))

  # Ordered composites: tuple / list — children via HAS_ELEMENT[index].
  defp emit_shape_node(ctx, {:tuple, elems}, id, file) do
    ctx = Context.add_node(ctx, shape_node(id, file, "tuple", "tuple", %{arity: length(elems)}))
    emit_elements(ctx, elems, id, file)
  end

  defp emit_shape_node(ctx, {:list, elems}, id, file) do
    ctx = Context.add_node(ctx, shape_node(id, file, "list", "list", %{arity: length(elems)}))
    emit_elements(ctx, elems, id, file)
  end

  # cons — HAS_HEAD / HAS_TAIL.
  defp emit_shape_node(ctx, {:cons, h, t}, id, file) do
    ctx = Context.add_node(ctx, shape_node(id, file, "cons", "cons", %{}))
    hid = shape_child_id(id, "h")
    tid = shape_child_id(id, "t")
    ctx = emit_shape_node(ctx, h, hid, file)
    ctx = Context.add_edge(ctx, shape_edge(id, hid, "HAS_HEAD", %{}))
    ctx = emit_shape_node(ctx, t, tid, file)
    Context.add_edge(ctx, shape_edge(id, tid, "HAS_TAIL", %{}))
  end

  # Keyed composites: map / struct — children via HAS_FIELD[key].
  defp emit_shape_node(ctx, {:map, pairs}, id, file) do
    ctx = Context.add_node(ctx, shape_node(id, file, "map", "map", %{}))
    emit_fields(ctx, pairs, id, file)
  end

  defp emit_shape_node(ctx, {:struct, mod, pairs}, id, file) do
    modname = Atom.to_string(mod)
    ctx = Context.add_node(ctx, shape_node(id, file, "struct", "%#{modname}{}", %{struct_module: modname}))
    emit_fields(ctx, pairs, id, file)
  end

  defp emit_shape_node(ctx, _other, id, file),
    do: Context.add_node(ctx, shape_node(id, file, "unknown", "?", %{}))

  defp emit_elements(ctx, elems, parent_id, file) do
    elems
    |> Enum.with_index()
    |> Enum.reduce(ctx, fn {el, i}, acc ->
      cid = shape_child_id(parent_id, Integer.to_string(i))
      acc = emit_shape_node(acc, el, cid, file)
      Context.add_edge(acc, shape_edge(parent_id, cid, "HAS_ELEMENT", %{index: i}))
    end)
  end

  defp emit_fields(ctx, pairs, parent_id, file) do
    pairs
    |> Enum.with_index()
    # child id keyed by INDEX (not key text) to avoid id collisions on
    # duplicate/non-scalar keys; the field key lives on the edge metadata.
    |> Enum.reduce(ctx, fn {{k, v}, i}, acc ->
      cid = shape_child_id(parent_id, "k#{i}")
      acc = emit_shape_node(acc, v, cid, file)
      Context.add_edge(acc, shape_edge(parent_id, cid, "HAS_FIELD", %{key: key_to_string(k)}))
    end)
  end

  defp shape_child_id(parent_id, seg), do: "#{parent_id}/#{seg}"

  # ====================================================================
  # LEGACY: PATTERN node emission (used by Rules.Functions walker)
  # ====================================================================

  def process_pattern(pattern, meta, ctx) do
    line = Keyword.get(meta, :line, 0)
    col = Keyword.get(meta, :column, 0)
    scope = Context.current_scope(ctx) || "module"

    pattern_id = SemanticId.pattern_id(ctx.file, scope, line, col)

    node = %{
      id: pattern_id,
      type: "PATTERN",
      name: describe_pattern(pattern),
      file: ctx.file,
      line: line,
      column: col,
      endLine: 0,
      endColumn: 0,
      exported: false,
      metadata: %{}
    }

    Context.add_node(ctx, node)
  end

  defp describe_pattern({:{}, _, _}), do: "tuple"
  defp describe_pattern({:%{}, _, _}), do: "map"
  defp describe_pattern({:%, _, _}), do: "struct"
  defp describe_pattern(list) when is_list(list), do: "list"
  defp describe_pattern({:<<>>, _, _}), do: "binary"
  defp describe_pattern(_), do: "match"
end
