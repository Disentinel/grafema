defmodule BeamAnalyzer.ErlangParser do
  @moduledoc "Parses Erlang source using :erl_scan + :erl_parse."

  def parse(source) do
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
