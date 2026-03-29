{-# LANGUAGE OverloadedStrings #-}
-- Rules for destructuring patterns
module Rules.Patterns
  ( ruleObjectPattern
  , ruleArrayPattern
  , ruleAssignmentPattern
  , ruleRestElement
  ) where

import Data.Text (Text)
import Analysis.Context
import {-# SOURCE #-} Analysis.Walker (walkNode)
import AST.Types

-- ── Object Pattern (destructuring) ─────────────────────────────────────

ruleObjectPattern :: ASTNode -> Analyzer (Maybe Text)
ruleObjectPattern node = do
  let props = getChildren "properties" node
  mapM_ (\p -> withAncestor node (walkNode p)) props
  return Nothing

-- ── Array Pattern (destructuring) ───────────────────────────────────────

ruleArrayPattern :: ASTNode -> Analyzer (Maybe Text)
ruleArrayPattern node = do
  let elems = getChildren "elements" node
  mapM_ (\e -> withAncestor node (walkNode e)) elems
  return Nothing

-- ── Assignment Pattern (default value) ──────────────────────────────────

ruleAssignmentPattern :: ASTNode -> Analyzer (Maybe Text)
ruleAssignmentPattern node = do
  case getChildrenMaybe "left" node of
    Just left -> withAncestor node (walkNode left) >> return ()
    Nothing   -> return ()
  case getChildrenMaybe "right" node of
    Just right -> withAncestor node (walkNode right) >> return ()
    Nothing    -> return ()
  return Nothing

-- ── Rest Element ────────────────────────────────────────────────────────

ruleRestElement :: ASTNode -> Analyzer (Maybe Text)
ruleRestElement node = do
  case getChildrenMaybe "argument" node of
    Just arg -> withAncestor node (walkNode arg) >> return ()
    Nothing  -> return ()
  return Nothing
