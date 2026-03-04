{-# LANGUAGE OverloadedStrings #-}
-- | Phase 3 rule: import declarations.
--
-- Handles 'ImportDecl GhcPs' from 'hsmodImports'. For each import:
--   * IMPORT node (represents the import statement)
--   * IMPORT_BINDING nodes (for selective imports like @import Foo (bar, baz)@)
--   * IMPORTS_FROM deferred edge (for cross-file resolution)
--   * CONTAINS edge from module to import
--
-- Called from 'Analysis.Walker.walkModule' after the MODULE node is emitted.
module Rules.Imports
  ( walkImports
  ) where

import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import GHC.Hs (GhcPs)
import GHC.Hs.ImpExp
  ( ImportDecl(..)
  , ImportDeclQualifiedStyle(..)
  , ImportListInterpretation(..)
  , IE(..)
  , IEWrappedName(..)
  )
import GHC.Types.SrcLoc (GenLocated(..), unLoc)
import GHC.Types.Name.Reader (rdrNameOcc)
import GHC.Types.Name.Occurrence (occNameString)
import GHC.Unit.Module (moduleNameString)

import Analysis.Context
  ( Analyzer, emitNode, emitEdge, emitDeferred
  , askFile, askModuleId
  )
import Analysis.Types
  ( GraphNode(..), GraphEdge(..), DeferredRef(..), DeferredKind(..)
  , MetaValue(..)
  )
import Grafema.SemanticId (semanticId)
import Loc (getLoc)

-- | Walk all import declarations in a module, emitting IMPORT nodes,
-- IMPORT_BINDING nodes for selective imports, and deferred IMPORTS_FROM
-- edges for cross-file resolution.
walkImports :: [GenLocated l (ImportDecl GhcPs)] -> Analyzer ()
walkImports = mapM_ walkImportDecl

-- | Process a single import declaration.
walkImportDecl :: GenLocated l (ImportDecl GhcPs) -> Analyzer ()
walkImportDecl (L _ decl) = do
  file     <- askFile
  moduleId <- askModuleId

  let modName = T.pack (moduleNameString (unLoc (ideclName decl)))
  let (line, col, endLine, endCol) = getLoc (ideclName decl)

  let isQualified = case ideclQualified decl of
        NotQualified -> False
        _            -> True

  let alias = fmap (T.pack . moduleNameString . unLoc) (ideclAs decl)

  let isHiding = case ideclImportList decl of
        Just (EverythingBut, _) -> True
        _                       -> False

  let nodeId = semanticId file "IMPORT" modName Nothing Nothing

  -- Build metadata map with optional fields
  let meta = Map.fromList $
        [ ("qualified", MetaBool isQualified) | isQualified ] ++
        [ ("alias", MetaText a) | Just a <- [alias] ] ++
        [ ("hiding", MetaBool True) | isHiding ]

  -- IMPORT node
  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "IMPORT"
    , gnName      = modName
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = meta
    }

  -- CONTAINS edge: module -> import
  emitEdge GraphEdge
    { geSource   = moduleId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Deferred IMPORTS_FROM edge for cross-file resolution
  emitDeferred DeferredRef
    { drKind       = ImportResolve
    , drName       = modName
    , drFromNodeId = nodeId
    , drEdgeType   = "IMPORTS_FROM"
    , drScopeId    = Nothing
    , drSource     = Nothing
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = Nothing
    , drMetadata   = Map.empty
    }

  -- Walk import bindings if selective (Exactly or EverythingBut with items)
  case ideclImportList decl of
    Just (_, L _ items) -> mapM_ (walkImportBinding file nodeId) items
    Nothing             -> pure ()

-- | Process a single import/export item from a selective import list,
-- emitting IMPORT_BINDING nodes.
walkImportBinding :: T.Text -> T.Text -> GenLocated l (IE GhcPs) -> Analyzer ()
walkImportBinding file importNodeId (L _ ie) = case ie of
  IEVar _ name ->
    emitBinding file importNodeId (extractIEName name)
  IEThingAbs _ name ->
    emitBinding file importNodeId (extractIEName name)
  IEThingAll _ name ->
    emitBinding file importNodeId (extractIEName name)
  IEThingWith _ name _ subs -> do
    emitBinding file importNodeId (extractIEName name)
    mapM_ (\sub -> emitBinding file importNodeId (extractIEName sub)) subs
  _ -> pure ()

-- | Extract the 'RdrName' string from an 'IEWrappedName' wrapped in Located.
extractIEName :: GenLocated l (IEWrappedName GhcPs) -> T.Text
extractIEName (L _ (IEName _ locRdrName)) =
  T.pack (occNameString (rdrNameOcc (unLoc locRdrName)))
extractIEName (L _ (IEPattern _ locRdrName)) =
  T.pack (occNameString (rdrNameOcc (unLoc locRdrName)))
extractIEName (L _ (IEType _ locRdrName)) =
  T.pack (occNameString (rdrNameOcc (unLoc locRdrName)))

-- | Emit an IMPORT_BINDING node and a CONTAINS edge from the IMPORT node.
emitBinding :: T.Text -> T.Text -> T.Text -> Analyzer ()
emitBinding file importNodeId name = do
  let nodeId = semanticId file "IMPORT_BINDING" name (Just importName) Nothing
  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "IMPORT_BINDING"
    , gnName      = name
    , gnFile      = file
    , gnLine      = 0
    , gnColumn    = 0
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported  = False
    , gnMetadata  = Map.empty
    }
  emitEdge GraphEdge
    { geSource   = importNodeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }
  where
    importName = extractParentName importNodeId

-- | Extract the parent name from a semantic ID for use in nested IDs.
-- Given @"file->IMPORT->Data.Text"@, returns @"Data.Text"@.
extractParentName :: T.Text -> T.Text
extractParentName sid = case T.splitOn "->" sid of
  (_:_:name:_) -> name
  _            -> sid
