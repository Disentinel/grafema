{-# LANGUAGE OverloadedStrings #-}
-- | C/C++ cross-file resolution daemon.
--
-- Runs as a daemon process, receiving resolution requests via
-- length-prefixed MessagePack frames on stdin, dispatching to the
-- appropriate resolution module, and returning new edges on stdout.
--
-- == Supported Commands
--
--   * @"cpp-includes"@ — resolve @#include@ directives to MODULE nodes
--   * @"cpp-types"@ — resolve type references, build class hierarchy
--   * @"cpp-calls"@ — resolve function/method calls
--   * @"cpp-virtual"@ — build virtual dispatch tables
--   * @"cpp-templates"@ — resolve template instantiations and specializations
--   * @"cpp-operators"@ — resolve overloaded operator calls
--   * @"cpp-constructors"@ — resolve constructor/destructor calls
--   * @"all"@ — run all phases in correct DAG order
--
-- == Execution Order (DAG)
--
-- When @"all"@ is requested, phases run in dependency order:
--
-- > Phase 0: IncludeResolution, TemplateResolution  (independent)
-- > Phase 1: TypeResolution                         (needs MODULE index)
-- > Phase 2: CallResolution, ConstructorResolution, OperatorResolution
-- >                                                 (need class hierarchy)
-- > Phase 3: VirtualDispatch                        (needs hierarchy + call edges)
module Main where

import Data.Aeson (FromJSON(..), ToJSON(..), withObject, (.:), object, (.=))
import qualified Data.Text as T
import Data.Text (Text)
import System.Environment (getArgs)
import System.IO (stdin, stdout, hSetBinaryMode, hPutStrLn, stderr)
import Grafema.Types (GraphNode)
import Grafema.Protocol (PluginCommand(..), readFrame, writeFrame, encodeMsgpack, decodeMsgpack)
import CppIndex (buildIndex)
import qualified CppIncludeResolution
import qualified CppTypeResolution
import qualified CppCallResolution
import qualified CppVirtualDispatch
import qualified CppTemplateResolution
import qualified CppOperatorResolution
import qualified CppConstructorResolution

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

-- | Dispatch a command to the appropriate resolver.
dispatch :: Text -> [GraphNode] -> IO DaemonResponse
dispatch cmd nodes = do
  let idx = buildIndex nodes
  case cmd of
    "cpp-includes" ->
      return $ ResOk (CppIncludeResolution.resolveAll nodes idx)

    "cpp-types" ->
      return $ ResOk (CppTypeResolution.resolveAll nodes idx)

    "cpp-calls" ->
      return $ ResOk (CppCallResolution.resolveAll nodes idx)

    "cpp-virtual" ->
      -- VirtualDispatch needs existing edges; when called standalone,
      -- it gets no prior edges and produces overrides from metadata alone
      return $ ResOk (CppVirtualDispatch.resolveAll nodes idx [])

    "cpp-templates" ->
      return $ ResOk (CppTemplateResolution.resolveAll nodes idx)

    "cpp-operators" ->
      return $ ResOk (CppOperatorResolution.resolveAll nodes idx)

    "cpp-constructors" ->
      return $ ResOk (CppConstructorResolution.resolveAll nodes idx)

    "all" ->
      return $ ResOk (runAllPhases nodes)

    "cpp-all" ->
      return $ ResOk (runAllPhases nodes)

    _ ->
      return $ ResError ("unknown command: " ++ T.unpack cmd)

-- | Run all resolution phases in correct dependency order.
--
-- Phase 0: Include + Template resolution (independent, no prerequisites)
-- Phase 1: Type resolution (needs MODULE index from include resolution)
-- Phase 2: Call + Constructor + Operator resolution (need class hierarchy)
-- Phase 3: Virtual dispatch (needs hierarchy + call edges)
runAllPhases :: [GraphNode] -> [PluginCommand]
runAllPhases nodes =
  let idx = buildIndex nodes

      -- Phase 0: independent
      includes  = CppIncludeResolution.resolveAll nodes idx
      templates = CppTemplateResolution.resolveAll nodes idx

      -- Phase 1: type resolution (builds EXTENDS, IMPLEMENTS, TYPE_OF, etc.)
      types = CppTypeResolution.resolveAll nodes idx

      -- Phase 2: call resolution (builds CALLS edges)
      calls        = CppCallResolution.resolveAll nodes idx
      constructors = CppConstructorResolution.resolveAll nodes idx
      operators    = CppOperatorResolution.resolveAll nodes idx

      -- Phase 3: virtual dispatch (needs hierarchy + call edges)
      phase012 = includes ++ templates ++ types ++ calls ++ constructors ++ operators
      virtual  = CppVirtualDispatch.resolveAll nodes idx phase012

  in phase012 ++ virtual

-- | Daemon loop: read frames, dispatch, write responses.
daemonLoop :: IO ()
daemonLoop = do
  mFrame <- readFrame stdin
  case mFrame of
    Nothing -> return ()
    Just payload -> do
      case decodeMsgpack payload of
        Left err -> do
          writeFrame stdout (encodeMsgpack (ResError ("decode error: " ++ err)))
        Right req -> do
          result <- dispatch (drCmd req) (drNodes req)
          writeFrame stdout (encodeMsgpack result)
      daemonLoop

main :: IO ()
main = do
  hSetBinaryMode stdin True
  hSetBinaryMode stdout True
  args <- getArgs
  if "--daemon" `elem` args
    then daemonLoop
    else hPutStrLn stderr "Usage: cpp-resolve --daemon"
