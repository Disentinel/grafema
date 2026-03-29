{-# LANGUAGE OverloadedStrings #-}
-- | Exports rule: detect exported declarations.
--
-- In C/C++, there is no explicit export list (until C++20 modules).
-- Export heuristics:
--   * Header file (.h/.hpp) declarations are all exports
--   * Public class members are exports
--   * Extern declarations are exports
--   * Non-static free functions in headers are exports
--
-- Emits EXPORT graph nodes with EXPORTS edges to the declared node,
-- plus ExportInfo metadata for the resolver.
--
-- Called from 'Analysis.Walker.walkFile' for each top-level declaration.
module Rules.Exports
  ( walkExports
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import CppAST
import Analysis.Types (GraphNode(..), GraphEdge(..), ExportInfo(..), ExportKind(..))
import Analysis.Context
    ( Analyzer
    , emitNode
    , emitEdge
    , emitExport
    , askFile
    , askModuleId
    , askIsHeader
    )
import Grafema.SemanticId (semanticId, contentHash)

-- ── Helpers ─────────────────────────────────────────────────────────────

-- | Emit an EXPORT node and EXPORTS edge, plus ExportInfo metadata.
emitExportNode :: Text -> Text -> Text -> Int -> Int -> Analyzer ()
emitExportNode file name targetId line col = do
  moduleId <- askModuleId
  let hash     = contentHash [("target", targetId)]
      exportId = semanticId file "EXPORT" name Nothing (Just hash)

  emitNode GraphNode
    { gnId        = exportId
    , gnType      = "EXPORT"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = line
    , gnEndColumn = col
    , gnExported  = True
    , gnMetadata  = Map.empty
    }

  emitEdge GraphEdge
    { geSource   = exportId
    , geTarget   = targetId
    , geType     = "EXPORTS"
    , geMetadata = Map.empty
    }

  emitEdge GraphEdge
    { geSource   = moduleId
    , geTarget   = exportId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  emitExport ExportInfo
    { eiName   = name
    , eiNodeId = targetId
    , eiKind   = NamedExport
    , eiSource = Nothing
    }

-- ── Export walker ──────────────────────────────────────────────────────

-- | Walk a declaration for export analysis.
walkExports :: CppNode -> Analyzer ()

-- Exported function declaration
walkExports node | nodeKind node == "FunctionDecl" = do
  isHeader <- askIsHeader
  if isHeader && not (lookupBoolField "isStatic" node)
    then do
      file <- askFile
      let name   = maybe "<anonymous>" id (nodeName node)
          nodeId = semanticId file "FUNCTION" name Nothing Nothing
      emitExportNode file name nodeId (nodeLine node) (nodeColumn node)
    else pure ()

-- Exported method declaration
walkExports node | nodeKind node == "MethodDecl" = do
  isHeader <- askIsHeader
  let access = lookupTextField "access" node
  if isHeader && access /= Just "private"
    then do
      file <- askFile
      let name   = maybe "<anonymous>" id (nodeName node)
          nodeId = semanticId file "FUNCTION" name Nothing Nothing
      emitExportNode file name nodeId (nodeLine node) (nodeColumn node)
    else pure ()

-- Exported class/struct/union declaration
walkExports node | nodeKind node `elem` ["ClassDecl", "StructDecl", "UnionDecl"] = do
  isHeader <- askIsHeader
  if isHeader
    then do
      file <- askFile
      let name       = maybe "<anonymous>" id (nodeName node)
          isAbstract = lookupBoolField "isAbstract" node
          graphType  = case nodeKind node of
            "ClassDecl" -> if isAbstract then "INTERFACE" else "CLASS"
            "StructDecl" -> "STRUCT"
            _            -> "UNION"
          nodeId = semanticId file graphType name Nothing Nothing
      emitExportNode file name nodeId (nodeLine node) (nodeColumn node)
    else pure ()

-- Exported enum declaration
walkExports node | nodeKind node == "EnumDecl" = do
  isHeader <- askIsHeader
  if isHeader
    then do
      file <- askFile
      let name   = maybe "<anonymous>" id (nodeName node)
          nodeId = semanticId file "ENUM" name Nothing Nothing
      emitExportNode file name nodeId (nodeLine node) (nodeColumn node)
    else pure ()

-- Exported variable (extern in header)
walkExports node | nodeKind node == "VarDecl" = do
  isHeader <- askIsHeader
  let isExtern = lookupBoolField "isExtern" node
  if isHeader && isExtern
    then do
      file <- askFile
      let name = maybe "<var>" id (nodeName node)
          line = nodeLine node
          hash = contentHash [("line", T.pack (show line)), ("name", name)]
          nodeId = semanticId file "VARIABLE" name Nothing (Just hash)
      emitExportNode file name nodeId line (nodeColumn node)
    else pure ()

-- Exported typedef/type alias
walkExports node | nodeKind node `elem` ["TypedefDecl", "TypeAliasDecl"] = do
  isHeader <- askIsHeader
  if isHeader
    then do
      file <- askFile
      let name   = maybe "<typedef>" id (nodeName node)
          nodeId = semanticId file "TYPEDEF" name Nothing Nothing
      emitExportNode file name nodeId (nodeLine node) (nodeColumn node)
    else pure ()

-- Exported macro definition
walkExports node | nodeKind node == "MacroDefinition" = do
  file <- askFile
  let name   = maybe "<macro>" id (nodeName node)
      nodeId = semanticId file "MACRO" name Nothing Nothing
  emitExportNode file name nodeId (nodeLine node) (nodeColumn node)

-- Namespace: walk children for exports
walkExports node | nodeKind node == "Namespace" =
  mapM_ walkExports (nodeChildren node)

-- Non-exported: skip
walkExports _ = pure ()
