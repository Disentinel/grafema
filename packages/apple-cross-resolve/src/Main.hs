{-# LANGUAGE OverloadedStrings #-}
module Main where

import Data.Aeson (FromJSON(..), ToJSON(..), withObject, (.:), object, (.=))
import qualified Data.Text as T
import Data.Text (Text)
import System.Environment (getArgs)
import System.IO (stdin, stdout, hSetBinaryMode)
import Options.Applicative
import qualified CrossImportResolution
import qualified CrossTypeResolution
import qualified CrossCallResolution
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
dispatch "apple-cross-imports" nodes = ResOk <$> CrossImportResolution.resolveAll nodes
dispatch "apple-cross-types"   nodes = ResOk <$> CrossTypeResolution.resolveAll nodes
dispatch "apple-cross-calls"   nodes = ResOk <$> CrossCallResolution.resolveAll nodes
dispatch "apple-cross-all"     nodes = do
  imports <- CrossImportResolution.resolveAll nodes
  types   <- CrossTypeResolution.resolveAll nodes
  calls   <- CrossCallResolution.resolveAll nodes
  return $ ResOk (imports ++ types ++ calls)
dispatch cmd _ = return $ ResError ("unknown command: " ++ T.unpack cmd)

-- | CLI subcommand parser.
data Command = CmdCrossImports | CmdCrossTypes | CmdCrossCalls

commandParser :: Parser Command
commandParser = subparser
  ( command "apple-cross-imports"
    (info (pure CmdCrossImports) (progDesc "Resolve bridging header imports (Swift <-> Obj-C)"))
  <> command "apple-cross-types"
    (info (pure CmdCrossTypes) (progDesc "Resolve Swift<->ObjC type bridging"))
  <> command "apple-cross-calls"
    (info (pure CmdCrossCalls) (progDesc "Resolve cross-language method calls (Swift <-> Obj-C)"))
  )

cliOpts :: ParserInfo Command
cliOpts = info (commandParser <**> helper)
  ( fullDesc
  <> progDesc "Apple cross-language resolution plugins for Grafema"
  <> header "apple-cross-resolve - Apple cross-language resolution (Swift <-> Obj-C)"
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
        CmdCrossImports -> CrossImportResolution.run
        CmdCrossTypes   -> CrossTypeResolution.run
        CmdCrossCalls   -> CrossCallResolution.run
