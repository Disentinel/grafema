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
import Grafema.Types (GraphNode)
import Grafema.Protocol (PluginCommand(..), readFrame, writeFrame, encodeMsgpack, decodeMsgpack)

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

-- | Daemon loop: read frames, dispatch, write responses.
daemonLoop :: IO ()
daemonLoop = do
  mFrame <- readFrame stdin
  case mFrame of
    Nothing -> return ()  -- EOF
    Just payload -> do
      case decodeMsgpack payload of
        Left err -> do
          writeFrame stdout (encodeMsgpack (ResError ("decode error: " ++ err)))
        Right req -> do
          result <- dispatch (drCmd req) (drNodes req)
          writeFrame stdout (encodeMsgpack result)
      daemonLoop

-- | Dispatch a command to the resolver.
dispatch :: Text -> [GraphNode] -> IO DaemonResponse
dispatch "beam-imports"    nodes = ResOk <$> BeamImportResolution.resolveAll nodes
dispatch "beam-local-refs" nodes = return $ ResOk (BeamLocalRefs.resolveAll nodes)
dispatch "beam-protocols"  nodes = return $ ResOk (BeamProtocolResolution.resolveAll nodes)
dispatch "beam-behaviours" nodes = return $ ResOk (BeamBehaviourResolution.resolveAll nodes)
dispatch cmd _ = return $ ResError ("unknown command: " ++ T.unpack cmd)

-- | CLI subcommand parser.
data Command
  = CmdBeamImports
  | CmdBeamLocalRefs
  | CmdBeamProtocols
  | CmdBeamBehaviours

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
    then daemonLoop
    else do
      cmd <- execParser cliOpts
      case cmd of
        CmdBeamImports     -> BeamImportResolution.run
        CmdBeamLocalRefs   -> BeamLocalRefs.run
        CmdBeamProtocols   -> BeamProtocolResolution.run
        CmdBeamBehaviours  -> BeamBehaviourResolution.run
