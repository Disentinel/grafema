{-# LANGUAGE OverloadedStrings #-}
-- | Shared indices for C/C++ cross-file resolution.
--
-- All resolution modules share a single 'CppIndex' built once from the
-- full node list. This avoids redundant traversals and ensures consistent
-- lookup behavior across include, type, call, virtual dispatch, template,
-- operator, and constructor resolution.
--
-- == Index construction
--
-- 'buildIndex' iterates all nodes exactly once and populates seven maps:
--
--   * 'moduleIndex' — file path to MODULE node ID (one per translation unit)
--   * 'classIndex' — class/struct name to CLASS node IDs
--   * 'functionIndex' — function name to FUNCTION node IDs
--   * 'methodIndex' — (class, method) pair to FUNCTION node IDs
--   * 'namespaceIndex' — namespace name to NAMESPACE node IDs
--   * 'templateIndex' — template name to node IDs (CLASS or FUNCTION templates)
--   * 'typedefIndex' — typedef/using alias name to node IDs
--
-- Namespace-qualified names are indexed both qualified ("ns::name") and
-- unqualified ("name") so callers can try fully-qualified lookup first
-- and fall back to unqualified.
module CppIndex
  ( CppIndex(..)
  , buildIndex
  , lookupMetaText
  , lookupMetaBool
  , lookupMetaInt
  , dirOfFile
  , splitQualified
  , unqualifiedName
  ) where

import Grafema.Types (GraphNode(..), MetaValue(..))

import Data.List (foldl')
import Data.Text (Text)
import qualified Data.Text as T
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map

-- | Central index structure shared by all C/C++ resolution modules.
data CppIndex = CppIndex
  { moduleIndex    :: !(Map Text Text)
    -- ^ File path -> MODULE node ID. One entry per translation unit.
  , classIndex     :: !(Map Text [Text])
    -- ^ Class/struct name -> list of CLASS node IDs.
    -- Both qualified ("ns::Foo") and unqualified ("Foo") keys are stored.
  , functionIndex  :: !(Map Text [Text])
    -- ^ Free function name -> list of FUNCTION node IDs.
    -- Both qualified ("ns::func") and unqualified ("func") keys are stored.
  , methodIndex    :: !(Map (Text, Text) [Text])
    -- ^ (class name, method name) -> list of FUNCTION node IDs.
  , namespaceIndex :: !(Map Text [Text])
    -- ^ Namespace name -> list of NAMESPACE node IDs.
  , templateIndex  :: !(Map Text [Text])
    -- ^ Template name -> list of node IDs (CLASS or FUNCTION templates).
  , typedefIndex   :: !(Map Text [Text])
    -- ^ Typedef/using alias name -> list of node IDs.
  } deriving (Show)

-- | Build the complete index from all graph nodes.
--
-- Iterates the node list once. Each node is classified by its @gnType@
-- and inserted into the appropriate map(s). Namespace-qualified names
-- generate two entries: one qualified, one unqualified.
buildIndex :: [GraphNode] -> CppIndex
buildIndex = foldl' insertNode emptyIndex
  where
    emptyIndex = CppIndex
      { moduleIndex    = Map.empty
      , classIndex     = Map.empty
      , functionIndex  = Map.empty
      , methodIndex    = Map.empty
      , namespaceIndex = Map.empty
      , templateIndex  = Map.empty
      , typedefIndex   = Map.empty
      }

    insertNode idx n = case gnType n of
      "MODULE" ->
        idx { moduleIndex = Map.insert (gnFile n) (gnId n) (moduleIndex idx) }

      "CLASS" ->
        let name = gnName n
            isTemplate = lookupMetaBool "isTemplate" n == Just True
            idx' = idx { classIndex = insertMultiKeys (qualifiedKeys name) (gnId n) (classIndex idx) }
        in if isTemplate
           then idx' { templateIndex = insertMultiKeys (qualifiedKeys name) (gnId n) (templateIndex idx') }
           else idx'

      "FUNCTION" ->
        let name    = gnName n
            mClass  = lookupMetaText "className" n
            mKind   = lookupMetaText "kind" n
            isTemplate = lookupMetaBool "isTemplate" n == Just True
        in case mClass of
          Just className ->
            -- Method: index under (className, methodName)
            let methodName = name
                idx' = idx { methodIndex = Map.insertWith (++) (className, methodName) [gnId n] (methodIndex idx) }
                -- Also index with unqualified class name if qualified
                uqClass = unqualifiedName className
                idx'' = if uqClass /= className
                        then idx' { methodIndex = Map.insertWith (++) (uqClass, methodName) [gnId n] (methodIndex idx') }
                        else idx'
            in if isTemplate
               then idx'' { templateIndex = insertMultiKeys (qualifiedKeys (className <> "::" <> methodName)) (gnId n) (templateIndex idx'') }
               else idx''
          Nothing ->
            -- Free function
            case mKind of
              Just "operator" ->
                -- Operator overloads as free functions go into functionIndex
                idx { functionIndex = insertMultiKeys (qualifiedKeys name) (gnId n) (functionIndex idx) }
              _ ->
                let idx' = idx { functionIndex = insertMultiKeys (qualifiedKeys name) (gnId n) (functionIndex idx) }
                in if isTemplate
                   then idx' { templateIndex = insertMultiKeys (qualifiedKeys name) (gnId n) (templateIndex idx') }
                   else idx'

      "NAMESPACE" ->
        idx { namespaceIndex = Map.insertWith (++) (gnName n) [gnId n] (namespaceIndex idx) }

      "TYPEDEF" ->
        idx { typedefIndex = insertMultiKeys (qualifiedKeys (gnName n)) (gnId n) (typedefIndex idx) }

      _ -> idx

