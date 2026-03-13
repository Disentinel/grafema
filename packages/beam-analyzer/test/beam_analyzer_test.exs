defmodule BeamAnalyzerTest do
  use ExUnit.Case, async: true

  describe "Elixir analysis" do
    test "analyzes simple module" do
      source = """
      defmodule MyApp.Calculator do
        def add(a, b), do: a + b
        defp multiply(a, b), do: a * b
      end
      """

      result = BeamAnalyzer.analyze("lib/calculator.ex", source)

      assert result.file == "lib/calculator.ex"
      assert result.moduleId == "lib/calculator.ex->MODULE->MyApp.Calculator"

      types = Enum.map(result.nodes, & &1.type)
      assert "MODULE" in types
      assert "FUNCTION" in types

      names = Enum.map(result.nodes, & &1.name)
      assert "MyApp.Calculator" in names
      assert "add/2" in names
      assert "multiply/2" in names

      # Public function should be exported
      export_names = Enum.map(result.exports, & &1.name)
      assert "add/2" in export_names
      refute "multiply/2" in export_names
    end

    test "analyzes imports" do
      source = """
      defmodule MyApp.Server do
        alias MyApp.Config
        import Enum, only: [map: 2]
        use GenServer
        require Logger
      end
      """

      result = BeamAnalyzer.analyze("lib/server.ex", source)

      import_nodes = Enum.filter(result.nodes, &(&1.type == "IMPORT"))
      import_names = Enum.map(import_nodes, & &1.name)

      assert "MyApp.Config" in import_names
      assert "Enum" in import_names
      assert "GenServer" in import_names
      assert "Logger" in import_names
    end

    test "analyzes function calls" do
      source = """
      defmodule MyApp.Processor do
        def process(data) do
          transform(data)
        end

        defp transform(data), do: data
      end
      """

      result = BeamAnalyzer.analyze("lib/processor.ex", source)

      call_nodes = Enum.filter(result.nodes, &(&1.type == "CALL"))
      assert length(call_nodes) > 0
    end

    test "generates CONTAINS edges" do
      source = """
      defmodule MyApp.Math do
        def add(a, b), do: a + b
      end
      """

      result = BeamAnalyzer.analyze("lib/math.ex", source)

      contains_edges = Enum.filter(result.edges, &(&1.type == "CONTAINS"))
      assert length(contains_edges) > 0

      # MODULE should contain FUNCTION
      module_id = "lib/math.ex->MODULE->MyApp.Math"
      assert Enum.any?(contains_edges, &(&1.src == module_id))
    end
  end

  describe "Erlang analysis" do
    test "analyzes simple erlang module" do
      source = """
      -module(sample_mod).
      -export([hello/1]).

      hello(Name) ->
          io:format("Hello ~s~n", [Name]).
      """

      result = BeamAnalyzer.analyze("src/sample_mod.erl", source)

      assert result.file == "src/sample_mod.erl"

      types = Enum.map(result.nodes, & &1.type)
      assert "MODULE" in types
      assert "FUNCTION" in types

      module_node = Enum.find(result.nodes, &(&1.type == "MODULE"))
      assert module_node.name == "sample_mod"
    end
  end

  describe "protocol" do
    test "frame round-trip" do
      payload = Jason.encode!(%{test: "data"})

      length = byte_size(payload)
      frame = <<length::unsigned-big-integer-size(32)>> <> payload

      <<read_len::unsigned-big-integer-size(32), rest::binary>> = frame
      assert read_len == byte_size(payload)
      assert rest == payload
    end
  end
end
