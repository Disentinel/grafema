{-# LANGUAGE OverloadedStrings #-}
-- | AST walker that traverses the Swift parse tree and emits graph nodes.
--
-- Emits a MODULE node for the file, then delegates to rule modules.
-- Swift top-level: imports and declarations (classes, structs, enums,
-- protocols, extensions, functions, variables, type aliases, actors).
module Analysis.Walker
  ( walkFile
  ) where

import qualified Data.Text as T
import Data.Text (Text)
import qualified Data.Map.Strict as Map

import SwiftAST (SwiftFile(..))
import Analysis.Context (Analyzer, emitNode, askFile, askModuleId)
import Analysis.Types (GraphNode(..), MetaValue(..))
import Rules.Declarations (walkDeclaration)
import Rules.Imports (walkImport)
import Rules.Types (walkDeclTypeRefs)
import Rules.Annotations (walkDeclAnnotations)
import Rules.Exports (walkDeclExports)

-- | Walk a parsed Swift file AST, emitting graph nodes.
walkFile :: SwiftFile -> Analyzer ()
walkFile swiftFile = do
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
    , gnMetadata  = Map.singleton "language" (MetaText "swift")
    }

  -- Walk imports
  mapM_ walkImport (sfImports swiftFile)

  -- Walk declarations (classes, structs, enums, protocols, extensions, functions, etc.)
  mapM_ walkDeclaration (sfDeclarations swiftFile)

  -- Walk type references (extends, implements, generic constraints)
  mapM_ walkDeclTypeRefs (sfDeclarations swiftFile)

  -- Walk annotations on declarations
  mapM_ walkDeclAnnotations (sfDeclarations swiftFile)

  -- Walk exports (internal by default in Swift)
  mapM_ walkDeclExports (sfDeclarations swiftFile)

-- | Extract module name from file path.
-- "Sources/Models/User.swift" -> "User"
extractModuleName :: Text -> Text
extractModuleName path =
  let segments = T.splitOn "/" path
      fileName = if null segments then path else last segments
      baseName = if T.isSuffixOf ".swift" fileName
                 then T.dropEnd 6 fileName
                 else fileName
  in baseName
