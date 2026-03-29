defmodule BeamAnalyzer do
  @moduledoc """
  BEAM (Elixir/Erlang) analyzer for Grafema.

  Modes:
  - One-shot: reads JSON from stdin, writes FileAnalysis to stdout
  - Daemon (--daemon): length-prefixed frame protocol on stdin/stdout
  """

  def main(args) do
    case args do
      ["--daemon"] -> daemon_loop()
      _ -> one_shot()
    end
  end

  defp one_shot do
    input = IO.read(:stdio, :eof)

    case Jason.decode(input) do
      {:ok, %{"file" => file, "source" => source}} ->
        result = analyze(file, source)
        IO.write(:stdio, Jason.encode!(result))

      {:error, reason} ->
        IO.write(:stdio, Jason.encode!(%{status: "error", error: "Invalid JSON: #{inspect(reason)}"}))
        System.halt(1)
    end
  end

  defp daemon_loop do
    case BeamAnalyzer.Protocol.read_frame(:stdio) do
      {:ok, data} ->
        response =
          case Jason.decode(data) do
            {:ok, %{"file" => file, "source" => source}} ->
              result = analyze(file, source)
              %{status: "ok", result: result}

            {:error, reason} ->
              %{status: "error", error: "Invalid JSON: #{inspect(reason)}"}
          end

        BeamAnalyzer.Protocol.write_frame(:stdio, Jason.encode!(response))
        daemon_loop()

      :eof ->
        :ok

      {:error, reason} ->
        IO.write(:stderr, "Protocol error: #{inspect(reason)}\n")
        System.halt(1)
    end
  end

  @doc """
  Analyze a single file and return the FileAnalysis map.
  """
  def analyze(file, source) do
    ctx = BeamAnalyzer.Context.new(file)

    ast_result =
      cond do
        String.ends_with?(file, ".erl") or String.ends_with?(file, ".hrl") ->
          BeamAnalyzer.ErlangParser.parse(source)

        true ->
          BeamAnalyzer.ElixirParser.parse(source)
      end

    case ast_result do
      {:ok, ast} ->
        ctx = BeamAnalyzer.Walker.walk(ast, ctx)
        BeamAnalyzer.FileAnalysis.to_map(ctx)

      {:error, reason} ->
        %{
          file: file,
          moduleId: "#{file}->MODULE->unknown",
          nodes: [],
          edges: [],
          exports: [],
          errors: [inspect(reason)]
        }
    end
  end
end