-- | Insert a value into multiple keys of a multi-map.
insertMultiKeys :: [Text] -> Text -> Map Text [Text] -> Map Text [Text]
insertMultiKeys keys val m = foldl' (\acc k -> Map.insertWith (++) k [val] acc) m keys

-- | Generate qualified and unqualified keys for index insertion.
--
-- @qualifiedKeys "ns::Foo"@ -> @["ns::Foo", "Foo"]@
-- @qualifiedKeys "Foo"@     -> @["Foo"]@
qualifiedKeys :: Text -> [Text]
qualifiedKeys name =
  let uq = unqualifiedName name
  in if uq /= name then [name, uq] else [name]

-- ── Utility functions ──────────────────────────────────────────────────

-- | Look up a text metadata value from a node's metadata map.
lookupMetaText :: Text -> GraphNode -> Maybe Text
lookupMetaText key node = case Map.lookup key (gnMetadata node) of
  Just (MetaText t) -> Just t
  _                 -> Nothing

-- | Look up a boolean metadata value from a node's metadata map.
lookupMetaBool :: Text -> GraphNode -> Maybe Bool
lookupMetaBool key node = case Map.lookup key (gnMetadata node) of
  Just (MetaBool b) -> Just b
  _                 -> Nothing

-- | Look up an integer metadata value from a node's metadata map.
lookupMetaInt :: Text -> GraphNode -> Maybe Int
lookupMetaInt key node = case Map.lookup key (gnMetadata node) of
  Just (MetaInt i) -> Just i
  _                -> Nothing

-- | Extract the directory portion of a file path.
--
-- @dirOfFile "src/utils/helper.cpp"@ -> @"src/utils"@
-- @dirOfFile "main.cpp"@ -> @""@
dirOfFile :: Text -> Text
dirOfFile f = case T.breakOnEnd "/" f of
  ("", _) -> ""
  (d, _)  -> T.dropEnd 1 d

-- | Split a qualified name on "::" into (qualifier, name).
--
-- @splitQualified "ns::Foo"@ -> @Just ("ns", "Foo")@
-- @splitQualified "ns1::ns2::Foo"@ -> @Just ("ns1::ns2", "Foo")@
-- @splitQualified "Foo"@ -> @Nothing@
splitQualified :: Text -> Maybe (Text, Text)
splitQualified name =
  case T.breakOnEnd "::" name of
    ("", _)   -> Nothing
    (qual, n) -> Just (T.dropEnd 2 qual, n)

-- | Extract the unqualified (last segment) name.
--
-- @unqualifiedName "ns::Foo"@ -> @"Foo"@
-- @unqualifiedName "a::b::c"@ -> @"c"@
-- @unqualifiedName "Foo"@ -> @"Foo"@
unqualifiedName :: Text -> Text
unqualifiedName name = case splitQualified name of
  Just (_, n) -> n
  Nothing     -> name
