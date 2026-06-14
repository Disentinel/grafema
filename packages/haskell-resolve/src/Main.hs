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
import Grafema.Types (GraphNode(..), GraphEdge)
import Grafema.Protocol (PluginCommand(..), readFrame, writeFrame, encodeMsgpack, decodeMsgpack, readNodesFromStdin, writeCommandsToStdout)
import Grafema.RuntimeGlobals (NameStrategy(..), NodeFilter(..), SymbolDB, loadSymbolDBFiles, resolveAll)
import System.FilePath ((</>))
import qualified Data.Set as Set

-- | Resolve the @haskell-globals@ command: unresolved CALLs against the stdlib
-- globals DB (CALLS edges) AND unbound value-REFERENCEs against the Prelude
-- (READS_FROM edges). Both passes share the @HASKELL_GLOBAL::@ virtual-node
-- namespace, so a name resolved by BOTH (e.g. @map@ called and referenced)
-- would otherwise emit its virtual node twice with conflicting bodies. We keep
-- the first EmitNode per id (CALL pass) and drop later duplicates; every edge
-- is preserved so each carries its own provenance (CALLS\/haskell-stdlib vs
-- READS_FROM\/haskell-prelude). RFDB also dedups nodes by id on commit, but
-- emitting a single, deterministic body here avoids last-write-wins races.
resolveHaskellGlobals :: SymbolDB -> [GraphNode] -> [PluginCommand]
resolveHaskellGlobals symbolDb nodes =
  dedupEmitNodes
    (resolveAll haskellStrategy symbolDb nodes
       ++ resolveAll haskellRefsStrategy symbolDb nodes)

-- | Drop 'EmitNode' commands whose node id was already emitted earlier in the
-- list. 'EmitEdge' commands are passed through unchanged.
dedupEmitNodes :: [PluginCommand] -> [PluginCommand]
dedupEmitNodes = go Set.empty
  where
    go _    [] = []
    go seen (EmitNode n : rest)
      | gnId n `Set.member` seen = go seen rest
      | otherwise = EmitNode n : go (Set.insert (gnId n) seen) rest
    go seen (cmd : rest) = cmd : go seen rest

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
  , nsResolvedVia = "runtime-globals"
  , nsGlobalCategory = "haskell-stdlib"
  , nsNodeType    = "GLOBAL_DEFINITION"
  , nsNodeSource  = "effects-db"
  }

-- | Haskell strategy for unqualified value-REFERENCE nodes (prelude reads).
--
-- Re-homes the prelude reference arm retired from HaskellLocalRefs: an
-- unqualified REFERENCE with no same-file binding (and not imported) that
-- names a Prelude\/base symbol resolves to a @HASKELL_GLOBAL::@ virtual via a
-- @READS_FROM@ edge. Edge\/node provenance is byte-identical to the legacy
-- native resolver (@resolvedVia=haskell-local-refs@,
-- @globalCategory=haskell-prelude@, node type @EXTERNAL_FUNCTION@,
-- @source=haskell-local-refs@) so a reload is a no-op for downstream.
haskellRefsStrategy :: NameStrategy
haskellRefsStrategy = NameStrategy
  { nsSeparator = "."
  , nsPrefix    = "HASKELL_GLOBAL::"
  , nsCategory  = "haskell-prelude"
  , nsFilter    = FilterReferencesUnbound
  , nsEdgeType  = "READS_FROM"
  , nsVirtualFile = ""
  , nsResolvedVia = "haskell-local-refs"
  , nsGlobalCategory = "haskell-prelude"
  , nsNodeType    = "EXTERNAL_FUNCTION"
  , nsNodeSource  = "haskell-local-refs"
  }

-- | Load the Haskell-scoped SymbolDB from the GRAFEMA_EFFECTS_DB env var.
--
-- Reads ONLY @runtimes\/haskell.yaml@ (not the whole multi-language
-- effects-db). This prevents cross-language contamination: bare names such as
-- @insert@\/@member@\/@run@\/@size@ exist only in the rust\/erlang\/elixir\/
-- python\/node runtime files, and the language-agnostic loader would otherwise
-- pull them into the Haskell SymbolDB and tag matched references\/calls with the
-- Haskell category. Returns an empty SymbolDB if the env var is unset.
loadEffectsDB :: IO SymbolDB
loadEffectsDB = do
  mPath <- lookupEnv "GRAFEMA_EFFECTS_DB"
  case mPath of
    Just path -> loadSymbolDBFiles [path </> "runtimes" </> "haskell.yaml"]
    Nothing   -> loadSymbolDBFiles []

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
dispatch symbolDb "haskell-globals"    nodes _     = return $ ResOk (resolveHaskellGlobals symbolDb nodes)
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
          writeCommandsToStdout (resolveHaskellGlobals symbolDb nodes)
