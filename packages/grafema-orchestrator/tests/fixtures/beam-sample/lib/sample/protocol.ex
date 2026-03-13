defprotocol Sample.Renderable do
  @doc "Renders a value to an iolist for output"
  def render(value)
end

defimpl Sample.Renderable, for: BitString do
  def render(string), do: string
end

defimpl Sample.Renderable, for: Integer do
  def render(number), do: Integer.to_string(number)
end

defmodule Sample.Renderer do
  @moduledoc "Uses the Renderable protocol to render collections"

  def render_all(items) do
    Enum.map(items, &Sample.Renderable.render/1)
  end
end
