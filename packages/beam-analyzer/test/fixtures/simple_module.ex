defmodule Sample do
  @moduledoc "Sample module for testing."

  alias Sample.Config
  import Enum, only: [map: 2, filter: 2]
  use GenServer

  @type state :: map()

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def get_value(key) do
    GenServer.call(__MODULE__, {:get, key})
  end

  defp internal_helper(data) do
    data
    |> transform()
    |> validate()
  end

  defp transform(data), do: data
  defp validate(data), do: {:ok, data}
end
