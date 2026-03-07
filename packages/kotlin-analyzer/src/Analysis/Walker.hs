{-# LANGUAGE OverloadedStrings #-}
-- | AST walker that traverses the Kotlin parse tree and emits graph nodes.
--
-- Emits a MODULE node for the file, then delegates to rule modules.
-- Key difference from Java: walks `declarations` directly (not `types`).
-- Top-level functions and properties are valid in Kotlin.
module Analysis.Walker
  ( walkFile
  ) where

import qualified Data.Text as T
import Data.Text (Text)
import qualified Data.Map.Strict as Map

import KotlinAST (KotlinFile(..))
import Analysis.Context (Analyzer, emitNode, askFile, askModuleId)
import Analysis.Types (GraphNode(..), MetaValue(..))
import Rules.Declarations (walkDeclaration)
import Rules.Imports (walkImport)
import Rules.Types (walkDeclTypeRefs)
import Rules.Annotations (walkDeclAnnotations)
import Rules.Exports (walkDeclExports)

-- | Walk a parsed Kotlin file AST, emitting graph nodes.
walkFile :: KotlinFile -> Analyzer ()
walkFile kotlinFile = do
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
    , gnMetadata  = case kfPackage kotlinFile of
        Just pkg -> Map.singleton "package" (MetaText pkg)
        Nothing  -> Map.empty
    }

  -- Walk imports
  mapM_ walkImport (kfImports kotlinFile)

  -- Walk declarations (classes, objects, functions, properties, type aliases)
  mapM_ walkDeclaration (kfDeclarations kotlinFile)

  -- Walk type references (extends, implements, type params)
  mapM_ walkDeclTypeRefs (kfDeclarations kotlinFile)

  -- Walk annotations on declarations
  mapM_ walkDeclAnnotations (kfDeclarations kotlinFile)

  -- Walk exports (public by default in Kotlin)
  mapM_ walkDeclExports (kfDeclarations kotlinFile)

-- | Extract module name from file path.
-- "src/com/example/Foo.kt" -> "Foo"
extractModuleName :: Text -> Text
extractModuleName path =
  let segments = T.splitOn "/" path
      fileName = if null segments then path else last segments
      baseName = if T.isSuffixOf ".kt" fileName
                 then T.dropEnd 3 fileName
                 else fileName
  in baseName
