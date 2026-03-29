defmodule BeamAnalyzer.ElixirParser do
  @moduledoc "Parses Elixir source using Code.string_to_quoted/2."

  def parse(source) do
    case Code.string_to_quoted(source, columns: true, token_metadata: true) do
      {:ok, ast} -> {:ok, ast}
      {:error, {location, msg, token}} ->
        line = Keyword.get(location, :line, 0)
        {:error, "Parse error at line #{line}: #{msg} #{token}"}
    end
  end
end
