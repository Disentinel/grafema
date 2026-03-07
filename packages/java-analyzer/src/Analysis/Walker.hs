{-# LANGUAGE OverloadedStrings #-}
-- | AST walker that traverses the Java parse tree and emits graph nodes.
--
-- Emits a MODULE node for the file, then delegates to rule modules:
--   * Rules.Imports      — IMPORT, IMPORT_BINDING nodes
--   * Rules.Declarations — CLASS, INTERFACE, ENUM, RECORD, FUNCTION,
--                          VARIABLE, constructor nodes
--   * Rules.Types        — EXTENDS, IMPLEMENTS, RETURNS, TYPE_OF edges,
--                          TYPE_PARAMETER nodes
--   * Rules.Annotations  — ATTRIBUTE nodes, HAS_ATTRIBUTE edges
--   * Rules.Exports      — ExportInfo for public declarations
module Analysis.Walker
  ( walkFile
  ) where

import qualified Data.Text as T
import Data.Text (Text)
import qualified Data.Map.Strict as Map

import JavaAST (JavaFile(..))
import Analysis.Context (Analyzer, emitNode, askFile, askModuleId)
import Analysis.Types (GraphNode(..), MetaValue(..))
import Rules.Declarations (walkDeclarations)
import Rules.Imports (walkImports)
import Rules.Types (walkTypeRefs)
import Rules.Annotations (walkAnnotations)
import Rules.Exports (walkExports)

-- | Walk a parsed Java file AST, emitting graph nodes.
walkFile :: JavaFile -> Analyzer ()
walkFile javaFile = do
  file     <- askFile
  moduleId <- askModuleId

  let modName = extractModuleName file

  -- Emit MODULE node
  emitNode GraphNode
    { gnId        = moduleId
    , gnType      = "MODULE"
    , gnName      = modName
    , gnFile      = file
    , gnLine      = 1
    , gnColumn    = 0
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported  = True
    , gnMetadata  = case jfPackage javaFile of
        Just pkg -> Map.singleton "package" (MetaText pkg)
        Nothing  -> Map.empty
    }

  -- Walk imports
  mapM_ walkImports (jfImports javaFile)

  -- Walk type declarations (classes, interfaces, enums, records, annotations)
  mapM_ walkDeclarations (jfTypes javaFile)

  -- Walk type references (extends, implements, type params)
  mapM_ walkTypeRefs (jfTypes javaFile)

  -- Walk annotations on type declarations
  mapM_ walkAnnotations (jfTypes javaFile)

  -- Walk exports (public visibility)
  mapM_ walkExports (jfTypes javaFile)

-- | Extract module name from file path.
-- "src/com/example/Foo.java" -> "Foo"
extractModuleName :: Text -> Text
extractModuleName path =
  let segments = T.splitOn "/" path
      fileName = if null segments then path else last segments
      baseName = if T.isSuffixOf ".java" fileName
                 then T.dropEnd 5 fileName
                 else fileName
  in baseName
