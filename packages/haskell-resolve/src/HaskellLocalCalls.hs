{-# LANGUAGE OverloadedStrings #-}
-- | Haskell same-file CALL resolution.
--
-- Resolves CALL nodes to FUNCTION/RECORD_FIELD/CONSTRUCTOR declarations
-- defined in the same file. This handles:
--
--   * Local function calls: @foo arg@ where @foo@ is defined in this module
--   * Record field accessors: @gnName node@ where @gnName@ is a RECORD_FIELD
--   * Data constructors: @Just x@ where @Just@ is local CONSTRUCTOR
--
-- Cross-file calls are handled by 'HaskellCrossModuleCalls' (via imports).
-- Stdlib calls are handled by 'haskell-runtime-globals' (via effects-db).
-- This module fills the gap for purely local resolution.
module HaskellLocalCalls (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import qualified Data.Set as Set
import Data.Set (Set)
import System.IO (hPutStrLn, stderr)

-- | (file, name) → declaration node ID.
type DeclIndex = Map (Text, Text) Text

-- | Set of (file, name) pairs that are imported (skip these in local resolution).
type ImportIndex = Set (Text, Text)

-- | Haskell node types that can be called by name.
callableTypes :: [Text]
callableTypes =
  [ "FUNCTION", "VARIABLE", "CONSTANT", "CONSTRUCTOR"
  , "RECORD_FIELD", "TYPE_SIGNATURE"
  ]

buildDeclIndex :: [GraphNode] -> DeclIndex
buildDeclIndex nodes =
  Map.fromList
    [ ((gnFile n, gnName n), gnId n)
    | n <- nodes
    , gnType n `elem` callableTypes
    , not (T.null (gnName n))
    ]

buildImportIndex :: [GraphNode] -> ImportIndex
buildImportIndex nodes =
  Set.fromList
    [ (gnFile n, gnName n)
    | n <- nodes
    , gnType n == "IMPORT_BINDING"
    , not (T.null (gnName n))
    ]

-- | Resolve a single CALL node to a same-file declaration.
resolveOne :: DeclIndex -> ImportIndex -> GraphNode -> [PluginCommand]
resolveOne declIdx importIdx callNode =
  let file = gnFile callNode
      name = gnName callNode
      -- Strip qualified prefix: "Map.lookup" → "lookup"
      bareName = case T.breakOnEnd "." name of
        ("", n) -> n
        (_, n)  -> n
      key = (file, bareName)
  in if Set.member key importIdx
       then []  -- imported names are handled by HaskellCrossModuleCalls
       else case Map.lookup key declIdx of
              Nothing -> []
              Just targetId ->
                [ EmitEdge GraphEdge
                    { geSource   = gnId callNode
                    , geTarget   = targetId
                    , geType     = "CALLS"
                    , geMetadata = Map.singleton "resolvedVia" (MetaText "haskell-local-calls")
                    }
                ]

-- | Check if a node is a Haskell CALL.
isHaskellCall :: GraphNode -> Bool
isHaskellCall n = gnType n == "CALL" && ".hs" `T.isSuffixOf` gnFile n

resolveAll :: [GraphNode] -> [GraphEdge] -> IO [PluginCommand]
resolveAll nodes _edges = do
  let declIdx   = buildDeclIndex nodes
      importIdx = buildImportIndex nodes
      callNodes = filter isHaskellCall nodes
      results = concatMap (resolveOne declIdx importIdx) callNodes
  hPutStrLn stderr $ "[haskell-local-calls] decls=" ++ show (Map.size declIdx)
    ++ " imports=" ++ show (Set.size importIdx)
    ++ " calls=" ++ show (length callNodes)
    ++ " resolved=" ++ show (length results)
  return results

run :: IO ()
run = do
  nodes <- readNodesFromStdin
  results <- resolveAll nodes []
  writeCommandsToStdout results
