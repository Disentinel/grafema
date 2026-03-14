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

  describe "protocol (frame)" do
    test "frame round-trip" do
      payload = Jason.encode!(%{test: "data"})

      length = byte_size(payload)
      frame = <<length::unsigned-big-integer-size(32)>> <> payload

      <<read_len::unsigned-big-integer-size(32), rest::binary>> = frame
      assert read_len == byte_size(payload)
      assert rest == payload
    end
  end

  describe "defprotocol analysis" do
    test "creates MODULE node with protocol metadata" do
      source = """
      defprotocol Stringify do
        def stringify(value)
      end
      """

      result = BeamAnalyzer.analyze("lib/stringify.ex", source)

      module_nodes = Enum.filter(result.nodes, &(&1.type == "MODULE"))
      assert length(module_nodes) == 1

      protocol_node = hd(module_nodes)
      assert protocol_node.name == "Stringify"
      assert protocol_node.id == "lib/stringify.ex->MODULE->Stringify"
      assert protocol_node.metadata.kind == "protocol"
    end

    test "protocol contains its function declarations" do
      source = """
      defprotocol Stringify do
        def stringify(value)
      end
      """

      result = BeamAnalyzer.analyze("lib/stringify.ex", source)

      func_nodes = Enum.filter(result.nodes, &(&1.type == "FUNCTION"))
      assert length(func_nodes) == 1
      assert hd(func_nodes).name == "stringify/1"

      contains_edges = Enum.filter(result.edges, &(&1.type == "CONTAINS"))
      assert Enum.any?(contains_edges, fn edge ->
        edge.src == "lib/stringify.ex->MODULE->Stringify" and
        edge.dst == "lib/stringify.ex->FUNCTION->stringify/1[in:Stringify]"
      end)
    end
  end

  describe "defimpl analysis" do
    test "creates MODULE node with protocol_impl metadata" do
      source = """
      defimpl Stringify, for: Map do
        def stringify(map), do: inspect(map)
      end
      """

      result = BeamAnalyzer.analyze("lib/stringify_map.ex", source)

      module_nodes = Enum.filter(result.nodes, &(&1.type == "MODULE"))
      assert length(module_nodes) == 1

      impl_node = hd(module_nodes)
      assert impl_node.name == "Stringify.Map"
      assert impl_node.metadata.kind == "protocol_impl"
      assert impl_node.metadata.protocol == "Stringify"
      assert impl_node.metadata.for_type == "Map"
    end

    test "creates IMPORT node referencing the protocol" do
      source = """
      defimpl Stringify, for: Map do
        def stringify(map), do: inspect(map)
      end
      """

      result = BeamAnalyzer.analyze("lib/stringify_map.ex", source)

      import_nodes = Enum.filter(result.nodes, &(&1.type == "IMPORT"))
      assert length(import_nodes) == 1

      import_node = hd(import_nodes)
      assert import_node.name == "Stringify"
      assert import_node.metadata.kind == "protocol_impl"
      assert import_node.metadata.for_type == "Map"
    end

    test "impl functions are contained by impl module" do
      source = """
      defimpl Stringify, for: List do
        def stringify(list), do: Enum.join(list, ", ")
      end
      """

      result = BeamAnalyzer.analyze("lib/stringify_list.ex", source)

      func_nodes = Enum.filter(result.nodes, &(&1.type == "FUNCTION"))
      assert length(func_nodes) == 1
      assert hd(func_nodes).name == "stringify/1"

      contains_edges = Enum.filter(result.edges, &(&1.type == "CONTAINS"))
      assert Enum.any?(contains_edges, fn edge ->
        edge.src == "lib/stringify_list.ex->MODULE->Stringify.List" and
        edge.dst == "lib/stringify_list.ex->FUNCTION->stringify/1[in:Stringify.List]"
      end)
    end
  end

  describe "behaviour analysis" do
    test "@behaviour creates IMPORT node with behaviour kind" do
      source = """
      defmodule MyWorker do
        @behaviour GenServer

        def init(arg), do: {:ok, arg}
        def handle_call(msg, _from, state), do: {:reply, msg, state}
      end
      """

      result = BeamAnalyzer.analyze("lib/my_worker.ex", source)

      import_nodes = Enum.filter(result.nodes, &(&1.type == "IMPORT"))
      assert length(import_nodes) == 1

      behaviour_import = hd(import_nodes)
      assert behaviour_import.name == "GenServer"
      assert behaviour_import.metadata.kind == "behaviour"
    end

    test "behaviour callback functions are detected" do
      source = """
      defmodule MyWorker do
        @behaviour GenServer

        def init(arg), do: {:ok, arg}
        def handle_call(msg, _from, state), do: {:reply, msg, state}
      end
      """

      result = BeamAnalyzer.analyze("lib/my_worker.ex", source)

      func_nodes = Enum.filter(result.nodes, &(&1.type == "FUNCTION"))
      func_names = Enum.map(func_nodes, & &1.name)

      assert "init/1" in func_names
      assert "handle_call/3" in func_names
    end
  end

  describe "mixed protocol and behaviour in one file" do
    test "analyzes protocols.ex fixture" do
      source = File.read!(Path.join(__DIR__, "fixtures/protocols.ex"))
      result = BeamAnalyzer.analyze("test/fixtures/protocols.ex", source)

      module_nodes = Enum.filter(result.nodes, &(&1.type == "MODULE"))
      module_names = Enum.map(module_nodes, & &1.name)

      # Protocol
      assert "Stringify" in module_names
      # Implementations
      assert "Stringify.Map" in module_names
      assert "Stringify.List" in module_names
      # Regular module with @behaviour
      assert "MyWorker" in module_names

      # Protocol module should have kind: protocol
      stringify_mod = Enum.find(module_nodes, &(&1.name == "Stringify"))
      assert stringify_mod.metadata.kind == "protocol"

      # Impl modules should have kind: protocol_impl
      map_impl = Enum.find(module_nodes, &(&1.name == "Stringify.Map"))
      assert map_impl.metadata.kind == "protocol_impl"
      assert map_impl.metadata.protocol == "Stringify"

      list_impl = Enum.find(module_nodes, &(&1.name == "Stringify.List"))
      assert list_impl.metadata.kind == "protocol_impl"
      assert list_impl.metadata.for_type == "List"

      # IMPORT nodes: 2 for protocol_impls + 1 for @behaviour GenServer
      import_nodes = Enum.filter(result.nodes, &(&1.type == "IMPORT"))
      import_names = Enum.map(import_nodes, & &1.name)
      assert "Stringify" in import_names
      assert "GenServer" in import_names

      # Behaviour import should have kind: behaviour
      genserver_import = Enum.find(import_nodes, &(&1.name == "GenServer"))
      assert genserver_import.metadata.kind == "behaviour"

      # Protocol impl imports should have kind: protocol_impl
      protocol_imports = Enum.filter(import_nodes, &(&1.metadata.kind == "protocol_impl"))
      assert length(protocol_imports) == 2

      # All modules should have CONTAINS edges to their functions
      contains_edges = Enum.filter(result.edges, &(&1.type == "CONTAINS"))
      assert length(contains_edges) >= 4
    end
  end
end
