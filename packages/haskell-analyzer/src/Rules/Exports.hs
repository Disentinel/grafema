{-# LANGUAGE OverloadedStrings #-}
-- | Phase 3 rule: module export list.
--
-- Handles the module export list from 'hsmodExports'. For each export item:
--   * EXPORT_BINDING node
--   * ExportInfo record for the orchestrator
--
-- If 'hsmodExports' is Nothing, the module exports everything (implicit
-- exports) -- no EXPORT_BINDING nodes are emitted in that case.
--
-- Called from 'Analysis.Walker.walkModule' after the MODULE node is emitted.
module Rules.Exports
  ( walkExports
  ) where

import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import GHC.Hs (GhcPs)
import GHC.Hs.ImpExp
  ( IE(..)
  , IEWrappedName(..)
  )
import GHC.Types.SrcLoc (GenLocated(..), unLoc)
import GHC.Types.Name.Reader (rdrNameOcc)
import GHC.Types.Name.Occurrence (occNameString)
import GHC.Unit.Module (moduleNameString)

import Analysis.Context
  ( Analyzer, emitNode, emitEdge, emitExport
  , askFile, askModuleId
  )
import Analysis.Types (GraphNode(..), GraphEdge(..), ExportInfo(..), ExportKind(..))
import Grafema.SemanticId (semanticId)

-- | Walk the module export list.
--
-- If 'Nothing', the module exports everything (implicit exports) --
-- no EXPORT_BINDING nodes are emitted since every top-level declaration
-- is implicitly exported.
--
-- If 'Just', walks each export item and emits EXPORT_BINDING nodes.
walkExports :: Maybe (GenLocated l [GenLocated l2 (IE GhcPs)]) -> Analyzer ()
walkExports Nothing            = pure ()  -- implicit exports: everything exported
walkExports (Just (L _ items)) = mapM_ walkExportItem items

-- | Process a single export list item, emitting EXPORT_BINDING node(s)
-- and ExportInfo record(s).
walkExportItem :: GenLocated l (IE GhcPs) -> Analyzer ()
walkExportItem (L _ ie) = case ie of
  IEVar _ name ->
    emitExportBinding (extractIEName name)
  IEThingAbs _ name ->
    emitExportBinding (extractIEName name)
  IEThingAll _ name ->
    emitExportBinding (extractIEName name)
  IEThingWith _ name _ subs -> do
    emitExportBinding (extractIEName name)
    mapM_ (\sub -> emitExportBinding (extractIEName sub)) subs
  IEModuleContents _ modName ->
    -- Re-export of an entire module: module Foo (module Bar)
    emitReExportModule (T.pack (moduleNameString (unLoc modName)))
  _ -> pure ()

-- | Emit an EXPORT_BINDING node and ExportInfo for a single exported name.
emitExportBinding :: T.Text -> Analyzer ()
emitExportBinding name = do
  file     <- askFile
  moduleId <- askModuleId
  let nodeId = semanticId file "EXPORT_BINDING" name Nothing Nothing
  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "EXPORT_BINDING"
    , gnName      = name
    , gnFile      = file
    , gnLine      = 0
    , gnColumn    = 0
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported  = True
    , gnMetadata  = Map.empty
    }
  emitEdge GraphEdge
    { geSource   = moduleId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }
  emitExport ExportInfo
    { eiName   = name
    , eiNodeId = nodeId
    , eiKind   = NamedExport
    , eiSource = Nothing
    }

-- | Emit an ExportInfo for a re-exported module (@module Foo@ in export list).
emitReExportModule :: T.Text -> Analyzer ()
emitReExportModule modName = do
  emitExport ExportInfo
    { eiName   = modName
    , eiNodeId = ""        -- star re-export: no specific node
    , eiKind   = ReExport
    , eiSource = Just modName
    }

-- | Extract the 'RdrName' string from an 'IEWrappedName' wrapped in Located.
extractIEName :: GenLocated l (IEWrappedName GhcPs) -> T.Text
extractIEName (L _ (IEName _ locRdrName)) =
  T.pack (occNameString (rdrNameOcc (unLoc locRdrName)))
extractIEName (L _ (IEPattern _ locRdrName)) =
  T.pack (occNameString (rdrNameOcc (unLoc locRdrName)))
extractIEName (L _ (IEType _ locRdrName)) =
  T.pack (occNameString (rdrNameOcc (unLoc locRdrName)))
