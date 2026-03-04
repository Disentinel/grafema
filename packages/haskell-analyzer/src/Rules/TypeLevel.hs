{-# LANGUAGE OverloadedStrings #-}
-- | Type-level declaration rules: type synonyms and type families.
--
-- Handles:
--   TyClD _ (SynDecl { .. }) -> TYPE_SYNONYM node
--   TyClD _ (FamDecl { .. }) -> TYPE_FAMILY node (data/open/closed)
--
-- Called from Walker.hs for type-level TyClDecl cases.
module Rules.TypeLevel
  ( walkTypeSynonym  -- :: LIdP GhcPs -> Analyzer ()
  , walkTypeFamily   -- :: FamilyDecl GhcPs -> Analyzer ()
  ) where

import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import GHC.Hs (GhcPs, LIdP)
import GHC.Hs.Decls (FamilyDecl(..), FamilyInfo(..))
import GHC.Types.SrcLoc (GenLocated(..))
import GHC.Types.Name.Reader (rdrNameOcc)
import GHC.Types.Name.Occurrence (occNameString)

import Analysis.Context (Analyzer, emitNode, emitEdge, askFile, askModuleId, askExported)
import Analysis.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Loc (getLocN)

-- | Walk a type synonym declaration (SynDecl).
--
-- Emits a TYPE_SYNONYM node and a CONTAINS edge from the module.
-- Example: @type Foo = Bar@ produces a node named "Foo" of type TYPE_SYNONYM.
walkTypeSynonym :: LIdP GhcPs -> Analyzer ()
walkTypeSynonym synName = do
  file     <- askFile
  moduleId <- askModuleId
  exported <- askExported
  let name      = T.pack (occNameString (rdrNameOcc (unLoc synName)))
  let (line, col, endLine, endCol) = getLocN synName
  let nodeId    = moduleId <> "->TYPE_SYNONYM->" <> name
  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "TYPE_SYNONYM"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = exported
    , gnMetadata  = Map.empty
    }
  emitEdge GraphEdge
    { geSource   = moduleId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }
  where
    unLoc (L _ x) = x

-- | Walk a type family declaration (FamDecl).
--
-- Emits a TYPE_FAMILY node with a "familyKind" metadata field
-- indicating whether it is a data family, open type family, or
-- closed type family. Also emits a CONTAINS edge from the module.
walkTypeFamily :: FamilyDecl GhcPs -> Analyzer ()
walkTypeFamily (FamilyDecl { fdLName = famName, fdInfo = info }) = do
  file     <- askFile
  moduleId <- askModuleId
  exported <- askExported
  let name      = T.pack (occNameString (rdrNameOcc (unLoc famName)))
  let (line, col, endLine, endCol) = getLocN famName
  let nodeId    = moduleId <> "->TYPE_FAMILY->" <> name
  let kindMeta  = case info of
        DataFamily          -> Map.singleton "familyKind" (MetaText "data")
        OpenTypeFamily      -> Map.singleton "familyKind" (MetaText "open")
        ClosedTypeFamily _  -> Map.singleton "familyKind" (MetaText "closed")
  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "TYPE_FAMILY"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = exported
    , gnMetadata  = kindMeta
    }
  emitEdge GraphEdge
    { geSource   = moduleId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }
  where
    unLoc (L _ x) = x
