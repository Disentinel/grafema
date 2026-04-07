{-# LANGUAGE OverloadedStrings #-}
module Main where

import Data.Aeson (FromJSON(..), ToJSON(..), withObject, (.:), (.:?), (.!=), object, (.=))
import qualified Data.Text as T
import Data.Text (Text)
import System.Environment (getArgs, lookupEnv)
import System.IO (stdin, stdout, stderr, hSetBinaryMode, hPutStrLn)
import Data.Time.Clock (getCurrentTime, diffUTCTime)
import Data.IORef
import Options.Applicative
import qualified ImportResolution
import qualified Builtins
import qualified CrossFileCalls
import qualified SameFileCalls
import qualified PropertyAccess
import qualified JsLocalRefs
import qualified JsThisMethodCalls
import Grafema.Types (GraphNode)
import Grafema.Protocol (PluginCommand(..), readFrame, writeFrame, encodeMsgpack, decodeMsgpack, pluginCommandToMsgpack, readNodesFromStdin, writeCommandsToStdout)
import Grafema.RuntimeGlobals (NameStrategy(..), NodeFilter(..), SymbolDB, loadSymbolDB, resolveAll)
import ImportResolution (ExportIndex, WorkspaceMap, ModuleIndex)
import qualified Data.Binary as Binary
import qualified Data.MessagePack as MP
import qualified Data.Vector as V
import qualified Data.Map.Strict as Map

-- | A workspace package mapping: npm name → entry point file path.
data WorkspacePackage = WorkspacePackage
  { wpName       :: !Text  -- ^ npm package name (e.g., "@grafema/util")
  , wpEntryPoint :: !Text  -- ^ entry point relative to project root (e.g., "packages/util/src/index.ts")
  , wpPackageDir :: !Text  -- ^ package directory relative to project root (e.g., "packages/util")
  } deriving (Show, Eq)

instance FromJSON WorkspacePackage where
  parseJSON = withObject "WorkspacePackage" $ \v -> WorkspacePackage
    <$> v .: "name"
    <*> v .: "entry_point"
    <*> v .: "package_dir"

-- | Request from orchestrator in daemon mode.
data DaemonRequest = DaemonRequest
  { drCmd               :: Text              -- "imports" | "runtime-globals" | "builtins" | "cross-file-calls"
  , drNodes             :: [GraphNode]
  , drWorkspacePackages :: [WorkspacePackage] -- workspace packages for cross-package resolution
  }

instance FromJSON DaemonRequest where
  parseJSON = withObject "DaemonRequest" $ \v -> DaemonRequest
    <$> v .: "cmd"
    <*> v .: "nodes"
    <*> v .:? "workspace_packages" .!= []

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

-- | Daemon context state: accumulates chunks during load-context,
-- flattens once on first resolve command.
data DaemonState
  = Accumulating [[GraphNode]]
  | Finalized [GraphNode]

-- | Pre-built indexes for per-file streaming resolution.
-- Built once by 'build-index', then reused for each 'resolve-file' call.
data ResolveIndexes = ResolveIndexes
  { riExportIndex  :: !ExportIndex
  , riWorkspaceMap :: !WorkspaceMap
  , riModuleIndex  :: !ModuleIndex
  }

-- | JS-specific resolution strategy for runtime globals.
-- Uses RESOLVES_TO edges (not READS_FROM) and matches REFERENCE nodes.
jsStrategy :: NameStrategy
jsStrategy = NameStrategy
  { nsSeparator = "."
  , nsPrefix    = "GLOBAL::"
  , nsCategory  = "ecmascript"
  , nsFilter    = FilterReferences
  , nsEdgeType  = "RESOLVES_TO"
  , nsVirtualFile = "<runtime/js>"
  }

-- | Load the effects-db SymbolDB from GRAFEMA_EFFECTS_DB env var.
-- Returns an empty SymbolDB if the env var is not set.
loadEffectsDB :: IO SymbolDB
loadEffectsDB = do
  mPath <- lookupEnv "GRAFEMA_EFFECTS_DB"
  case mPath of
    Just path -> loadSymbolDB path
    Nothing   -> loadSymbolDB "/nonexistent"

-- | Flatten accumulated chunks into a single list, caching the result.
finalizeContext :: IORef DaemonState -> IO [GraphNode]
finalizeContext stateRef = do
  state <- readIORef stateRef
  case state of
    Finalized cached -> return cached
    Accumulating chunks -> do
      let flat = concat chunks
      writeIORef stateRef (Finalized flat)
      return flat

-- | Daemon loop: read frames from stdin, dispatch, write responses.
--   Maintains an IORef of context chunks that accumulate across load-context calls.
--   Also maintains an IORef of pre-built indexes for per-file streaming resolution.
daemonLoop :: SymbolDB -> IORef DaemonState -> IORef (Maybe ResolveIndexes) -> IO ()
daemonLoop symbolDb stateRef indexRef = do
  mFrame <- readFrame stdin
  case mFrame of
    Nothing -> return ()  -- EOF
    Just payload -> do
      case decodeMsgpack payload of
        Left err -> do
          writeFrame stdout (encodeMsgpack (ResError ("decode error: " ++ err)))
        Right req -> do
          case drCmd req of
            "load-context" -> do
              state <- readIORef stateRef
              case state of
                Accumulating chunks -> do
                  writeIORef stateRef (Accumulating (chunks ++ [drNodes req]))
                  writeFrame stdout (encodeMsgpack (ResOk []))
                Finalized _ -> do
                  -- Defensive: re-accumulate if load-context after resolve
                  writeIORef stateRef (Accumulating [drNodes req])
                  writeFrame stdout (encodeMsgpack (ResOk []))
            "clear-context" -> do
              writeIORef stateRef (Accumulating [])
              writeFrame stdout (encodeMsgpack (ResOk []))
            "resolve-all" -> do
              startTime <- getCurrentTime
              hPutStrLn stderr "[grafema-resolve] Starting resolve-all"
              allNodes <- finalizeContext stateRef
              let ws = drWorkspacePackages req
              let wsList = map (\wp -> (wpName wp, wpEntryPoint wp, wpPackageDir wp)) ws
              -- Run resolvers sequentially via evaluate to ensure each
              -- resolver's indexes are GC-eligible before the next runs.
              -- The ++ chain is lazy so encodeMsgpack serializes incrementally.
              let r1 = SameFileCalls.resolveAll allNodes
              let r2 = JsLocalRefs.resolveAll allNodes
              let r3 = resolveAll jsStrategy symbolDb allNodes
              let r4 = Builtins.resolveAll allNodes
              r5 <- ImportResolution.resolveAllWithWorkspace allNodes wsList
              let r6 = CrossFileCalls.resolveAll allNodes
              let r7 = PropertyAccess.resolveAll allNodes
              let result = r1 ++ r2 ++ r3 ++ r4 ++ r5 ++ r6 ++ r7
              -- Encode directly to msgpack, bypassing aeson intermediate
              let msgpackResult = MP.ObjectMap $ V.fromList
                    [ (MP.ObjectStr "status", MP.ObjectStr "ok")
                    , (MP.ObjectStr "commands", MP.ObjectArray (V.fromList (map pluginCommandToMsgpack result)))
                    ]
              writeFrame stdout (Binary.encode msgpackResult)
              endTime <- getCurrentTime
              hPutStrLn stderr $ "[grafema-resolve] resolve-all complete in "
                ++ show (diffUTCTime endTime startTime)
            "build-index" -> do
              startTime <- getCurrentTime
              let nodes = drNodes req
              let ws = drWorkspacePackages req
              let wsList = map (\wp -> (wpName wp, wpEntryPoint wp, wpPackageDir wp)) ws
              let exportIndex = ImportResolution.buildExportIndex nodes
              let wsMap = ImportResolution.buildWorkspaceMap wsList
              let moduleIndex = ImportResolution.buildModuleIndex nodes
              writeIORef indexRef (Just (ResolveIndexes exportIndex wsMap moduleIndex))
              endTime <- getCurrentTime
              hPutStrLn stderr $ "[grafema-resolve] build-index complete: "
                ++ show (Map.size exportIndex) ++ " files in export index, "
                ++ show (Map.size moduleIndex) ++ " modules, "
                ++ show (diffUTCTime endTime startTime)
              writeFrame stdout (encodeMsgpack (ResOk []))
            "resolve-file" -> do
              mIndexes <- readIORef indexRef
              case mIndexes of
                Nothing -> writeFrame stdout (encodeMsgpack (ResError "No index built. Send build-index first."))
                Just indexes -> do
                  let fileNodes = drNodes req
                  -- Run all 7 resolvers on just this file's nodes
                  let r1 = SameFileCalls.resolveAll fileNodes
                  let r2 = JsLocalRefs.resolveAll fileNodes
                  let r3 = resolveAll jsStrategy symbolDb fileNodes
                  let r4 = Builtins.resolveAll fileNodes
                  -- For import resolution: use pre-built export index + workspace map + module index
                  r5 <- ImportResolution.resolveFileWithIndex (riExportIndex indexes) (riWorkspaceMap indexes) (riModuleIndex indexes) fileNodes
                  -- For cross-file calls: use pre-built export index
                  let r6 = CrossFileCalls.resolveFileWithIndex (riExportIndex indexes) fileNodes
                  let r7 = PropertyAccess.resolveFileWithIndex (riExportIndex indexes) fileNodes
                  let result = r1 ++ r2 ++ r3 ++ r4 ++ r5 ++ r6 ++ r7
                  -- Encode directly to msgpack, bypassing aeson intermediate
                  let msgpackResult = MP.ObjectMap $ V.fromList
                        [ (MP.ObjectStr "status", MP.ObjectStr "ok")
                        , (MP.ObjectStr "commands", MP.ObjectArray (V.fromList (map pluginCommandToMsgpack result)))
                        ]
                  writeFrame stdout (Binary.encode msgpackResult)
            _ -> do
              -- Legacy per-command path (backward compat)
              allNodes <- finalizeContext stateRef
              let allWithReq = allNodes ++ drNodes req
              result <- dispatch symbolDb (drCmd req) allWithReq (drWorkspacePackages req)
              writeFrame stdout (encodeMsgpack result)
      daemonLoop symbolDb stateRef indexRef

-- | Dispatch a request to the appropriate resolver.
dispatch :: SymbolDB -> Text -> [GraphNode] -> [WorkspacePackage] -> IO DaemonResponse
dispatch _ "imports" nodes wsPackages =
  let wsList = map (\wp -> (wpName wp, wpEntryPoint wp, wpPackageDir wp)) wsPackages
  in ResOk <$> ImportResolution.resolveAllWithWorkspace nodes wsList
dispatch symbolDb "runtime-globals" nodes _ = return $ ResOk (resolveAll jsStrategy symbolDb nodes)
dispatch _ "builtins" nodes _ = return $ ResOk (Builtins.resolveAll nodes)
dispatch _ "cross-file-calls" nodes _ = return $ ResOk (CrossFileCalls.resolveAll nodes)
dispatch _ "same-file-calls" nodes _ = return $ ResOk (SameFileCalls.resolveAll nodes)
dispatch _ "property-access" nodes _ = return $ ResOk (PropertyAccess.resolveAll nodes)
dispatch _ "js-local-refs" nodes _ = return $ ResOk (JsLocalRefs.resolveAll nodes)
dispatch _ "js-this-method-calls" nodes _ = ResOk <$> JsThisMethodCalls.resolveAll nodes []
dispatch _ cmd _ _ = return $ ResError ("unknown command: " ++ T.unpack cmd)

-- | Original CLI subcommand parser.
data Command = CmdImports | CmdRuntimeGlobals | CmdBuiltins | CmdCrossFileCalls | CmdSameFileCalls | CmdPropertyAccess | CmdJsLocalRefs

commandParser :: Parser Command
commandParser = subparser
  ( command "imports"
    (info (pure CmdImports) (progDesc "Resolve JS/TS imports across files"))
  <> command "runtime-globals"
    (info (pure CmdRuntimeGlobals) (progDesc "Resolve unresolved references to runtime globals"))
  <> command "builtins"
    (info (pure CmdBuiltins) (progDesc "Resolve Node.js builtin module imports and calls"))
  <> command "cross-file-calls"
    (info (pure CmdCrossFileCalls) (progDesc "Create CALLS edges for cross-file invocations"))
  <> command "same-file-calls"
    (info (pure CmdSameFileCalls) (progDesc "Create CALLS edges for same-file function invocations"))
  <> command "property-access"
    (info (pure CmdPropertyAccess) (progDesc "Resolve PROPERTY_ACCESS nodes to property definitions"))
  <> command "js-local-refs"
    (info (pure CmdJsLocalRefs) (progDesc "Resolve JS/TS REFERENCE nodes to same-file declarations"))
  )

cliOpts :: ParserInfo Command
cliOpts = info (commandParser <**> helper)
  ( fullDesc
  <> progDesc "Grafema cross-file resolution plugins"
  <> header "grafema-resolve - resolution plugins for the Grafema graph"
  )

main :: IO ()
main = do
  hSetBinaryMode stdin True
  hSetBinaryMode stdout True
  args <- getArgs
  if "--daemon" `elem` args
    then do
      symbolDb <- loadEffectsDB
      contextRef <- newIORef (Accumulating [])
      indexRef <- newIORef Nothing
      daemonLoop symbolDb contextRef indexRef
    else do
      cmd <- execParser cliOpts
      case cmd of
        CmdImports        -> ImportResolution.run
        CmdRuntimeGlobals -> do
          symbolDb <- loadEffectsDB
          nodes <- readNodesFromStdin
          writeCommandsToStdout (resolveAll jsStrategy symbolDb nodes)
        CmdBuiltins       -> Builtins.run
        CmdCrossFileCalls -> CrossFileCalls.run
        CmdSameFileCalls  -> SameFileCalls.run
        CmdPropertyAccess -> PropertyAccess.run
        CmdJsLocalRefs    -> JsLocalRefs.run
