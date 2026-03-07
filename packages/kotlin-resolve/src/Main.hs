{-# LANGUAGE OverloadedStrings #-}
module Main where

import Data.Aeson (FromJSON(..), ToJSON(..), withObject, (.:), object, (.=))
import qualified Data.Text as T
import Data.Text (Text)
import System.Environment (getArgs)
import System.IO (stdin, stdout, hSetBinaryMode)
import Options.Applicative
import qualified ImportResolution
import qualified TypeResolution
import qualified CallResolution
import qualified AnnotationResolution
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
dispatch "kotlin-imports"     nodes = ResOk <$> ImportResolution.resolveAll nodes
dispatch "kotlin-types"       nodes = ResOk <$> TypeResolution.resolveAll nodes
dispatch "kotlin-calls"       nodes = ResOk <$> CallResolution.resolveAll nodes
dispatch "kotlin-annotations" nodes = ResOk <$> AnnotationResolution.resolveAll nodes
dispatch "kotlin-all"         nodes = do
  -- Run all 4 resolution phases in one pass (avoids 4x serialization roundtrip)
  imports     <- ImportResolution.resolveAll nodes
  types       <- TypeResolution.resolveAll nodes
  calls       <- CallResolution.resolveAll nodes
  annotations <- AnnotationResolution.resolveAll nodes
  return $ ResOk (imports ++ types ++ calls ++ annotations)
dispatch cmd _ = return $ ResError ("unknown command: " ++ T.unpack cmd)

-- | CLI subcommand parser.
data Command = CmdKotlinImports | CmdKotlinTypes | CmdKotlinCalls | CmdKotlinAnnotations

commandParser :: Parser Command
commandParser = subparser
  ( command "kotlin-imports"
    (info (pure CmdKotlinImports) (progDesc "Resolve Kotlin imports across files"))
  <> command "kotlin-types"
    (info (pure CmdKotlinTypes) (progDesc "Resolve Kotlin type references across files"))
  <> command "kotlin-calls"
    (info (pure CmdKotlinCalls) (progDesc "Resolve Kotlin method/function calls to declarations"))
  <> command "kotlin-annotations"
    (info (pure CmdKotlinAnnotations) (progDesc "Resolve Kotlin annotations to annotation types"))
  )

cliOpts :: ParserInfo Command
cliOpts = info (commandParser <**> helper)
  ( fullDesc
  <> progDesc "Kotlin cross-file resolution plugins for Grafema"
  <> header "kotlin-resolve - Kotlin import and type resolution for the Grafema graph"
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
        CmdKotlinImports     -> ImportResolution.run
        CmdKotlinTypes       -> TypeResolution.run
        CmdKotlinCalls       -> CallResolution.run
        CmdKotlinAnnotations -> AnnotationResolution.run
