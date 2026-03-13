defprotocol Stringify do
  @doc "Converts a value to a string representation"
  def stringify(value)
end

defimpl Stringify, for: Map do
  def stringify(map) do
    map
    |> Enum.map(fn {k, v} -> "#{k}: #{v}" end)
    |> Enum.join(", ")
  end
end

defimpl Stringify, for: List do
  def stringify(list) do
    Enum.join(list, ", ")
  end
end

defmodule MyWorker do
  @behaviour GenServer

  def init(arg) do
    {:ok, arg}
  end

  def handle_call({:get, key}, _from, state) do
    {:reply, Map.get(state, key), state}
  end

  def handle_call(:state, _from, state) do
    {:reply, state, state}
  end
end
