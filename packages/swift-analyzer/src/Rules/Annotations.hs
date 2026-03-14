{-# LANGUAGE OverloadedStrings #-}
-- | Annotations rule for Swift: ATTRIBUTE nodes + CONTAINS edges.
--
-- Emits an ATTRIBUTE node for each Swift attribute (@available, @objc,
-- @MainActor, @Published, etc.) on declarations.  Recurses into member
-- declarations for type/extension/actor/protocol decls.
module Rules.Annotations (walkDeclAnnotations) where

import qualified Data.Map.Strict as Map
import qualified Data.Text as T

import SwiftAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId, contentHash)

-- | Walk a declaration, emitting ATTRIBUTE nodes for its attributes
-- and recursing into member declarations.
walkDeclAnnotations :: SwiftDecl -> Analyzer ()
walkDeclAnnotations decl = do
  mapM_ (emitAttribute (getDeclSpan decl)) (getDeclAttributes decl)
  mapM_ walkDeclAnnotations (getDeclMembers decl)

-- | Emit a single ATTRIBUTE node with a CONTAINS edge from the current scope.
emitAttribute :: Span -> SwiftAttribute -> Analyzer ()
emitAttribute sp attr = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  let name = "@" <> saName attr
      line = posLine (spanStart sp)
      col  = posCol (spanStart sp)
      hash = contentHash
        [ ("attr", name)
        , ("line", T.pack (show line))
        , ("col",  T.pack (show col))
        ]
      nodeId = semanticId file "ATTRIBUTE" name parent (Just hash)
      baseMeta =
        [ ("language", MetaText "swift")
        ]
      argsMeta = case saArguments attr of
        Just args -> [("arguments", MetaText args)]
        Nothing   -> []
  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "ATTRIBUTE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol (spanEnd sp)
    , gnMetadata  = Map.fromList (baseMeta ++ argsMeta)
    , gnExported  = False
    }
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- | Extract attributes from a declaration.
-- OperatorDecl and UnknownDecl have no attributes field.
getDeclAttributes :: SwiftDecl -> [SwiftAttribute]
getDeclAttributes OperatorDecl{}  = []
getDeclAttributes UnknownDecl{}   = []
getDeclAttributes d               = sdAttributes d

-- | Extract member declarations (for recursion into type bodies).
getDeclMembers :: SwiftDecl -> [SwiftDecl]
getDeclMembers (StructDecl    _ _ _ _ members _ _) = members
getDeclMembers (ClassDecl     _ _ _ _ members _ _) = members
getDeclMembers (EnumDecl      _ _ _ _ members _ _) = members
getDeclMembers (ProtocolDecl  _ _ _ members _ _)   = members
getDeclMembers (ExtensionDecl _ _ _ members _ _)   = members
getDeclMembers (ActorDecl     _ _ _ _ members _ _) = members
getDeclMembers _                                    = []

-- | Extract the span from any declaration.
getDeclSpan :: SwiftDecl -> Span
getDeclSpan OperatorDecl{ sdSpan = sp } = sp
getDeclSpan UnknownDecl{ sdSpan = sp }  = sp
getDeclSpan d                           = sdSpan d
