{-# LANGUAGE OverloadedStrings #-}
module Main where

import Data.Aeson (FromJSON(..), ToJSON(..), withObject, (.:), object, (.=))
import qualified Data.Text as T
import Data.Text (Text)
import System.Environment (getArgs)
import System.IO (stdin, stdout, hSetBinaryMode)
import Options.Applicative
import qualified SwiftImportResolution
import qualified SwiftCallResolution
import qualified SwiftTypeResolution
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
dispatch "swift-imports"  nodes = ResOk <$> SwiftImportResolution.resolveAll nodes
dispatch "swift-calls"    nodes = ResOk <$> SwiftCallResolution.resolveAll nodes
dispatch "swift-types"    nodes = ResOk <$> SwiftTypeResolution.resolveAll nodes
dispatch "swift-all"      nodes = do
  imports <- SwiftImportResolution.resolveAll nodes
  types   <- SwiftTypeResolution.resolveAll nodes
  calls   <- SwiftCallResolution.resolveAll nodes
  return $ ResOk (imports ++ types ++ calls)
dispatch cmd _ = return $ ResError ("unknown command: " ++ T.unpack cmd)

-- | CLI subcommand parser.
data Command = CmdImports | CmdCalls | CmdTypes

commandParser :: Parser Command
commandParser = subparser
  ( command "swift-imports"
    (info (pure CmdImports) (progDesc "Resolve Swift module imports"))
  <> command "swift-calls"
    (info (pure CmdCalls) (progDesc "Resolve cross-file function calls"))
  <> command "swift-types"
    (info (pure CmdTypes) (progDesc "Resolve type references and conformances"))
  )

cliOpts :: ParserInfo Command
cliOpts = info (commandParser <**> helper)
  ( fullDesc
  <> progDesc "Swift resolution plugins for Grafema"
  <> header "swift-resolve - Swift cross-file resolution"
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
        CmdImports -> SwiftImportResolution.run
        CmdCalls   -> SwiftCallResolution.run
        CmdTypes   -> SwiftTypeResolution.run
