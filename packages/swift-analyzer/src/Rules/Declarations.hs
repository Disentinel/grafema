{-# LANGUAGE OverloadedStrings #-}
-- | Declarations rule for Swift.
--
-- Handles:
--   * StructDecl     -> CLASS node (kind=struct)
--   * ClassDecl      -> CLASS node (kind=class)
--   * EnumDecl       -> CLASS node (kind=enum)
--   * ProtocolDecl   -> CLASS node (kind=protocol)
--   * ExtensionDecl  -> EXTENSION node
--   * ActorDecl      -> CLASS node (kind=actor, actorIsolated=true)
--   * FuncDecl       -> delegates to Rules.Methods
--   * InitDecl       -> delegates to Rules.Methods
--   * DeinitDecl     -> delegates to Rules.Methods
--   * SubscriptDecl  -> delegates to Rules.Methods
--   * VarDecl        -> VARIABLE node per binding
--   * TypeAliasDecl  -> TYPE_ALIAS node
--   * EnumCaseDecl   -> VARIABLE node per case element
--   * AssociatedTypeDecl -> TYPE_PARAMETER node
--   * OperatorDecl   -> skipped
--   * UnknownDecl    -> skipped
module Rules.Declarations
  ( walkDeclaration
  , walkMembers
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import SwiftAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId, contentHash)
import Rules.Expressions (walkExpr)
import Rules.Methods (walkFuncDecl, walkInitDecl, walkDeinitDecl, walkSubscriptDecl)

-- Visibility helpers

visibilityText :: [Text] -> Text
visibilityText mods
  | "open"          `elem` mods = "open"
  | "public"        `elem` mods = "public"
  | "internal"      `elem` mods = "internal"
  | "fileprivate"   `elem` mods = "fileprivate"
  | "private"       `elem` mods = "private"
  | otherwise                    = "internal"  -- Swift default

isExportable :: [Text] -> Bool
isExportable mods = not ("private" `elem` mods || "fileprivate" `elem` mods)

-- Top-level declaration walker

walkDeclaration :: SwiftDecl -> Analyzer ()

-- StructDecl -> CLASS node (kind: "struct")
walkDeclaration (StructDecl name mods _gps _supers members _attrs sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported
  let classExported = exported && isExportable mods
      nodeId = semanticId file "CLASS" name parent Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "CLASS", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = classExported
    , gnMetadata = Map.fromList
        [ ("kind", MetaText "struct")
        , ("visibility", MetaText (visibilityText mods))
        , ("language", MetaText "swift")
        ]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  withNamedParent name $ withEnclosingClass nodeId $ withExported classExported $
    walkMembers members

-- ClassDecl -> CLASS node (kind: "class")
walkDeclaration (ClassDecl name mods _gps _supers members _attrs sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported
  let classExported = exported && isExportable mods
      nodeId = semanticId file "CLASS" name parent Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "CLASS", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = classExported
    , gnMetadata = Map.fromList
        [ ("kind", MetaText "class")
        , ("visibility", MetaText (visibilityText mods))
        , ("open", MetaBool ("open" `elem` mods))
        , ("abstract", MetaBool ("abstract" `elem` mods))
        , ("language", MetaText "swift")
        ]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  withNamedParent name $ withEnclosingClass nodeId $ withExported classExported $
    walkMembers members

-- EnumDecl -> CLASS node (kind: "enum")
walkDeclaration (EnumDecl name mods _gps _supers members _attrs sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported
  let classExported = exported && isExportable mods
      nodeId = semanticId file "CLASS" name parent Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "CLASS", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = classExported
    , gnMetadata = Map.fromList
        [ ("kind", MetaText "enum")
        , ("visibility", MetaText (visibilityText mods))
        , ("language", MetaText "swift")
        ]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  withNamedParent name $ withEnclosingClass nodeId $ withExported classExported $
    walkMembers members

-- ProtocolDecl -> CLASS node (kind: "protocol")
walkDeclaration (ProtocolDecl name mods _supers members _attrs sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported
  let classExported = exported && isExportable mods
      nodeId = semanticId file "CLASS" name parent Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "CLASS", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = classExported
    , gnMetadata = Map.fromList
        [ ("kind", MetaText "protocol")
        , ("visibility", MetaText (visibilityText mods))
        , ("language", MetaText "swift")
        ]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  withNamedParent name $ withEnclosingClass nodeId $ withExported classExported $
    walkMembers members

-- ExtensionDecl -> EXTENSION node
walkDeclaration (ExtensionDecl extType mods _supers members _attrs sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported
  let typeName = typeDisplayName extType
      classExported = exported && isExportable mods
      hash = contentHash [("line", T.pack (show (posLine (spanStart sp))))]
      nodeId = semanticId file "EXTENSION" typeName parent (Just hash)
  emitNode GraphNode
    { gnId = nodeId, gnType = "EXTENSION", gnName = typeName, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = classExported
    , gnMetadata = Map.fromList
        [ ("extendedType", MetaText typeName)
        , ("visibility", MetaText (visibilityText mods))
        , ("language", MetaText "swift")
        ]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  withNamedParent typeName $ withEnclosingClass nodeId $ withExported classExported $
    walkMembers members

-- ActorDecl -> CLASS node (kind: "actor", actorIsolated: true)
walkDeclaration (ActorDecl name mods _gps _supers members _attrs sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported
  let classExported = exported && isExportable mods
      nodeId = semanticId file "CLASS" name parent Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "CLASS", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = classExported
    , gnMetadata = Map.fromList
        [ ("kind", MetaText "actor")
        , ("actorIsolated", MetaBool True)
        , ("visibility", MetaText (visibilityText mods))
        , ("language", MetaText "swift")
        ]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  withNamedParent name $ withEnclosingClass nodeId $ withExported classExported $
    walkMembers members

-- FuncDecl -> delegates to Rules.Methods
walkDeclaration fd@FuncDecl{} = walkFuncDecl fd

-- InitDecl -> delegates to Rules.Methods
walkDeclaration id'@InitDecl{} = walkInitDecl id'

-- DeinitDecl -> delegates to Rules.Methods
walkDeclaration dd@DeinitDecl{} = walkDeinitDecl dd

-- VarDecl -> VARIABLE node per binding
walkDeclaration (VarDecl mods bindSpec bindings _attrs sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported
  let varExported = exported && isExportable mods
  mapM_ (walkBinding file scopeId parent varExported bindSpec mods sp) bindings

-- SubscriptDecl -> delegates to Rules.Methods
walkDeclaration sd@SubscriptDecl{} = walkSubscriptDecl sd

-- TypeAliasDecl -> TYPE_ALIAS node
walkDeclaration (TypeAliasDecl name mods _targetType _gps _attrs sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported
  let nodeId = semanticId file "TYPE_ALIAS" name parent Nothing
      aliasExported = exported && isExportable mods
  emitNode GraphNode
    { gnId = nodeId, gnType = "TYPE_ALIAS", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = aliasExported
    , gnMetadata = Map.fromList
        [ ("visibility", MetaText (visibilityText mods))
        , ("language", MetaText "swift")
        ]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }

-- EnumCaseDecl -> VARIABLE node per case element
walkDeclaration (EnumCaseDecl elements _attrs _sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported
  mapM_ (\e -> do
    let name = seeName e
        nodeId = semanticId file "VARIABLE" name parent Nothing
    emitNode GraphNode
      { gnId = nodeId, gnType = "VARIABLE", gnName = name, gnFile = file
      , gnLine = posLine (spanStart (seeSpan e)), gnColumn = posCol (spanStart (seeSpan e))
      , gnEndLine = posLine (spanEnd (seeSpan e)), gnEndColumn = posCol (spanEnd (seeSpan e))
      , gnExported = exported
      , gnMetadata = Map.fromList
          [ ("kind", MetaText "enum_case")
          , ("hasAssociatedValues", MetaBool (not (null (seeAssociatedVals e))))
          , ("language", MetaText "swift")
          ]
      }
    emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
    ) elements

-- AssociatedTypeDecl -> TYPE_PARAMETER node
walkDeclaration (AssociatedTypeDecl name mods _inherited _defaultType _attrs sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported
  let nodeId = semanticId file "TYPE_PARAMETER" name parent Nothing
      typeExported = exported && isExportable mods
  emitNode GraphNode
    { gnId = nodeId, gnType = "TYPE_PARAMETER", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = typeExported
    , gnMetadata = Map.fromList
        [ ("associatedType", MetaBool True)
        , ("visibility", MetaText (visibilityText mods))
        , ("language", MetaText "swift")
        ]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }

-- OperatorDecl -> skip
walkDeclaration OperatorDecl{} = return ()

-- UnknownDecl -> skip
walkDeclaration UnknownDecl{} = return ()

-- Walk variable binding
walkBinding :: Text -> Text -> Maybe Text -> Bool -> Text -> [Text] -> Span -> SwiftBinding -> Analyzer ()
walkBinding file scopeId parent exported bindSpec mods _declSpan binding = do
  let patName = patternName (sbPattern binding)
      nodeId = semanticId file "VARIABLE" patName parent Nothing
      hasAccessors = not (null (sbAccessors binding))
      isComputed = hasAccessors
      isLazy = "lazy" `elem` mods
      isStatic = "static" `elem` mods || "class" `elem` mods
  emitNode GraphNode
    { gnId = nodeId, gnType = "VARIABLE", gnName = patName, gnFile = file
    , gnLine = posLine (spanStart (sbSpan binding)), gnColumn = posCol (spanStart (sbSpan binding))
    , gnEndLine = posLine (spanEnd (sbSpan binding)), gnEndColumn = posCol (spanEnd (sbSpan binding))
    , gnExported = exported
    , gnMetadata = Map.fromList
        [ ("kind", MetaText "property")
        , ("bindingSpecifier", MetaText bindSpec)
        , ("visibility", MetaText (visibilityText mods))
        , ("computed", MetaBool isComputed)
        , ("lazy", MetaBool isLazy)
        , ("static", MetaBool isStatic)
        , ("language", MetaText "swift")
        ]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  -- Walk initializer expression if present
  case sbInitializer binding of
    Just expr -> walkExpr expr
    Nothing -> return ()

-- Walk members of a type declaration
walkMembers :: [SwiftDecl] -> Analyzer ()
walkMembers = mapM_ walkDeclaration

-- Pattern name extraction
patternName :: SwiftPattern -> Text
patternName (IdentifierPattern name) = name
patternName (ValueBindingPattern _ pat) = patternName pat
patternName (TuplePattern pats) = T.intercalate "," (map patternName pats)
patternName _ = "_"

-- Type display name
typeDisplayName :: SwiftType -> Text
typeDisplayName (SimpleType name _) = name
typeDisplayName (OptionalType t) = typeDisplayName t <> "?"
typeDisplayName (ArrayType t) = "[" <> typeDisplayName t <> "]"
typeDisplayName (DictionaryType k v') = "[" <> typeDisplayName k <> ":" <> typeDisplayName v' <> "]"
typeDisplayName (MemberType base name) = typeDisplayName base <> "." <> name
typeDisplayName (UnknownType t) = t
typeDisplayName _ = "<type>"
