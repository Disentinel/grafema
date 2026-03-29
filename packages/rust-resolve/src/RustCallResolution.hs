{-# LANGUAGE OverloadedStrings #-}
-- | Rust intra-file call resolution plugin.
--
-- Creates CALLS edges for CALL nodes that refer to FUNCTION definitions
-- in the same file. This covers:
--
--   * Simple calls: @foo()@ -> CALL.name "foo" matches FUNCTION.name "foo"
--   * Path calls:   @utils::helper()@ -> last segment "helper" matches FUNCTION.name "helper"
--   * Method calls: @self.process()@ -> CALL.name "process" matches FUNCTION.name "process"
--     (impl methods are FUNCTION nodes in the same file)
--
-- Cross-file resolution (via @use@ imports) is handled by 'RustImportResolution'.
-- This module only handles same-file matches.
--
-- == Algorithm
--
-- 1. Build a function index: @(file, name)@ -> node ID  for all FUNCTION nodes.
-- 2. For each CALL node in the same file:
--      a. Try exact match: CALL.name == FUNCTION.name
--      b. Try suffix match: last @::@-segment of CALL.name == FUNCTION.name
-- 3. Emit a CALLS edge from the CALL node to the FUNCTION node.
module RustCallResolution (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import System.IO (hPutStrLn, stderr)

-- | Function index: (file, name) -> node ID.
type FuncIndex = Map (Text, Text) Text

-- | Build function index from FUNCTION nodes.
buildFuncIndex :: [GraphNode] -> FuncIndex
buildFuncIndex nodes =
  Map.fromList
    [ ((gnFile n, gnName n), gnId n)
    | n <- nodes
    , gnType n == "FUNCTION"
    , not (T.null (gnName n))
    ]

-- | Extract the last segment of a Rust path.
--
-- @"crate::module::foo"@ -> @"foo"@
-- @"foo"@                -> @"foo"@
lastSegment :: Text -> Text
lastSegment t =
  case T.splitOn "::" t of
    [] -> t
    xs -> last xs

-- | Resolve a single CALL node to a same-file FUNCTION.
--
-- Returns a CALLS edge command if a matching FUNCTION is found,
-- or Nothing otherwise.
resolveCall :: FuncIndex -> GraphNode -> Maybe PluginCommand
resolveCall funcIdx callNode =
  let file = gnFile callNode
      name = gnName callNode
      seg  = lastSegment name
      -- Try exact match first, then last-segment match
      mTarget =
        case Map.lookup (file, name) funcIdx of
          Just tid -> Just tid
          Nothing
            | seg /= name -> Map.lookup (file, seg) funcIdx
            | otherwise   -> Nothing
  in case mTarget of
    Just targetId ->
      Just $ EmitEdge GraphEdge
        { geSource   = gnId callNode
        , geTarget   = targetId
        , geType     = "CALLS"
        , geMetadata = Map.singleton "resolvedVia" (MetaText "rust-calls")
        }
    Nothing -> Nothing

-- | Core resolution logic.
--
-- Reads all graph nodes, builds the function index, and resolves
-- all CALL nodes to same-file FUNCTION nodes.
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let funcIdx   = buildFuncIndex nodes
      callNodes = filter (\n -> gnType n == "CALL") nodes
      cmds      = concatMap (\c -> maybe [] (:[]) (resolveCall funcIdx c)) callNodes

  hPutStrLn stderr $
    "rust-calls: " ++ show (length cmds) ++ " CALLS edges from "
      ++ show (length callNodes) ++ " call nodes"

  return cmds

-- | CLI entry: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands
