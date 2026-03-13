{-# LANGUAGE OverloadedStrings #-}
-- | Export rules for Obj-C analysis.
--
-- Heuristic: declarations in .h files are exported (public API),
-- declarations in .m/.mm files are internal (implementation).
--
-- The Walker sets ctxExported based on file extension before walking
-- declarations, so gnExported on nodes is already correct. This module
-- emits ExportInfo records for .h file declarations to support
-- cross-module visibility tracking in the orchestrator.
module Rules.Exports
  ( walkDeclExports
  ) where

import qualified Data.Text as T

import ObjcAST (ObjcDecl(..))
import Analysis.Types (ExportInfo(..), ExportKind(..))
import Analysis.Context (Analyzer, askFile, emitExport)
import Grafema.SemanticId (semanticId)

-- | Walk a declaration, emitting ExportInfo for .h file declarations.
-- Only top-level named declarations in headers are exported.
walkDeclExports :: ObjcDecl -> Analyzer ()
walkDeclExports decl = do
  file <- askFile
  let isHeader = T.isSuffixOf ".h" file
  if isHeader
    then case decl of
      ObjCInterfaceDecl name _ _ ->
        emitExportNamed file "CLASS" name
      ObjCProtocolDecl name _ _ ->
        emitExportNamed file "CLASS" name
      ObjCCategoryDecl name _ _ ->
        emitExportNamed file "EXTENSION" name
      FunctionDecl name _ _ ->
        emitExportNamed file "FUNCTION" name
      EnumDecl name _ _ ->
        emitExportNamed file "CLASS" name
      TypedefDecl name _ ->
        emitExportNamed file "CLASS" name
      VarDecl name _ ->
        emitExportNamed file "VARIABLE" name
      _ -> return ()
    else return ()

-- | Emit a named export for a declaration.
emitExportNamed :: T.Text -> T.Text -> T.Text -> Analyzer ()
emitExportNamed file nodeType name = do
  let nodeId = semanticId file nodeType name Nothing Nothing
  emitExport ExportInfo
    { eiName   = name
    , eiNodeId = nodeId
    , eiKind   = NamedExport
    , eiSource = Nothing
    }
