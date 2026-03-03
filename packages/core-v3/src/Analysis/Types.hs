{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE StrictData #-}
-- Graph output types matching Contract B (core-v2/src/types.ts)
module Analysis.Types
  ( GraphNode(..)
  , GraphEdge(..)
  , DeferredRef(..)
  , DeferredKind(..)
  , FileAnalysis(..)
  , emptyFileAnalysis
  , ScopeKind(..)
  , Scope(..)
  , Declaration(..)
  , DeclKind(..)
  , MetaValue(..)
  ) where

import Data.Text (Text)
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import Data.Aeson (ToJSON(..), object, (.=), Value(..))
import qualified Data.Aeson.Key as K

-- ── Graph Primitives ────────────────────────────────────────────────────

data GraphNode = GraphNode
  { gnId       :: !Text
  , gnType     :: !Text
  , gnName     :: !Text
  , gnFile     :: !Text
  , gnLine     :: !Int     -- 1-based
  , gnColumn   :: !Int     -- 0-based
  , gnExported :: !Bool
  , gnMetadata :: !(Map Text MetaValue)
  } deriving (Show, Eq)

-- | Metadata values — we support the same types as JSON
data MetaValue
  = MetaText !Text
  | MetaBool !Bool
  | MetaInt  !Int
  | MetaList ![MetaValue]
  | MetaNull
  deriving (Show, Eq)

data GraphEdge = GraphEdge
  { geSource   :: !Text
  , geTarget   :: !Text
  , geType     :: !Text
  , geMetadata :: !(Map Text MetaValue)
  } deriving (Show, Eq)

-- ── Deferred References ─────────────────────────────────────────────────

data DeferredKind
  = ScopeLookup
  | ExportLookup
  | ImportResolve
  | CallResolve
  | TypeResolve
  | AliasResolve
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
  } deriving (Show)

instance Semigroup FileAnalysis where
  a <> b = FileAnalysis
    { faFile           = faFile a
    , faModuleId       = faModuleId a
    , faNodes          = faNodes a <> faNodes b
    , faEdges          = faEdges a <> faEdges b
    , faUnresolvedRefs = faUnresolvedRefs a <> faUnresolvedRefs b
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
  }

-- ── Scope Types ─────────────────────────────────────────────────────────

data ScopeKind
  = GlobalScope
  | ModuleScope
  | FunctionScope
  | BlockScope
  | ClassScope
  | WithScope
  | CatchScope
  deriving (Show, Eq)

data DeclKind
  = DeclVar
  | DeclLet
  | DeclConst
  | DeclFunction
  | DeclClass
  | DeclParam
  | DeclImport
  | DeclCatch
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

instance ToJSON MetaValue where
  toJSON (MetaText t) = toJSON t
  toJSON (MetaBool b) = toJSON b
  toJSON (MetaInt  i) = toJSON i
  toJSON (MetaList l) = toJSON l
  toJSON MetaNull     = Null

metaToJSON :: Map Text MetaValue -> Value
metaToJSON m
  | Map.null m = object []
  | otherwise  = object [ K.fromText k .= v | (k, v) <- Map.toList m ]

instance ToJSON GraphNode where
  toJSON n = object $
    [ "id"       .= gnId n
    , "type"     .= gnType n
    , "name"     .= gnName n
    , "file"     .= gnFile n
    , "line"     .= gnLine n
    , "column"   .= gnColumn n
    , "exported" .= gnExported n
    ] ++
    [ "metadata" .= metaToJSON (gnMetadata n) | not (Map.null (gnMetadata n)) ]

instance ToJSON GraphEdge where
  toJSON e = object $
    [ "src"  .= geSource e
    , "dst"  .= geTarget e
    , "type" .= geType e
    ] ++
    [ "metadata" .= metaToJSON (geMetadata e) | not (Map.null (geMetadata e)) ]

deferredKindText :: DeferredKind -> Text
deferredKindText ScopeLookup   = "scope_lookup"
deferredKindText ExportLookup  = "export_lookup"
deferredKindText ImportResolve = "import_resolve"
deferredKindText CallResolve   = "call_resolve"
deferredKindText TypeResolve   = "type_resolve"
deferredKindText AliasResolve  = "alias_resolve"

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
    ]
