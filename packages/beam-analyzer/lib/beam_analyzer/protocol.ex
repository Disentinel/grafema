defmodule BeamAnalyzer.Protocol do
  @moduledoc """
  Length-prefixed frame protocol for daemon mode.
  Reads/writes 4-byte BE u32 length + payload on stdin/stdout.
  """

  def read_frame(device) do
    case IO.binread(device, 4) do
      :eof -> :eof
      {:error, reason} -> {:error, reason}
      <<length::unsigned-big-integer-size(32)>> ->
        case IO.binread(device, length) do
          :eof -> {:error, :unexpected_eof}
          {:error, reason} -> {:error, reason}
          data when is_binary(data) -> {:ok, data}
        end
      data when is_binary(data) and byte_size(data) < 4 ->
        {:error, :incomplete_header}
    end
  end

  def write_frame(device, payload) when is_binary(payload) do
    length = byte_size(payload)
    header = <<length::unsigned-big-integer-size(32)>>
    IO.binwrite(device, header <> payload)
  end
end
