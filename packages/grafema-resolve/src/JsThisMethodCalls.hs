{-# LANGUAGE OverloadedStrings #-}
-- | JS/TS @this.method()@ call resolution.
--
-- Resolves CALL nodes with @name = "this.foo"@ to METHOD nodes in the
-- same file. Since @this@ refers to the enclosing class instance, we
-- look up @foo@ among METHOD nodes in the same file — a close analog
-- of Rust's self.method() resolution.
--
-- When multiple classes in the same file have methods with the same
-- name, we skip to avoid false positives. Precise scope-aware lookup
-- (finding the exact enclosing class) would require more work.
module JsThisMethodCalls (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import System.IO (hPutStrLn, stderr)

-- | (file, methodName) → METHOD node ID.
-- Built from METHOD nodes, keyed by file + name.
-- When multiple methods share a name in the same file, the value is
-- a list — we only resolve when exactly one candidate exists.
type MethodIndex = Map (Text, Text) [Text]

buildMethodIndex :: [GraphNode] -> MethodIndex
buildMethodIndex nodes =
  Map.fromListWith (++)
    [ ((gnFile n, gnName n), [gnId n])
    | n <- nodes
    , gnType n == "METHOD"
    , not (T.null (gnName n))
    ]

-- | Check if a node is a JS/TS `this.method()` call.
isThisCall :: GraphNode -> Bool
isThisCall n =
  gnType n == "CALL" &&
  "this." `T.isPrefixOf` gnName n &&
  isJsTsFile (gnFile n)
  where
    isJsTsFile f = any (`T.isSuffixOf` f) [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]

-- | Strip the "this." prefix from a call name.
stripThis :: Text -> Text
stripThis name = T.drop 5 name  -- length of "this."

-- | Resolve a single this.method() call.
resolveOne :: MethodIndex -> GraphNode -> [PluginCommand]
resolveOne methodIdx callNode =
  let methodName = stripThis (gnName callNode)
      file = gnFile callNode
  in case Map.lookup (file, methodName) methodIdx of
       Just [targetId] ->
         -- Exactly one candidate — resolve with confidence
         [ EmitEdge GraphEdge
             { geSource   = gnId callNode
             , geTarget   = targetId
             , geType     = "CALLS"
             , geMetadata = Map.singleton "resolvedVia" (MetaText "js-this-method-calls")
             }
         ]
       _ -> []  -- no match or ambiguous (multiple classes with same method name)

resolveAll :: [GraphNode] -> [GraphEdge] -> IO [PluginCommand]
resolveAll nodes _edges = do
  let methodIdx = buildMethodIndex nodes
      callNodes = filter isThisCall nodes
      results = concatMap (resolveOne methodIdx) callNodes
  hPutStrLn stderr $ "[js-this-method-calls] methods=" ++ show (Map.size methodIdx)
    ++ " calls=" ++ show (length callNodes)
    ++ " resolved=" ++ show (length results)
  return results

run :: IO ()
run = do
  nodes <- readNodesFromStdin
  results <- resolveAll nodes []
  writeCommandsToStdout results
