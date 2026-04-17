{-# LANGUAGE OverloadedStrings #-}
-- | Python class inheritance EXTENDS edge resolution.
--
-- Creates resolved EXTENDS edges for Python class inheritance:
--   - Same-file:   @class Dog(Animal):@
--                  → CLASS Dog → EXTENDS → CLASS Animal (same file)
--   - Cross-file:  @from .base import Animal; class Dog(Animal):@
--                  → CLASS Dog → EXTENDS → CLASS Animal (resolved via imports)
--
-- Python supports multiple inheritance, so @class C(A, B):@ emits one
-- EXTENDS edge per base.  The @bases@ metadata (comma-separated base
-- names) is populated by the Python analyzer (Declarations.hs).
--
-- The Python analyzer already emits "stub" EXTENDS edges whose target IDs
-- are synthesized and may not match real nodes for cross-file parents.
-- This resolver emits authoritative edges tagged with
-- @resolvedVia = "python-class-inheritance"@.
module ClassInheritance (resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..))
import ImportResolution
  ( ModuleIndex, NameIndex
  , buildModuleIndex, buildNameIndex
  , resolveRelativeImport, getMetaText
  )

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

-- | (file, className) -> nodeId
type ClassIndex = Map (Text, Text) Text

-- | Resolved import binding: local name → where it came from.
data PyImportBinding = PyImportBinding
  { pibSource       :: !Text  -- source_module (e.g., ".base", "pkg.models")
  , pibImportedName :: !Text  -- original name in the source module
  }

-- | (file, localName) -> PyImportBinding
type ImportBindingIndex = Map (Text, Text) PyImportBinding

-- ---------------------------------------------------------------------------
-- Index construction
-- ---------------------------------------------------------------------------

buildClassIndex :: [GraphNode] -> ClassIndex
buildClassIndex nodes =
  Map.fromList
    [ ((gnFile n, gnName n), gnId n)
    | n <- nodes
    , gnType n == "CLASS"
    , not (T.null (gnName n))
    ]

buildImportBindingIndex :: [GraphNode] -> ImportBindingIndex
buildImportBindingIndex nodes =
  Map.fromList
    [ ((gnFile n, gnName n), PyImportBinding source importedName)
    | n <- nodes
    , gnType n == "IMPORT_BINDING"
    , Just source <- [getMetaText "source_module" n]
    , let importedName = case getMetaText "imported_name" n of
            Just nm -> nm
            Nothing -> gnName n
    ]

isPythonFile :: Text -> Bool
isPythonFile f = T.isSuffixOf ".py" f || T.isSuffixOf ".pyi" f

-- ---------------------------------------------------------------------------
-- Resolution
-- ---------------------------------------------------------------------------

-- | Attempt to resolve one base class name to an EXTENDS edge.
resolveBase
  :: Text               -- subclass file
  -> Text               -- subclass CLASS node ID
  -> ClassIndex
  -> ImportBindingIndex
  -> ModuleIndex
  -> NameIndex
  -> Text               -- base class name (e.g. "Animal")
  -> [PluginCommand]
resolveBase file classId classIdx importIdx modIdx nameIdx baseName =
  -- 1. Same-file: base class is defined in the same file
  case Map.lookup (file, baseName) classIdx of
    Just targetId ->
      [ EmitEdge GraphEdge
          { geSource   = classId
          , geTarget   = targetId
          , geType     = "EXTENDS"
          , geMetadata = Map.singleton "resolvedVia" (MetaText "python-class-inheritance")
          }
      ]
    Nothing ->
      -- 2. Cross-file: base class was imported
      case Map.lookup (file, baseName) importIdx of
        Nothing -> []
        Just pib ->
          let modPath = resolveRelativeImport modIdx file (pibSource pib)
          in case Map.lookup (modPath, pibImportedName pib) nameIdx of
               Just (_f, targetId) ->
                 [ EmitEdge GraphEdge
                     { geSource   = classId
                     , geTarget   = targetId
                     , geType     = "EXTENDS"
                     , geMetadata = Map.fromList
                         [ ("resolvedVia",  MetaText "python-class-inheritance")
                         , ("importedFrom", MetaText (pibSource pib))
                         ]
                     }
                 ]
               Nothing -> []

-- | Resolve all bases of one CLASS node.
resolveOneClass
  :: ClassIndex
  -> ImportBindingIndex
  -> ModuleIndex
  -> NameIndex
  -> GraphNode
  -> [PluginCommand]
resolveOneClass classIdx importIdx modIdx nameIdx classNode =
  case getMetaText "bases" classNode of
    Nothing -> []
    Just basesText ->
      let file      = gnFile classNode
          classId   = gnId classNode
          baseNames = filter (not . T.null) (T.splitOn "," basesText)
      in concatMap
           (resolveBase file classId classIdx importIdx modIdx nameIdx)
           baseNames

-- | Entry point: resolve all Python class inheritance edges.
resolveAll :: [GraphNode] -> [PluginCommand]
resolveAll nodes =
  let classIdx  = buildClassIndex nodes
      importIdx = buildImportBindingIndex nodes
      modIdx    = buildModuleIndex nodes
      nameIdx   = buildNameIndex nodes modIdx
      targets   = filter (\n ->
          gnType n == "CLASS"
          && isPythonFile (gnFile n)
          && Map.member "bases" (gnMetadata n)
        ) nodes
  in concatMap (resolveOneClass classIdx importIdx modIdx nameIdx) targets
