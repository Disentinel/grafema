defmodule Ichi.Mamori do
  @moduledoc """
  守り — protection layer. Module name is ASCII, but the docs, atoms, and
  string literals below contain non-latin1 codepoints. Used to regression-
  test that the analyzer doesn't crash with `{:no_translation, :unicode,
  :latin1}` when writing results to stdio.
  """

  use GenServer

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(_), do: {:ok, %{note: "内観 — reflection", emoji: "🧭"}}

  @impl true
  def handle_info(:reflect, state), do: {:noreply, state}

  @impl true
  def handle_call(:get_note, _from, state), do: {:reply, state.note, state}
end
