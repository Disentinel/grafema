{-# LANGUAGE OverloadedStrings #-}
module Main where

import Data.Aeson (FromJSON(..), ToJSON(..), withObject, (.:), object, (.=))
import qualified Data.Text as T
import Data.Text (Text)
import System.Environment (getArgs)
import System.IO (stdin, stdout, hSetBinaryMode)
import Options.Applicative
import qualified PhpImportResolution
import qualified PhpTypeResolution
import qualified PhpCallResolution
import qualified PhpTypeInference
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
dispatch "php-imports"        nodes = ResOk <$> PhpImportResolution.resolveAll nodes
dispatch "php-types"          nodes = ResOk <$> PhpTypeResolution.resolveAll nodes
dispatch "php-calls"          nodes = ResOk <$> PhpCallResolution.resolveAll nodes
dispatch "php-type-inference" nodes = ResOk <$> PhpTypeInference.resolveAll nodes
dispatch "php-all"            nodes = do
  -- Run all 4 resolution phases in one pass (avoids 4x serialization roundtrip)
  imports   <- PhpImportResolution.resolveAll nodes
  types     <- PhpTypeResolution.resolveAll nodes
  inference <- PhpTypeInference.resolveAll nodes
  calls     <- PhpCallResolution.resolveAll nodes
  return $ ResOk (imports ++ types ++ inference ++ calls)
dispatch cmd _ = return $ ResError ("unknown command: " ++ T.unpack cmd)

-- | CLI subcommand parser.
data Command = CmdPhpImports | CmdPhpTypes | CmdPhpCalls | CmdPhpTypeInference

commandParser :: Parser Command
commandParser = subparser
  ( command "php-imports"
    (info (pure CmdPhpImports) (progDesc "Resolve PHP imports across files"))
  <> command "php-types"
    (info (pure CmdPhpTypes) (progDesc "Resolve PHP type references across files"))
  <> command "php-calls"
    (info (pure CmdPhpCalls) (progDesc "Resolve PHP function/method calls to declarations"))
  <> command "php-type-inference"
    (info (pure CmdPhpTypeInference) (progDesc "Resolve PHP type annotations (TYPE_OF, RETURNS)"))
  )

cliOpts :: ParserInfo Command
cliOpts = info (commandParser <**> helper)
  ( fullDesc
  <> progDesc "PHP cross-file resolution plugins for Grafema"
  <> header "php-resolve - PHP import, type, and call resolution for the Grafema graph"
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
        CmdPhpImports        -> PhpImportResolution.run
        CmdPhpTypes          -> PhpTypeResolution.run
        CmdPhpCalls          -> PhpCallResolution.run
        CmdPhpTypeInference  -> PhpTypeInference.run
