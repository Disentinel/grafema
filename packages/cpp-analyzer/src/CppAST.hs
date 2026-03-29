{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE StrictData #-}
-- | C/C++ AST types with FromJSON instances.
--
-- The AST is produced by the C/C++ parser (tree-sitter based) and received
-- as JSON from the orchestrator. We use a single CppNode type with a
-- "kind" discriminator field and an Object for kind-specific fields,
-- similar to tree-sitter's uniform node representation.
--
-- Position data uses Pos/Span types consistent with other Grafema analyzers.
module CppAST
  ( CppFile(..)
  , CppNode(..)
  , Span(..)
  , Pos(..)
  , nodeSpan
  , lookupTextField
  , lookupBoolField
  , lookupIntField
  , lookupNodeField
  , lookupNodesField
  , lookupTextsField
  ) where

import Data.Text (Text)
import Data.Aeson
    ( FromJSON(..)
    , Value(..)
    , Object
    , withObject
    , (.:)
    , (.:?)
    , (.!=)
    )
import qualified Data.Aeson as Aeson
import Data.Aeson.Types (Parser)
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM

-- ── Position & Span ────────────────────────────────────────────────────

data Pos = Pos
  { posLine :: !Int
  , posCol  :: !Int
  } deriving (Show, Eq)

data Span = Span
  { spanStart :: !Pos
  , spanEnd   :: !Pos
  } deriving (Show, Eq)

-- ── Top-level file ─────────────────────────────────────────────────────

data CppFile = CppFile
  { cfChildren :: ![CppNode]
  , cfLanguage :: !Text     -- ^ "c" or "cpp"
  } deriving (Show, Eq)

-- ── Unified AST node ───────────────────────────────────────────────────

-- | A single C/C++ AST node. Uses a uniform representation with
-- kind-specific fields stored in an Object, avoiding a massive ADT.
-- This is the same pattern used by tree-sitter JSON output.
data CppNode = CppNode
  { nodeKind      :: !Text           -- ^ node kind (e.g., "FunctionDecl", "ClassDecl")
  , nodeName      :: !(Maybe Text)   -- ^ node name (if named declaration)
  , nodeLine      :: !Int            -- ^ 1-based start line
  , nodeColumn    :: !Int            -- ^ 0-based start column
  , nodeEndLine   :: !(Maybe Int)    -- ^ 1-based end line
  , nodeEndColumn :: !(Maybe Int)    -- ^ 0-based end column
  , nodeChildren  :: ![CppNode]      -- ^ child nodes
  , nodeFields    :: !Object         -- ^ all kind-specific fields
  } deriving (Show, Eq)

-- | Construct a Span from a CppNode's position data.
nodeSpan :: CppNode -> Span
nodeSpan n = Span
  { spanStart = Pos (nodeLine n) (nodeColumn n)
  , spanEnd   = Pos
      (maybe (nodeLine n) id (nodeEndLine n))
      (maybe (nodeColumn n) id (nodeEndColumn n))
  }

-- ── Field lookup helpers ───────────────────────────────────────────────

-- | Look up a text field from the node's kind-specific fields.
lookupTextField :: Text -> CppNode -> Maybe Text
lookupTextField key node =
  case KM.lookup (Key.fromText key) (nodeFields node) of
    Just (String t) -> Just t
    _               -> Nothing

-- | Look up a boolean field from the node's kind-specific fields.
lookupBoolField :: Text -> CppNode -> Bool
lookupBoolField key node =
  case KM.lookup (Key.fromText key) (nodeFields node) of
    Just (Bool b) -> b
    _             -> False

-- | Look up an integer field from the node's kind-specific fields.
lookupIntField :: Text -> CppNode -> Maybe Int
lookupIntField key node =
  case KM.lookup (Key.fromText key) (nodeFields node) of
    Just (Number n) -> Just (truncate n)
    _               -> Nothing

-- | Look up a single child node field from the node's kind-specific fields.
lookupNodeField :: Text -> CppNode -> Maybe CppNode
lookupNodeField key node =
  case KM.lookup (Key.fromText key) (nodeFields node) of
    Just val -> case Aeson.fromJSON val of
      Aeson.Success n -> Just n
      _               -> Nothing
    Nothing -> Nothing

-- | Look up a list of child nodes from the node's kind-specific fields.
lookupNodesField :: Text -> CppNode -> [CppNode]
lookupNodesField key node =
  case KM.lookup (Key.fromText key) (nodeFields node) of
    Just val -> case Aeson.fromJSON val of
      Aeson.Success ns -> ns
      _                -> []
    Nothing -> []

-- | Look up a list of text values from the node's kind-specific fields.
lookupTextsField :: Text -> CppNode -> [Text]
lookupTextsField key node =
  case KM.lookup (Key.fromText key) (nodeFields node) of
    Just val -> case Aeson.fromJSON val of
      Aeson.Success ts -> ts
      _                -> []
    Nothing -> []

-- ── FromJSON instances ─────────────────────────────────────────────────

instance FromJSON Pos where
  parseJSON = withObject "Pos" $ \v -> Pos
    <$> v .: "line"
    <*> v .: "col"

instance FromJSON Span where
  parseJSON = withObject "Span" $ \v -> Span
    <$> v .: "start"
    <*> v .: "end"

instance FromJSON CppFile where
  parseJSON = withObject "CppFile" $ \v -> CppFile
    <$> v .:? "children" .!= []
    <*> v .:? "language" .!= "cpp"

instance FromJSON CppNode where
  parseJSON = withObject "CppNode" $ \v -> do
    kind     <- v .:  "kind"    :: Parser Text
    name     <- v .:? "name"    :: Parser (Maybe Text)
    line     <- v .:? "line"    .!= 1
    col      <- v .:? "column"  .!= 0
    endLine  <- v .:? "endLine" :: Parser (Maybe Int)
    endCol   <- v .:? "endColumn" :: Parser (Maybe Int)
    children <- v .:? "children" .!= []

    -- Everything except known structural keys goes into nodeFields
    let knownKeys = ["kind", "name", "line", "column", "endLine", "endColumn", "children"]
        fields = KM.filterWithKey
          (\k _ -> Key.toText k `notElem` knownKeys)
          v

    pure CppNode
      { nodeKind      = kind
      , nodeName      = name
      , nodeLine      = line
      , nodeColumn    = col
      , nodeEndLine   = endLine
      , nodeEndColumn = endCol
      , nodeChildren  = children
      , nodeFields    = fields
      }
