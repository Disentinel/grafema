defmodule BeamAnalyzer.Rules.StateDFGTest do
  use ExUnit.Case, async: true

  alias BeamAnalyzer.Rules.StateDFG

  # Parse an Elixir snippet as an expression/block AST.
  defp body(src) do
    {:ok, ast} = Code.string_to_quoted(src)
    ast
  end

  describe "writes" do
    test "map update %{state | field: _}" do
      ast = body("%{state | foo: 1}")
      assert {["foo"], []} = StateDFG.extract(ast)
    end

    test "map update with multiple fields" do
      ast = body("%{state | foo: 1, bar: 2, baz: 3}")
      assert {["bar", "baz", "foo"], []} = StateDFG.extract(ast)
    end

    test "struct update %Struct{state | field: _}" do
      ast = body("%MyMod{state | paused: true}")
      assert {["paused"], []} = StateDFG.extract(ast)
    end

    test "Map.put(state, :field, _)" do
      ast = body("Map.put(state, :queue, [])")
      assert {["queue"], []} = StateDFG.extract(ast)
    end

    test "Map.delete(state, :field)" do
      ast = body("Map.delete(state, :stale_ref)")
      assert {["stale_ref"], []} = StateDFG.extract(ast)
    end

    test "Map.update!(state, :counter, &(&1 + 1))" do
      ast = body("Map.update!(state, :counter, &(&1 + 1))")
      assert {["counter"], []} = StateDFG.extract(ast)
    end

    test "nested update inside return tuple" do
      ast = body("{:noreply, %{state | last: now}}")
      assert {["last"], []} = StateDFG.extract(ast)
    end

    test "multiple write sites in one body" do
      ast =
        body("""
          s1 = %{state | a: 1}
          Map.put(s1, :b, 2)
          %{state | c: 3}
        """)

      # only writes against the `state` variable are recorded (not s1)
      assert {["a", "c"], []} = StateDFG.extract(ast)
    end

    test "ignores writes against a variable not named `state`" do
      ast = body("%{other | field: 1}")
      assert {[], []} = StateDFG.extract(ast)
    end
  end

  describe "guards" do
    test "if state.field do" do
      ast = body("if state.running, do: :go")
      assert {[], ["running"]} = StateDFG.extract(ast)
    end

    test "unless state.field" do
      ast = body("unless state.halted, do: :go")
      assert {[], ["halted"]} = StateDFG.extract(ast)
    end

    test "case state.field do" do
      ast =
        body("""
          case state.mode do
            :a -> 1
            :b -> 2
          end
        """)

      assert {[], ["mode"]} = StateDFG.extract(ast)
    end

    test "case Map.get(state, :field) do" do
      ast =
        body("""
          case Map.get(state, :stash) do
            nil -> :none
            v -> v
          end
        """)

      assert {[], ["stash"]} = StateDFG.extract(ast)
    end

    test "function call on state is not a guard read" do
      # `do_something(state.x)` is a call argument, not a control-flow
      # scrutinee — we conservatively don't record it.
      ast = body("do_something(state.x)")
      assert {[], []} = StateDFG.extract(ast)
    end
  end

  describe "combined" do
    test "handler that reads a guard and writes a field" do
      ast =
        body("""
          if state.paused do
            state
          else
            %{state | count: state.count + 1}
          end
        """)

      assert {["count"], ["paused"]} = StateDFG.extract(ast)
    end

    test "dedup when same field appears twice" do
      ast =
        body("""
          _ = state.foo
          if state.foo do
            %{state | foo: :new}
          end
        """)

      # foo appears as a guard (from `if state.foo`) and as a write.
      # Should each appear exactly once.
      assert {["foo"], ["foo"]} = StateDFG.extract(ast)
    end
  end

  test "nil AST returns empty lists" do
    assert {[], []} = StateDFG.extract(nil)
  end
end
