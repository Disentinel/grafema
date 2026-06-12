{-# LANGUAGE OverloadedStrings #-}
module Main where

import Data.Aeson (FromJSON(..), ToJSON(..), withObject, (.:), (.:?), (.!=), object, (.=))
import qualified Data.Text as T
import Data.Text (Text)
import System.Environment (getArgs, lookupEnv)
import System.IO (stdin, stdout, hSetBinaryMode)
import Options.Applicative
import Grafema.Types (GraphNode)
import Grafema.Protocol (PluginCommand(..), readFrame, writeFrame, encodeMsgpack, decodeMsgpack, pluginCommandToMsgpack, readNodesFromStdin, writeCommandsToStdout)
import Grafema.RuntimeGlobals (NameStrategy(..), NodeFilter(..), SymbolDB, loadSymbolDB, resolveAll)
import qualified Data.Set as Set

import qualified Data.Binary as Binary
import qualified Data.MessagePack as MP
import qualified Data.Vector as V

-- NOTE (Wave 6, resolve→datalog2 migration): this daemon used to run EIGHT
-- per-file steps (same-file-calls, js-local-refs, runtime-globals, builtins,
-- import-resolution, cross-file-calls, property-access, class-inheritance)
-- plus the js-this-method-calls / runtime-call-globals second-pass commands.
-- All of them except `runtime-globals` were replaced by datalog2 stdlib rule
-- packs (js_local_refs, js_same_file_calls, js_this_method_calls,
-- js_module_imports, js_import_bindings, js_cross_file_calls,
-- js_property_access_ns/full, js_class_inheritance, js_builtins_nodes/edges,
-- js_runtime_globals_nodes/edges) and DELETED — see
-- _ai/research/resolve-datalog2-migration-synthesis.md for the per-step
-- differential evidence. The ONLY remaining step is `runtime-globals`: the
-- REFERENCE→GLOBAL_DEFINITION RESOLVES_TO arm (jsStrategy below), which no
-- pack emits (the packs cover only the CALL→CALLS arm).

-- | Per-step resolver gating: GRAFEMA_SKIP_RESOLVE_STEPS carries a
-- comma-separated list of step names whose implementation is SKIPPED.
-- Unset/empty = no behavior change. Known name here: runtime-globals.
getSkipSteps :: IO (Set.Set String)
getSkipSteps = do
  mv <- lookupEnv "GRAFEMA_SKIP_RESOLVE_STEPS"
  case mv of
    Nothing -> pure Set.empty
    Just v  -> pure (Set.fromList (words (map (\c -> if c == ',' then ' ' else c) v)))

-- | Request from orchestrator in daemon mode. The `workspace_packages` field is
-- still sent by the orchestrator on resolve-file requests (it was consumed by
-- the deleted import-resolution step); it is accepted and ignored for wire
-- compatibility.
data DaemonRequest = DaemonRequest
  { drCmd   :: Text
  , drNodes :: [GraphNode]
  }

instance FromJSON DaemonRequest where
  parseJSON = withObject "DaemonRequest" $ \v -> DaemonRequest
    <$> v .: "cmd"
    <*> v .:? "nodes" .!= []

-- | Response to orchestrator.
data DaemonResponse
  = ResOk [PluginCommand]
  | ResError String

instance ToJSON DaemonResponse where
  toJSON (ResOk cmds) = object
    [ "status"   .= ("ok" :: Text)
    , "commands" .= cmds
    ]
  toJSON (ResError msg) = object
    [ "status" .= ("error" :: Text)
    , "error"  .= msg
    ]

-- | JS-specific resolution strategy for runtime globals.
-- Uses RESOLVES_TO edges (not READS_FROM) and matches REFERENCE nodes.
jsStrategy :: NameStrategy
jsStrategy = NameStrategy
  { nsSeparator = "."
  , nsPrefix    = "GLOBAL::"
  , nsCategory  = "ecmascript"
  , nsFilter    = FilterReferences
  , nsEdgeType  = "RESOLVES_TO"
  , nsVirtualFile = "<runtime/js>"
  }

-- | Load the effects-db SymbolDB from GRAFEMA_EFFECTS_DB env var.
-- Returns an empty SymbolDB if the env var is not set.
loadEffectsDB :: IO SymbolDB
loadEffectsDB = do
  mPath <- lookupEnv "GRAFEMA_EFFECTS_DB"
  case mPath of
    Just path -> loadSymbolDB path
    Nothing   -> loadSymbolDB "/nonexistent"

-- | Run the remaining resolve step (runtime-globals, unless skipped) over a
-- node set and write the msgpack response directly (bypassing the aeson
-- intermediate, as the result list can be large).
runSteps :: SymbolDB -> [GraphNode] -> IO ()
runSteps symbolDb nodes = do
  skips <- getSkipSteps
  let result = if Set.member "runtime-globals" skips
                 then []
                 else resolveAll jsStrategy symbolDb nodes
  let msgpackResult = MP.ObjectMap $ V.fromList
        [ (MP.ObjectStr "status", MP.ObjectStr "ok")
        , (MP.ObjectStr "commands", MP.ObjectArray (V.fromList (map pluginCommandToMsgpack result)))
        ]
  writeFrame stdout (Binary.encode msgpackResult)

-- | Daemon loop: read frames from stdin, dispatch, write responses.
daemonLoop :: SymbolDB -> IO ()
daemonLoop symbolDb = do
  mFrame <- readFrame stdin
  case mFrame of
    Nothing -> return ()  -- EOF
    Just payload -> do
      case decodeMsgpack payload of
        Left err -> do
          writeFrame stdout (encodeMsgpack (ResError ("decode error: " ++ err)))
        Right req -> do
          case drCmd req of
            -- Context accumulation (kept for protocol compatibility with the
            -- resolve-all flow): the remaining step is per-node-set, so the
            -- context is not retained — load-context chunks are resolved as
            -- they arrive by resolve-all callers; here they are acknowledged.
            "load-context" ->
              writeFrame stdout (encodeMsgpack (ResOk []))
            "clear-context" ->
              writeFrame stdout (encodeMsgpack (ResOk []))
            "resolve-all" -> runSteps symbolDb (drNodes req)
            "resolve-file" -> runSteps symbolDb (drNodes req)
            "runtime-globals" ->
              writeFrame stdout (encodeMsgpack (ResOk (resolveAll jsStrategy symbolDb (drNodes req))))
            cmd -> writeFrame stdout (encodeMsgpack (ResError ("unknown command: " ++ T.unpack cmd)))
      daemonLoop symbolDb

-- | Original CLI subcommand parser.
data Command = CmdRuntimeGlobals

commandParser :: Parser Command
commandParser = subparser
  ( command "runtime-globals"
    (info (pure CmdRuntimeGlobals) (progDesc "Resolve unresolved references to runtime globals"))
  )

cliOpts :: ParserInfo Command
cliOpts = info (commandParser <**> helper)
  ( fullDesc
  <> progDesc "Grafema cross-file resolution plugins"
  <> header "grafema-resolve - resolution plugins for the Grafema graph"
  )

main :: IO ()
main = do
  hSetBinaryMode stdin True
  hSetBinaryMode stdout True
  args <- getArgs
  if "--daemon" `elem` args
    then do
      symbolDb <- loadEffectsDB
      daemonLoop symbolDb
    else do
      cmd <- execParser cliOpts
      case cmd of
        CmdRuntimeGlobals -> do
          symbolDb <- loadEffectsDB
          nodes <- readNodesFromStdin
          writeCommandsToStdout (resolveAll jsStrategy symbolDb nodes)
