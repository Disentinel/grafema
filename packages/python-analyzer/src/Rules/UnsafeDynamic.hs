{-# LANGUAGE OverloadedStrings #-}
-- | Unsafe dynamic access rule: tracks eval(), exec(), getattr(),
-- setattr(), __import__() and other dynamic access patterns that
-- break static analysis guarantees.
--
-- Detects these unsafe patterns:
--   * eval(expr)                -> UNSAFE_DYNAMIC "eval"
--   * exec(code)               -> UNSAFE_DYNAMIC "exec"
--   * getattr(obj, name)       -> UNSAFE_DYNAMIC "getattr"
--   * setattr(obj, name, val)  -> UNSAFE_DYNAMIC "setattr"
--   * delattr(obj, name)       -> UNSAFE_DYNAMIC "delattr"
--   * compile(source, ...)     -> UNSAFE_DYNAMIC "compile"
--   * type(name, bases, dict)  -> UNSAFE_DYNAMIC "dynamic_class" (3-arg form)
--   * importlib.import_module() -> UNSAFE_DYNAMIC "importlib.import_module"
--
-- Node types: UNSAFE_DYNAMIC
-- Edge types: CONTAINS
--
-- Called from the analysis walker for each expression.
module Rules.UnsafeDynamic
  ( walkUnsafeDynamic
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set

import PythonAST (PythonExpr(..), Span(..), Pos(..))
import Analysis.Types
    ( GraphNode(..)
    , GraphEdge(..)
    , MetaValue(..)
    )
import Analysis.Context
    ( Analyzer
    , emitNode
    , emitEdge
    , askFile
    , askScopeId
    , askNamedParent
    )
import Grafema.SemanticId (semanticId, contentHash)

-- ── Unsafe call detection ─────────────────────────────────────────────

-- | Set of builtin function names that are considered unsafe dynamic access.
unsafeCalls :: Set.Set Text
unsafeCalls = Set.fromList
  [ "eval"
  , "exec"
  , "getattr"
  , "setattr"
  , "delattr"
  , "compile"
  ]

-- | Module-qualified unsafe calls: (module, function).
unsafeModuleCalls :: [(Text, Text)]
unsafeModuleCalls =
  [ ("importlib", "import_module")
  ]

-- ── Walker ────────────────────────────────────────────────────────────

-- | Walk an expression and emit UNSAFE_DYNAMIC node if it matches
-- a known unsafe dynamic pattern.
walkUnsafeDynamic :: PythonExpr -> Analyzer ()
walkUnsafeDynamic (CallExpr func args _ sp) =
  case detectUnsafeKind func args of
    Just kind -> emitUnsafeDynamic kind sp
    Nothing   -> pure ()
walkUnsafeDynamic _ = pure ()

-- ── Detection logic ───────────────────────────────────────────────────

-- | Detect if a call expression represents an unsafe dynamic pattern.
-- Returns the kind string if unsafe, Nothing otherwise.
detectUnsafeKind :: PythonExpr -> [PythonExpr] -> Maybe Text
-- Direct call to unsafe builtin: eval(...), exec(...), etc.
detectUnsafeKind (NameExpr name _) _args
  | Set.member name unsafeCalls = Just name
-- 3-arg type() creates a class dynamically: type("Name", (Base,), {})
detectUnsafeKind (NameExpr "type" _) args
  | length args == 3 = Just "dynamic_class"
-- Module-qualified calls: importlib.import_module(...)
detectUnsafeKind (AttributeExpr (NameExpr modName _) funcName _) _args
  | (modName, funcName) `elem` unsafeModuleCalls =
    Just (modName <> "." <> funcName)
detectUnsafeKind _ _ = Nothing

-- ── Emission ──────────────────────────────────────────────────────────

-- | Emit an UNSAFE_DYNAMIC node + CONTAINS edge.
emitUnsafeDynamic :: Text -> Span -> Analyzer ()
emitUnsafeDynamic kind sp = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent

  let line = posLine (spanStart sp)
      col  = posCol  (spanStart sp)
      hash = contentHash
        [ ("kind", kind)
        , ("line", T.pack (show line))
        ]
      nodeId = semanticId file "UNSAFE_DYNAMIC" kind parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "UNSAFE_DYNAMIC"
    , gnName      = kind
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.singleton "kind" (MetaText kind)
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }
