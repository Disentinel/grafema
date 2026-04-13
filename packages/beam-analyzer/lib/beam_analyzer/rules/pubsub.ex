defmodule BeamAnalyzer.Rules.PubSub do
  @moduledoc """
  PubSub topology modeling (REG-1098 W7).

  Detects direct `Phoenix.PubSub.subscribe/2` and
  `Phoenix.PubSub.broadcast*` calls and emits:

    * `PUBSUB_TOPIC` nodes, unique per `(pubsub_server, topic_string)`
    * `SUBSCRIBES_TO` edges from the containing MODULE to the topic
    * `BROADCASTS_TO` edges from the broadcast CALL site to the topic

  Only literal topic strings and literal pubsub server aliases are
  modeled. Dynamic topics, dynamic pubsub servers, pipe-form pubsub
  calls, and wrapper calls (e.g. `EventBus.subscribe`) are out of
  scope for W7.
  """

  alias BeamAnalyzer.{Context, Rules.Patterns}

  @broadcast_ops [:broadcast, :broadcast!, :broadcast_from, :local_broadcast]

  @doc """
  Return `{:pubsub, op}` if the dot-call AST targets `Phoenix.PubSub.<op>`
  for one of the supported ops; otherwise `:not_pubsub`.
  """
  def classify({:., _, [{:__aliases__, _, [:Phoenix, :PubSub]}, op]})
      when op == :subscribe or op in @broadcast_ops do
    {:pubsub, op}
  end

  def classify(_), do: :not_pubsub

  @doc """
  Handle `Phoenix.PubSub.subscribe(pubsub, topic)`. No-op if the pubsub
  server is not a literal alias or the topic is not a string literal.
  """
  def process_subscribe(ctx, pubsub_ast, topic_ast, _meta) do
    with pubsub_name when is_binary(pubsub_name) <- pubsub_name_of(pubsub_ast),
         {:ok, topic} <- literal_topic(topic_ast) do
      {ctx, topic_id} = ensure_topic_node(ctx, pubsub_name, topic)

      edge = %{
        src: ctx.module_id,
        dst: topic_id,
        type: "SUBSCRIBES_TO",
        metadata: %{via: "Phoenix.PubSub.subscribe"}
      }

      Context.add_edge(ctx, edge)
    else
      _ -> ctx
    end
  end

  @doc """
  Handle `Phoenix.PubSub.<broadcast op>(pubsub, topic, msg)`. The CALL
  node for this site must already have been added by `Rules.Calls` —
  `call_id` identifies it.
  """
  def process_broadcast(ctx, call_id, pubsub_ast, topic_ast, msg_ast, op) do
    with pubsub_name when is_binary(pubsub_name) <- pubsub_name_of(pubsub_ast),
         {:ok, topic} <- literal_topic(topic_ast) do
      {ctx, topic_id} = ensure_topic_node(ctx, pubsub_name, topic)

      message_shape =
        msg_ast
        |> Patterns.normalize()
        |> Patterns.shape_to_meta()

      edge = %{
        src: call_id,
        dst: topic_id,
        type: "BROADCASTS_TO",
        metadata: %{
          via: "Phoenix.PubSub.#{op}",
          message_shape: message_shape
        }
      }

      Context.add_edge(ctx, edge)
    else
      _ -> ctx
    end
  end

  # ------------------------------------------------------------------
  # Helpers
  # ------------------------------------------------------------------

  defp pubsub_name_of({:__aliases__, _, parts}) when is_list(parts) do
    parts |> Enum.map(&Atom.to_string/1) |> Enum.join(".")
  end

  defp pubsub_name_of(_), do: :dynamic

  defp literal_topic(topic) when is_binary(topic), do: {:ok, topic}
  defp literal_topic(_), do: :skip

  defp topic_node_id(pubsub_name, topic),
    do: "<pubsub>->PUBSUB_TOPIC->#{pubsub_name}[topic:#{topic}]"

  defp ensure_topic_node(ctx, pubsub_name, topic) do
    id = topic_node_id(pubsub_name, topic)

    if Enum.any?(ctx.nodes, fn n -> n.id == id end) do
      {ctx, id}
    else
      node = %{
        id: id,
        type: "PUBSUB_TOPIC",
        name: topic,
        file: "<pubsub>",
        line: 0,
        column: 0,
        endLine: 0,
        endColumn: 0,
        exported: false,
        metadata: %{pubsub: pubsub_name, topic: topic}
      }

      {Context.add_node(ctx, node), id}
    end
  end
end
