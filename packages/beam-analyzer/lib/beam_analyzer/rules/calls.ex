defmodule BeamAnalyzer.Rules.Calls do
  @moduledoc "Handles function calls -> CALL nodes, pipe desugaring."

  alias BeamAnalyzer.{Context, SemanticId}

  def process({name, meta, args}, ctx) when is_atom(name) and is_list(args) do
    # Skip special forms
    if name in [:__block__, :__aliases__, :fn, :&, :quote, :unquote] do
      ctx
    else
      line = Keyword.get(meta, :line, 0)
      col = Keyword.get(meta, :column, 0)
      add_call(ctx, Atom.to_string(name), length(args), line, col)
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
    receiver_name =
      case receiver do
        {name, _, _} when is_atom(name) -> Atom.to_string(name)
        _ -> "<obj>"
      end

    call_name = "#{receiver_name}.#{method}"
    line = Keyword.get(call_meta, :line, 0)
    col = Keyword.get(call_meta, :column, 0)
    add_call(ctx, call_name, length(args), line, col)
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
    line = Keyword.get(meta, :line, 0)
    col = Keyword.get(meta, :column, 0)
    # In pipe, the actual arity is args + 1 (piped value)
    add_call(ctx, Atom.to_string(name), length(args) + 1, line, col)
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
