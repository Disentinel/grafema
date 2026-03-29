defmodule Pipes do
  def process(data) do
    data
    |> String.trim()
    |> String.split(",")
    |> Enum.map(&String.trim/1)
    |> Enum.filter(&(&1 != ""))
    |> Enum.sort()
  end

  def transform(items) do
    items
    |> Enum.map(fn item -> item * 2 end)
    |> Enum.sum()
  end
end
