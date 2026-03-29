defmodule BeamAnalyzer.OtpKnowledge do
  @moduledoc """
  Hardcoded knowledge about what callbacks OTP behaviours inject via `use`.

  When macro expansion isn't available at analysis time (the target project's
  deps aren't loaded), we fall back to this knowledge base.

  Format: {function_name, arity, :public | :private}
  """

  @genserver_callbacks [
    {"init", 1, :public},
    {"handle_call", 3, :public},
    {"handle_cast", 2, :public},
    {"handle_info", 2, :public},
    {"handle_continue", 2, :public},
    {"terminate", 2, :public},
    {"code_change", 3, :public},
    {"child_spec", 1, :public}
  ]

  @supervisor_callbacks [
    {"init", 1, :public},
    {"child_spec", 1, :public}
  ]

  @agent_callbacks [
    {"child_spec", 1, :public}
  ]

  @task_callbacks [
    {"child_spec", 1, :public}
  ]

  @gen_statem_callbacks [
    {"init", 1, :public},
    {"callback_mode", 0, :public},
    {"handle_event", 4, :public},
    {"terminate", 3, :public},
    {"code_change", 4, :public},
    {"child_spec", 1, :public}
  ]

  @gen_event_callbacks [
    {"init", 1, :public},
    {"handle_event", 2, :public},
    {"handle_call", 2, :public},
    {"handle_info", 2, :public},
    {"terminate", 2, :public},
    {"code_change", 3, :public}
  ]

  @phoenix_controller [
    {"action", 2, :public},
    {"init", 1, :public}
  ]

  @phoenix_liveview [
    {"mount", 3, :public},
    {"render", 1, :public},
    {"handle_event", 3, :public},
    {"handle_info", 2, :public},
    {"handle_params", 3, :public},
    {"terminate", 2, :public}
  ]

  @phoenix_component [
    {"render", 1, :public}
  ]

  @phoenix_channel [
    {"join", 3, :public},
    {"handle_in", 3, :public},
    {"handle_info", 2, :public},
    {"handle_out", 3, :public},
    {"terminate", 2, :public}
  ]

  @doc "Return known callbacks for a module name used with `use`."
  def callbacks_for(module_name) do
    case module_name do
      "GenServer" -> @genserver_callbacks
      "Supervisor" -> @supervisor_callbacks
      "Agent" -> @agent_callbacks
      "Task" -> @task_callbacks
      "GenStateMachine" -> @gen_statem_callbacks
      "GenEvent" -> @gen_event_callbacks
      # Phoenix
      "Phoenix.Controller" -> @phoenix_controller
      "Phoenix.LiveView" -> @phoenix_liveview
      "Phoenix.LiveComponent" -> @phoenix_liveview
      "Phoenix.Component" -> @phoenix_component
      "Phoenix.Channel" -> @phoenix_channel
      # Ecto
      "Ecto.Schema" -> [{"changeset", 2, :public}]
      "Ecto.Repo" -> []
      # ExUnit
      "ExUnit.Case" -> []
      # Plug
      "Plug.Router" -> [{"init", 1, :public}, {"call", 2, :public}]
      "Plug.Builder" -> [{"init", 1, :public}, {"call", 2, :public}]
      _ -> []
    end
  end
end
