{-# LANGUAGE OverloadedStrings #-}
-- | AST walker that traverses the Rust parse tree and emits graph nodes.
--
-- Phase 1: extracts the module name from the file path and emits a MODULE
-- 'GraphNode'.
-- Phase 3: walks items for declarations (FUNCTION, VARIABLE nodes).
-- Phase 4: walks items for data types (STRUCT, ENUM, VARIANT nodes).
-- Phase 5: walks items for traits and impl blocks (TRAIT, IMPL_BLOCK,
-- TYPE_SIGNATURE, ASSOCIATED_TYPE nodes).
-- Phase 6: walks items for imports (IMPORT, IMPORT_BINDING nodes).
-- Phase 7: walks items for exports (populates faExports via pub visibility).
-- Phase 8: walks expressions for REFERENCE, CALL, BRANCH, CLOSURE nodes
-- (triggered from Rules.Declarations via Rules.Expressions).
-- Phase 11: walks expressions for error flow (? operator ERROR_PROPAGATES edges)
-- (triggered from Rules.Declarations via Rules.ErrorFlow).
-- Phase 14: walks items and types for type-level constructs (TYPE_ALIAS,
-- LIFETIME, TRAIT_BOUND nodes) via Rules.TypeLevel.
-- Phase 15: walks items for attributes and derive macros (ATTRIBUTE nodes,
-- HAS_ATTRIBUTE, DERIVES edges) via Rules.Attributes.
module Analysis.Walker
  ( walkFile
  ) where

import qualified Data.Text as T
import Data.Text (Text)
import qualified Data.Map.Strict as Map

import RustAST (RustFile(..))
import Analysis.Context (Analyzer, emitNode, askFile, askModuleId)
import Analysis.Types (GraphNode(..))
import Rules.Declarations (walkDeclarations)
import Rules.DataTypes (walkDataTypes)
import Rules.Traits (walkTraits)
import Rules.Imports (walkImports)
import Rules.Exports (walkExports)
import Rules.TypeLevel (walkTypeLevel)
import Rules.Attributes (walkAttributes)

-- | Walk a parsed Rust file AST, emitting graph nodes.
walkFile :: RustFile -> Analyzer ()
walkFile rustFile = do
  file     <- askFile
  moduleId <- askModuleId

  let modName = extractModuleName file

  -- Emit MODULE node
  emitNode GraphNode
    { gnId       = moduleId
    , gnType     = "MODULE"
    , gnName     = modName
    , gnFile     = file
    , gnLine     = 1
    , gnColumn   = 0
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = True
    , gnMetadata = Map.empty
    }

  -- Phase 3: walk items for declarations
  mapM_ walkDeclarations (rfItems rustFile)

  -- Phase 4: walk items for data types (STRUCT, ENUM, VARIANT)
  mapM_ walkDataTypes (rfItems rustFile)

  -- Phase 5: walk items for traits and impl blocks (TRAIT, IMPL_BLOCK, TYPE_SIGNATURE, ASSOCIATED_TYPE)
  mapM_ walkTraits (rfItems rustFile)

  -- Phase 6: walk items for imports (IMPORT, IMPORT_BINDING)
  mapM_ walkImports (rfItems rustFile)

  -- Phase 7: walk items for exports (populate faExports)
  mapM_ walkExports (rfItems rustFile)

  -- Phase 14: walk items for type-level constructs (TYPE_ALIAS, LIFETIME, TRAIT_BOUND)
  mapM_ walkTypeLevel (rfItems rustFile)

  -- Phase 15: walk items for attributes and derive macros (ATTRIBUTE, HAS_ATTRIBUTE, DERIVES)
  mapM_ walkAttributes (rfItems rustFile)

-- | Extract module name from file path.
-- "src/foo/bar.rs" -> "bar"
-- "src/foo/mod.rs" -> "foo"
extractModuleName :: Text -> Text
extractModuleName path =
  let segments = T.splitOn "/" path
      fileName = if null segments then path else last segments
      baseName = if T.isSuffixOf ".rs" fileName
                 then T.dropEnd 3 fileName
                 else fileName
  in if baseName == "mod" && length segments > 1
     then segments !! (length segments - 2)
     else baseName
