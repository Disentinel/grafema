defmodule BeamAnalyzer.Protocol do
  @moduledoc """
  Length-prefixed frame protocol for daemon mode.
  Reads/writes 4-byte BE u32 length + payload on stdin/stdout.

  Uses raw file handles (/dev/stdin, /dev/stdout) to bypass Erlang's IO
  encoding layer, which would corrupt binary data by expanding bytes > 0x7F
  into multi-byte UTF-8 sequences.
  """

  @doc "Open raw binary handles for stdin/stdout, return {in_dev, out_dev}."
  def open_raw_stdio do
    {:ok, raw_in} = :file.open('/dev/stdin', [:read, :raw, :binary])
    {:ok, raw_out} = :file.open('/dev/stdout', [:write, :raw, :binary])
    {raw_in, raw_out}
  end

  def read_frame(device) do
    case :file.read(device, 4) do
      :eof -> :eof
      {:error, reason} -> {:error, reason}
      {:ok, <<length::unsigned-big-integer-size(32)>>} ->
        case :file.read(device, length) do
          :eof -> {:error, :unexpected_eof}
          {:error, reason} -> {:error, reason}
          {:ok, data} when is_binary(data) -> {:ok, data}
        end
      {:ok, data} when is_binary(data) and byte_size(data) < 4 ->
        {:error, :incomplete_header}
    end
  end

  def write_frame(device, payload) when is_binary(payload) do
    length = byte_size(payload)
    header = <<length::unsigned-big-integer-size(32)>>
    :file.write(device, header <> payload)
  end
end
