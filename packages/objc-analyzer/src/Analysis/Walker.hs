{-# LANGUAGE OverloadedStrings #-}
-- | AST walker that traverses the Obj-C parse tree and emits graph nodes.
--
-- Emits a MODULE node for the file, then delegates to rule modules.
-- Obj-C top-level: imports (#import/#include) and declarations
-- (interfaces, protocols, categories, implementations, C functions, enums).
--
-- Export visibility: .h file declarations are exported (public API),
-- .m/.mm file declarations are internal (implementation).
module Analysis.Walker
  ( walkFile
  ) where

import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import ObjcAST (ObjcFile(..), ObjcDecl(..))
import Analysis.Context (Analyzer, emitNode, askFile, askModuleId, withExported)
import Analysis.Types (GraphNode(..), MetaValue(..))
import Rules.Declarations (walkDeclaration)
import Rules.Imports (walkImportDecl)
import Rules.Exports (walkDeclExports)

-- | Walk a parsed Obj-C file AST, emitting graph nodes.
walkFile :: ObjcFile -> Analyzer ()
walkFile objcFile = do
  file     <- askFile
  moduleId <- askModuleId

  let modName  = extractModuleName file
      isHeader = T.isSuffixOf ".h" file

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
    , gnMetadata  = Map.singleton "language" (MetaText "objc")
    }

  -- Walk all top-level declarations.
  -- .h files: declarations are exported (public API).
  -- .m/.mm files: declarations are internal (implementation).
  withExported isHeader $
    mapM_ walkTopLevel (ofDeclarations objcFile)

-- | Route top-level declarations to the appropriate rule module.
walkTopLevel :: ObjcDecl -> Analyzer ()
walkTopLevel d@(InclusionDirective{}) = walkImportDecl d
walkTopLevel d = do
  walkDeclaration d
  walkDeclExports d

-- | Extract module name from file path.
-- "Sources/Models/AppDelegate.m" -> "AppDelegate"
extractModuleName :: T.Text -> T.Text
extractModuleName path =
  let segments = T.splitOn "/" path
      fileName = if null segments then path else last segments
  in stripExtension fileName

-- | Strip common Obj-C file extensions.
stripExtension :: T.Text -> T.Text
stripExtension f
  | T.isSuffixOf ".m" f  = T.dropEnd 2 f
  | T.isSuffixOf ".mm" f = T.dropEnd 3 f
  | T.isSuffixOf ".h" f  = T.dropEnd 2 f
  | otherwise             = f
