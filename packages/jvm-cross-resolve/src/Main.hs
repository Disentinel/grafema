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
dispatch "jvm-cross-imports" nodes = ResOk <$> CrossImportResolution.resolveAll nodes
dispatch "jvm-cross-types"   nodes = ResOk <$> CrossTypeResolution.resolveAll nodes
dispatch "jvm-cross-calls"   nodes = ResOk <$> CrossCallResolution.resolveAll nodes
dispatch "jvm-cross-all"     nodes = do
  imports <- CrossImportResolution.resolveAll nodes
  types   <- CrossTypeResolution.resolveAll nodes
  calls   <- CrossCallResolution.resolveAll nodes
  return $ ResOk (imports ++ types ++ calls)
dispatch cmd _ = return $ ResError ("unknown command: " ++ T.unpack cmd)

-- | CLI subcommand parser.
data Command = CmdCrossImports | CmdCrossTypes | CmdCrossCalls

commandParser :: Parser Command
commandParser = subparser
  ( command "jvm-cross-imports"
    (info (pure CmdCrossImports) (progDesc "Resolve cross-language imports (Java <-> Kotlin)"))
  <> command "jvm-cross-types"
    (info (pure CmdCrossTypes) (progDesc "Resolve cross-language type references (Java <-> Kotlin)"))
  <> command "jvm-cross-calls"
    (info (pure CmdCrossCalls) (progDesc "Resolve cross-language method calls (Java <-> Kotlin)"))
  )

cliOpts :: ParserInfo Command
cliOpts = info (commandParser <**> helper)
  ( fullDesc
  <> progDesc "JVM cross-language resolution plugins for Grafema"
  <> header "jvm-cross-resolve - JVM cross-language resolution (Java <-> Kotlin)"
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
