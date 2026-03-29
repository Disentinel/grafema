{-# LANGUAGE OverloadedStrings #-}
-- | Exports rule: uppercase first letter -> ExportInfo records.
--
-- In Go, there is no explicit export list. Names starting with an
-- uppercase letter are exported from the package. This module walks
-- each declaration and emits ExportInfo for exported names so the
-- orchestrator can build cross-file resolution tables.
--
-- Handles these Go declaration types:
--   * 'FuncDecl'          with exported name -> NamedExport
--   * 'StructTypeDecl'    with exported name -> NamedExport (ExportType)
--   * 'InterfaceTypeDecl' with exported name -> NamedExport (ExportType)
--   * 'VarDecl'           with exported names -> NamedExport per name
--   * 'ConstDecl'         with exported names -> NamedExport per name
--   * 'TypeAliasDecl'     with exported name -> NamedExport (ExportType)
--
-- Non-exported items produce no ExportInfo.
--
-- Called from 'Analysis.Walker.walkFile' for each top-level declaration.
module Rules.Exports
  ( walkExports
  ) where

import Data.Char (isUpper)
import Data.Text (Text)
import qualified Data.Text as T

import GoAST
import Analysis.Types (ExportInfo(..), ExportKind(..))
import Analysis.Context
    ( Analyzer
    , emitExport
    , askFile
    )
import Grafema.SemanticId (semanticId, contentHash)

-- ── Export detection ─────────────────────────────────────────────────────

-- | In Go, names starting with an uppercase letter are exported.
isExported :: Text -> Bool
isExported name = case T.uncons name of
  Just (c, _) -> isUpper c
  Nothing     -> False

-- ── Span helpers ─────────────────────────────────────────────────────────

spanLC :: Span -> (Int, Int)
spanLC sp = (posLine (spanStart sp), posCol (spanStart sp))

-- ── Top-level export walker ──────────────────────────────────────────────

-- | Walk a declaration for export analysis.
walkExports :: GoDecl -> Analyzer ()

-- Exported function (no receiver) -> NamedExport
walkExports (FuncDecl name Nothing _ _ _ _ _)
  | isExported name = do
    file <- askFile
    let nodeId = semanticId file "FUNCTION" name Nothing Nothing
    emitExport ExportInfo
      { eiName   = name
      , eiNodeId = nodeId
      , eiKind   = NamedExport
      , eiSource = Nothing
      }

-- Exported method (with receiver) -> NamedExport
walkExports (FuncDecl name (Just recv) _ _ _ _ _)
  | isExported name = do
    file <- askFile
    let recvType = grTypeName recv
        nodeId = semanticId file "FUNCTION" name (Just recvType) Nothing
    emitExport ExportInfo
      { eiName   = recvType <> "." <> name
      , eiNodeId = nodeId
      , eiKind   = NamedExport
      , eiSource = Nothing
      }

-- Exported struct -> NamedExport
walkExports (StructTypeDecl name _ _ _)
  | isExported name = do
    file <- askFile
    let nodeId = semanticId file "CLASS" name Nothing Nothing
    emitExport ExportInfo
      { eiName   = name
      , eiNodeId = nodeId
      , eiKind   = NamedExport
      , eiSource = Nothing
      }

-- Exported interface -> NamedExport
walkExports (InterfaceTypeDecl name _ _ _ _)
  | isExported name = do
    file <- askFile
    let nodeId = semanticId file "INTERFACE" name Nothing Nothing
    emitExport ExportInfo
      { eiName   = name
      , eiNodeId = nodeId
      , eiKind   = NamedExport
      , eiSource = Nothing
      }

-- Exported vars -> NamedExport per exported name
walkExports (VarDecl specs _sp) = do
  file <- askFile
  mapM_ (\spec -> do
    let (sLine, _) = spanLC (gvsSpan spec)
    mapM_ (\varName ->
      if isExported varName
        then do
          let hash = contentHash [("line", T.pack (show sLine)), ("name", varName)]
              nodeId = semanticId file "VARIABLE" varName Nothing (Just hash)
          emitExport ExportInfo
            { eiName   = varName
            , eiNodeId = nodeId
            , eiKind   = NamedExport
            , eiSource = Nothing
            }
        else pure ()
      ) (gvsNames spec)
    ) specs

-- Exported consts -> NamedExport per exported name
walkExports (ConstDecl specs _sp) = do
  file <- askFile
  mapM_ (\spec -> do
    let (sLine, _) = spanLC (gvsSpan spec)
    mapM_ (\constName ->
      if isExported constName
        then do
          let hash = contentHash [("line", T.pack (show sLine)), ("name", constName)]
              nodeId = semanticId file "CONSTANT" constName Nothing (Just hash)
          emitExport ExportInfo
            { eiName   = constName
            , eiNodeId = nodeId
            , eiKind   = NamedExport
            , eiSource = Nothing
            }
        else pure ()
      ) (gvsNames spec)
    ) specs

-- Exported type alias -> NamedExport
walkExports (TypeAliasDecl name _ _)
  | isExported name = do
    file <- askFile
    let nodeId = semanticId file "CLASS" name Nothing Nothing
    emitExport ExportInfo
      { eiName   = name
      , eiNodeId = nodeId
      , eiKind   = NamedExport
      , eiSource = Nothing
      }

-- Non-exported: skip
walkExports _ = pure ()
