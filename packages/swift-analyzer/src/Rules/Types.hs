{-# LANGUAGE OverloadedStrings #-}
-- | Type references rule for Swift.
--
-- Handles type relationships:
--   * inheritedTypes -> EXTENDS edges + deferred InheritanceResolve
--   * generic params -> TYPE_PARAMETER nodes
module Rules.Types
  ( walkDeclTypeRefs
  , typeToName
  ) where

import Data.Text (Text)
import qualified Data.Map.Strict as Map

import SwiftAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId)

-- Top-level type ref walker

walkDeclTypeRefs :: SwiftDecl -> Analyzer ()

walkDeclTypeRefs (StructDecl name _ gps supers _ _ _) =
  walkInheritance name supers >> walkGenericParams name gps
walkDeclTypeRefs (ClassDecl name _ gps supers _ _ _) =
  walkInheritance name supers >> walkGenericParams name gps
walkDeclTypeRefs (EnumDecl name _ gps supers _ _ _) =
  walkInheritance name supers >> walkGenericParams name gps
walkDeclTypeRefs (ProtocolDecl name _ supers _ _ _) =
  walkInheritance name supers
walkDeclTypeRefs (ActorDecl name _ gps supers _ _ _) =
  walkInheritance name supers >> walkGenericParams name gps
walkDeclTypeRefs _ = return ()

walkInheritance :: Text -> [SwiftType] -> Analyzer ()
walkInheritance _name [] = return ()
walkInheritance name supers = do
  file <- askFile
  parent <- askNamedParent
  let nodeId = semanticId file "CLASS" name parent Nothing
  mapM_ (\super -> do
    let superName = typeToName super
    emitDeferred DeferredRef
      { drKind = InheritanceResolve
      , drName = superName
      , drFromNodeId = nodeId
      , drEdgeType = "EXTENDS"
      , drScopeId = Nothing
      , drSource = Nothing
      , drFile = file
      , drLine = 0
      , drColumn = 0
      , drReceiver = Nothing
      , drMetadata = Map.empty
      }
    ) supers

walkGenericParams :: Text -> [SwiftGenericParam] -> Analyzer ()
walkGenericParams _ [] = return ()
walkGenericParams name gps = do
  file <- askFile
  parent <- askNamedParent
  let parentId = semanticId file "CLASS" name parent Nothing
  mapM_ (\gp -> do
    let gpName = sgpName gp
        nodeId = semanticId file "TYPE_PARAMETER" gpName (Just name) Nothing
    emitNode GraphNode
      { gnId = nodeId, gnType = "TYPE_PARAMETER", gnName = gpName, gnFile = file
      , gnLine = 0, gnColumn = 0, gnEndLine = 0, gnEndColumn = 0
      , gnExported = False
      , gnMetadata = Map.fromList [("language", MetaText "swift")]
      }
    emitEdge GraphEdge { geSource = parentId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
    ) gps

-- | Extract a type name from a SwiftType.
typeToName :: SwiftType -> Text
typeToName (SimpleType name _) = name
typeToName (OptionalType t) = typeToName t
typeToName (ImplicitlyUnwrappedOptionalType t) = typeToName t
typeToName (MemberType base name) = typeToName base <> "." <> name
typeToName (UnknownType t) = t
typeToName _ = "<type>"
