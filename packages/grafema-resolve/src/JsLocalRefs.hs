{-# LANGUAGE OverloadedStrings #-}
-- | JS/TS local reference resolution plugin.
--
-- Creates READS_FROM edges for REFERENCE nodes that refer to same-file
-- declarations (FUNCTION, VARIABLE, CONSTANT, CLASS, PARAMETER, INTERFACE,
-- ENUM, TYPE_SYNONYM).
--
-- Skip logic:
--   - Imported names (in ImportIndex) — handled by ImportResolution
--   - Runtime globals (in globalsDb) — handled by RuntimeGlobals
--
-- Runs after RuntimeGlobals so globals are already resolved.
module JsLocalRefs (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)
import ResolveUtil (buildImportIndex)

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import qualified Data.Set as Set
import Data.Set (Set)

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

-- | Declaration index: (file, name) -> node ID
type DeclIndex = Map (Text, Text) Text

-- ---------------------------------------------------------------------------
-- Index construction
-- ---------------------------------------------------------------------------

-- | Node types that can be referenced as local declarations.
declTypes :: [Text]
declTypes =
  [ "FUNCTION", "VARIABLE", "CONSTANT", "CLASS"
  , "PARAMETER", "INTERFACE", "ENUM", "TYPE_SYNONYM"
  ]

-- | Build declaration index from nodes that can be referenced.
buildDeclIndex :: [GraphNode] -> DeclIndex
buildDeclIndex nodes =
  Map.fromList
    [ ((gnFile n, gnName n), gnId n)
    | n <- nodes
    , gnType n `elem` declTypes
    , not (T.null (gnName n))
    ]

-- | Static set of known runtime global names (must match RuntimeGlobals.globalsDb).
-- We skip these so we don't create duplicate READS_FROM edges.
runtimeGlobalNames :: Set Text
runtimeGlobalNames = Set.fromList
  [ -- Node.js
    "console", "process", "Buffer", "__dirname", "__filename"
  , "module", "exports", "require", "global"
  , "setTimeout", "setInterval", "setImmediate"
  , "clearTimeout", "clearInterval", "clearImmediate", "queueMicrotask"
  -- Browser
  , "window", "document", "navigator", "location", "history"
  , "localStorage", "sessionStorage", "fetch", "XMLHttpRequest"
  , "WebSocket", "requestAnimationFrame", "cancelAnimationFrame"
  , "alert", "confirm", "prompt"
  -- ECMAScript
  , "JSON", "Math", "Date", "Promise", "Array", "Object", "String"
  , "Number", "Boolean", "Symbol", "Map", "Set", "WeakMap", "WeakSet"
  , "Proxy", "Reflect", "Error", "TypeError", "RangeError"
  , "ReferenceError", "SyntaxError", "RegExp"
  , "parseInt", "parseFloat", "isNaN", "isFinite"
  , "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI"
  , "undefined", "NaN", "Infinity"
  , "this", "super", "globalThis", "arguments"
  , "Uint8Array", "Int8Array", "Uint16Array", "Int16Array"
  , "Uint32Array", "Int32Array", "Float32Array", "Float64Array"
  , "BigInt64Array", "BigUint64Array", "ArrayBuffer", "SharedArrayBuffer"
  , "DataView", "TextEncoder", "TextDecoder", "URL", "URLSearchParams"
  , "AbortController", "AbortSignal", "Intl", "BigInt"
  , "AggregateError", "EvalError", "URIError"
  , "FinalizationRegistry", "WeakRef", "structuredClone", "atob", "btoa"
  ]

-- ---------------------------------------------------------------------------
-- Resolution
-- ---------------------------------------------------------------------------

-- | Core resolution logic.
resolveAll :: [GraphNode] -> [PluginCommand]
resolveAll nodes =
  let declIndex   = buildDeclIndex nodes
      importIndex = buildImportIndex nodes
      refNodes    = filter (\n -> gnType n == "REFERENCE") nodes
  in concatMap (resolveRef declIndex importIndex) refNodes

-- | Resolve a single REFERENCE node.
resolveRef :: DeclIndex -> Set (Text, Text) -> GraphNode -> [PluginCommand]
resolveRef declIndex importIndex refNode =
  let file = gnFile refNode
      name = gnName refNode
  in
    -- Skip imported names (handled by ImportResolution)
    if Set.member (file, name) importIndex
      then []
    -- Skip runtime globals (handled by RuntimeGlobals)
    else if Set.member name runtimeGlobalNames
      then []
    -- Try same-file declaration lookup
    else case Map.lookup (file, name) declIndex of
      Just targetId -> [EmitEdge GraphEdge
        { geSource   = gnId refNode
        , geTarget   = targetId
        , geType     = "READS_FROM"
        , geMetadata = Map.singleton "resolvedVia" (MetaText "js-local-refs")
        }]
      Nothing -> []

-- ---------------------------------------------------------------------------
-- CLI entry point
-- ---------------------------------------------------------------------------

run :: IO ()
run = do
  nodes <- readNodesFromStdin
  writeCommandsToStdout (resolveAll nodes)
