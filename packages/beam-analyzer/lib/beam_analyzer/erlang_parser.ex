defmodule BeamAnalyzer.ErlangParser do
  @moduledoc "Parses Erlang source using :erl_scan + :erl_parse."

  def parse(source) do
    source = expand_simple_macros(source)
    charlist = String.to_charlist(source)

    case :erl_scan.string(charlist, 1, [:text, :return_comments]) do
      {:ok, tokens, _end_loc} ->
        forms = split_by_dot(tokens)

        parsed =
          Enum.reduce(forms, [], fn form_tokens, acc ->
            case :erl_parse.parse_form(form_tokens) do
              {:ok, form} -> [form | acc]
              {:error, _} -> acc
            end
          end)

        {:ok, Enum.reverse(parsed)}

      {:error, {line, _mod, reason}, _} ->
        {:error, "Scan error at line #{line}: #{inspect(reason)}"}
    end
  end

  # Pre-expand macros before scanning.
  # Full Erlang preprocessor (epp) is not available without a compilation context,
  # but -define() macros and ?MODULE/?MODULE_STRING cover the vast majority of
  # real-world usage. Parameterized macros -define(NAME(X), ...) are NOT handled.
  defp expand_simple_macros(source) do
    source
    |> expand_define_macros()
    |> expand_module_macros()
  end

  # Collect all -define(NAME, VALUE). and -define(NAME). directives, then
  # replace ?NAME occurrences. Define directives are removed from the source
  # to avoid parse errors (the scanner doesn't understand -define).
  defp expand_define_macros(source) do
    # Match -define(NAME, VALUE). — value is everything between the first comma
    # and the closing "). " allowing nested parens/brackets/braces.
    value_regex = ~r/-define\(\s*([A-Z_][A-Za-z0-9_]*)\s*,\s*((?:[^()]*|\((?:[^()]*|\([^()]*\))*\))*)\s*\)\s*\./

    # Match -define(NAME). — flag macro with no value
    flag_regex = ~r/-define\(\s*([A-Z_][A-Za-z0-9_]*)\s*\)\s*\./

    # Skip parameterized macros: -define(NAME(...), ...)
    param_regex = ~r/-define\(\s*[A-Z_][A-Za-z0-9_]*\s*\(.*?\)\s*,/

    # Collect value macros
    value_macros =
      Regex.scan(value_regex, source)
      |> Enum.reject(fn [full | _] ->
        Regex.match?(param_regex, full)
      end)
      |> Enum.map(fn [_full, name, value] -> {name, String.trim(value)} end)

    # Collect flag macros
    flag_macros =
      Regex.scan(flag_regex, source)
      |> Enum.map(fn [_full, name] -> {name, "true"} end)

    macros = value_macros ++ flag_macros

    case macros do
      [] ->
        source

      _ ->
        # Remove -define() lines from source
        source =
          source
          |> String.replace(value_regex, "")
          |> String.replace(flag_regex, "")

        # Replace ?NAME with VALUE for each macro
        Enum.reduce(macros, source, fn {name, value}, acc ->
          String.replace(acc, "?#{name}", value)
        end)
    end
  end

  defp expand_module_macros(source) do
    case Regex.run(~r/-module\((\w+)\)/, source) do
      [_, module_name] ->
        source
        |> String.replace("?MODULE_STRING", "\"#{module_name}\"")
        |> String.replace("?MODULE", module_name)

      _ ->
        source
    end
  end

  defp split_by_dot(tokens) do
    {current, forms} =
      Enum.reduce(tokens, {[], []}, fn token, {current, forms} ->
        case elem(token, 0) do
          :dot -> {[], [Enum.reverse([token | current]) | forms]}
          _ -> {[token | current], forms}
        end
      end)

    forms =
      case current do
        [] -> forms
        _ -> [Enum.reverse(current) | forms]
      end

    Enum.reverse(forms)
  end
end
