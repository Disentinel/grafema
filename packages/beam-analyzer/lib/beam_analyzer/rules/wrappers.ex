defmodule BeamAnalyzer.Rules.Wrappers do
  @moduledoc """
  Detects single-expression function bodies that wrap message-passing primitives.

  Used by REG-1098 W5/W6 to surface public-API indirections (e.g.
  `EventBus.emit/3`) as first-class wrapper metadata on FUNCTION nodes.
  W6 will consume the `wraps` metadata to synthesize virtual SENDS_TO
  edges at wrapper call sites.

  Pure detection logic — no graph mutations.
  """

  alias BeamAnalyzer.Rules.Patterns

  @type wraps_kind :: :call | :cast | :send | :send_after | :sub | :broadcast

  @type wrap_info :: %{
          kind: wraps_kind(),
          target: :module_self | :var | :literal,
          target_hint: String.t() | nil,
          message_shape: list() | nil,
          topic: String.t() | nil
        }

  @doc """
  Inspect a function body AST fragment. If it is a single-expression wrapper
  around a known message-passing operation, return `{:ok, wrap_info}`.
  Otherwise return `:no_wrap`.

  Accepts either the already-unwrapped body expression or the `[do: body]`
  keyword form as produced by `def name(args), do: body`.
  """
  @spec detect_wrapper(any()) :: {:ok, wrap_info()} | :no_wrap
  def detect_wrapper([{:do, body} | _]), do: detect_wrapper_body(body)
  def detect_wrapper([[{:do, body} | _] | _]), do: detect_wrapper_body(body)
  def detect_wrapper(body), do: detect_wrapper_body(body)

  # Multi-statement body → never a wrapper.
  defp detect_wrapper_body({:__block__, _, _}), do: :no_wrap

  # GenServer.call / GenServer.cast
  defp detect_wrapper_body(
         {{:., _, [{:__aliases__, _, [:GenServer]}, op]}, _, [target, msg | _rest]}
       )
       when op in [:call, :cast] do
    {target_kind, hint} = resolve_target(target)

    {:ok,
     %{
       kind: op,
       target: target_kind,
       target_hint: hint,
       message_shape: shape_of(msg),
       topic: nil
     }}
  end

  # bare send/2
  defp detect_wrapper_body({:send, _, [target, msg]}) do
    {target_kind, hint} = resolve_target(target)

    {:ok,
     %{
       kind: :send,
       target: target_kind,
       target_hint: hint,
       message_shape: shape_of(msg),
       topic: nil
     }}
  end

  # Process.send / Process.send_after
  defp detect_wrapper_body(
         {{:., _, [{:__aliases__, _, [:Process]}, op]}, _, [target, msg | _rest]}
       )
       when op in [:send, :send_after] do
    {target_kind, hint} = resolve_target(target)

    {:ok,
     %{
       kind: op,
       target: target_kind,
       target_hint: hint,
       message_shape: shape_of(msg),
       topic: nil
     }}
  end

  # Phoenix.PubSub.subscribe(pubsub, topic)
  defp detect_wrapper_body(
         {{:., _, [{:__aliases__, _, [:Phoenix, :PubSub]}, :subscribe]}, _,
          [_pubsub, topic | _rest]}
       ) do
    case literal_topic(topic) do
      {:ok, topic_str} ->
        {:ok,
         %{
           kind: :sub,
           target: :literal,
           target_hint: nil,
           message_shape: nil,
           topic: topic_str
         }}

      :error ->
        :no_wrap
    end
  end

  # Phoenix.PubSub.broadcast* / local_broadcast
  defp detect_wrapper_body(
         {{:., _, [{:__aliases__, _, [:Phoenix, :PubSub]}, op]}, _,
          [_pubsub, topic, msg | _rest]}
       )
       when op in [:broadcast, :broadcast!, :broadcast_from, :local_broadcast] do
    case literal_topic(topic) do
      {:ok, topic_str} ->
        {:ok,
         %{
           kind: :broadcast,
           target: :literal,
           target_hint: nil,
           message_shape: shape_of(msg),
           topic: topic_str
         }}

      :error ->
        :no_wrap
    end
  end

  defp detect_wrapper_body(_), do: :no_wrap

  # --- Target resolution ---

  defp resolve_target({:__MODULE__, _, _}), do: {:module_self, nil}

  defp resolve_target({:__aliases__, _, parts}) when is_list(parts) do
    hint = parts |> Module.concat() |> Atom.to_string()
    {:literal, hint}
  end

  defp resolve_target({name, _, ctx}) when is_atom(name) and is_atom(ctx) do
    {:var, nil}
  end

  defp resolve_target(_), do: {:var, nil}

  # --- Message shape helper ---

  defp shape_of(msg) do
    msg |> Patterns.normalize() |> Patterns.shape_to_meta()
  end

  # --- Literal topic extraction ---

  defp literal_topic(topic) when is_binary(topic), do: {:ok, topic}
  defp literal_topic(_), do: :error
end
