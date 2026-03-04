{-# LANGUAGE OverloadedStrings #-}
-- | Phase 2 rule: data type declarations.
--
-- Handles GHC AST constructs from 'HsDataDefn':
--   * 'DataDecl'     -> DATA_TYPE node + CONTAINS edge from module
--   * 'ConDeclH98'   -> CONSTRUCTOR node + CONTAINS edge from DATA_TYPE
--   * 'ConDeclGADT'  -> CONSTRUCTOR node + CONTAINS edge from DATA_TYPE
--   * 'ConDeclField' -> RECORD_FIELD node + HAS_FIELD edge from CONSTRUCTOR
--
-- Called from 'Analysis.Walker.walkDecl' for @TyClD _ (DataDecl ...)@.
-- Phase 2 scope: emit declaration-level nodes only. Constructor argument
-- types and deriving clauses are not walked (deferred to later phases).
module Rules.DataTypes
  ( walkDataDecl
  ) where

import Data.Foldable (forM_)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import GHC.Hs (GhcPs, LIdP)
import GHC.Hs.Decls
  ( HsDataDefn(..)
  , ConDecl(..)
  , LConDecl
  , HsConDeclGADTDetails(..)
  )
import GHC.Hs.Type
  ( ConDeclField(..)
  , LConDeclField
  , HsConDetails(..)
  , FieldOcc(..)
  )
import GHC.Types.SrcLoc (GenLocated(..), unLoc)
import GHC.Types.Name.Reader (rdrNameOcc)
import GHC.Types.Name.Occurrence (occNameString)

import Analysis.Context (Analyzer, emitNode, emitEdge, askFile, askModuleId)
import Analysis.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.SemanticId (semanticId)
import Loc (getLocN)

-- | Walk a data type declaration, emitting graph nodes for the type
-- and all its constructors and record fields.
--
-- @walkDataDecl typeName dataDef@ processes a @data@ or @newtype@ declaration:
--   * Emits a DATA_TYPE node with semantic ID @file->DATA_TYPE->name@
--   * Emits a CONTAINS edge from the module to the data type
--   * Walks each constructor in 'dd_cons'
--
-- Deriving clauses ('dd_derivs') are ignored in this phase.
walkDataDecl :: LIdP GhcPs -> HsDataDefn GhcPs -> Analyzer ()
walkDataDecl typeName dataDef = do
  file     <- askFile
  moduleId <- askModuleId
  let name = T.pack (occNameString (rdrNameOcc (unLoc typeName)))
  let (line, col, endLine, endCol) = getLocN typeName
  let nodeId = semanticId file "DATA_TYPE" name Nothing Nothing

  -- DATA_TYPE node
  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "DATA_TYPE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.empty
    }

  -- CONTAINS edge: module -> data type
  emitEdge GraphEdge
    { geSource   = moduleId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk each data constructor
  mapM_ (walkConDecl file nodeId) (dd_cons dataDef)

-- | Walk a single data constructor declaration.
--
-- Handles both Haskell 98 style ('ConDeclH98') and GADT style ('ConDeclGADT').
-- For each constructor:
--   * Emits a CONSTRUCTOR node
--   * Emits a CONTAINS edge from the parent DATA_TYPE
--   * If record syntax ('RecCon' / 'RecConGADT'), walks each record field
walkConDecl :: T.Text -> T.Text -> LConDecl GhcPs -> Analyzer ()
walkConDecl file parentId (L _ (ConDeclH98 { con_name = conName, con_args = args })) = do
  let name = T.pack (occNameString (rdrNameOcc (unLoc conName)))
  let (line, col, endLine, endCol) = getLocN conName
  let conNodeId = semanticId file "CONSTRUCTOR" name (Just parentName) Nothing

  -- CONSTRUCTOR node
  emitNode GraphNode
    { gnId        = conNodeId
    , gnType      = "CONSTRUCTOR"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.empty
    }

  -- CONTAINS edge: data type -> constructor
  emitEdge GraphEdge
    { geSource   = parentId
    , geTarget   = conNodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk record fields if RecCon
  case args of
    RecCon (L _ fields) -> mapM_ (walkField file conNodeId name) fields
    _                   -> pure ()

  where
    parentName = extractParentName parentId

walkConDecl file parentId (L _ (ConDeclGADT { con_names = conNames, con_g_args = gadtArgs })) = do
  -- GADT constructors can have multiple names: C1, C2 :: T -> Foo
  forM_ conNames $ \conName -> do
    let name = T.pack (occNameString (rdrNameOcc (unLoc conName)))
    let (line, col, endLine, endCol) = getLocN conName
    let conNodeId = semanticId file "CONSTRUCTOR" name (Just parentName) Nothing

    -- CONSTRUCTOR node
    emitNode GraphNode
      { gnId        = conNodeId
      , gnType      = "CONSTRUCTOR"
      , gnName      = name
      , gnFile      = file
      , gnLine      = line
      , gnColumn    = col
      , gnEndLine   = endLine
      , gnEndColumn = endCol
      , gnExported  = False
      , gnMetadata  = Map.singleton "gadt" (MetaBool True)
      }

    -- CONTAINS edge: data type -> constructor
    emitEdge GraphEdge
      { geSource   = parentId
      , geTarget   = conNodeId
      , geType     = "CONTAINS"
      , geMetadata = Map.empty
      }

    -- GADT constructors can also have record syntax via con_g_args
    case gadtArgs of
      RecConGADT (L _ fields) _ -> mapM_ (walkField file conNodeId name) fields
      _                         -> pure ()

  where
    parentName = extractParentName parentId

-- | Walk a record field declaration.
--
-- A single 'ConDeclField' may declare multiple field names
-- (e.g. @{ foo, bar :: Int }@). This emits one RECORD_FIELD node
-- per field name, each with a HAS_FIELD edge from the constructor.
walkField :: T.Text -> T.Text -> T.Text -> LConDeclField GhcPs -> Analyzer ()
walkField file conNodeId conName (L _ (ConDeclField { cd_fld_names = names })) = do
  forM_ names $ \lFieldOcc -> do
    let locLabel = foLabel (unLoc lFieldOcc)
    let fieldName = T.pack (occNameString (rdrNameOcc (unLoc locLabel)))
    let (line, col, endLine, endCol) = getLocN locLabel

    let fieldNodeId = semanticId file "RECORD_FIELD" fieldName (Just conName) Nothing

    -- RECORD_FIELD node
    emitNode GraphNode
      { gnId        = fieldNodeId
      , gnType      = "RECORD_FIELD"
      , gnName      = fieldName
      , gnFile      = file
      , gnLine      = line
      , gnColumn    = col
      , gnEndLine   = endLine
      , gnEndColumn = endCol
      , gnExported  = False
      , gnMetadata  = Map.empty
      }

    -- HAS_FIELD edge: constructor -> field
    emitEdge GraphEdge
      { geSource   = conNodeId
      , geTarget   = fieldNodeId
      , geType     = "HAS_FIELD"
      , geMetadata = Map.empty
      }

-- ── Helpers ──────────────────────────────────────────────────────────────

-- | Extract the parent name from a semantic ID for use in nested IDs.
-- Given @"file->DATA_TYPE->Foo"@, returns @"Foo"@.
-- Falls back to the full ID if the format is unexpected.
extractParentName :: T.Text -> T.Text
extractParentName sid = case T.splitOn "->" sid of
  (_:_:name:_) -> name
  _            -> sid
