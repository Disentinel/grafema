defmodule Sample do
  @moduledoc "Sample module for Grafema BEAM analysis testing."

  alias Sample.Server
  import Enum, only: [map: 2, filter: 2]

  @type result :: {:ok, any()} | {:error, String.t()}

  def process(data) do
    data
    |> transform()
    |> validate()
    |> format_result()
  end

  def add(a, b), do: a + b

  defp transform(data) do
    map(data, &to_string/1)
  end

  defp validate(items) do
    filter(items, fn item -> item != "" end)
  end

  defp format_result(items) do
    case items do
      [] -> {:error, "empty"}
      items -> {:ok, items}
    end
  end
end
