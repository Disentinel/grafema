defmodule BeamAnalyzer.Rules.Modules do
  @moduledoc "Handles defmodule -> MODULE nodes."

  alias BeamAnalyzer.{Context, SemanticId}

  def process({:defmodule, meta, [module_alias | body]}, ctx) do
    module_name = extract_module_name(module_alias)
    line = Keyword.get(meta, :line, 0)
    col = Keyword.get(meta, :column, 0)

    ctx = Context.set_module(ctx, module_name)

    node = %{
      id: SemanticId.module_id(ctx.file, module_name),
      type: "MODULE",
      name: module_name,
      file: ctx.file,
      line: line,
      column: col,
      endLine: 0,
      endColumn: 0,
      exported: true,
      metadata: %{language: "elixir"}
    }

    ctx = Context.add_node(ctx, node)
    ctx = Context.push_scope(ctx, module_name)

    # Walk module body — body from defmodule AST is [[do: ...]], not [do: ...]
    keyword_body = List.first(body) || []
    ctx = walk_module_body(keyword_body, ctx)

    Context.pop_scope(ctx)
  end

  def process(_ast, ctx), do: ctx

  def process_erlang({:attribute, loc, :module, module_name}, ctx) do
    name = Atom.to_string(module_name)
    ctx = Context.set_module(ctx, name)
    line = extract_line(loc)

    node = %{
      id: SemanticId.module_id(ctx.file, name),
      type: "MODULE",
      name: name,
      file: ctx.file,
      line: line,
      column: 0,
      endLine: 0,
      endColumn: 0,
      exported: true,
      metadata: %{language: "erlang"}
    }

    Context.add_node(ctx, node)
  end

  def process_erlang({:attribute, _line, :export, funs}, ctx) do
    Enum.reduce(funs, ctx, fn {name, arity}, ctx ->
      BeamAnalyzer.Rules.Exports.add_export(ctx, Atom.to_string(name), arity)
    end)
  end

  def process_erlang({:function, loc, name, arity, clauses}, ctx) do
    line = extract_line(loc)
    BeamAnalyzer.Rules.Functions.process_erlang_function(
      ctx, Atom.to_string(name), arity, line, clauses
    )
  end

  def process_erlang({:attribute, loc, :type, {name, _type_def, _params}}, ctx) do
    line = extract_line(loc)
    BeamAnalyzer.Rules.Types.process_erlang_type(ctx, Atom.to_string(name), line)
  end

  def process_erlang({:attribute, loc, :spec, {{name, arity}, _spec}}, ctx) do
    line = extract_line(loc)
    BeamAnalyzer.Rules.Types.process_erlang_spec(ctx, Atom.to_string(name), arity, line)
  end

  def process_erlang({:attribute, loc, :import, {module, funs}}, ctx) do
    line = extract_line(loc)
    module_name = Atom.to_string(module)
    Enum.reduce(funs, ctx, fn {name, arity}, ctx ->
      BeamAnalyzer.Rules.Imports.add_erlang_import(ctx, module_name, Atom.to_string(name), arity, line)
    end)
  end

  def process_erlang(_form, ctx), do: ctx

  defp walk_module_body([do: {:__block__, _, statements}], ctx) do
    Enum.reduce(statements, ctx, &walk_statement/2)
  end

  defp walk_module_body([do: statement], ctx) do
    walk_statement(statement, ctx)
  end

  defp walk_module_body([{:do, {:__block__, _, statements}} | _], ctx) do
    Enum.reduce(statements, ctx, &walk_statement/2)
  end

  defp walk_module_body([{:do, statement} | _], ctx) do
    walk_statement(statement, ctx)
  end

  defp walk_module_body(_, ctx), do: ctx

  defp walk_statement({:def, _meta, _args} = ast, ctx) do
    BeamAnalyzer.Rules.Functions.process(ast, ctx)
  end

  defp walk_statement({:defp, _meta, _args} = ast, ctx) do
    BeamAnalyzer.Rules.Functions.process(ast, ctx)
  end

  defp walk_statement({:alias, _meta, _args} = ast, ctx) do
    BeamAnalyzer.Rules.Imports.process(ast, ctx)
  end

  defp walk_statement({:import, _meta, _args} = ast, ctx) do
    BeamAnalyzer.Rules.Imports.process(ast, ctx)
  end

  defp walk_statement({:use, _meta, _args} = ast, ctx) do
    BeamAnalyzer.Rules.Imports.process(ast, ctx)
  end

  defp walk_statement({:require, _meta, _args} = ast, ctx) do
    BeamAnalyzer.Rules.Imports.process(ast, ctx)
  end

  defp walk_statement({:@, _meta, [{:type, _, _}]} = ast, ctx) do
    BeamAnalyzer.Rules.Types.process(ast, ctx)
  end

  defp walk_statement({:@, _meta, [{:spec, _, _}]} = ast, ctx) do
    BeamAnalyzer.Rules.Types.process(ast, ctx)
  end

  defp walk_statement({:@, _meta, [{:behaviour, _, _}]} = ast, ctx) do
    BeamAnalyzer.Rules.Imports.process_behaviour(ast, ctx)
  end

  defp walk_statement({:@, _meta, [{:callback, _, _}]} = ast, ctx) do
    BeamAnalyzer.Rules.Types.process(ast, ctx)
  end

  defp walk_statement({:defmodule, _meta, _args} = ast, ctx) do
    # Nested module
    process(ast, ctx)
  end

  defp walk_statement(_ast, ctx), do: ctx

  defp extract_module_name({:__aliases__, _, parts}) do
    parts |> Enum.map(&Atom.to_string/1) |> Enum.join(".")
  end

  defp extract_module_name(atom) when is_atom(atom), do: Atom.to_string(atom)
  defp extract_module_name(other), do: inspect(other)

  # OTP 26+: line info is keyword list like [text: ~c"module", location: 1]
  # OTP < 26: line info is integer
  defp extract_line(loc) when is_integer(loc), do: loc
  defp extract_line(loc) when is_list(loc), do: Keyword.get(loc, :location, 0)
  defp extract_line(_), do: 0
end
