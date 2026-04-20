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

  describe "unicode source handling" do
    test "analyzes a file containing kanji and emoji without crashing" do
      source = File.read!(Path.join(__DIR__, "fixtures/unicode.ex"))
      result = BeamAnalyzer.analyze("test/fixtures/unicode.ex", source)

      module_names =
        result.nodes
        |> Enum.filter(&(&1.type == "MODULE"))
        |> Enum.map(& &1.name)

      assert "Ichi.Mamori" in module_names
      # Successful analysis has no `:errors` key; its presence signals a parse
      # failure (see BeamAnalyzer.analyze/2 error branch).
      refute Map.has_key?(result, :errors)

      # Round-trip through Jason — reproduces the stdio encoding path that
      # used to raise {:no_translation, :unicode, :latin1} on some hosts.
      assert {:ok, _encoded} = Jason.encode(result)
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

  # REG-1097: kami unresolved-CALL triage exposed three classes of analyzer
  # noise that account for ~37% of unresolved CALL nodes. None of these are
  # actual function call sites and they should not produce CALL nodes at all.
  describe "noise removal (REG-1097)" do
    defp call_names(source) do
      result = BeamAnalyzer.analyze("lib/noise.ex", source)

      result.nodes
      |> Enum.filter(&(&1.type == "CALL"))
      |> Enum.map(& &1.name)
    end

    test "operators and special forms are not CALL nodes" do
      source = """
      defmodule Noise.Ops do
        def run(a, b, list) do
          _arith = a + b - a * b / 1
          _cmp = a == b and a != b and a < b and a > b
          _bool = a && b || not a
          _membership = a in list
          _concat = "x" <> "y"
          _list_concat = [1, 2] ++ [3]
          _bits = <<1, 2, 3>>
          _map = %{key: :value}
          _tuple = {a, b}
          _try = try do
            :ok
          rescue
            _ -> :err
          end
          _sigil = ~r/foo/
          a
        end
      end
      """

      names = call_names(source)
      forbidden = [
        "+", "-", "*", "/", "==", "!=", "<", ">", "and", "or", "&&", "||",
        "not", "in", "<>", "++", "<<>>", "%{}", "{}", "try", "sigil_r",
        "rescue", "->", "=", "::", "@", "|"
      ]

      for op <- forbidden do
        refute op in names, "operator/special-form #{inspect(op)} should not produce a CALL node"
      end
    end

    test "<obj>.method placeholder calls are suppressed" do
      # When the receiver is the result of an expression rather than a simple
      # identifier, beam-analyzer used to emit a CALL with receiver "<obj>".
      # Such calls carry no resolvable information and are pure noise.
      source = """
      defmodule Noise.Obj do
        def run(state) do
          state.foo.bar()
          get_thing().some_method()
        end

        defp get_thing, do: %{}
      end
      """

      names = call_names(source)

      refute Enum.any?(names, &String.starts_with?(&1, "<obj>.")),
             "expected no <obj>.* placeholder calls, got: #{inspect(names)}"
    end

    test "struct field access is not classified as a zero-arg method call" do
      # `state.name` (no parens) is field access, not a function call.
      # Elixir AST tags this with the :no_parens marker on the dot meta.
      source = """
      defmodule Noise.Field do
        def run(state) do
          _name = state.name
          _other = state.queue_dir
          state
        end
      end
      """

      names = call_names(source)

      refute "state.name" in names,
             "field access state.name should not produce a CALL node, got: #{inspect(names)}"
      refute "state.queue_dir" in names,
             "field access state.queue_dir should not produce a CALL node, got: #{inspect(names)}"
    end

    test "real qualified function calls are still emitted" do
      # Regression guard: noise removal must not break legitimate Mod.fun() calls.
      source = """
      defmodule Noise.Real do
        def run do
          Enum.map([1, 2, 3], fn x -> x + 1 end)
          GenServer.call(:server, :ping)
        end
      end
      """

      names = call_names(source)
      assert "Enum.map" in names
      assert "GenServer.call" in names
    end
  end

  defp pnorm(src),
    do: BeamAnalyzer.Rules.Patterns.normalize(Code.string_to_quoted!(src))

  describe "Patterns (REG-1098 W1)" do
    alias BeamAnalyzer.Rules.Patterns

    # --- normalize/1 ---

    test "normalize: variable collapses to :_" do
      assert pnorm("x") == :_
    end

    test "normalize: wildcard collapses to :_" do
      assert pnorm("_") == :_
    end

    test "normalize: pinned var collapses to :_" do
      assert pnorm("^x") == :_
    end

    test "normalize: atom literal" do
      assert pnorm(":pay") == {:atom, :pay}
    end

    test "normalize: integer is :number" do
      assert pnorm("42") == :number
    end

    test "normalize: float is :number" do
      assert pnorm("3.14") == :number
    end

    test "normalize: binary string" do
      assert pnorm(~s|"hello"|) == {:str, "hello"}
    end

    test "normalize: 2-tuple" do
      assert pnorm("{:ok, result}") == {:tuple, [{:atom, :ok}, :_]}
    end

    test "normalize: N-tuple" do
      assert pnorm("{:event, source, data}") ==
               {:tuple, [{:atom, :event}, :_, :_]}
    end

    test "normalize: map with atom key" do
      assert pnorm(~s|%{type: "foo"}|) == {:map, [{:type, {:str, "foo"}}]}
    end

    test "normalize: struct with atom key" do
      assert pnorm("%Order{status: :pending}") ==
               {:struct, Order, [{:status, {:atom, :pending}}]}
    end

    test "normalize: plain list" do
      assert pnorm("[1, 2, 3]") == {:list, [:number, :number, :number]}
    end

    test "normalize: cons pattern [h | t]" do
      assert pnorm("[h | t]") == {:cons, :_, :_}
    end

    test "normalize: binding keeps the pattern side" do
      assert pnorm("%Order{} = order") == pnorm("%Order{}")
    end

    test "normalize: guarded pattern discards the guard" do
      assert pnorm("{:ok, x} when is_integer(x)") == pnorm("{:ok, x}")
    end

    test "normalize: map keys are canonically sorted" do
      a = pnorm(~s|%{type: "X", source: :q}|)
      b = pnorm(~s|%{source: :q, type: "X"}|)
      assert a == b
    end

    test "normalize: unrecognized AST is :unknown" do
      # function call is not a pattern literal
      assert Patterns.normalize({{:., [], [{:foo, [], nil}, :bar]}, [], []}) == :unknown
    end

    # --- describe_shape/1 ---

    test "describe_shape: wildcard and unknown collapse to _" do
      assert Patterns.describe_shape(:_) == "_"
      assert Patterns.describe_shape(:unknown) == "_"
    end

    test "describe_shape: atom head uses atom text" do
      assert Patterns.describe_shape({:atom, :tick}) == "tick"
      assert Patterns.describe_shape({:atom, :post_commit_fire}) == "post_commit_fire"
    end

    test "describe_shape: tuple is slash-joined" do
      shape =
        {:tuple,
         [{:atom, :reflect}, {:atom, :post_commit}, :_]}

      assert Patterns.describe_shape(shape) == "reflect/post_commit/_"
    end

    test "describe_shape: map is map{sorted,keys}" do
      shape = {:map, [{:type, {:atom, :done}}, {:source, {:atom, :queue}}]}
      assert Patterns.describe_shape(shape) == "map{source,type}"
    end

    test "describe_shape: struct uses short module name" do
      shape = {:struct, MyApp.Event, [{:kind, {:atom, :fire}}]}
      assert Patterns.describe_shape(shape) == "%Event{kind}"
    end

    test "describe_shape: labels are capped at 64 chars" do
      long_tuple =
        {:tuple, Enum.map(1..50, &{:atom, :"segment_#{&1}"})}

      label = Patterns.describe_shape(long_tuple)
      assert byte_size(label) <= 64
      assert String.ends_with?(label, "...")
    end

    # --- unify?/2 ---

    test "unify: :_ against anything is true (both directions)" do
      assert Patterns.unify?(:_, {:atom, :pay})
      assert Patterns.unify?({:atom, :pay}, :_)
    end

    test "unify: :unknown against anything is true (both directions)" do
      assert Patterns.unify?(:unknown, {:tuple, [:_, :_]})
      assert Patterns.unify?({:tuple, [:_, :_]}, :unknown)
    end

    test "unify: same atoms match" do
      assert Patterns.unify?({:atom, :pay}, {:atom, :pay})
    end

    test "unify: different atoms do not match" do
      refute Patterns.unify?({:atom, :pay}, {:atom, :refund})
    end

    test "unify: tuple with compatible elements" do
      send = {:tuple, [{:atom, :pay}, :_]}
      handler = {:tuple, [{:atom, :pay}, :number]}
      assert Patterns.unify?(send, handler)
    end

    test "unify: tuple with incompatible tag atoms" do
      a = {:tuple, [{:atom, :pay}, :_]}
      b = {:tuple, [{:atom, :refund}, :_]}
      refute Patterns.unify?(a, b)
    end

    test "unify: tuples of different arity do not match" do
      refute Patterns.unify?({:tuple, [:_, :_]}, {:tuple, [:_, :_, :_]})
    end

    test "unify: map with extra send-side keys still matches" do
      handler = {:map, [{:type, {:str, "X"}}]}
      send = {:map, [{:extra, :_}, {:type, {:str, "X"}}]}
      assert Patterns.unify?(send, handler)
    end

    test "unify: map with conflicting key value" do
      a = {:map, [{:type, {:str, "X"}}]}
      b = {:map, [{:type, {:str, "Y"}}]}
      refute Patterns.unify?(a, b)
    end

    test "unify: maps with disjoint keys are compatible" do
      a = {:map, [{:a, :number}]}
      b = {:map, [{:b, :number}]}
      assert Patterns.unify?(a, b)
    end

    test "unify: same struct with compatible fields" do
      a = {:struct, Order, [{:status, {:atom, :pending}}]}
      b = {:struct, Order, [{:status, :_}]}
      assert Patterns.unify?(a, b)
    end

    test "unify: different structs do not match" do
      a = {:struct, Order, [{:status, :_}]}
      b = {:struct, Refund, [{:status, :_}]}
      refute Patterns.unify?(a, b)
    end

    test "unify: struct against plain map" do
      a = {:struct, Order, [{:status, :_}]}
      b = {:map, [{:status, :_}]}
      assert Patterns.unify?(a, b)
      assert Patterns.unify?(b, a)
    end

    test "unify: cons against list" do
      assert Patterns.unify?({:cons, :_, :_}, {:list, [:_, :_]})
      assert Patterns.unify?({:list, [:_, :_]}, {:cons, :_, :_})
    end

    test "unify: Mamori regression — atoms do NOT unify with strings" do
      # kami Mamori:83/90 bug: handler clause used %{source: :queue, type: :enqueued}
      # while Phoenix.PubSub broadcast sent %{source: "queue", type: "enqueued"}.
      # These must NOT unify — the whole point of W1 is to catch atom-vs-string mismatch.
      handler = {:map, [{:source, {:atom, :queue}}, {:type, {:atom, :enqueued}}]}
      send = {:map, [{:source, {:str, "queue"}}, {:type, {:str, "enqueued"}}]}
      refute Patterns.unify?(send, handler)
      refute Patterns.unify?(handler, send)
    end

    test "unify: reflexivity on normalize output for typical patterns" do
      for src <- [
            ":pay",
            "42",
            ~s|"hello"|,
            "{:ok, x}",
            "{:event, a, b, c}",
            ~s|%{type: "X"}|,
            "%Order{status: :pending}",
            "[1, 2, 3]"
          ] do
        s = pnorm(src)
        assert Patterns.unify?(s, s), "expected #{inspect(s)} to unify with itself"
      end
    end

    # --- shape_to_meta/1 — JSON-safe serialization ---

    test "shape_to_meta: wildcard and unknown" do
      assert Patterns.shape_to_meta(:_) == ["wildcard"]
      assert Patterns.shape_to_meta(:unknown) == ["unknown"]
    end

    test "shape_to_meta: atom literal" do
      assert Patterns.shape_to_meta({:atom, :pay}) == ["atom", "pay"]
    end

    test "shape_to_meta: tuple with mixed contents" do
      assert Patterns.shape_to_meta(pnorm("{:ok, result}")) ==
               ["tuple", [["atom", "ok"], ["wildcard"]]]
    end

    test "shape_to_meta: map with atom key" do
      assert Patterns.shape_to_meta(pnorm(~s|%{type: "foo"}|)) ==
               ["map", [["type", ["str", "foo"]]]]
    end

    test "shape_to_meta: full result is Jason-encodable" do
      shapes = [
        pnorm("{:pay, amount}"),
        pnorm("_"),
        pnorm(":stop"),
        pnorm(~s|%{event: "click", target: t}|)
      ]

      for s <- shapes do
        assert {:ok, _} = Jason.encode(Patterns.shape_to_meta(s))
      end
    end
  end

  # ==================================================================
  # REG-1098 W2 — Handler message pattern extraction
  # ==================================================================

  describe "Handler pattern extraction (REG-1098 W2)" do
    # Fixture factory: embeds handler body inside a self-registering GenServer
    # so a PROCESS node exists and MESSAGE_TYPE nodes are emitted.
    defp w2_analyze(handler_source) do
      source = """
      defmodule W2.Server do
        use GenServer

        def start_link(arg) do
          GenServer.start_link(__MODULE__, arg, name: __MODULE__)
        end

      #{handler_source}
      end
      """

      BeamAnalyzer.analyze("lib/w2_server.ex", source)
    end

    defp msg_nodes(result),
      do: Enum.filter(result.nodes, &(&1.type == "MESSAGE_TYPE"))

    test "single-clause handle_call extracts tuple pattern shape" do
      result =
        w2_analyze("""
          def handle_call({:pay, amount}, _from, state) do
            {:reply, amount, state}
          end
        """)

      [msg] = msg_nodes(result)
      assert msg.name == "call:pay/_"
      assert msg.metadata.handler_type == "call"
      assert msg.metadata.shape_label == "pay/_"
      assert msg.metadata.catchall == false

      assert msg.metadata.pattern_shape ==
               ["tuple", [["atom", "pay"], ["wildcard"]]]
    end

    test "multi-clause handle_info produces distinct MESSAGE_TYPE nodes per clause" do
      result =
        w2_analyze("""
          def handle_info(:tick, state), do: {:noreply, state}
          def handle_info({:data, payload}, state), do: {:noreply, Map.put(state, :last, payload)}
          def handle_info(:stop, state), do: {:stop, :normal, state}
        """)

      msgs = msg_nodes(result) |> Enum.filter(&(&1.metadata.handler_type == "info"))
      assert length(msgs) == 3

      ids = Enum.map(msgs, & &1.id) |> Enum.uniq()
      assert length(ids) == 3

      names = Enum.map(msgs, & &1.name)
      assert "info:tick" in names
      assert "info:stop" in names
      assert "info:data/_" in names

      shapes = Enum.map(msgs, & &1.metadata.pattern_shape)
      assert ["atom", "tick"] in shapes
      assert ["atom", "stop"] in shapes
      assert ["tuple", [["atom", "data"], ["wildcard"]]] in shapes
    end

    test "wildcard handle_info is catchall" do
      result =
        w2_analyze("""
          def handle_info(_, state), do: {:noreply, state}
        """)

      [msg] = msg_nodes(result)
      assert msg.metadata.catchall == true
      assert msg.metadata.pattern_shape == ["wildcard"]
    end

    test "bare variable handle_info is catchall" do
      result =
        w2_analyze("""
          def handle_info(msg, state), do: {:noreply, [msg | state]}
        """)

      [msg] = msg_nodes(result)
      assert msg.metadata.catchall == true
    end

    test "guarded bare-variable handle_info is conservatively catchall" do
      result =
        w2_analyze("""
          def handle_info(msg, state) when is_atom(msg), do: {:noreply, state}
        """)

      [msg] = msg_nodes(result)
      assert msg.metadata.catchall == true
    end

    test "specific tuple handle_cast is not catchall" do
      result =
        w2_analyze("""
          def handle_cast({:enqueue, task}, state), do: {:noreply, [task | state]}
        """)

      [msg] = msg_nodes(result)
      assert msg.name == "cast:enqueue/_"
      assert msg.metadata.handler_type == "cast"
      assert msg.metadata.shape_label == "enqueue/_"
      assert msg.metadata.catchall == false

      assert msg.metadata.pattern_shape ==
               ["tuple", [["atom", "enqueue"], ["wildcard"]]]
    end

    test "clauses at different lines get distinct MESSAGE_TYPE ids" do
      result =
        w2_analyze("""
          def handle_cast(:a, state), do: {:noreply, state}
          def handle_cast(:b, state), do: {:noreply, state}
        """)

      msgs = msg_nodes(result) |> Enum.filter(&(&1.metadata.handler_type == "cast"))
      assert length(msgs) == 2
      [m1, m2] = msgs
      assert m1.id != m2.id
      assert m1.line != m2.line
      assert Enum.sort(Enum.map(msgs, & &1.name)) == ["cast:a", "cast:b"]
    end

    test "nested tuple clause produces slash-joined shape label" do
      result =
        w2_analyze("""
          def handle_info({:reflect, :post_commit, _meta}, state), do: {:noreply, state}
        """)

      [msg] = msg_nodes(result)
      assert msg.name == "info:reflect/post_commit/_"
      assert msg.metadata.shape_label == "reflect/post_commit/_"
    end

    test "map-pattern clause produces sorted key-list label" do
      result =
        w2_analyze("""
          def handle_info({:event, %{type: :done, source: :queue}}, state),
            do: {:noreply, state}
        """)

      [msg] = msg_nodes(result)
      assert msg.name == "info:event/map{source,type}"
    end

    test "wildcard catchall gets _ label, not generic kind" do
      result =
        w2_analyze("""
          def handle_info(_, state), do: {:noreply, state}
        """)

      [msg] = msg_nodes(result)
      assert msg.name == "info:_"
      assert msg.metadata.shape_label == "_"
      assert msg.metadata.catchall == true
    end

    test "HANDLES_IN and RECEIVES edges created for every clause" do
      result =
        w2_analyze("""
          def handle_info(:a, state), do: {:noreply, state}
          def handle_info(:b, state), do: {:noreply, state}
          def handle_info(:c, state), do: {:noreply, state}
        """)

      handles_in = Enum.filter(result.edges, &(&1.type == "HANDLES_IN"))
      receives = Enum.filter(result.edges, &(&1.type == "RECEIVES"))

      # 3 clauses -> 3 HANDLES_IN edges and 3 RECEIVES edges
      assert length(handles_in) == 3
      assert length(receives) == 3

      # All HANDLES_IN edges must target the same PROCESS node
      process_ids = handles_in |> Enum.map(& &1.dst) |> Enum.uniq()
      assert length(process_ids) == 1
    end

    test "full analysis result is Jason-encodable with pattern metadata" do
      result =
        w2_analyze("""
          def handle_call({:get, key}, _from, state), do: {:reply, Map.get(state, key), state}
          def handle_cast({:put, k, v}, state), do: {:noreply, Map.put(state, k, v)}
          def handle_info(_, state), do: {:noreply, state}
        """)

      assert {:ok, _} = Jason.encode(result)
    end
  end

  # ==================================================================
  # REG-1098 W3 — Send-site message pattern extraction
  # ==================================================================

  describe "Send pattern extraction (REG-1098 W3)" do
    # Fixture factory: wraps body inside a self-registering GenServer so a
    # PROCESS node exists and SENDS_TO edges are emitted by detect_message_send.
    defp w3_analyze(body_source) do
      source = """
      defmodule W3.Server do
        use GenServer

        def start_link(arg) do
          GenServer.start_link(__MODULE__, arg, name: __MODULE__)
        end

      #{body_source}
      end
      """

      BeamAnalyzer.analyze("lib/w3_server.ex", source)
    end

    defp sends_to_edges(result),
      do: Enum.filter(result.edges, &(&1.type == "SENDS_TO"))

    test "GenServer.call with tuple message captures shape" do
      result =
        w3_analyze("""
          def fetch(key) do
            GenServer.call(__MODULE__, {:get, key})
          end
        """)

      [edge] = sends_to_edges(result)
      assert edge.metadata.via == "GenServer.call"

      assert edge.metadata.message_shape ==
               ["tuple", [["atom", "get"], ["wildcard"]]]
    end

    test "GenServer.cast with atom message captures shape" do
      result =
        w3_analyze("""
          def reset do
            GenServer.cast(__MODULE__, :reset)
          end
        """)

      [edge] = sends_to_edges(result)
      assert edge.metadata.via == "GenServer.cast"
      assert edge.metadata.message_shape == ["atom", "reset"]
    end

    test "GenServer.cast with 3-tuple message captures shape" do
      result =
        w3_analyze("""
          def put(k, v) do
            GenServer.cast(__MODULE__, {:put, k, v})
          end
        """)

      [edge] = sends_to_edges(result)

      assert edge.metadata.message_shape ==
               ["tuple", [["atom", "put"], ["wildcard"], ["wildcard"]]]
    end

    test "send with literal number message captures shape" do
      result =
        w3_analyze("""
          def ping do
            send(__MODULE__, 42)
          end
        """)

      [edge] = sends_to_edges(result)
      assert edge.metadata.via == "send"
      assert edge.metadata.message_shape == ["number"]
    end

    test "GenServer.cast with map message captures shape" do
      result =
        w3_analyze("""
          def bump do
            GenServer.cast(__MODULE__, %{op: :increment})
          end
        """)

      [edge] = sends_to_edges(result)

      assert edge.metadata.message_shape ==
               ["map", [["op", ["atom", "increment"]]]]
    end

    test "non-sender calls do not produce SENDS_TO edges or message_shape" do
      result =
        w3_analyze("""
          def mapper(list) do
            Enum.map(list, fn x -> x end)
          end
        """)

      # Enum.map is not a message sender: no SENDS_TO edge from this call.
      enum_edges =
        Enum.filter(result.edges, fn e ->
          e.type == "SENDS_TO" and
            Enum.any?(result.nodes, fn n -> n.id == e.src and n.name == "Enum.map" end)
        end)

      assert enum_edges == []

      # And the CALL node for Enum.map must not have a stray message_shape.
      call =
        Enum.find(result.nodes, fn n -> n.type == "CALL" and n.name == "Enum.map" end)

      refute Map.has_key?(call.metadata, :message_shape)
    end

    defp call_node(result, name) do
      Enum.find(result.nodes, fn n -> n.type == "CALL" and n.name == name end)
    end

    test "self() target marks target_is_self=true on CALL and edge" do
      result =
        w3_analyze("""
          def start do
            Process.send_after(self(), :tick, 1000)
          end
        """)

      call = call_node(result, "Process.send_after")
      assert call.metadata.target_is_self == true
      assert call.metadata.sender_via == "info"
      assert call.metadata.sender_base == "Process.send_after"
      assert call.metadata.message_shape == ["atom", "tick"]

      [edge] = sends_to_edges(result)
      assert edge.metadata.target_is_self == true
    end

    test "__MODULE__ target marks target_is_self=true" do
      result =
        w3_analyze("""
          def fetch(key), do: GenServer.call(__MODULE__, {:get, key})
        """)

      call = call_node(result, "GenServer.call")
      assert call.metadata.target_is_self == true
      assert call.metadata.sender_via == "call"
      assert call.metadata.target_hint == "W3.Server"
    end

    test "literal alias matching current module marks target_is_self=true" do
      result =
        w3_analyze("""
          def fetch(key), do: GenServer.call(W3.Server, {:get, key})
        """)

      call = call_node(result, "GenServer.call")
      assert call.metadata.target_is_self == true
      assert call.metadata.target_hint == "W3.Server"
    end

    test "external module alias is not self, target_hint captures it" do
      result =
        w3_analyze("""
          def delegate(msg), do: GenServer.cast(Some.Other.Server, msg)
        """)

      call = call_node(result, "GenServer.cast")
      assert call.metadata.target_is_self == false
      assert call.metadata.target_hint == "Some.Other.Server"
      assert call.metadata.sender_via == "cast"
    end

    test "bare variable target is not self and has no target_hint" do
      result =
        w3_analyze("""
          def fwd(pid, msg), do: send(pid, msg)
        """)

      call = call_node(result, "send")
      assert call.metadata.target_is_self == false
      refute Map.has_key?(call.metadata, :target_hint)
      assert call.metadata.sender_via == "info"
    end

    test "self() bound to variable is tracked: send(me, _) is self-directed" do
      # Elixir idiom: `me = self()` then pass `me` into a spawned
      # Task closure so the task can send messages back to the
      # starter process. Before self-alias tracking, `send(me, msg)`
      # looked like a send to a bare var (target_is_self=false) and
      # never resolved to a handler.
      result =
        w3_analyze("""
          def start do
            me = self()
            send(me, :tick)
          end
        """)

      call = call_node(result, "send")
      assert call.metadata.target_is_self == true
    end

    test "unrelated var assignment does not mark send as self-directed" do
      result =
        w3_analyze("""
          def relay(pid) do
            me = pid
            send(me, :tick)
          end
        """)

      call = call_node(result, "send")
      assert call.metadata.target_is_self == false
    end

    test "self-alias tracking is scoped to the function — doesn't leak" do
      result =
        w3_analyze("""
          def first do
            me = self()
            send(me, :a)
          end

          def second(pid) do
            send(me, :b)
          end
        """)

      calls = Enum.filter(result.nodes, &(&1.type == "CALL" and &1.name == "send"))
      [call_first, call_second] = Enum.sort_by(calls, & &1.line)
      assert call_first.metadata.target_is_self == true
      # `me` in second/1 is unbound (would be a compile error in real
      # code but walker must still not carry over the alias).
      assert call_second.metadata.target_is_self == false
    end

    test "Process.send_after is recognised as a message sender" do
      result =
        w3_analyze("""
          def schedule, do: Process.send_after(self(), :tick, 1000)
        """)

      [edge] = sends_to_edges(result)
      assert edge.metadata.via == "Process.send_after"
      assert edge.metadata.message_shape == ["atom", "tick"]
    end

    test "SENDS_TO edge still carries via field alongside message_shape" do
      result =
        w3_analyze("""
          def reset do
            GenServer.cast(__MODULE__, :reset)
          end
        """)

      [edge] = sends_to_edges(result)
      assert edge.metadata.via == "GenServer.cast"
      assert Map.has_key?(edge.metadata, :message_shape)
    end

    test "full analysis result with send sites is Jason-encodable" do
      result =
        w3_analyze("""
          def fetch(key), do: GenServer.call(__MODULE__, {:get, key})
          def put(k, v), do: GenServer.cast(__MODULE__, {:put, k, v})
          def ping, do: send(__MODULE__, 42)
        """)

      assert {:ok, _} = Jason.encode(result)
      assert length(sends_to_edges(result)) == 3
    end
  end

  # ==================================================================
  # try / rescue / catch / after body walking
  # ==================================================================

  describe "try-body walking" do
    # Calls inside `try do ... rescue/catch/after/else ... end` must be
    # indexed like any other expression. Before this pass, sends inside
    # protected blocks were invisible — `send(Ichi.Naikan, {:reflect, :force})`
    # in `ichi/dashboard.ex` produced no CALL/SENDS_TO nodes at all,
    # silently turning Naikan's `handle_info({:reflect, :force}, _)`
    # into a "dead" handler in the graph.
    defp try_analyze(body_source) do
      source = """
      defmodule Try.Server do
        def run do
      #{body_source}
        end
      end
      """

      BeamAnalyzer.analyze("lib/try_server.ex", source)
    end

    defp try_call_names(result),
      do: result.nodes |> Enum.filter(&(&1.type == "CALL")) |> Enum.map(& &1.name)

    test "send inside try-do body is indexed" do
      result =
        try_analyze("""
          try do
            send(Ichi.Naikan, {:reflect, :force})
          rescue
            _ -> :ok
          end
        """)

      assert "send" in try_call_names(result)
    end

    test "call inside rescue clause is indexed" do
      result =
        try_analyze("""
          try do
            :ok
          rescue
            _ -> Logger.error("boom")
          end
        """)

      assert "Logger.error" in try_call_names(result)
    end

    test "call inside catch clause is indexed" do
      result =
        try_analyze("""
          try do
            :ok
          catch
            :exit, _ -> Logger.warning("exit caught")
          end
        """)

      assert "Logger.warning" in try_call_names(result)
    end

    test "call inside after block is indexed" do
      result =
        try_analyze("""
          try do
            :ok
          after
            File.close(:fd)
          end
        """)

      assert "File.close" in try_call_names(result)
    end

    test "call inside else clause is indexed" do
      result =
        try_analyze("""
          try do
            :ok
          else
            _ -> IO.puts("done")
          end
        """)

      assert "IO.puts" in try_call_names(result)
    end

    test "all sections walked — do + rescue + after" do
      result =
        try_analyze("""
          try do
            do_work()
          rescue
            _ -> rescue_work()
          after
            after_work()
          end
        """)

      names = try_call_names(result)
      assert "do_work" in names
      assert "rescue_work" in names
      assert "after_work" in names
    end

    test "try emits a BRANCH node" do
      result =
        try_analyze("""
          try do
            :ok
          rescue
            _ -> :ok
          end
        """)

      branches = Enum.filter(result.nodes, &(&1.type == "BRANCH"))
      assert Enum.any?(branches, &(&1.name == "try"))
    end

    test "Plug.Router regression: send inside block-style macro do-end is walked" do
      # Real shape from ichi/dashboard.ex: `post "/admin/reflect" do send(...) end`.
      # AST: {:post, meta, ["/admin/reflect", [do: body]]}. The `[do: body]`
      # is a keyword-list argument, not a `{:do, body}` tuple — walk_call_args
      # must descend into it. Before the fix, every Plug.Router/Phoenix route
      # body was invisible to the graph.
      source = """
      defmodule Routes do
        post "/admin/reflect" do
          send(Ichi.Naikan, {:reflect, :force})
          :ok
        end
      end
      """

      result = BeamAnalyzer.analyze("lib/routes.ex", source)

      call =
        Enum.find(result.nodes, fn n -> n.type == "CALL" and n.name == "send" end)

      assert call != nil
      assert call.metadata.target_hint == "Ichi.Naikan"
      assert call.metadata.message_shape ==
               ["tuple", [["atom", "reflect"], ["atom", "force"]]]
    end

    test "dashboard.ex regression: send to external module lands as SENDS_TO" do
      # Exact shape of ichi/dashboard.ex:723 — the false-negative that
      # made Naikan's {:reflect, :force} handler look dead.
      result = try_analyze("""
        try do
          send(Ichi.Naikan, {:reflect, :force})
        rescue
          _ -> :error
        end
      """)

      call =
        Enum.find(result.nodes, fn n -> n.type == "CALL" and n.name == "send" end)

      assert call != nil
      assert call.metadata.sender_via == "info"
      assert call.metadata.target_hint == "Ichi.Naikan"
      assert call.metadata.target_is_self == false

      assert call.metadata.message_shape ==
               ["tuple", [["atom", "reflect"], ["atom", "force"]]]
    end
  end

  describe "Wrapper detection (REG-1098 W5)" do
    defp w5_analyze(body_source) do
      source = """
      defmodule W5.Server do
        use GenServer

        def start_link(arg) do
          GenServer.start_link(__MODULE__, arg, name: __MODULE__)
        end

      #{body_source}
      end
      """

      BeamAnalyzer.analyze("lib/w5_server.ex", source)
    end

    defp wraps_for(result, fn_name) do
      node = Enum.find(result.nodes, fn n -> n.type == "FUNCTION" and n.name == fn_name end)
      assert node, "missing FUNCTION node #{fn_name}"
      Map.get(node.metadata, :wraps)
    end

    test "GenServer.cast wrapper to __MODULE__" do
      result =
        w5_analyze("""
          def emit(src, type, data) do
            GenServer.cast(__MODULE__, {:emit, src, type, data})
          end
        """)

      wraps = wraps_for(result, "emit/3")
      assert wraps.kind == :cast
      assert wraps.target == :module_self
      assert wraps.target_hint == nil

      assert wraps.message_shape ==
               ["tuple", [["atom", "emit"], ["wildcard"], ["wildcard"], ["wildcard"]]]
    end

    test "GenServer.call wrapper with default arg" do
      result =
        w5_analyze("""
          def pending(consumer \\\\ :kutisabi) do
            GenServer.call(__MODULE__, {:flush_pending, consumer})
          end
        """)

      wraps = wraps_for(result, "pending/1")
      assert wraps.kind == :call
      assert wraps.target == :module_self

      assert wraps.message_shape ==
               ["tuple", [["atom", "flush_pending"], ["wildcard"]]]
    end

    test "variable-target GenServer.cast wrapper" do
      result =
        w5_analyze("""
          def send_to_worker(pid, msg) do
            GenServer.cast(pid, msg)
          end
        """)

      wraps = wraps_for(result, "send_to_worker/2")
      assert wraps.kind == :cast
      assert wraps.target == :var
      assert wraps.target_hint == nil
      assert wraps.message_shape == ["wildcard"]
    end

    test "aliased-module GenServer.cast wrapper" do
      result =
        w5_analyze("""
          def notify_event_bus(data) do
            GenServer.cast(Ichi.EventBus, {:data, data})
          end
        """)

      wraps = wraps_for(result, "notify_event_bus/1")
      assert wraps.kind == :cast
      assert wraps.target == :literal
      assert wraps.target_hint == "Elixir.Ichi.EventBus"
      assert wraps.message_shape == ["tuple", [["atom", "data"], ["wildcard"]]]
    end

    test "bare send/2 wrapper to __MODULE__" do
      result =
        w5_analyze("""
          def ping do
            send(__MODULE__, :ping)
          end
        """)

      wraps = wraps_for(result, "ping/0")
      assert wraps.kind == :send
      assert wraps.target == :module_self
      assert wraps.message_shape == ["atom", "ping"]
    end

    test "Process.send_after wrapper" do
      result =
        w5_analyze("""
          def schedule(delay) do
            Process.send_after(__MODULE__, :tick, delay)
          end
        """)

      wraps = wraps_for(result, "schedule/1")
      assert wraps.kind == :send_after
      assert wraps.target == :module_self
      assert wraps.message_shape == ["atom", "tick"]
    end

    test "Phoenix.PubSub.subscribe wrapper with literal topic" do
      result =
        w5_analyze("""
          def subscribe do
            Phoenix.PubSub.subscribe(Ichi.PubSub, "events")
          end
        """)

      wraps = wraps_for(result, "subscribe/0")
      assert wraps.kind == :sub
      assert wraps.target == :literal
      assert wraps.topic == "events"
      assert wraps.message_shape == nil
    end

    test "Phoenix.PubSub.broadcast wrapper with literal topic" do
      result =
        w5_analyze("""
          def broadcast_event(event) do
            Phoenix.PubSub.broadcast(Ichi.PubSub, "events", {:event, event})
          end
        """)

      wraps = wraps_for(result, "broadcast_event/1")
      assert wraps.kind == :broadcast
      assert wraps.topic == "events"
      assert wraps.message_shape == ["tuple", [["atom", "event"], ["wildcard"]]]
    end

    test "multi-statement body is NOT a wrapper" do
      result =
        w5_analyze("""
          def complicated(x) do
            _ = x
            GenServer.cast(__MODULE__, {:msg, x})
          end
        """)

      assert wraps_for(result, "complicated/1") == nil
    end

    test "private def is NOT a wrapper" do
      result =
        w5_analyze("""
          defp emit(src, type, data) do
            GenServer.cast(__MODULE__, {:emit, src, type, data})
          end
        """)

      assert wraps_for(result, "emit/3") == nil
    end

    test "handler callback is NOT a wrapper" do
      result =
        w5_analyze("""
          def handle_cast({:forward, msg}, state) do
            GenServer.cast(__MODULE__, msg)
            {:noreply, state}
          end
        """)

      # Even if the body were single-expression, handle_cast is a callback.
      assert wraps_for(result, "handle_cast/2") == nil
    end

    test "regular arithmetic function is NOT a wrapper" do
      result =
        w5_analyze("""
          def compute(x) do
            x * 2
          end
        """)

      assert wraps_for(result, "compute/1") == nil
    end

    test "Phoenix.PubSub.subscribe with dynamic topic is NOT a wrapper" do
      result =
        w5_analyze("""
          def subscribe(topic) do
            Phoenix.PubSub.subscribe(Ichi.PubSub, topic)
          end
        """)

      assert wraps_for(result, "subscribe/1") == nil
    end

    test "first arg `server \\\\ __MODULE__` promotes target from :var to :module_self" do
      # Canonical public-API shape: accept server override, default to __MODULE__.
      # W5's single-expression detector only sees the body `GenServer.call(server, ...)`
      # and marks target as :var — functions.ex must refine to :module_self using
      # the function params.
      result =
        w5_analyze("""
          def upsert(server \\\\ __MODULE__, id, record) do
            GenServer.call(server, {:upsert, id, record})
          end
        """)

      wraps = wraps_for(result, "upsert/3")
      assert wraps.kind == :call
      assert wraps.target == :module_self
    end

    test "var target stays :var when first arg has no __MODULE__ default" do
      result =
        w5_analyze("""
          def forward(pid, msg) do
            send(pid, msg)
          end
        """)

      wraps = wraps_for(result, "forward/2")
      assert wraps.kind == :send
      assert wraps.target == :var
    end

    test "literal target is not overridden by default-arg refinement" do
      result =
        w5_analyze("""
          def tick(msg) do
            send(Ichi.Scheduler, msg)
          end
        """)

      wraps = wraps_for(result, "tick/1")
      assert wraps.kind == :send
      assert wraps.target == :literal
      assert wraps.target_hint == "Elixir.Ichi.Scheduler"
    end

    test "full analysis with 3 wrappers is Jason-encodable" do
      result =
        w5_analyze("""
          def emit(src, type, data), do: GenServer.cast(__MODULE__, {:emit, src, type, data})
          def subscribe, do: Phoenix.PubSub.subscribe(Ichi.PubSub, "events")
          def ping, do: send(__MODULE__, :ping)
        """)

      assert {:ok, _} = Jason.encode(result)
      assert wraps_for(result, "emit/3").kind == :cast
      assert wraps_for(result, "subscribe/0").kind == :sub
      assert wraps_for(result, "ping/0").kind == :send
    end
  end

  describe "PubSub topology (REG-1098 W7)" do
    defp w7_analyze(body_source) do
      source = """
      defmodule W7.Server do
        use GenServer

        def start_link(arg) do
          GenServer.start_link(__MODULE__, arg, name: __MODULE__)
        end

      #{body_source}
      end
      """

      BeamAnalyzer.analyze("lib/w7_server.ex", source)
    end

    defp topics(result),
      do: Enum.filter(result.nodes, fn n -> n.type == "PUBSUB_TOPIC" end)

    defp subscribe_edges(result),
      do: Enum.filter(result.edges, fn e -> e.type == "SUBSCRIBES_TO" end)

    defp broadcast_edges(result),
      do: Enum.filter(result.edges, fn e -> e.type == "BROADCASTS_TO" end)

    defp module_id(result) do
      result.nodes
      |> Enum.find(fn n -> n.type == "MODULE" end)
      |> Map.fetch!(:id)
    end

    test "simple subscribe emits PUBSUB_TOPIC and SUBSCRIBES_TO" do
      result =
        w7_analyze("""
          def init(_) do
            Phoenix.PubSub.subscribe(Ichi.PubSub, "events")
            {:ok, %{}}
          end
        """)

      assert [topic] = topics(result)
      assert topic.id == "<pubsub>->PUBSUB_TOPIC->Ichi.PubSub[topic:events]"
      assert topic.name == "events"
      assert topic.file == "<pubsub>"
      assert topic.metadata == %{pubsub: "Ichi.PubSub", topic: "events"}

      assert [edge] = subscribe_edges(result)
      assert edge.src == module_id(result)
      assert edge.dst == topic.id
      assert edge.metadata == %{via: "Phoenix.PubSub.subscribe"}
    end

    test "simple broadcast emits PUBSUB_TOPIC and BROADCASTS_TO with message_shape" do
      result =
        w7_analyze("""
          def emit_event do
            Phoenix.PubSub.broadcast(Ichi.PubSub, "events", {:event, :hello})
          end
        """)

      assert [topic] = topics(result)
      assert topic.id == "<pubsub>->PUBSUB_TOPIC->Ichi.PubSub[topic:events]"

      assert [edge] = broadcast_edges(result)
      assert edge.dst == topic.id
      # Source is a CALL node that must exist in the graph
      assert Enum.any?(result.nodes, fn n -> n.type == "CALL" and n.id == edge.src end)
      assert edge.metadata.via == "Phoenix.PubSub.broadcast"

      assert edge.metadata.message_shape ==
               ["tuple", [["atom", "event"], ["atom", "hello"]]]
    end

    test "broadcast!, broadcast_from, local_broadcast all produce BROADCASTS_TO" do
      for op <- ["broadcast!", "broadcast_from", "local_broadcast"] do
        args =
          case op do
            # Phoenix.PubSub.broadcast_from(pubsub, from, topic, message)
            "broadcast_from" -> "Ichi.PubSub, self(), \"events\", :hi"
            _ -> "Ichi.PubSub, \"events\", :hi"
          end

        result =
          w7_analyze("""
            def emit_event do
              Phoenix.PubSub.#{op}(#{args})
            end
          """)

        assert [_topic] = topics(result), "missing topic for #{op}"
        assert [edge] = broadcast_edges(result), "missing BROADCASTS_TO for #{op}"
        assert edge.metadata.via == "Phoenix.PubSub.#{op}"
      end
    end

    test "two subscribes to same topic share one PUBSUB_TOPIC node but produce two edges" do
      result =
        w7_analyze("""
          def init(_) do
            Phoenix.PubSub.subscribe(Ichi.PubSub, "events")
            Phoenix.PubSub.subscribe(Ichi.PubSub, "events")
            {:ok, %{}}
          end
        """)

      assert [_single_topic] = topics(result)
      assert length(subscribe_edges(result)) == 2
    end

    test "different topics produce different PUBSUB_TOPIC nodes" do
      result =
        w7_analyze("""
          def init(_) do
            Phoenix.PubSub.subscribe(Ichi.PubSub, "events")
            Phoenix.PubSub.subscribe(Ichi.PubSub, "metrics")
            {:ok, %{}}
          end
        """)

      ts = topics(result)
      assert length(ts) == 2
      names = ts |> Enum.map(& &1.name) |> Enum.sort()
      assert names == ["events", "metrics"]
    end

    test "cross-module subscribes share one PUBSUB_TOPIC node" do
      source = """
      defmodule W7.A do
        def init(_), do: Phoenix.PubSub.subscribe(Ichi.PubSub, "events")
      end

      defmodule W7.B do
        def init(_), do: Phoenix.PubSub.subscribe(Ichi.PubSub, "events")
      end
      """

      result = BeamAnalyzer.analyze("lib/w7_multi.ex", source)

      assert [_single_topic] = topics(result)
      edges = subscribe_edges(result)
      assert length(edges) == 2

      module_ids =
        result.nodes
        |> Enum.filter(fn n -> n.type == "MODULE" end)
        |> Enum.map(& &1.id)
        |> MapSet.new()

      edge_sources = edges |> Enum.map(& &1.src) |> MapSet.new()
      assert MapSet.equal?(edge_sources, module_ids)
    end

    test "dynamic topic is skipped (no topic node, no edge)" do
      result =
        w7_analyze("""
          def sub(topic), do: Phoenix.PubSub.subscribe(Ichi.PubSub, topic)
        """)

      assert topics(result) == []
      assert subscribe_edges(result) == []
    end

    test "dynamic pubsub server is skipped" do
      result =
        w7_analyze("""
          def sub(server), do: Phoenix.PubSub.subscribe(server, "events")
        """)

      assert topics(result) == []
      assert subscribe_edges(result) == []
    end

    test "full analysis with subscribe + broadcast is Jason-encodable" do
      result =
        w7_analyze("""
          def init(_) do
            Phoenix.PubSub.subscribe(Ichi.PubSub, "events")
            {:ok, %{}}
          end

          def emit do
            Phoenix.PubSub.broadcast(Ichi.PubSub, "events", {:event, :hi})
          end
        """)

      assert {:ok, _} = Jason.encode(result)
      assert [_topic] = topics(result)
      assert length(subscribe_edges(result)) == 1
      assert length(broadcast_edges(result)) == 1
    end

    test "non-pubsub dot-calls do not produce spurious topic nodes" do
      result =
        w7_analyze("""
          def init(_) do
            Phoenix.PubSub.subscribe(Ichi.PubSub, "events")
            Enum.map([1, 2, 3], fn x -> x end)
            {:ok, %{}}
          end
        """)

      assert [topic] = topics(result)
      assert topic.name == "events"
    end

    test "subscribe in handle_info callback still produces MODULE-sourced edge" do
      result =
        w7_analyze("""
          def handle_info(:resubscribe, state) do
            Phoenix.PubSub.subscribe(Ichi.PubSub, "events")
            {:noreply, state}
          end
        """)

      assert [_topic] = topics(result)
      assert [edge] = subscribe_edges(result)
      assert edge.src == module_id(result)
    end
  end

  # ==================================================================
  # REG-1098 W8 — Handler body effect scanning
  # ==================================================================

  describe "Handler body effect scanning (REG-1098 W8)" do
    defp w8_analyze(handler_source) do
      source = """
      defmodule W8.Server do
        use GenServer

        def start_link(arg) do
          GenServer.start_link(__MODULE__, arg, name: __MODULE__)
        end

      #{handler_source}
      end
      """

      BeamAnalyzer.analyze("lib/w8_server.ex", source)
    end

    defp w8_msgs(result),
      do: Enum.filter(result.nodes, &(&1.type == "MESSAGE_TYPE"))

    test "silent handler: body is only a tuple literal" do
      result =
        w8_analyze("""
          def handle_info({:rotate, _}, state), do: {:noreply, state}
        """)

      [msg] = w8_msgs(result)
      assert msg.metadata.body_total_calls == 0
      assert msg.metadata.body_effects == []
    end

    test "Logger.info is classified as effect and counts as call" do
      result =
        w8_analyze("""
          def handle_info(:tick, state) do
            Logger.info("tick")
            {:noreply, state}
          end
        """)

      [msg] = w8_msgs(result)
      assert msg.metadata.body_total_calls == 1
      assert msg.metadata.body_effects == ["Logger.info"]
    end

    test "local helper call counts in total but not in effects" do
      result =
        w8_analyze("""
          def handle_info({:update, x}, state), do: do_update(state, x)
        """)

      [msg] = w8_msgs(result)
      assert msg.metadata.body_total_calls == 1
      assert msg.metadata.body_effects == []
    end

    test "GenServer.cast is classified as effect" do
      result =
        w8_analyze("""
          def handle_cast(:forward, state) do
            GenServer.cast(__MODULE__, :again)
            {:noreply, state}
          end
        """)

      [msg] = w8_msgs(result)
      assert "GenServer.cast" in msg.metadata.body_effects
    end

    test "Phoenix.PubSub.broadcast is classified as effect" do
      result =
        w8_analyze("""
          def handle_info(:emit, state) do
            Phoenix.PubSub.broadcast(Ichi.PubSub, "events", :msg)
            {:noreply, state}
          end
        """)

      [msg] = w8_msgs(result)
      assert "Phoenix.PubSub.broadcast" in msg.metadata.body_effects
    end

    test "multiple effects are deduped and sorted" do
      result =
        w8_analyze("""
          def handle_info(:do_all, state) do
            Logger.info("hi")
            File.write!("/tmp/x", "a")
            Phoenix.PubSub.broadcast(Ichi.PubSub, "events", :msg)
            Logger.info("bye")
            {:noreply, state}
          end
        """)

      [msg] = w8_msgs(result)

      assert msg.metadata.body_effects == [
               "File.write!",
               "Logger.info",
               "Phoenix.PubSub.broadcast"
             ]
    end

    test "effect inside a pipe is detected" do
      result =
        w8_analyze("""
          def handle_info(:tick, state) do
            :ok |> Logger.info()
            {:noreply, state}
          end
        """)

      [msg] = w8_msgs(result)
      assert "Logger.info" in msg.metadata.body_effects
    end

    test "effect inside case branch is counted" do
      result =
        w8_analyze("""
          def handle_info({:foo, x}, state) do
            case x do
              :a -> Logger.info("a")
              _ -> :noop
            end
            {:noreply, state}
          end
        """)

      [msg] = w8_msgs(result)
      assert msg.metadata.body_total_calls >= 1
      assert "Logger.info" in msg.metadata.body_effects
    end

    test "counters reset per clause (multi-clause handler)" do
      result =
        w8_analyze("""
          def handle_info(:silent, state), do: {:noreply, state}
          def handle_info(:loud, state) do
            Logger.info("loud")
            {:noreply, state}
          end
        """)

      msgs =
        w8_msgs(result)
        |> Enum.filter(&(&1.metadata.handler_type == "info"))
        |> Enum.sort_by(& &1.line)

      assert length(msgs) == 2
      [silent, loud] = msgs
      assert silent.metadata.body_total_calls == 0
      assert silent.metadata.body_effects == []
      assert loud.metadata.body_total_calls >= 1
      assert "Logger.info" in loud.metadata.body_effects
    end

    test "operators and tuple construction do not count as calls" do
      result =
        w8_analyze("""
          def handle_info(:math, state), do: {:noreply, state + 1}
        """)

      [msg] = w8_msgs(result)
      assert msg.metadata.body_total_calls == 0
      assert msg.metadata.body_effects == []
    end

    test "sigils do not count as calls" do
      result =
        w8_analyze("""
          def handle_info({:url, _s}, state) do
            _m = ~r/hello/
            {:noreply, state}
          end
        """)

      [msg] = w8_msgs(result)
      assert msg.metadata.body_total_calls == 0
      assert msg.metadata.body_effects == []
    end

    test "full analysis result with silent + effectful clauses is Jason-encodable" do
      result =
        w8_analyze("""
          def handle_info(:silent, state), do: {:noreply, state}
          def handle_info(:loud, state) do
            Logger.info("loud")
            {:noreply, state}
          end
        """)

      assert {:ok, _} = Jason.encode(result)
    end
  end
end
