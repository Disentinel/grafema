defmodule BeamAnalyzer.MixProject do
  use Mix.Project

  def project do
    [
      app: :beam_analyzer,
      version: "0.1.0",
      elixir: "~> 1.15",
      escript: [main_module: BeamAnalyzer],
      deps: deps()
    ]
  end

  def application do
    [extra_applications: [:logger]]
  end

  defp deps do
    [{:jason, "~> 1.4"}]
  end
end
