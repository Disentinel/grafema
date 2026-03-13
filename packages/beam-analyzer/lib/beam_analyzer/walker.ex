defmodule BeamAnalyzer.Walker do
  @moduledoc "Dispatches AST nodes to rule modules for analysis."

  alias BeamAnalyzer.Rules

  def walk(ast, ctx) when is_list(ast) do
    # Erlang: list of forms
    Enum.reduce(ast, ctx, &walk_erlang_form/2)
  end

  def walk(ast, ctx) do
    # Elixir: single AST
    walk_elixir(ast, ctx)
  end

  defp walk_elixir({:__block__, _, statements}, ctx) do
    # Multiple top-level statements (e.g., multiple defmodule in one file)
    Enum.reduce(statements, ctx, fn stmt, ctx ->
      Rules.Modules.process(stmt, ctx)
    end)
  end

  defp walk_elixir(ast, ctx) do
    Rules.Modules.process(ast, ctx)
  end

  defp walk_erlang_form(form, ctx) do
    Rules.Modules.process_erlang(form, ctx)
  end
end
