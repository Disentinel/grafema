{-# LANGUAGE OverloadedStrings #-}
module Main where

import Data.Aeson (FromJSON(..), ToJSON(..), withObject, (.:), (.:?), (.!=), object, (.=))
import qualified Data.Text as T
import Data.Text (Text)
import System.Environment (getArgs)
import System.IO (stdin, stdout, stderr, hSetBinaryMode, hPutStrLn)
import Data.Time.Clock (getCurrentTime, diffUTCTime)
import Data.IORef
import Options.Applicative
import qualified ImportResolution
import qualified RuntimeGlobals
import qualified Builtins
import qualified CrossFileCalls
import qualified SameFileCalls
import qualified PropertyAccess
import qualified JsLocalRefs
import Grafema.Types (GraphNode)
import Grafema.Protocol (PluginCommand(..), readFrame, writeFrame, encodeMsgpack, decodeMsgpack, pluginCommandToMsgpack)
import qualified Data.Binary as Binary
import qualified Data.MessagePack as MP
import qualified Data.Vector as V

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
daemonLoop :: IORef DaemonState -> IO ()
daemonLoop stateRef = do
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
              let r3 = RuntimeGlobals.resolveAll allNodes
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
            _ -> do
              -- Legacy per-command path (backward compat)
              allNodes <- finalizeContext stateRef
              let allWithReq = allNodes ++ drNodes req
              result <- dispatch (drCmd req) allWithReq (drWorkspacePackages req)
              writeFrame stdout (encodeMsgpack result)
      daemonLoop stateRef

-- | Dispatch a request to the appropriate resolver.
dispatch :: Text -> [GraphNode] -> [WorkspacePackage] -> IO DaemonResponse
dispatch "imports" nodes wsPackages =
  let wsList = map (\wp -> (wpName wp, wpEntryPoint wp, wpPackageDir wp)) wsPackages
  in ResOk <$> ImportResolution.resolveAllWithWorkspace nodes wsList
dispatch "runtime-globals" nodes _ = return $ ResOk (RuntimeGlobals.resolveAll nodes)
dispatch "builtins" nodes _ = return $ ResOk (Builtins.resolveAll nodes)
dispatch "cross-file-calls" nodes _ = return $ ResOk (CrossFileCalls.resolveAll nodes)
dispatch "same-file-calls" nodes _ = return $ ResOk (SameFileCalls.resolveAll nodes)
dispatch "property-access" nodes _ = return $ ResOk (PropertyAccess.resolveAll nodes)
dispatch "js-local-refs" nodes _ = return $ ResOk (JsLocalRefs.resolveAll nodes)
dispatch cmd _ _ = return $ ResError ("unknown command: " ++ T.unpack cmd)

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
      contextRef <- newIORef (Accumulating [])
      daemonLoop contextRef
    else do
      cmd <- execParser cliOpts
      case cmd of
        CmdImports        -> ImportResolution.run
        CmdRuntimeGlobals -> RuntimeGlobals.run
        CmdBuiltins       -> Builtins.run
        CmdCrossFileCalls -> CrossFileCalls.run
        CmdSameFileCalls  -> SameFileCalls.run
        CmdPropertyAccess -> PropertyAccess.run
        CmdJsLocalRefs    -> JsLocalRefs.run
