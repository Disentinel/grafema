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
