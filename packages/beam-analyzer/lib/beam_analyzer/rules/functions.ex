defmodule BeamAnalyzer.Rules.Functions do
  @moduledoc "Handles def/defp -> FUNCTION nodes, function bodies -> CALL/VARIABLE nodes."

  alias BeamAnalyzer.{Context, SemanticId}

  def process({kind, meta, [{:when, _, [{name, _, args} | _guards]} | body]}, ctx)
      when kind in [:def, :defp] do
    process_function(ctx, kind, name, args, meta, body)
  end

  def process({kind, meta, [{name, _, args} | body]}, ctx)
      when kind in [:def, :defp] and is_atom(name) do
    process_function(ctx, kind, name, args, meta, body)
  end

  def process(_ast, ctx), do: ctx

  defp process_function(ctx, kind, name, args, meta, body) do
    args = args || []
    arity = length(args)
    line = Keyword.get(meta, :line, 0)
    col = Keyword.get(meta, :column, 0)
    module_name = ctx.module_name || "unknown"
    exported = kind == :def

    func_id = SemanticId.function_id(ctx.file, name, arity, module_name)

    node = %{
      id: func_id,
      type: "FUNCTION",
      name: "#{name}/#{arity}",
      file: ctx.file,
      line: line,
      column: col,
      endLine: 0,
      endColumn: 0,
      exported: exported,
      metadata: %{
        language: "elixir",
        arity: arity,
        kind: Atom.to_string(kind)
      }
    }

    ctx = Context.add_node(ctx, node)

    # CONTAINS edge from MODULE to FUNCTION
    ctx = Context.add_edge(ctx, %{
      src: ctx.module_id,
      dst: func_id,
      type: "CONTAINS",
      metadata: %{}
    })

    # Detect infrastructure patterns (handle_* callbacks)
    ctx = BeamAnalyzer.Rules.Infrastructure.process_function(ctx, "#{name}/#{arity}", func_id)

    # Add export if public
    ctx =
      if exported do
        BeamAnalyzer.Rules.Exports.add_export(ctx, "#{name}", arity)
      else
        ctx
      end

    # Walk function body for calls, variables, control flow
    ctx = Context.push_scope(ctx, "#{name}/#{arity}")

    # Process parameters as variables
    ctx = process_params(args, ctx)

    # Walk body — body from function AST is [[do: ...]], not [do: ...]
    keyword_body = List.first(body) || []
    ctx = walk_body(keyword_body, ctx)

    Context.pop_scope(ctx)
  end

  def process_erlang_function(ctx, name, arity, line, clauses) do
    module_name = ctx.module_name || "unknown"
    func_id = SemanticId.function_id(ctx.file, name, arity, module_name)

    node = %{
      id: func_id,
      type: "FUNCTION",
      name: "#{name}/#{arity}",
      file: ctx.file,
      line: line,
      column: 0,
      endLine: 0,
      endColumn: 0,
      exported: false,
      metadata: %{
        language: "erlang",
        arity: arity,
        clauses: length(clauses)
      }
    }

    ctx = Context.add_node(ctx, node)

    ctx = Context.add_edge(ctx, %{
      src: ctx.module_id,
      dst: func_id,
      type: "CONTAINS",
      metadata: %{}
    })

    # Detect infrastructure patterns (handle_* callbacks)
    ctx = BeamAnalyzer.Rules.Infrastructure.process_function(ctx, "#{name}/#{arity}", func_id)

    ctx = Context.push_scope(ctx, "#{name}/#{arity}")

    ctx = Enum.reduce(clauses, ctx, fn {:clause, _line, _args, _guards, body}, ctx ->
      Enum.reduce(body, ctx, &walk_erlang_expr/2)
    end)

    Context.pop_scope(ctx)
  end

  defp process_params(args, ctx) do
    Enum.reduce(args, ctx, fn
      {name, meta, nil}, ctx when is_atom(name) ->
        BeamAnalyzer.Rules.Variables.add_variable(ctx, name, meta, "parameter")

      _, ctx ->
        ctx
    end)
  end

  defp walk_body([do: {:__block__, _, stmts}], ctx) do
    Enum.reduce(stmts, ctx, &walk_expr/2)
  end

  defp walk_body([do: stmt], ctx) do
    walk_expr(stmt, ctx)
  end

  defp walk_body([{:do, {:__block__, _, stmts}} | _], ctx) do
    Enum.reduce(stmts, ctx, &walk_expr/2)
  end

  defp walk_body([{:do, stmt} | _], ctx) do
    walk_expr(stmt, ctx)
  end

  defp walk_body(_, ctx), do: ctx

  # Walk Elixir expressions for calls, variables, control flow
  defp walk_expr({:=, _meta, [left, right]}, ctx) do
    ctx = BeamAnalyzer.Rules.Variables.process_match(left, ctx)
    walk_expr(right, ctx)
  end

  defp walk_expr({:|>, meta, [left, right]}, ctx) do
    BeamAnalyzer.Rules.Calls.process_pipe(left, right, meta, ctx)
  end

  defp walk_expr({name, meta, args} = ast, ctx) when is_atom(name) and is_list(args) do
    case name do
      :case -> walk_case(ast, ctx)
      :cond -> walk_cond(ast, ctx)
      :if -> walk_if_unless(ast, ctx)
      :unless -> walk_if_unless(ast, ctx)
      :with -> walk_with(ast, ctx)
      :for -> walk_for(ast, ctx)
      _ ->
        ctx = BeamAnalyzer.Rules.Calls.process({name, meta, args}, ctx)
        # Walk call arguments to find nested calls/expressions
        ctx = walk_call_args(args, ctx)
        line = Keyword.get(meta, :line, 0)
        col = Keyword.get(meta, :column, 0)
        scope = Context.current_scope(ctx) || "module"
        call_id = SemanticId.call_id(ctx.file, Atom.to_string(name), scope, line, col)
        BeamAnalyzer.Rules.Infrastructure.process_call(ctx, Atom.to_string(name), call_id, line, col)
    end
  end

  defp walk_expr({{:., dot_meta, [{:__aliases__, _, parts}, method]} = dot, call_meta, args}, ctx) do
    ctx = BeamAnalyzer.Rules.Calls.process_dot_call(dot, call_meta, args, dot_meta, ctx)
    # Walk call arguments to find nested calls/expressions
    ctx = walk_call_args(args, ctx)
    module_name = parts |> Enum.map(&Atom.to_string/1) |> Enum.join(".")
    call_name = "#{module_name}.#{method}"
    line = Keyword.get(call_meta, :line, 0)
    col = Keyword.get(call_meta, :column, 0)
    scope = Context.current_scope(ctx) || "module"
    call_id = SemanticId.call_id(ctx.file, call_name, scope, line, col)
    BeamAnalyzer.Rules.Infrastructure.process_call(ctx, call_name, call_id, line, col)
  end

  defp walk_expr({{:., meta, _} = dot, call_meta, args}, ctx) do
    ctx = BeamAnalyzer.Rules.Calls.process_dot_call(dot, call_meta, args, meta, ctx)
    # Walk call arguments to find nested calls/expressions
    walk_call_args(args, ctx)
  end

  defp walk_expr({:__block__, _, stmts}, ctx) do
    Enum.reduce(stmts, ctx, &walk_expr/2)
  end

  defp walk_expr(_expr, ctx), do: ctx

  # --- Control flow recursion helpers ---

  # case: create BRANCH, walk scrutinee, walk each clause (pattern + body)
  # AST: {:case, meta, [expr, [do: clauses]]}
  defp walk_case({:case, _meta, _args} = ast, ctx) do
    ctx = BeamAnalyzer.Rules.ControlFlow.process(ast, ctx)

    case ast do
      {:case, _meta, [expr, [do: clauses]]} ->
        ctx = walk_expr(expr, ctx)
        walk_clauses(clauses, ctx)

      {:case, _meta, [expr | _]} ->
        walk_expr(expr, ctx)
    end
  end

  # if/unless: create BRANCH, walk condition and do/else blocks
  # AST: {:if, meta, [condition, [do: then_body]]}
  # AST: {:if, meta, [condition, [do: then_body, else: else_body]]}
  defp walk_if_unless({kind, _meta, _args} = ast, ctx) when kind in [:if, :unless] do
    ctx = BeamAnalyzer.Rules.ControlFlow.process(ast, ctx)

    case ast do
      {_, _meta, [condition, blocks]} when is_list(blocks) ->
        ctx = walk_expr(condition, ctx)
        ctx = walk_block(Keyword.get(blocks, :do), ctx)
        walk_block(Keyword.get(blocks, :else), ctx)

      {_, _meta, [condition | _]} ->
        walk_expr(condition, ctx)
    end
  end

  # cond: create BRANCH, walk each clause body
  # AST: {:cond, meta, [[do: clauses]]}
  defp walk_cond({:cond, _meta, _args} = ast, ctx) do
    ctx = BeamAnalyzer.Rules.ControlFlow.process(ast, ctx)

    case ast do
      {:cond, _meta, [[do: clauses]]} ->
        walk_clauses(clauses, ctx)

      _ ->
        ctx
    end
  end

  # with: create BRANCH, walk do body and else clauses
  # AST: {:with, meta, [clauses... ++ [do: body, else: else_clauses]]}
  defp walk_with({:with, _meta, _args} = ast, ctx) do
    ctx = BeamAnalyzer.Rules.ControlFlow.process(ast, ctx)

    case ast do
      {:with, _meta, args} when is_list(args) ->
        {opts, match_clauses} = extract_with_opts(args)

        # Walk match clause right-hand sides (the expressions being matched)
        ctx =
          Enum.reduce(match_clauses, ctx, fn
            {:<-, _meta, [_pattern, rhs]}, ctx -> walk_expr(rhs, ctx)
            expr, ctx -> walk_expr(expr, ctx)
          end)

        # Walk do block
        ctx = walk_block(Keyword.get(opts, :do), ctx)

        # Walk else clauses (they are arrow clauses like case)
        case Keyword.get(opts, :else) do
          nil -> ctx
          clauses when is_list(clauses) -> walk_clauses(clauses, ctx)
          _ -> ctx
        end

      _ ->
        ctx
    end
  end

  # for: create LOOP, walk body
  # AST: {:for, meta, [generators... ++ [do: body]]}
  defp walk_for({:for, _meta, _args} = ast, ctx) do
    ctx = BeamAnalyzer.Rules.ControlFlow.process(ast, ctx)

    case ast do
      {:for, _meta, args} when is_list(args) ->
        {opts, generators} = extract_with_opts(args)

        # Walk generator right-hand sides
        ctx =
          Enum.reduce(generators, ctx, fn
            {:<-, _meta, [_pattern, rhs]}, ctx -> walk_expr(rhs, ctx)
            expr, ctx -> walk_expr(expr, ctx)
          end)

        # Walk do block
        walk_block(Keyword.get(opts, :do), ctx)

      _ ->
        ctx
    end
  end

  # Walk clauses like {:->, meta, [[pattern], body]}
  defp walk_clauses(clauses, ctx) when is_list(clauses) do
    Enum.reduce(clauses, ctx, fn
      {:->, meta, [patterns, body]}, ctx ->
        # Create PATTERN nodes for each clause pattern
        ctx =
          Enum.reduce(patterns, ctx, fn pattern, ctx ->
            ctx = BeamAnalyzer.Rules.Patterns.process_pattern(pattern, meta, ctx)
            # Also extract variables from patterns
            BeamAnalyzer.Rules.Variables.process_match(pattern, ctx)
          end)

        # Walk the clause body
        walk_block(body, ctx)

      _, ctx ->
        ctx
    end)
  end

  defp walk_clauses(_, ctx), do: ctx

  # Walk a block expression (single expr or __block__)
  defp walk_block(nil, ctx), do: ctx

  defp walk_block({:__block__, _, stmts}, ctx) do
    Enum.reduce(stmts, ctx, &walk_expr/2)
  end

  defp walk_block(expr, ctx) do
    walk_expr(expr, ctx)
  end

  # Extract keyword opts (do/else) from the end of an args list (used by with/for)
  defp extract_with_opts(args) do
    case List.last(args) do
      opts when is_list(opts) ->
        if Keyword.keyword?(opts) do
          {opts, Enum.slice(args, 0..-2//1)}
        else
          {[], args}
        end

      _ ->
        {[], args}
    end
  end

  # Walk function call arguments to discover nested expressions
  defp walk_call_args(args, ctx) when is_list(args) do
    Enum.reduce(args, ctx, fn
      # Skip keyword lists at the top level (they are options, not expressions)
      # but still walk their values
      {key, value}, ctx when is_atom(key) ->
        walk_expr(value, ctx)

      arg, ctx ->
        walk_expr(arg, ctx)
    end)
  end

  defp walk_call_args(_, ctx), do: ctx

  # --- Erlang expression walking ---

  # Local call: foo(args)
  defp walk_erlang_expr({:call, loc, {:atom, _, name}, args}, ctx) do
    line = extract_erl_line(loc)
    name_str = Atom.to_string(name)
    ctx = BeamAnalyzer.Rules.Calls.add_call(ctx, name_str, length(args), line, 0)
    scope = Context.current_scope(ctx) || "module"
    call_id = SemanticId.call_id(ctx.file, name_str, scope, line, 0)
    ctx = BeamAnalyzer.Rules.Infrastructure.process_call(ctx, name_str, call_id, line, 0)
    # Walk arguments for nested expressions
    Enum.reduce(args, ctx, &walk_erlang_expr/2)
  end

  # Remote call: mod:func(args)
  defp walk_erlang_expr({:call, loc, {:remote, _, {:atom, _, mod}, {:atom, _, name}}, args}, ctx) do
    line = extract_erl_line(loc)
    call_name = "#{mod}.#{name}"
    ctx = BeamAnalyzer.Rules.Calls.add_call(ctx, call_name, length(args), line, 0)
    scope = Context.current_scope(ctx) || "module"
    call_id = SemanticId.call_id(ctx.file, call_name, scope, line, 0)
    ctx = BeamAnalyzer.Rules.Infrastructure.process_call(ctx, call_name, call_id, line, 0)
    Enum.reduce(args, ctx, &walk_erlang_expr/2)
  end

  # Dynamic call: Var(args) or Expr(args)
  defp walk_erlang_expr({:call, _loc, fun_expr, args}, ctx) do
    ctx = walk_erlang_expr(fun_expr, ctx)
    Enum.reduce(args, ctx, &walk_erlang_expr/2)
  end

  # Match: Pattern = Expr
  defp walk_erlang_expr({:match, _loc, left, right}, ctx) do
    ctx = walk_erlang_expr(right, ctx)
    walk_erlang_expr(left, ctx)
  end

  # Case expression
  defp walk_erlang_expr({:case, _loc, expr, clauses}, ctx) do
    ctx = walk_erlang_expr(expr, ctx)
    walk_erlang_clauses(clauses, ctx)
  end

  # If expression (Erlang)
  defp walk_erlang_expr({:if, _loc, clauses}, ctx) do
    walk_erlang_clauses(clauses, ctx)
  end

  # Receive expression
  defp walk_erlang_expr({:receive, _loc, clauses}, ctx) do
    walk_erlang_clauses(clauses, ctx)
  end

  # Receive with after
  defp walk_erlang_expr({:receive, _loc, clauses, _timeout, after_body}, ctx) do
    ctx = walk_erlang_clauses(clauses, ctx)
    Enum.reduce(after_body, ctx, &walk_erlang_expr/2)
  end

  # Try expression
  defp walk_erlang_expr({:try, _loc, body, case_clauses, catch_clauses, after_body}, ctx) do
    ctx = Enum.reduce(body, ctx, &walk_erlang_expr/2)
    ctx = walk_erlang_clauses(case_clauses, ctx)
    ctx = walk_erlang_clauses(catch_clauses, ctx)
    Enum.reduce(after_body, ctx, &walk_erlang_expr/2)
  end

  # Block expression
  defp walk_erlang_expr({:block, _loc, exprs}, ctx) do
    Enum.reduce(exprs, ctx, &walk_erlang_expr/2)
  end

  # Binary operator: {op, loc, op_atom, left, right}
  defp walk_erlang_expr({:op, _loc, _op, left, right}, ctx) do
    ctx = walk_erlang_expr(left, ctx)
    walk_erlang_expr(right, ctx)
  end

  # Unary operator
  defp walk_erlang_expr({:op, _loc, _op, arg}, ctx) do
    walk_erlang_expr(arg, ctx)
  end

  # Tuple: {tuple, loc, elements}
  defp walk_erlang_expr({:tuple, _loc, elements}, ctx) do
    Enum.reduce(elements, ctx, &walk_erlang_expr/2)
  end

  # Cons / list
  defp walk_erlang_expr({:cons, _loc, head, tail}, ctx) do
    ctx = walk_erlang_expr(head, ctx)
    walk_erlang_expr(tail, ctx)
  end

  # Map update / create
  defp walk_erlang_expr({:map, _loc, assocs}, ctx) do
    Enum.reduce(assocs, ctx, fn
      {:map_field_assoc, _, key, val}, ctx ->
        ctx = walk_erlang_expr(key, ctx)
        walk_erlang_expr(val, ctx)
      {:map_field_exact, _, key, val}, ctx ->
        ctx = walk_erlang_expr(key, ctx)
        walk_erlang_expr(val, ctx)
      _, ctx -> ctx
    end)
  end

  defp walk_erlang_expr({:map, _loc, expr, assocs}, ctx) do
    ctx = walk_erlang_expr(expr, ctx)
    Enum.reduce(assocs, ctx, fn
      {:map_field_assoc, _, key, val}, ctx ->
        ctx = walk_erlang_expr(key, ctx)
        walk_erlang_expr(val, ctx)
      {:map_field_exact, _, key, val}, ctx ->
        ctx = walk_erlang_expr(key, ctx)
        walk_erlang_expr(val, ctx)
      _, ctx -> ctx
    end)
  end

  defp walk_erlang_expr(_expr, ctx), do: ctx

  # Helper: walk Erlang clauses ({:clause, loc, patterns, guards, body})
  defp walk_erlang_clauses(clauses, ctx) when is_list(clauses) do
    Enum.reduce(clauses, ctx, fn
      {:clause, _, _patterns, _guards, body}, ctx ->
        Enum.reduce(body, ctx, &walk_erlang_expr/2)
      _, ctx -> ctx
    end)
  end

  defp walk_erlang_clauses(_, ctx), do: ctx

  # OTP 26+: location is keyword list; OTP < 26: integer
  defp extract_erl_line(loc) when is_integer(loc), do: loc
  defp extract_erl_line(loc) when is_list(loc), do: Keyword.get(loc, :location, 0)
  defp extract_erl_line(_), do: 0
end
