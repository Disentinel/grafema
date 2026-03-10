{-# LANGUAGE OverloadedStrings #-}
-- Rules for JSX nodes
module Rules.JSX
  ( ruleJSXElement
  , ruleJSXFragment
  , ruleJSXOpeningElement
  , ruleJSXAttribute
  , ruleJSXExpressionContainer
  ) where

import qualified Data.Map.Strict as Map
import qualified Data.Text as T
import Data.Text (Text)
import Analysis.Types
import Analysis.Context
import {-# SOURCE #-} Analysis.Walker (walkNode)
import Analysis.SemanticId (semanticId, contentHash)
import AST.Types
import AST.Span (Span(..))

-- ── JSX Element ─────────────────────────────────────────────────────────

ruleJSXElement :: ASTNode -> Analyzer (Maybe Text)
ruleJSXElement node = do
  mOpeningId <- case getChildrenMaybe "openingElement" node of
    Just opening -> withAncestor node (walkNode opening)
    Nothing      -> return Nothing
  let children = getChildren "children" node
  mapM_ (\c -> withAncestor node (walkNode c)) children
  return mOpeningId

-- ── JSX Fragment ────────────────────────────────────────────────────────

ruleJSXFragment :: ASTNode -> Analyzer (Maybe Text)
ruleJSXFragment node = do
  let children = getChildren "children" node
  mapM_ (\c -> withAncestor node (walkNode c)) children
  return Nothing

-- ── JSX Opening Element ─────────────────────────────────────────────────

ruleJSXOpeningElement :: ASTNode -> Analyzer (Maybe Text)
ruleJSXOpeningElement node = do
  file <- askFile
  parent <- askNamedParent
  let sp   = astNodeSpan node
      name = case getChildrenMaybe "name" node of
               Just n  -> getTextFieldOr "name" "<jsx>" n
               Nothing -> "<jsx>"
      hash = contentHash [("a", T.pack (show (length (getChildren "attributes" node)))), ("line", T.pack (show (spanStart sp)))]
      nodeId = semanticId file "CALL" name parent (Just hash)
  emitNode GraphNode
    { gnId = nodeId, gnType = "CALL", gnName = name
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.singleton "jsx" (MetaBool True)
    }
  let attrs = getChildren "attributes" node
  mapM_ (\a -> withAncestor node (walkNode a)) attrs
  return (Just nodeId)

-- ── JSX Attribute ───────────────────────────────────────────────────────

ruleJSXAttribute :: ASTNode -> Analyzer (Maybe Text)
ruleJSXAttribute node = do
  case getChildrenMaybe "value" node of
    Just val -> withAncestor node (walkNode val)
    Nothing  -> return Nothing

-- ── JSX Expression Container ────────────────────────────────────────────

ruleJSXExpressionContainer :: ASTNode -> Analyzer (Maybe Text)
ruleJSXExpressionContainer node = do
  case getChildrenMaybe "expression" node of
    Just expr -> withAncestor node (walkNode expr)
    Nothing   -> return Nothing
