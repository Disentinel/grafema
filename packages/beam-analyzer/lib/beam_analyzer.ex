defmodule BeamAnalyzer do
  @moduledoc """
  BEAM (Elixir/Erlang) analyzer for Grafema.

  Modes:
  - One-shot: reads JSON from stdin, writes FileAnalysis to stdout
  - Daemon (--daemon): length-prefixed frame protocol on stdin/stdout
  """

  def main(args) do
    # Stdio is the frame-protocol transport — force encoding to :latin1
    # so `IO.binread`/`IO.binwrite` are true byte passthroughs without
    # any unicode<->latin1 translation hops. Without this, escript's
    # default :unicode stdio raises `{:no_translation, :unicode, :latin1}`
    # when reading framed bytes whose length prefix or payload happens
    # to look like an invalid unicode codepoint.
    :io.setopts(:standard_io, encoding: :latin1)

    # stderr is text output (humans / logs) — keep it :unicode so
    # inspect() on tuples containing multi-byte binaries doesn't crash.
    :io.setopts(:standard_error, encoding: :unicode)

    # CRITICAL for daemon mode: redirect Logger to stderr. In daemon
    # mode stdin/stdout carry the length-prefixed frame protocol —
    # any extra byte on stdout desynchronizes the orchestrator's
    # reader, which then parses garbage as a frame length and bails
    # with `{:no_translation, ...}` or `frame too large`.
    #
    # Compile/parser warnings from `Code.string_to_quoted` on some
    # Elixir files (especially ones with unusual atoms or deprecated
    # syntax) route through Logger, whose default handler writes to
    # `:standard_io`. Pointing the default handler at standard_error
    # keeps stdout exclusively for frames.
    _ =
      :logger.update_handler_config(:default, :config, %{type: :standard_error})

    case args do
      ["--daemon"] -> daemon_loop()
      _ -> one_shot()
    end
  end

  defp one_shot do
    input = IO.binread(:stdio, :eof)

    case Jason.decode(input) do
      {:ok, %{"file" => file, "source" => source}} ->
        result = analyze(file, source)
        IO.binwrite(:stdio, Jason.encode!(result))

      {:error, reason} ->
        IO.binwrite(:stdio, Jason.encode!(%{status: "error", error: "Invalid JSON: #{inspect(reason)}"}))
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
        IO.binwrite(:stderr, "Protocol error: #{inspect(reason)}\n")
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
