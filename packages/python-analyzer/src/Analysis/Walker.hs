{-# LANGUAGE OverloadedStrings #-}
-- | AST walker that traverses the Python parse tree and emits graph nodes.
--
-- Emits a MODULE node for the file, then delegates to rule modules:
--   * Rules.Imports      — IMPORT, IMPORT_BINDING nodes
--   * Rules.Declarations — FUNCTION, CLASS, VARIABLE nodes
--   * Rules.Calls        — CALL nodes and CALLS edges
--   * Rules.Types        — type annotation edges
--   * Rules.ControlFlow  — control flow edges
--   * Rules.ErrorFlow    — RAISES edges
--   * Rules.Decorators   — ATTRIBUTE nodes for decorators
--   * Rules.Exports      — ExportInfo for module-level names
--   * Rules.UnsafeDynamic — unsafe dynamic access tracking
module Analysis.Walker
  ( walkFile
  ) where

import qualified Data.Text as T
import Data.Text (Text)
import qualified Data.Map.Strict as Map

import PythonAST
import Analysis.Context (Analyzer, emitNode, askFile, askModuleId)
import Analysis.Types (GraphNode(..), MetaValue(..))
import Rules.Imports (walkImport)
import Rules.Declarations (walkDeclarations)
import Rules.ControlFlow (walkControlFlow)
import Rules.ErrorFlow (walkErrorFlow)
import Rules.Exports (walkExports)
import Rules.Calls (walkExpr)

-- | Walk a parsed Python file AST, emitting graph nodes.
walkFile :: PythonModule -> Analyzer ()
walkFile pyModule = do
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
    , gnMetadata  = Map.empty
    }

  -- Walk module-level exports
  let stmts = pmBody pyModule
  walkExports stmts

  -- Walk each top-level statement
  mapM_ walkStmt stmts

-- | Walk a single statement, dispatching to all rule modules and recursing
-- into sub-statement bodies and embedded expressions.
walkStmt :: PythonStmt -> Analyzer ()
walkStmt stmt = do
  -- Imports
  walkImport stmt
  -- Declarations (functions, classes, variables)
  walkDeclarations stmt
  -- Control flow (for, while, if, match, with)
  walkControlFlow stmt
  -- Error flow (try/except/finally)
  walkErrorFlow stmt
  -- Walk all embedded expressions (emits CALL, REFERENCE, PROPERTY_ACCESS)
  walkStmtExprs stmt
  -- Recurse into sub-statement bodies
  walkStmtBodies stmt

-- | Walk all expressions embedded in a statement.
-- This emits CALL, REFERENCE, PROPERTY_ACCESS nodes for every expression
-- in every statement — not just module-level ExprStmt.
walkStmtExprs :: PythonStmt -> Analyzer ()
walkStmtExprs (ExprStmt val _)             = walkExpr val
walkStmtExprs (ReturnStmt mVal _)          = mapM_ walkExpr mVal
walkStmtExprs (DeleteStmt targets _)       = mapM_ walkExpr targets
walkStmtExprs (AssignStmt _targets val _)  = walkExpr val
walkStmtExprs (AugAssignStmt _target _ val _) = walkExpr val
walkStmtExprs (AnnAssignStmt _ _ mVal _ _) = mapM_ walkExpr mVal
walkStmtExprs (ForStmt _ iter _ _ _ _)     = walkExpr iter
walkStmtExprs (WhileStmt test _ _ _)       = walkExpr test
walkStmtExprs (IfStmt test _ _ _)          = walkExpr test
walkStmtExprs (WithStmt items _ _ _)       =
  mapM_ (\wi -> walkExpr (pwiContextExpr wi)) items
walkStmtExprs (MatchStmt subject _ _)      = walkExpr subject
walkStmtExprs (RaiseStmt mExc mCause _)    = do
  mapM_ walkExpr mExc
  mapM_ walkExpr mCause
walkStmtExprs (AssertStmt test mMsg _)     = do
  walkExpr test
  mapM_ walkExpr mMsg
walkStmtExprs _ = pure ()

-- | Recurse into all sub-statement bodies of a statement.
-- This is what makes expression walking happen inside function bodies,
-- class bodies, if/for/while bodies, try/except bodies, etc.
walkStmtBodies :: PythonStmt -> Analyzer ()
walkStmtBodies (FunctionDef _ _ body _ _ _ _) = mapM_ walkStmt body
walkStmtBodies (ClassDef _ _ _ body _ _)      = mapM_ walkStmt body
walkStmtBodies (ForStmt _ _ body orElse _ _)  = do
  mapM_ walkStmt body
  mapM_ walkStmt orElse
walkStmtBodies (WhileStmt _ body orElse _)    = do
  mapM_ walkStmt body
  mapM_ walkStmt orElse
walkStmtBodies (IfStmt _ body orElse _)       = do
  mapM_ walkStmt body
  mapM_ walkStmt orElse
walkStmtBodies (WithStmt _ body _ _)          = mapM_ walkStmt body
walkStmtBodies (MatchStmt _ cases _)          =
  mapM_ (\mc -> mapM_ walkStmt (pmcBody mc)) cases
walkStmtBodies (TryStmt body handlers orElse finalBody _) = do
  mapM_ walkStmt body
  mapM_ (\h -> mapM_ walkStmt (pehBody h)) handlers
  mapM_ walkStmt orElse
  mapM_ walkStmt finalBody
walkStmtBodies _ = pure ()

-- | Extract module name from file path.
-- "src/mypackage/utils.py" -> "utils"
extractModuleName :: Text -> Text
extractModuleName path =
  let segments = T.splitOn "/" path
      fileName = if null segments then path else last segments
  in if T.isSuffixOf ".pyi" fileName
     then T.dropEnd 4 fileName
     else if T.isSuffixOf ".py" fileName
          then T.dropEnd 3 fileName
          else fileName

-- Suppress unused import warnings (will be used in Wave 3+)
_suppressUnused :: MetaValue
_suppressUnused = MetaText ""
