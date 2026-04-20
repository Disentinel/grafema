{-# LANGUAGE OverloadedStrings #-}
module Main where

import Data.Aeson (FromJSON(..), ToJSON(..), withObject, (.:), object, (.=))
import qualified Data.Text as T
import Data.Text (Text)
import System.Environment (getArgs)
import System.IO (stdin, stdout, hSetBinaryMode)
import Options.Applicative
import qualified BeamImportResolution
import qualified BeamLocalRefs
import qualified BeamProtocolResolution
import qualified BeamBehaviourResolution
import qualified BeamRuntimeGlobals
import qualified BeamWrapperResolution
import qualified BeamMessageFindings
import qualified BeamMessageTypeResolution
import qualified Grafema.RuntimeGlobals as RG
import Grafema.Types (GraphNode)
import Grafema.Protocol (PluginCommand(..), readFrame, writeFrame, encodeMsgpack, decodeMsgpack)
import System.Environment (lookupEnv)
import Data.Maybe (fromMaybe)
import Data.IORef

-- | Request from orchestrator in daemon mode.
data DaemonRequest = DaemonRequest
  { drCmd   :: Text
  , drNodes :: [GraphNode]
  }

instance FromJSON DaemonRequest where
  parseJSON = withObject "DaemonRequest" $ \v -> DaemonRequest
    <$> v .: "cmd"
    <*> v .: "nodes"

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

-- | Lazily loaded effects-db symbol cache. The DB is only needed for
-- @beam-runtime-globals@, so we defer the (relatively cheap but
-- non-trivial) YAML parse until the first such request and cache the
-- result for subsequent calls within the same daemon lifetime.
type SymbolCache = IORef (Maybe RG.SymbolDB)

-- | Daemon loop: read frames, dispatch, write responses.
daemonLoop :: SymbolCache -> IO ()
daemonLoop cache = do
  mFrame <- readFrame stdin
  case mFrame of
    Nothing -> return ()  -- EOF
    Just payload -> do
      case decodeMsgpack payload of
        Left err -> do
          writeFrame stdout (encodeMsgpack (ResError ("decode error: " ++ err)))
        Right req -> do
          result <- dispatch cache (drCmd req) (drNodes req)
          writeFrame stdout (encodeMsgpack result)
      daemonLoop cache

-- | Resolve the effects-db root from @GRAFEMA_EFFECTS_DB@, defaulting
-- to @./effects-db@ for ad-hoc CLI runs.
loadCachedDB :: SymbolCache -> IO RG.SymbolDB
loadCachedDB cache = do
  cur <- readIORef cache
  case cur of
    Just db -> return db
    Nothing -> do
      effectsDir <- fromMaybe "effects-db" <$> lookupEnv "GRAFEMA_EFFECTS_DB"
      db <- RG.loadSymbolDB effectsDir
      writeIORef cache (Just db)
      return db

-- | Dispatch a command to the resolver.
dispatch :: SymbolCache -> Text -> [GraphNode] -> IO DaemonResponse
dispatch _ "beam-imports"    nodes = ResOk <$> BeamImportResolution.resolveAll nodes
dispatch _ "beam-local-refs" nodes = return $ ResOk (BeamLocalRefs.resolveAll nodes)
dispatch _ "beam-protocols"  nodes = return $ ResOk (BeamProtocolResolution.resolveAll nodes)
dispatch _ "beam-behaviours" nodes = return $ ResOk (BeamBehaviourResolution.resolveAll nodes)
dispatch cache "beam-runtime-globals" nodes = do
  db <- loadCachedDB cache
  return $ ResOk (BeamRuntimeGlobals.resolveAll db nodes)
dispatch _ "beam-wrapper-resolve" nodes = return $ ResOk (BeamWrapperResolution.resolveAll nodes)
dispatch _ "beam-message-types" nodes = return $ ResOk (BeamMessageTypeResolution.resolveAll nodes)
dispatch _ "beam-message-findings" nodes = return $ ResOk (BeamMessageFindings.runFindings nodes [])
dispatch _ cmd _ = return $ ResError ("unknown command: " ++ T.unpack cmd)

-- | CLI subcommand parser.
data Command
  = CmdBeamImports
  | CmdBeamLocalRefs
  | CmdBeamProtocols
  | CmdBeamBehaviours
  | CmdBeamRuntimeGlobals
  | CmdBeamWrapperResolve
  | CmdBeamMessageTypes
  | CmdBeamMessageFindings

commandParser :: Parser Command
commandParser = subparser
  ( command "beam-imports"
    (info (pure CmdBeamImports) (progDesc "Resolve BEAM module imports (alias/import/use/require)"))
  <> command "beam-local-refs"
    (info (pure CmdBeamLocalRefs) (progDesc "Resolve BEAM local function calls to same-file definitions"))
  <> command "beam-protocols"
    (info (pure CmdBeamProtocols) (progDesc "Resolve BEAM protocol implementations (defimpl)"))
  <> command "beam-behaviours"
    (info (pure CmdBeamBehaviours) (progDesc "Resolve BEAM behaviour callbacks (@behaviour)"))
  <> command "beam-runtime-globals"
    (info (pure CmdBeamRuntimeGlobals) (progDesc "Resolve BEAM stdlib calls (Elixir + Erlang BIFs) via effects-db"))
  <> command "beam-wrapper-resolve"
    (info (pure CmdBeamWrapperResolve) (progDesc "Emit virtual side-effect edges for calls to public-API wrapper functions (REG-1098 W6)"))
  <> command "beam-message-types"
    (info (pure CmdBeamMessageTypes) (progDesc "Emit SENDS_MESSAGE / SELF_SCHEDULE edges from CALL send-sites to matching MESSAGE_TYPE clauses"))
  <> command "beam-message-findings"
    (info (pure CmdBeamMessageFindings) (progDesc "Emit ISSUE nodes for BEAM MessageFlow findings (REG-1098 W9)"))
  )

cliOpts :: ParserInfo Command
cliOpts = info (commandParser <**> helper)
  ( fullDesc
  <> progDesc "BEAM cross-file resolution plugins for Grafema"
  <> header "beam-resolve - BEAM (Elixir/Erlang) resolution for the Grafema graph"
  )

main :: IO ()
main = do
  hSetBinaryMode stdin True
  hSetBinaryMode stdout True
  args <- getArgs
  if "--daemon" `elem` args
    then do
      cache <- newIORef Nothing
      daemonLoop cache
    else do
      cmd <- execParser cliOpts
      case cmd of
        CmdBeamImports        -> BeamImportResolution.run
        CmdBeamLocalRefs      -> BeamLocalRefs.run
        CmdBeamProtocols      -> BeamProtocolResolution.run
        CmdBeamBehaviours     -> BeamBehaviourResolution.run
        CmdBeamRuntimeGlobals -> BeamRuntimeGlobals.run
        CmdBeamWrapperResolve -> BeamWrapperResolution.run
        CmdBeamMessageTypes   -> BeamMessageTypeResolution.run
        CmdBeamMessageFindings -> BeamMessageFindings.run
