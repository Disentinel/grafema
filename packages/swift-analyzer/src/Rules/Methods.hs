{-# LANGUAGE OverloadedStrings #-}
-- | Method and function declaration rules for Swift.
--
-- Handles:
--   * FuncDecl      -> FUNCTION node (kind=function/method)
--   * InitDecl      -> FUNCTION node (kind=init)
--   * DeinitDecl    -> FUNCTION node (kind=deinit)
--   * SubscriptDecl -> FUNCTION node (kind=subscript)
module Rules.Methods
  ( walkFuncDecl
  , walkInitDecl
  , walkDeinitDecl
  , walkSubscriptDecl
  ) where

import Data.Text (Text)
import qualified Data.Map.Strict as Map

import SwiftAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId)
import Rules.Expressions (walkStmt)
import Rules.Types (typeToName)
import Rules.Concurrency (isMainActorAnnotated, isSendableAnnotated)

-- Visibility helpers (duplicated from Declarations to avoid circular deps)

isExportable :: [Text] -> Bool
isExportable mods = not ("private" `elem` mods || "fileprivate" `elem` mods)

visibilityText :: [Text] -> Text
visibilityText mods
  | "open"          `elem` mods = "open"
  | "public"        `elem` mods = "public"
  | "internal"      `elem` mods = "internal"
  | "fileprivate"   `elem` mods = "fileprivate"
  | "private"       `elem` mods = "private"
  | otherwise                    = "internal"

-- | Walk a function declaration.
walkFuncDecl :: SwiftDecl -> Analyzer ()
walkFuncDecl (FuncDecl name mods _gps params retType body attrs isAsync throws sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported
  encClass <- askEnclosingClass
  let funcExported = exported && isExportable mods
      kind = case encClass of
               Just _  -> "method"
               Nothing -> "function"
      nodeId = semanticId file "FUNCTION" name parent Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "FUNCTION", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = funcExported
    , gnMetadata = Map.fromList $
        [ ("kind", MetaText kind)
        , ("visibility", MetaText (visibilityText mods))
        , ("isAsync", MetaBool isAsync)
        , ("throws", MetaBool throws)
        , ("mutating", MetaBool ("mutating" `elem` mods))
        , ("static", MetaBool ("static" `elem` mods || "class" `elem` mods))
        , ("override", MetaBool ("override" `elem` mods))
        , ("paramCount", MetaInt (length params))
        , ("return_type", MetaText (maybe "" typeToName retType))
        , ("language", MetaText "swift")
        ]
        ++ [("mainActor", MetaBool True) | isMainActorAnnotated attrs]
        ++ [("sendable", MetaBool True) | isSendableAnnotated attrs]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  case encClass of
    Just clsId -> emitEdge GraphEdge { geSource = clsId, geTarget = nodeId, geType = "HAS_METHOD", geMetadata = Map.empty }
    Nothing -> return ()
  -- Walk body
  withEnclosingFn nodeId $ withNamedParent name $
    case body of
      Just stmts -> mapM_ walkStmt stmts
      Nothing -> return ()
walkFuncDecl _ = return ()

-- | Walk an init declaration.
walkInitDecl :: SwiftDecl -> Analyzer ()
walkInitDecl (InitDecl mods params body attrs isOptional isAsync throws sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported
  let funcExported = exported && isExportable mods
      nodeId = semanticId file "FUNCTION" "init" parent Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "FUNCTION", gnName = "init", gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = funcExported
    , gnMetadata = Map.fromList $
        [ ("kind", MetaText "init")
        , ("visibility", MetaText (visibilityText mods))
        , ("isOptionalInit", MetaBool isOptional)
        , ("isAsync", MetaBool isAsync)
        , ("throws", MetaBool throws)
        , ("paramCount", MetaInt (length params))
        , ("language", MetaText "swift")
        ]
        ++ [("mainActor", MetaBool True) | isMainActorAnnotated attrs]
        ++ [("sendable", MetaBool True) | isSendableAnnotated attrs]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  withEnclosingFn nodeId $ withNamedParent "init" $
    case body of
      Just stmts -> mapM_ walkStmt stmts
      Nothing -> return ()
walkInitDecl _ = return ()

-- | Walk a deinit declaration.
walkDeinitDecl :: SwiftDecl -> Analyzer ()
walkDeinitDecl (DeinitDecl body _attrs sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  let nodeId = semanticId file "FUNCTION" "deinit" parent Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "FUNCTION", gnName = "deinit", gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = False
    , gnMetadata = Map.fromList [("kind", MetaText "deinit"), ("language", MetaText "swift")]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  withEnclosingFn nodeId $
    case body of
      Just stmts -> mapM_ walkStmt stmts
      Nothing -> return ()
walkDeinitDecl _ = return ()

-- | Walk a subscript declaration.
walkSubscriptDecl :: SwiftDecl -> Analyzer ()
walkSubscriptDecl (SubscriptDecl mods params retType _accessors _gps _attrs sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported
  let funcExported = exported && isExportable mods
      nodeId = semanticId file "FUNCTION" "subscript" parent Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "FUNCTION", gnName = "subscript", gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = funcExported
    , gnMetadata = Map.fromList
        [ ("kind", MetaText "subscript")
        , ("visibility", MetaText (visibilityText mods))
        , ("paramCount", MetaInt (length params))
        , ("return_type", MetaText (maybe "" typeToName retType))
        , ("language", MetaText "swift")
        ]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
walkSubscriptDecl _ = return ()
