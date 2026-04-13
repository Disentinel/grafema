{-# LANGUAGE OverloadedStrings #-}
-- | BEAM (Elixir / Erlang) runtime globals resolution.
--
-- Wraps the language-agnostic 'Grafema.RuntimeGlobals' engine with two
-- 'NameStrategy' configurations:
--
--   * Elixir: dot-separated qualified names (e.g. @Enum.map@, @File.read!@).
--     Symbols come from @effects-db/runtimes/elixir.yaml@.
--
--   * Erlang: in Elixir source, Erlang BIFs are written with a leading
--     colon (@:erlang.now()@, @:lists.foldl(...)@). beam-analyzer strips the
--     colon when emitting CALL nodes, so the call name shape is identical
--     to the Elixir form (@erlang.now@, @lists.foldl@). We therefore reuse
--     the dot separator and rely on module-name uniqueness — Erlang module
--     names are lowercase (@erlang@, @lists@, @maps@), Elixir modules are
--     CamelCase (@Enum@, @String@), so collisions are impossible by
--     convention.
--
-- Resolution order:
--
--   1. The shared engine builds a function index from FUNCTION nodes and
--      filters out CALL nodes that already resolve locally (handled by
--      'BeamLocalRefs.resolveAll').
--   2. For each remaining CALL, all dot-suffixes of the name are tried
--      against the symbol DB (e.g. @Enum.map@ → @[\"Enum.map\", \"map\"]@).
--   3. On match, a virtual @GLOBAL_DEFINITION@ node is emitted (deduped)
--      together with a @CALLS@ edge that carries effect metadata copied
--      from the YAML entry.
module BeamRuntimeGlobals (run, resolveAll) where

import Grafema.Types (GraphNode)
import Grafema.Protocol (PluginCommand, readNodesFromStdin, writeCommandsToStdout)
import qualified Grafema.RuntimeGlobals as RG

import System.Environment (lookupEnv)
import Data.Maybe (fromMaybe)

-- | Strategy for matching Elixir-style qualified calls against the
-- effects-db. Elixir module names use @.@ as separator and are CamelCase
-- (@Enum.map@, @GenServer.call@).
elixirStrategy :: RG.NameStrategy
elixirStrategy = RG.NameStrategy
  { RG.nsSeparator   = "."
  , RG.nsPrefix      = "BEAM_GLOBAL::"
  , RG.nsCategory    = "elixir-stdlib"
  , RG.nsFilter      = RG.FilterCalls
  , RG.nsEdgeType    = "CALLS"
  , RG.nsVirtualFile = "<runtime/elixir>"
  }

-- | Strategy for Erlang BIFs. Same separator as Elixir because
-- beam-analyzer drops the @:@ prefix when emitting CALL names.
-- Distinguished by 'nsCategory' / 'nsPrefix' for downstream tooling.
erlangStrategy :: RG.NameStrategy
erlangStrategy = RG.NameStrategy
  { RG.nsSeparator   = "."
  , RG.nsPrefix      = "ERLANG_BIF::"
  , RG.nsCategory    = "erlang-bif"
  , RG.nsFilter      = RG.FilterCalls
  , RG.nsEdgeType    = "CALLS"
  , RG.nsVirtualFile = "<runtime/erlang>"
  }

-- | Run both strategies against the same node set. The shared engine
-- deduplicates virtual nodes by name within a single 'RG.resolveAll'
-- call; running the two strategies sequentially is safe because their
-- prefixes differ.
resolveAll :: RG.SymbolDB -> [GraphNode] -> [PluginCommand]
resolveAll db nodes =
  RG.resolveAll elixirStrategy db nodes
  ++ RG.resolveAll erlangStrategy db nodes

-- | CLI entry point used in standalone mode.
--
-- The effects-db root defaults to @./effects-db@ but can be overridden
-- via the @GRAFEMA_EFFECTS_DB@ environment variable. The orchestrator
-- always sets this when launching the daemon, so the fallback only
-- matters for ad-hoc CLI runs.
run :: IO ()
run = do
  effectsDir <- fromMaybe "effects-db" <$> lookupEnv "GRAFEMA_EFFECTS_DB"
  db    <- RG.loadSymbolDB effectsDir
  nodes <- readNodesFromStdin
  writeCommandsToStdout (resolveAll db nodes)
