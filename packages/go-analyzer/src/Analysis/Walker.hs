{-# LANGUAGE OverloadedStrings #-}
-- | AST walker that traverses the Go parse tree and emits graph nodes.
--
-- Emits a MODULE node for the file, then delegates to rule modules:
--   * Rules.Imports      — IMPORT nodes
--   * Rules.Declarations — FUNCTION, CLASS (struct), INTERFACE, VARIABLE,
--                          CONSTANT nodes
--   * Rules.Exports      — ExportInfo for exported (uppercase) declarations
module Analysis.Walker
  ( walkFile
  ) where

import qualified Data.Text as T
import Data.Text (Text)
import qualified Data.Map.Strict as Map

import GoAST (GoFile(..))
import Analysis.Context (Analyzer, emitNode, askFile, askModuleId, askPackageName)
import Analysis.Types (GraphNode(..), MetaValue(..))
import Rules.Declarations (walkDeclarations)
import Rules.Imports (walkImport)
import Rules.Exports (walkExports)

-- | Walk a parsed Go file AST, emitting graph nodes.
walkFile :: GoFile -> Analyzer ()
walkFile goFile = do
  file     <- askFile
  moduleId <- askModuleId
  pkg      <- askPackageName

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
    , gnMetadata  = Map.singleton "package" (MetaText pkg)
    }

  -- Walk imports
  mapM_ walkImport (gfImports goFile)

  -- Walk declarations
  mapM_ walkDeclarations (gfDecls goFile)

  -- Walk exports
  mapM_ walkExports (gfDecls goFile)

-- | Extract module name from file path.
-- "src/main.go" -> "main"
-- "pkg/handler.go" -> "handler"
extractModuleName :: Text -> Text
extractModuleName path =
  let segments = T.splitOn "/" path
      fileName = if null segments then path else last segments
      baseName = if T.isSuffixOf ".go" fileName
                 then T.dropEnd 3 fileName
                 else fileName
  in baseName
