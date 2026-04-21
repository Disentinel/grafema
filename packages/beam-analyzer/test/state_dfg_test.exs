defmodule BeamAnalyzer.Rules.StateDFGTest do
  use ExUnit.Case, async: true

  alias BeamAnalyzer.Rules.StateDFG

  defp body(src) do
    {:ok, ast} = Code.string_to_quoted(src)
    ast
  end

  describe "writes — names only" do
    test "map update %{state | field: _}" do
      r = StateDFG.extract(body("%{state | foo: 1}"))
      assert r.writes == ["foo"]
    end

    test "map update with multiple fields" do
      r = StateDFG.extract(body("%{state | foo: 1, bar: 2, baz: 3}"))
      assert r.writes == ["bar", "baz", "foo"]
    end

    test "struct update %Struct{state | field: _}" do
      r = StateDFG.extract(body("%MyMod{state | paused: true}"))
      assert r.writes == ["paused"]
    end

    test "Map.put(state, :field, _)" do
      r = StateDFG.extract(body("Map.put(state, :queue, [])"))
      assert r.writes == ["queue"]
    end

    test "Map.delete(state, :field)" do
      r = StateDFG.extract(body("Map.delete(state, :stale_ref)"))
      assert r.writes == ["stale_ref"]
    end

    test "Map.update!(state, :counter, fn)" do
      r = StateDFG.extract(body("Map.update!(state, :counter, &(&1 + 1))"))
      assert r.writes == ["counter"]
    end

    test "nested update inside return tuple" do
      r = StateDFG.extract(body("{:noreply, %{state | last: now}}"))
      assert r.writes == ["last"]
    end

    test "ignores writes against a variable not named `state`" do
      r = StateDFG.extract(body("%{other | field: 1}"))
      assert r.writes == []
    end
  end

  describe "writes — value classification" do
    test "literal true → writes_truthy" do
      r = StateDFG.extract(body("%{state | paused: true}"))
      assert r.writes == ["paused"]
      assert r.writes_truthy == ["paused"]
      assert r.writes_falsy == []
    end

    test "literal false → writes_falsy" do
      r = StateDFG.extract(body("%{state | paused: false}"))
      assert r.writes == ["paused"]
      assert r.writes_truthy == []
      assert r.writes_falsy == ["paused"]
    end

    test "nil → writes_falsy" do
      r = StateDFG.extract(body("%{state | task: nil}"))
      assert r.writes == ["task"]
      assert r.writes_falsy == ["task"]
    end

    test "atom → writes_truthy" do
      r = StateDFG.extract(body("%{state | mode: :running}"))
      assert r.writes_truthy == ["mode"]
    end

    test "integer → writes_truthy" do
      r = StateDFG.extract(body("%{state | count: 0}"))
      assert r.writes_truthy == ["count"]
    end

    test "dynamic RHS lands in writes_dynamic, not truthy/falsy" do
      r = StateDFG.extract(body("%{state | x: other_var, y: compute()}"))
      assert r.writes == ["x", "y"]
      assert r.writes_dynamic == ["x", "y"]
      assert r.writes_truthy == []
      assert r.writes_falsy == []
    end

    test "Map.put with literal RHS classified" do
      r = StateDFG.extract(body("Map.put(state, :running, true)"))
      assert r.writes_truthy == ["running"]
    end

    test "Map.delete is classified as falsy (subsequent read returns nil)" do
      r = StateDFG.extract(body("Map.delete(state, :ref)"))
      assert r.writes == ["ref"]
      assert r.writes_falsy == ["ref"]
    end

    test "Map.update!/3 is classified as dynamic" do
      r = StateDFG.extract(body("Map.update!(state, :counter, &(&1 + 1))"))
      assert r.writes == ["counter"]
      assert r.writes_dynamic == ["counter"]
    end
  end

  describe "guards" do
    test "if state.field → guards_truthy" do
      r = StateDFG.extract(body("if state.running, do: :go"))
      assert r.guards == ["running"]
      assert r.guards_truthy == ["running"]
    end

    test "unless state.field → guards_truthy" do
      r = StateDFG.extract(body("unless state.halted, do: :go"))
      assert r.guards_truthy == ["halted"]
    end

    test "case state.field → guards (plain), NOT guards_truthy" do
      r =
        StateDFG.extract(
          body("""
          case state.mode do
            :a -> 1
            :b -> 2
          end
          """)
        )

      assert r.guards == ["mode"]
      assert r.guards_truthy == []
    end

    test "case Map.get(state, :field) → guards" do
      r =
        StateDFG.extract(
          body("""
          case Map.get(state, :stash) do
            nil -> :none
            v -> v
          end
          """)
        )

      assert r.guards == ["stash"]
    end
  end

  describe "extract_init" do
    test "init map literal captures keys and classifies values" do
      r =
        StateDFG.extract_init(
          body("""
          {:ok, %{paused: false, counter: 0, task: nil}}
          """)
        )

      assert r.writes == ["counter", "paused", "task"]
      assert r.writes_truthy == ["counter"]
      assert r.writes_falsy == ["paused", "task"]
    end

    test "init struct literal" do
      r =
        StateDFG.extract_init(
          body("""
          {:ok, %__MODULE__{running: true, timer: nil}}
          """)
        )

      assert r.writes == ["running", "timer"]
      assert r.writes_truthy == ["running"]
      assert r.writes_falsy == ["timer"]
    end

    test "init with dynamic values → writes_dynamic" do
      r =
        StateDFG.extract_init(
          body("""
          {:ok, %{path: some_path, count: start_count()}}
          """)
        )

      assert r.writes == ["count", "path"]
      assert r.writes_dynamic == ["count", "path"]
      assert r.writes_truthy == []
      assert r.writes_falsy == []
    end

    test "backwards-compat shim extract_init_writes returns the writes list" do
      ast = body("{:ok, %{a: 1}}")
      assert StateDFG.extract_init_writes(ast) == ["a"]
    end
  end

  describe "uses" do
    test "state.field in call argument" do
      r = StateDFG.extract(body("send_msg(state.topic, :event)"))
      assert r.uses == ["topic"]
    end

    test "state.field inside return tuple" do
      r = StateDFG.extract(body("{:reply, state.counter, state}"))
      assert r.uses == ["counter"]
    end

    test "state.field inside string interpolation" do
      r = StateDFG.extract(body(~s|"count: " <> to_string(state.n)|))
      assert r.uses == ["n"]
    end

    test "uses is superset of guards" do
      r = StateDFG.extract(body("if state.running, do: state.count"))
      assert r.guards == ["running"]
      assert r.guards_truthy == ["running"]
      # both `running` (from the if-cond) and `count` (from the do-body)
      # end up in uses.
      assert r.uses == ["count", "running"]
    end

    test "Map.fetch!/2 is a use" do
      r = StateDFG.extract(body("Map.fetch!(state, :cfg)"))
      assert r.uses == ["cfg"]
    end
  end

  test "nil AST returns empty everything" do
    r = StateDFG.extract(nil)
    assert r.writes == []
    assert r.guards == []
    assert r.guards_truthy == []
    assert r.writes_truthy == []
    assert r.writes_falsy == []
    assert r.writes_dynamic == []
    assert r.uses == []
  end
end
