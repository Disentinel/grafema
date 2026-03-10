{-# LANGUAGE OverloadedStrings #-}
-- | Export rule: emits ExportInfo for Python module-level declarations
-- and __all__ definitions.
--
-- Python export semantics:
--   * If __all__ is defined: only listed names are exported
--   * If __all__ is not defined: all non-underscore-prefixed names are exported
--
-- Handles these Python constructs:
--   * AssignStmt with __all__ target   -> explicit export list
--   * FunctionDef at module level      -> auto-export if no underscore prefix
--   * ClassDef at module level         -> auto-export if no underscore prefix
--   * AssignStmt at module level       -> auto-export target names
--
-- Called from the analysis walker for module-level statements.
module Rules.Exports
  ( walkExports
  ) where

import Control.Monad (when)
import Data.Text (Text)
import qualified Data.Text as T

import PythonAST (PythonStmt(..), PythonExpr(..))
import Analysis.Types (ExportInfo(..), ExportKind(..))
import Analysis.Context
    ( Analyzer
    , emitExport
    , askFile
    )
import Grafema.SemanticId (semanticId)

-- ── Top-level export walker ───────────────────────────────────────────

-- | Walk module-level statements and emit export info.
-- If __all__ is found, only those names are exported.
-- Otherwise, all non-underscore-prefixed names are exported.
walkExports :: [PythonStmt] -> Analyzer ()
walkExports stmts =
  case findAllAssignment stmts of
    Just names -> mapM_ emitExportInfo names
    Nothing    -> emitPublicNames stmts

-- ── __all__ detection ─────────────────────────────────────────────────

-- | Find __all__ = ["name1", "name2"] assignment at module level.
findAllAssignment :: [PythonStmt] -> Maybe [Text]
findAllAssignment [] = Nothing
findAllAssignment (AssignStmt targets val _ : rest) =
  if isAllTarget targets
    then extractStringList val
    else findAllAssignment rest
findAllAssignment (_ : rest) = findAllAssignment rest

-- | Check if assignment target is __all__.
isAllTarget :: [PythonExpr] -> Bool
isAllTarget [NameExpr "__all__" _] = True
isAllTarget _                      = False

-- | Extract a list of string values from a list expression.
-- Handles: ["a", "b", "c"]
extractStringList :: PythonExpr -> Maybe [Text]
extractStringList (ListExpr elts _) = mapM extractStringConstant elts
extractStringList (TupleExpr elts _) = mapM extractStringConstant elts
extractStringList _ = Nothing

-- | Extract a string value from a constant expression.
extractStringConstant :: PythonExpr -> Maybe Text
extractStringConstant (ConstantExpr val _kind _sp) =
  -- ConstantExpr stores the value as Text. For strings, this is the
  -- string content. We only accept non-empty values that don't look
  -- like numbers or booleans.
  if T.null val || val == "True" || val == "False" || val == "None"
    then Nothing
    else Just val
extractStringConstant _ = Nothing

-- ── Export emission ───────────────────────────────────────────────────

-- | Emit ExportInfo for a named export.
emitExportInfo :: Text -> Analyzer ()
emitExportInfo name = do
  file <- askFile
  -- Approximate node ID: the actual node may be FUNCTION, CLASS, or VARIABLE
  -- The resolver will match by name within the module.
  let nodeId = semanticId file "VARIABLE" name Nothing Nothing
  emitExport ExportInfo
    { eiName   = name
    , eiNodeId = nodeId
    , eiKind   = NamedExport
    , eiSource = Nothing
    }

-- ── Default public names (no __all__) ─────────────────────────────────

-- | Emit exports for all module-level non-underscore-prefixed names.
emitPublicNames :: [PythonStmt] -> Analyzer ()
emitPublicNames = mapM_ emitIfPublic
  where
    emitIfPublic :: PythonStmt -> Analyzer ()
    emitIfPublic (FunctionDef name _ _ _ _ _ _) =
      when (not (T.isPrefixOf "_" name)) $ emitExportInfo name
    emitIfPublic (ClassDef name _ _ _ _ _) =
      when (not (T.isPrefixOf "_" name)) $ emitExportInfo name
    emitIfPublic (AssignStmt targets _ _) =
      mapM_ emitTargetIfPublic targets
    emitIfPublic (AnnAssignStmt target _ _ _ _) =
      emitTargetIfPublic target
    emitIfPublic _ = pure ()

    emitTargetIfPublic :: PythonExpr -> Analyzer ()
    emitTargetIfPublic (NameExpr name _) =
      when (not (T.isPrefixOf "_" name)) $ emitExportInfo name
    emitTargetIfPublic (TupleExpr elts _) =
      mapM_ emitTargetIfPublic elts
    emitTargetIfPublic _ = pure ()
