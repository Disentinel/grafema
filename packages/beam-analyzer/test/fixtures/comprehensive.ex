defmodule MyApp.Accounts do
  @moduledoc "User account management."

  alias MyApp.Repo
  import Enum, only: [map: 2, filter: 2]
  require Logger

  @type user :: %{name: String.t(), age: integer()}
  @spec find_user(String.t()) :: {:ok, user()} | {:error, term()}

  def find_user(name) do
    result = Repo.get_by(name: name)

    case result do
      nil -> {:error, :not_found}
      user -> {:ok, user}
    end
  end

  def list_active_users(users) do
    users
    |> filter(&(&1.active))
    |> map(&normalize_user/1)
    |> Enum.sort_by(& &1.name)
  end

  def process_result({:ok, data}), do: handle_success(data)
  def process_result({:error, reason}), do: handle_error(reason)
  def process_result(_other), do: :unknown

  defp handle_success(%{name: name, age: age}) when is_binary(name) do
    Logger.info("Found user: #{name}")
    {name, age}
  end

  defp handle_error(reason) do
    Logger.error("Error: #{inspect(reason)}")
    nil
  end

  defp normalize_user(user) do
    %{user | name: String.trim(user.name)}
  end

  def batch_process(items) do
    for item <- items, item.valid?, into: [] do
      transform(item)
    end
  end

  defp transform(item), do: item

  def conditional_logic(x) do
    if x > 0 do
      with {:ok, data} <- fetch(x),
           {:ok, result} <- validate(data) do
        result
      else
        {:error, reason} -> {:failed, reason}
      end
    else
      cond do
        x == 0 -> :zero
        x < -10 -> :very_negative
        true -> :negative
      end
    end
  end

  defp fetch(_x), do: {:ok, %{}}
  defp validate(data), do: {:ok, data}
end

defmodule MyApp.Accounts.Server do
  use GenServer

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def get_user(name) do
    GenServer.call(__MODULE__, {:get, name})
  end

  def update_user(name, data) do
    GenServer.cast(__MODULE__, {:update, name, data})
  end

  @impl true
  def init(opts) do
    {:ok, %{users: %{}, opts: opts}}
  end

  @impl true
  def handle_call({:get, name}, _from, state) do
    user = Map.get(state.users, name)
    {:reply, user, state}
  end

  @impl true
  def handle_cast({:update, name, data}, state) do
    new_state = put_in(state, [:users, name], data)
    {:noreply, new_state}
  end

  @impl true
  def handle_info(:cleanup, state) do
    {:noreply, state}
  end
end

defmodule MyApp.Supervisor do
  use Supervisor

  def start_link(init_arg) do
    Supervisor.start_link(__MODULE__, init_arg, name: __MODULE__)
  end

  @impl true
  def init(_init_arg) do
    children = [
      {MyApp.Accounts.Server, []},
      {Task.Supervisor, name: MyApp.TaskSupervisor}
    ]

    Supervisor.init(children, strategy: :one_for_one)
  end
end
