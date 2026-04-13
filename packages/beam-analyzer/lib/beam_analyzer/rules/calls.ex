defmodule BeamAnalyzer.Rules.Calls do
  @moduledoc "Handles function calls -> CALL nodes, pipe desugaring."

  alias BeamAnalyzer.{Context, SemanticId}

  # Operators, special forms, and pseudo-AST atoms that share the
  # `{name, meta, args}` shape with real function calls but are not callable.
  # REG-1097: emitting CALL nodes for these polluted ~700 of 3446 unresolved
  # CALLs in kami and made the resolution metrics meaningless.
  @non_callable MapSet.new([
    # Block / forms / quoting
    :__block__, :__aliases__, :__MODULE__, :__ENV__, :__CALLER__,
    :fn, :&, :quote, :unquote, :unquote_splicing, :alias, :require,
    :import, :super, :defmodule, :def, :defp, :defmacro, :defmacrop,
    :defguard, :defguardp, :defprotocol, :defimpl, :defstruct,
    :defexception, :defdelegate, :defoverridable, :defcallback,
    # Special forms
    :case, :cond, :if, :unless, :with, :for, :receive, :try,
    :rescue, :catch, :else, :after, :do, :end,
    # Match / pin
    :=, :^, :when,
    # Arrow / cons / pipe
    :->, :|, :|>,
    # Arithmetic
    :+, :-, :*, :/, :div, :rem,
    # Comparison
    :==, :!=, :===, :!==, :=~, :<, :>, :<=, :>=,
    # Logical
    :and, :or, :not, :&&, :||, :!,
    # Membership
    :in,
    # Concatenation
    :<>, :++, :--,
    # Bitstring / map / tuple literals
    :<<>>, :%{}, :%, :{},
    # Module attribute / capture / typespec
    :@, :"::"
  ])

  @doc """
  True if this atom name represents an actual callable function rather
  than an operator, special form, or pseudo-AST node.
  """
  def callable?(name) when is_atom(name) do
    cond do
      MapSet.member?(@non_callable, name) -> false
      # All Elixir sigils (~r, ~s, ~w, ~D, ~U, ...) appear as `sigil_<letter>`
      String.starts_with?(Atom.to_string(name), "sigil_") -> false
      true -> true
    end
  end

  def process({name, meta, args}, ctx) when is_atom(name) and is_list(args) do
    if callable?(name) do
      line = Keyword.get(meta, :line, 0)
      col = Keyword.get(meta, :column, 0)
      add_call(ctx, Atom.to_string(name), length(args), line, col)
    else
      ctx
    end
  end

  def process(_ast, ctx), do: ctx

  def process_dot_call({:., _dot_meta, [{:__aliases__, _, parts}, method]}, call_meta, args, _meta, ctx) do
    module_name = parts |> Enum.map(&Atom.to_string/1) |> Enum.join(".")
    call_name = "#{module_name}.#{method}"
    line = Keyword.get(call_meta, :line, 0)
    col = Keyword.get(call_meta, :column, 0)
    add_call(ctx, call_name, length(args), line, col)
  end

  def process_dot_call({:., _dot_meta, [receiver, method]}, call_meta, args, _meta, ctx) when is_atom(method) do
    cond do
      # Field access: `state.name` (no parens) is not a function call.
      # Elixir tags this with :no_parens on the OUTER call meta.
      Keyword.get(call_meta, :no_parens, false) ->
        ctx

      # Plain identifier receiver: `var.method(args)` — keep as a CALL,
      # the resolver can try to trace `var` to a known type later.
      match?({name, _, _} when is_atom(name), receiver) ->
        {recv_name, _, _} = receiver
        call_name = "#{recv_name}.#{method}"
        line = Keyword.get(call_meta, :line, 0)
        col = Keyword.get(call_meta, :column, 0)
        add_call(ctx, call_name, length(args), line, col)

      # Compound receiver (chained access, pipe result, function call result).
      # The old code emitted "<obj>.method" — which is unresolvable by
      # construction and just inflates noise. Drop it.
      true ->
        ctx
    end
  end

  def process_dot_call(_dot, _call_meta, _args, _meta, ctx), do: ctx

  def process_pipe(left, right, _meta, ctx) do
    # Walk left side first
    ctx = walk_pipe_arg(left, ctx)
    # Right side is the call that receives left as first argument
    walk_pipe_arg(right, ctx)
  end

  # Pipe clause MUST come first — :|> is an atom, would match the general clause below
  defp walk_pipe_arg({:|>, _meta, [left, right]}, ctx) do
    ctx = walk_pipe_arg(left, ctx)
    walk_pipe_arg(right, ctx)
  end

  defp walk_pipe_arg({{:., _, [{:__aliases__, _, parts}, method]}, meta, args}, ctx) do
    module_name = parts |> Enum.map(&Atom.to_string/1) |> Enum.join(".")
    call_name = "#{module_name}.#{method}"
    line = Keyword.get(meta, :line, 0)
    col = Keyword.get(meta, :column, 0)
    add_call(ctx, call_name, length(args) + 1, line, col)
  end

  defp walk_pipe_arg({name, meta, args}, ctx) when is_atom(name) and is_list(args) do
    if callable?(name) do
      line = Keyword.get(meta, :line, 0)
      col = Keyword.get(meta, :column, 0)
      # In pipe, the actual arity is args + 1 (piped value)
      add_call(ctx, Atom.to_string(name), length(args) + 1, line, col)
    else
      ctx
    end
  end

  defp walk_pipe_arg(_expr, ctx), do: ctx

  def add_call(ctx, name, arity, line, col) do
    scope = Context.current_scope(ctx) || "module"
    call_id = SemanticId.call_id(ctx.file, name, scope, line, col)

    node = %{
      id: call_id,
      type: "CALL",
      name: name,
      file: ctx.file,
      line: line,
      column: col,
      endLine: 0,
      endColumn: 0,
      exported: false,
      metadata: %{arity: arity}
    }

    Context.add_node(ctx, node)
  end
end
