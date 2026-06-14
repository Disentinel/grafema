{-# LANGUAGE OverloadedStrings #-}
module Main where

import Data.Aeson (FromJSON(..), ToJSON(..), withObject, (.:), (.:?), (.!=), object, (.=))
import qualified Data.Text as T
import Data.Text (Text)
import System.Environment (getArgs, lookupEnv)
import System.IO (stdin, stdout, hSetBinaryMode)
import Options.Applicative
import qualified RustCrossMethodCalls
import Grafema.Types (GraphNode, GraphEdge)
import Grafema.Protocol (PluginCommand(..), readFrame, writeFrame, encodeMsgpack, decodeMsgpack, readNodesFromStdin, writeCommandsToStdout)
import Grafema.RuntimeGlobals (NameStrategy(..), NodeFilter(..), SymbolDB, loadSymbolDB, resolveAll)

-- NOTE (Wave 6, resolve→derive migration): the rust-imports, rust-calls and
-- rust-trait-resolve commands (RustImportResolution / RustCallResolution /
-- RustTraitResolution) were replaced by the rust_imports / rust_calls /
-- rust_trait_resolve derive stdlib packs and DELETED — see
-- the resolve-migration synthesis doc in _ai/research/ for the per-step
-- evidence. The remaining native steps are rust-cross-methods (its
-- dyn-dispatch and self-field arms have no pack) and rust-globals
-- (effects-db driven; no facts pack exists for Rust).

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

-- | Rust-specific resolution strategy for runtime globals.
rustStrategy :: NameStrategy
rustStrategy = NameStrategy
  { nsSeparator = "::"
  , nsPrefix    = "RUST_GLOBAL::"
  , nsCategory  = "rust-stdlib"
  , nsFilter    = FilterCalls
  , nsEdgeType  = "CALLS"
  , nsVirtualFile = "<runtime/rust>"
  , nsResolvedVia = "runtime-globals"
  , nsGlobalCategory = "rust-stdlib"
  , nsNodeType    = "GLOBAL_DEFINITION"
  , nsNodeSource  = "effects-db"
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
dispatch _        "rust-cross-methods" nodes edges = ResOk <$> RustCrossMethodCalls.resolveAll nodes edges
dispatch symbolDb "rust-globals"       nodes _     = return $ ResOk (resolveAll rustStrategy symbolDb nodes)
dispatch _        cmd                  _     _     = return $ ResError ("unknown command: " ++ T.unpack cmd)

-- | CLI subcommand parser.
data Command = CmdRustCrossMethods | CmdRustGlobals

commandParser :: Parser Command
commandParser = subparser
  ( command "rust-cross-methods"
    (info (pure CmdRustCrossMethods) (progDesc "Resolve Rust cross-file method calls via type annotations"))
 <> command "rust-globals"
    (info (pure CmdRustGlobals) (progDesc "Resolve Rust stdlib globals for unresolved calls"))
  )

cliOpts :: ParserInfo Command
cliOpts = info (commandParser <**> helper)
  ( fullDesc
  <> progDesc "Rust cross-file resolution plugins for Grafema"
  <> header "rust-resolve - Rust resolution plugins for the Grafema graph"
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
        CmdRustCrossMethods -> RustCrossMethodCalls.run
        CmdRustGlobals -> do
          symbolDb <- loadEffectsDB
          nodes <- readNodesFromStdin
          writeCommandsToStdout (resolveAll rustStrategy symbolDb nodes)
