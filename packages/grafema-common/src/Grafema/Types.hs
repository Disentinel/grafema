{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE ScopedTypeVariables #-}
{-# LANGUAGE StrictData #-}
{-# LANGUAGE TupleSections #-}
-- Shared graph types matching Contract B (core-v2/src/types.ts)
-- Extracted from Analysis.Types for reuse by grafema-analyzer and plugins.
module Grafema.Types
  ( GraphNode(..)
  , gnSemanticId
  , GraphEdge(..)
  , MetaValue(..)
  , ExportInfo(..)
  , ExportKind(..)
  , metaToJSON
  ) where

import Data.Text (Text)
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import Data.Aeson (ToJSON(..), FromJSON(..), object, (.=), (.:), (.:?), (.!=), Value(..), withObject, withText)
import qualified Data.Aeson.Key as K
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (floatingOrInteger)
import qualified Data.Vector as V

-- | Graph Primitives

data GraphNode = GraphNode
  { gnId        :: !Text
  , gnType      :: !Text
  , gnName      :: !Text
  , gnFile      :: !Text
  , gnLine      :: !Int     -- 1-based start line
  , gnColumn    :: !Int     -- 0-based start column
  , gnEndLine   :: !Int     -- 1-based end line (0 for virtual nodes)
  , gnEndColumn :: !Int     -- 0-based end column (0 for virtual nodes)
  , gnExported  :: !Bool
  , gnMetadata  :: !(Map Text MetaValue)
  } deriving (Show, Eq)

-- | Get the semantic ID. When nodes come from the resolve protocol, the
-- @semanticId@ field in metadata holds the URL-encoded path form. For
-- analyzer-emitted nodes, falls back to 'gnId' (which is itself the
-- semantic ID at that point — RFDB hashes it on commit).
gnSemanticId :: GraphNode -> Text
gnSemanticId n = case Map.lookup "semanticId" (gnMetadata n) of
  Just (MetaText t) -> t
  _                 -> gnId n

-- | Metadata values -- we support the same types as JSON
data MetaValue
  = MetaText !Text
  | MetaBool !Bool
  | MetaInt  !Int
  | MetaList ![MetaValue]
  | MetaMap  !(Map Text MetaValue)
    -- ^ Nested JSON object. Added for REG-1098 W6 where FUNCTION
    -- metadata carries a @wraps@ sub-object describing public-API
    -- wrapper calls (kind, target, message_shape, topic).
  | MetaNull
  deriving (Show, Eq)

data GraphEdge = GraphEdge
  { geSource   :: !Text
  , geTarget   :: !Text
  , geType     :: !Text
  , geMetadata :: !(Map Text MetaValue)
  } deriving (Show, Eq)

-- | Export Info

data ExportKind = NamedExport | DefaultExport | ReExport
  deriving (Show, Eq)

data ExportInfo = ExportInfo
  { eiName    :: !Text       -- exported name (or "default")
  , eiNodeId  :: !Text       -- semantic ID of the exported node (or "" for star re-exports)
  , eiKind    :: !ExportKind
  , eiSource  :: !(Maybe Text) -- for re-exports: source module specifier
  } deriving (Show, Eq)

-- | ToJSON instances (Contract B output)

instance ToJSON MetaValue where
  toJSON (MetaText t) = toJSON t
  toJSON (MetaBool b) = toJSON b
  toJSON (MetaInt  i) = toJSON i
  toJSON (MetaList l) = toJSON l
  toJSON (MetaMap  m) = object [ K.fromText k .= v | (k, v) <- Map.toList m ]
  toJSON MetaNull     = Null

metaToJSON :: Map Text MetaValue -> Value
metaToJSON m
  | Map.null m = object []
  | otherwise  = object [ K.fromText k .= v | (k, v) <- Map.toList m ]

instance ToJSON GraphNode where
  toJSON n = object $
    [ "id"        .= gnId n
    , "type"      .= gnType n
    , "name"      .= gnName n
    , "file"      .= gnFile n
    , "line"      .= gnLine n
    , "column"    .= gnColumn n
    , "endLine"   .= gnEndLine n
    , "endColumn" .= gnEndColumn n
    , "exported"  .= gnExported n
    ] ++
    [ "metadata" .= metaToJSON (gnMetadata n) | not (Map.null (gnMetadata n)) ]

instance ToJSON GraphEdge where
  toJSON e = object $
    [ "src"  .= geSource e
    , "dst"  .= geTarget e
    , "type" .= geType e
    ] ++
    [ "metadata" .= metaToJSON (geMetadata e) | not (Map.null (geMetadata e)) ]

instance ToJSON ExportKind where
  toJSON NamedExport   = toJSON ("named" :: Text)
  toJSON DefaultExport = toJSON ("default" :: Text)
  toJSON ReExport      = toJSON ("reexport" :: Text)

instance ToJSON ExportInfo where
  toJSON e = object $
    [ "name"   .= eiName e
    , "nodeId" .= eiNodeId e
    , "kind"   .= eiKind e
    ] ++
    [ "source" .= s | Just s <- [eiSource e] ]

-- | FromJSON instances (for plugin protocol deserialization)

instance FromJSON MetaValue where
  parseJSON (String t) = pure (MetaText t)
  parseJSON (Bool b)   = pure (MetaBool b)
  parseJSON (Number n) = pure $ case floatingOrInteger n of
    Right i -> MetaInt i
    Left (_ :: Double) -> MetaInt (truncate n)
  parseJSON (Array a)  = MetaList <$> mapM parseJSON (V.toList a)
  parseJSON (Object o) = do
    -- Parse nested JSON objects into MetaMap (used by REG-1098 W6 for
    -- the FUNCTION.metadata.wraps sub-object).
    pairs <- mapM (\(k, v) -> (K.toText k,) <$> parseJSON v) (KM.toList o)
    pure (MetaMap (Map.fromList pairs))
  parseJSON Null       = pure MetaNull

instance FromJSON GraphNode where
  parseJSON = withObject "GraphNode" $ \v -> do
    nid <- v .: "id"
    mSid <- v .:? "semanticId"
    baseMeta <- v .:? "metadata" .!= Map.empty
    -- If semanticId is present at top level, store it in metadata for
    -- gnSemanticId accessor to find later.
    let meta = case mSid of
          Just sid | sid /= nid -> Map.insert "semanticId" (MetaText sid) baseMeta
          _ -> baseMeta
    GraphNode nid
      <$> v .:  "type"
      <*> v .:  "name"
      <*> v .:  "file"
      <*> v .:  "line"
      <*> v .:  "column"
      <*> v .:? "endLine"   .!= 0
      <*> v .:? "endColumn" .!= 0
      <*> v .:  "exported"
      <*> pure meta

instance FromJSON GraphEdge where
  parseJSON = withObject "GraphEdge" $ \v -> GraphEdge
    <$> v .:  "src"
    <*> v .:  "dst"
    <*> v .:  "type"
    <*> v .:? "metadata" .!= Map.empty

instance FromJSON ExportKind where
  parseJSON = withText "ExportKind" $ \t -> case t of
    "named"    -> pure NamedExport
    "default"  -> pure DefaultExport
    "reexport" -> pure ReExport
    _          -> fail $ "Unknown ExportKind: " ++ show t

instance FromJSON ExportInfo where
  parseJSON = withObject "ExportInfo" $ \v -> ExportInfo
    <$> v .:  "name"
    <*> v .:  "nodeId"
    <*> v .:  "kind"
    <*> v .:? "source"
