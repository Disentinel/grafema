{-# LANGUAGE OverloadedStrings #-}
module Main where

import Data.Aeson (FromJSON(..), ToJSON(..), withObject, (.:), object, (.=))
import qualified Data.Text as T
import Data.Text (Text)
import System.Environment (getArgs)
import System.IO (stdin, stdout, hSetBinaryMode)
import Options.Applicative
import qualified HaskellImportResolution
import qualified HaskellLocalRefs
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
dispatch "haskell-imports" nodes = ResOk <$> HaskellImportResolution.resolveAll nodes
dispatch "haskell-local-refs" nodes = return $ ResOk (HaskellLocalRefs.resolveAll nodes)
dispatch cmd _ = return $ ResError ("unknown command: " ++ T.unpack cmd)

-- | CLI subcommand parser.
data Command = CmdHaskellImports | CmdHaskellLocalRefs

commandParser :: Parser Command
commandParser = subparser
  ( command "haskell-imports"
    (info (pure CmdHaskellImports) (progDesc "Resolve Haskell imports across files"))
  <> command "haskell-local-refs"
    (info (pure CmdHaskellLocalRefs) (progDesc "Resolve Haskell local references to same-file declarations"))
  )

cliOpts :: ParserInfo Command
cliOpts = info (commandParser <**> helper)
  ( fullDesc
  <> progDesc "Haskell cross-file resolution plugins for Grafema"
  <> header "haskell-resolve - Haskell import resolution for the Grafema graph"
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
        CmdHaskellImports    -> HaskellImportResolution.run
        CmdHaskellLocalRefs  -> HaskellLocalRefs.run
