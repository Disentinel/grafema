{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE StrictData #-}
-- | Graph output types matching Contract B (core-v2/src/types.ts)
-- Adapted from java-analyzer's Analysis.Types for Python-specific analysis.
-- Shared types (GraphNode, GraphEdge, MetaValue, ExportInfo, ExportKind)
-- are re-exported from Grafema.Types (grafema-common package).
module Analysis.Types
  ( -- Re-exported from Grafema.Types
    module Grafema.Types
    -- Analyzer-internal types
  , DeferredRef(..)
  , DeferredKind(..)
  , FileAnalysis(..)
  , emptyFileAnalysis
  , ScopeKind(..)
  , Scope(..)
  , Declaration(..)
  , DeclKind(..)
  ) where

import Data.Text (Text)
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import Data.Aeson (ToJSON(..), object, (.=))

import Grafema.Types

-- ── Deferred References ─────────────────────────────────────────────────

data DeferredKind
  = ImportResolve         -- ^ import declaration cross-file resolution
  | TypeResolve           -- ^ type annotation resolution
  | CallResolve           -- ^ function/method call resolution
  | AttributeResolve     -- ^ attribute access resolution
  | DecoratorResolve     -- ^ decorator resolution
  deriving (Show, Eq)

data DeferredRef = DeferredRef
  { drKind       :: !DeferredKind
  , drName       :: !Text
  , drFromNodeId :: !Text
  , drEdgeType   :: !Text
  , drScopeId    :: !(Maybe Text)
  , drSource     :: !(Maybe Text)
  , drFile       :: !Text
  , drLine       :: !Int
  , drColumn     :: !Int
  , drReceiver   :: !(Maybe Text)
  , drMetadata   :: !(Map Text MetaValue)
  } deriving (Show, Eq)

-- ── File Analysis Result ────────────────────────────────────────────────

data FileAnalysis = FileAnalysis
  { faFile           :: !Text
  , faModuleId       :: !Text
  , faNodes          :: ![GraphNode]
  , faEdges          :: ![GraphEdge]
  , faUnresolvedRefs :: ![DeferredRef]
  , faExports        :: ![ExportInfo]
  } deriving (Show)

instance Semigroup FileAnalysis where
  a <> b = FileAnalysis
    { faFile           = faFile a
    , faModuleId       = faModuleId a
    , faNodes          = faNodes a <> faNodes b
    , faEdges          = faEdges a <> faEdges b
    , faUnresolvedRefs = faUnresolvedRefs a <> faUnresolvedRefs b
    , faExports        = faExports a <> faExports b
    }

instance Monoid FileAnalysis where
  mempty = emptyFileAnalysis

emptyFileAnalysis :: FileAnalysis
emptyFileAnalysis = FileAnalysis
  { faFile           = ""
  , faModuleId       = ""
  , faNodes          = []
  , faEdges          = []
  , faUnresolvedRefs = []
  , faExports        = []
  }

-- ── Scope Types (Python-specific — follows LEGB rule) ─────────────────

data ScopeKind
  = ModuleScope           -- ^ top-level (Global in LEGB)
  | FunctionScope         -- ^ def/async def (Local in LEGB)
  | ClassScope            -- ^ class body (NOT in LEGB for nested functions)
  | LambdaScope           -- ^ lambda body
  | ComprehensionScope    -- ^ list/set/dict/generator comp
  | ExceptScope           -- ^ except handler (scopes exception variable)
  deriving (Show, Eq)

data DeclKind
  = DeclFunction          -- ^ def/async def
  | DeclClass             -- ^ class declaration
  | DeclVariable          -- ^ variable assignment
  | DeclParameter         -- ^ function parameter
  | DeclImport            -- ^ import declaration
  deriving (Show, Eq)

data Declaration = Declaration
  { declNodeId :: !Text
  , declKind   :: !DeclKind
  , declName   :: !Text
  } deriving (Show, Eq)

data Scope = Scope
  { scopeId           :: !Text
  , scopeKind         :: !ScopeKind
  , scopeDeclarations :: !(Map Text Declaration)
  , scopeParent       :: !(Maybe Scope)
  } deriving (Show)

-- ── ToJSON instances (Contract B output) ────────────────────────────────

deferredKindText :: DeferredKind -> Text
deferredKindText ImportResolve    = "import_resolve"
deferredKindText TypeResolve      = "type_resolve"
deferredKindText CallResolve      = "call_resolve"
deferredKindText AttributeResolve = "attribute_resolve"
deferredKindText DecoratorResolve = "decorator_resolve"

instance ToJSON DeferredKind where
  toJSON = toJSON . deferredKindText

instance ToJSON DeferredRef where
  toJSON d = object $
    [ "kind"       .= drKind d
    , "name"       .= drName d
    , "fromNodeId" .= drFromNodeId d
    , "edgeType"   .= drEdgeType d
    , "file"       .= drFile d
    , "line"       .= drLine d
    , "column"     .= drColumn d
    ] ++
    [ "scopeId"  .= s | Just s <- [drScopeId d] ] ++
    [ "source"   .= s | Just s <- [drSource d] ] ++
    [ "receiver" .= r | Just r <- [drReceiver d] ] ++
    [ "metadata" .= metaToJSON (drMetadata d) | not (Map.null (drMetadata d)) ]

instance ToJSON FileAnalysis where
  toJSON fa = object
    [ "file"           .= faFile fa
    , "moduleId"       .= faModuleId fa
    , "nodes"          .= faNodes fa
    , "edges"          .= faEdges fa
    , "unresolvedRefs" .= faUnresolvedRefs fa
    , "exports"        .= faExports fa
    ]
