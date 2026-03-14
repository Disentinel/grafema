files = [
  "test/fixtures/comprehensive.ex",
  "test/fixtures/simple_module.ex",
  "test/fixtures/genserver.ex",
  "test/fixtures/pipes.ex",
  "test/fixtures/pattern_matching.ex",
  "test/fixtures/simple_module.erl",
  "test/fixtures/comprehensive.erl"
]

analyzer = Path.join(File.cwd!(), "beam_analyzer")

for file <- files do
  IO.puts("\n=== Analyzing: #{file} ===")
  source = File.read!(file)
  json = Jason.encode!(%{"file" => file, "source" => source})

  # Write JSON to temp file, cat it into analyzer
  tmp = "/tmp/beam_verify_input.json"
  File.write!(tmp, json)
  {output, exit_code} = System.cmd("sh", ["-c", "cat #{tmp} | #{analyzer}"])

  case Jason.decode(output) do
    {:ok, data} ->
      nodes = data["nodes"] || []
      edges = data["edges"] || []
      exports = data["exports"] || []
      errors = data["errors"] || []

      IO.puts("  Module ID: #{data["moduleId"]}")
      IO.puts("  Nodes: #{length(nodes)}")
      IO.puts("  Edges: #{length(edges)}")
      IO.puts("  Exports: #{length(exports)}")

      if length(errors) > 0 do
        IO.puts("  ERRORS: #{inspect(errors)}")
      end

      type_counts = Enum.group_by(nodes, & &1["type"]) |> Enum.map(fn {type, ns} -> {type, length(ns)} end) |> Enum.sort()
      IO.puts("  Node types: #{inspect(type_counts)}")

      edge_counts = Enum.group_by(edges, & &1["type"]) |> Enum.map(fn {type, es} -> {type, length(es)} end) |> Enum.sort()
      IO.puts("  Edge types: #{inspect(edge_counts)}")

      IO.puts("  Sample nodes:")
      nodes
      |> Enum.take(12)
      |> Enum.each(fn n ->
        IO.puts("    #{n["type"]} | #{n["name"]} | line:#{n["line"]} | exported:#{n["exported"]}")
      end)

    {:error, reason} ->
      IO.puts("  FAILED: #{inspect(reason)}")
      IO.puts("  Exit code: #{exit_code}")
      IO.puts("  Raw (first 500): #{String.slice(output, 0, 500)}")
  end
end
