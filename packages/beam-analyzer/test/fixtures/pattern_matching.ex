defmodule PatternMatching do
  def process({:ok, data}), do: handle_success(data)
  def process({:error, reason}), do: handle_error(reason)
  def process(_other), do: :unknown

  defp handle_success(%{name: name, age: age}) do
    {name, age}
  end

  defp handle_error(reason) when is_binary(reason), do: reason
  defp handle_error(reason), do: inspect(reason)
end
