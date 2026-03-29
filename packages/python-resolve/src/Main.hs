{-# LANGUAGE OverloadedStrings #-}
module Main where

import Data.Aeson (FromJSON(..), ToJSON(..), withObject, (.:), object, (.=))
import qualified Data.Text as T
import Data.Text (Text)
import System.Environment (getArgs)
import System.IO (stdin, stdout, hSetBinaryMode)
import Options.Applicative
import qualified ImportResolution
import qualified CallResolution
import qualified TypeResolution
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
dispatch "python-imports" nodes = ResOk <$> ImportResolution.resolveAll nodes
dispatch "python-types"   nodes = ResOk <$> TypeResolution.resolveAll nodes
dispatch "python-calls"   nodes = ResOk <$> CallResolution.resolveAll nodes
dispatch "python-all"     nodes = do
  -- Run all 3 resolution phases in one pass (avoids 3x serialization roundtrip)
  imports <- ImportResolution.resolveAll nodes
  types   <- TypeResolution.resolveAll nodes
  calls   <- CallResolution.resolveAll nodes
  return $ ResOk (imports ++ types ++ calls)
dispatch cmd _ = return $ ResError ("unknown command: " ++ T.unpack cmd)

-- | CLI subcommand parser.
data Command = CmdPythonImports | CmdPythonTypes | CmdPythonCalls

commandParser :: Parser Command
commandParser = subparser
  ( command "python-imports"
    (info (pure CmdPythonImports) (progDesc "Resolve Python imports across files"))
  <> command "python-types"
    (info (pure CmdPythonTypes) (progDesc "Resolve Python type references across files"))
  <> command "python-calls"
    (info (pure CmdPythonCalls) (progDesc "Resolve Python function/method calls to declarations"))
  )

cliOpts :: ParserInfo Command
cliOpts = info (commandParser <**> helper)
  ( fullDesc
  <> progDesc "Python cross-file resolution plugins for Grafema"
  <> header "python-resolve - Python import, type, and call resolution for the Grafema graph"
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
        CmdPythonImports -> ImportResolution.run
        CmdPythonTypes   -> TypeResolution.run
        CmdPythonCalls   -> CallResolution.run
