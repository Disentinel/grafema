{-# LANGUAGE OverloadedStrings #-}
module Main where

import Data.Aeson (FromJSON(..), ToJSON(..), withObject, (.:), (.:?), (.!=), object, (.=))
import qualified Data.Text as T
import Data.Text (Text)
import System.Environment (getArgs, lookupEnv)
import System.IO (stdin, stdout, hSetBinaryMode)
import Options.Applicative
import qualified HaskellImportResolution
import qualified HaskellLocalRefs
import qualified HaskellCrossModuleCalls
import Grafema.Types (GraphNode, GraphEdge)
import Grafema.Protocol (PluginCommand(..), readFrame, writeFrame, encodeMsgpack, decodeMsgpack, readNodesFromStdin, writeCommandsToStdout)
import Grafema.RuntimeGlobals (NameStrategy(..), NodeFilter(..), SymbolDB, loadSymbolDB, resolveAll)

-- | Request from orchestrator in daemon mode.
data DaemonRequest = DaemonRequest
  { drCmd   :: Text
  , drNodes :: [GraphNode]
  , drEdges :: [GraphEdge]
  }

instance FromJSON DaemonRequest where
  parseJSON = withObject "DaemonRequest" $ \v -> DaemonRequest
    <$> v .: "cmd"
    <*> v .: "nodes"
    <*> v .:? "edges" .!= []

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

-- | Haskell-specific resolution strategy for runtime globals.
haskellStrategy :: NameStrategy
haskellStrategy = NameStrategy
  { nsSeparator = "."
  , nsPrefix    = "HASKELL_GLOBAL::"
  , nsCategory  = "haskell-stdlib"
  , nsFilter    = FilterCalls
  , nsEdgeType  = "CALLS"
  , nsVirtualFile = "<runtime/haskell>"
  }

-- | Load the effects-db SymbolDB from GRAFEMA_EFFECTS_DB env var.
-- Returns an empty SymbolDB if the env var is not set.
loadEffectsDB :: IO SymbolDB
loadEffectsDB = do
  mPath <- lookupEnv "GRAFEMA_EFFECTS_DB"
  case mPath of
    Just path -> loadSymbolDB path
    Nothing   -> loadSymbolDB "/nonexistent"

-- | Daemon loop: read frames, dispatch, write responses.
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
          result <- dispatch symbolDb (drCmd req) (drNodes req) (drEdges req)
          writeFrame stdout (encodeMsgpack result)
      daemonLoop symbolDb

-- | Dispatch a command to the resolver.
dispatch :: SymbolDB -> Text -> [GraphNode] -> [GraphEdge] -> IO DaemonResponse
dispatch _        "haskell-imports"    nodes _     = ResOk <$> HaskellImportResolution.resolveAll nodes
dispatch _        "haskell-local-refs" nodes _     = return $ ResOk (HaskellLocalRefs.resolveAll nodes)
dispatch _        "haskell-cross-module-calls" nodes edges = ResOk <$> HaskellCrossModuleCalls.resolveAll nodes edges
dispatch symbolDb "haskell-globals"    nodes _     = return $ ResOk (resolveAll haskellStrategy symbolDb nodes)
dispatch _        cmd                  _     _     = return $ ResError ("unknown command: " ++ T.unpack cmd)

-- | CLI subcommand parser.
data Command = CmdHaskellImports | CmdHaskellLocalRefs | CmdHaskellCrossModule | CmdHaskellGlobals

commandParser :: Parser Command
commandParser = subparser
  ( command "haskell-imports"
    (info (pure CmdHaskellImports) (progDesc "Resolve Haskell imports across files"))
  <> command "haskell-local-refs"
    (info (pure CmdHaskellLocalRefs) (progDesc "Resolve Haskell local references to same-file declarations"))
  <> command "haskell-cross-module-calls"
    (info (pure CmdHaskellCrossModule) (progDesc "Resolve Haskell CALLs to imported declarations"))
  <> command "haskell-globals"
    (info (pure CmdHaskellGlobals) (progDesc "Resolve unresolved Haskell calls against stdlib globals database"))
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
    then do
      symbolDb <- loadEffectsDB
      daemonLoop symbolDb
    else do
      cmd <- execParser cliOpts
      case cmd of
        CmdHaskellImports     -> HaskellImportResolution.run
        CmdHaskellLocalRefs   -> HaskellLocalRefs.run
        CmdHaskellCrossModule -> HaskellCrossModuleCalls.run
        CmdHaskellGlobals     -> do
          symbolDb <- loadEffectsDB
          nodes <- readNodesFromStdin
          writeCommandsToStdout (resolveAll haskellStrategy symbolDb nodes)
