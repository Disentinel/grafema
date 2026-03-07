{-# LANGUAGE OverloadedStrings #-}
-- | Declarations rule: CLASS, INTERFACE, ENUM, RECORD, FUNCTION,
-- VARIABLE, and constructor nodes.
--
-- Handles these Java AST constructs:
--   * 'ClassDecl'              -> CLASS node
--   * 'InterfaceDecl'          -> INTERFACE node
--   * 'EnumDecl'               -> ENUM node
--   * 'RecordDecl'             -> RECORD node
--   * 'AnnotationTypeDecl'     -> ANNOTATION_TYPE node
--   * 'MethodMember'           -> FUNCTION node
--   * 'ConstructorMember'      -> FUNCTION node (kind=constructor)
--   * 'CompactConstructorMember' -> FUNCTION node (kind=compact_constructor)
--   * 'FieldMember'            -> VARIABLE node (kind=field)
--   * 'EnumConstantMember'     -> VARIABLE node (kind=enum_constant)
--   * 'VarDeclStmt'            -> VARIABLE node (kind=local)
--
-- Also emits CONTAINS, HAS_METHOD, HAS_PROPERTY, INNER_CLASS_OF edges.
-- Walks method/constructor bodies by calling Rules.Expressions and
-- Rules.ControlFlow.
--
-- Called from 'Analysis.Walker.walkFile' for each top-level type declaration.
module Rules.Declarations
  ( walkDeclarations
  , walkMember
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import JavaAST
import Analysis.Types
    ( GraphNode(..)
    , GraphEdge(..)
    , MetaValue(..)
    , Scope(..)
    , ScopeKind(..)
    )
import Analysis.Context
    ( Analyzer
    , emitNode
    , emitEdge
    , askFile
    , askScopeId
    , askExported
    , askEnclosingClass
    , askNamedParent
    , withScope
    , withEnclosingFn
    , withEnclosingClass
    , withNamedParent
    , withExported
    , withStatic
    )
import Grafema.SemanticId (semanticId, contentHash)
import Rules.Expressions (walkExpr, walkStmt)
import Rules.ErrorFlow (walkErrorFlow, walkErrorFlowStmt, countThrows)
import Rules.Types (typeToName)

-- ── Visibility helpers ─────────────────────────────────────────────────

-- | Is the modifier list indicating public visibility?
isPublic :: [Text] -> Bool
isPublic mods = "public" `elem` mods

-- | Is the modifier list indicating static?
isStatic :: [Text] -> Bool
isStatic mods = "static" `elem` mods

-- | Convert modifier list to visibility text.
visibilityText :: [Text] -> Text
visibilityText mods
  | "public"    `elem` mods = "public"
  | "protected" `elem` mods = "protected"
  | "private"   `elem` mods = "private"
  | otherwise                = "package-private"

-- ── Top-level type declaration walker ───────────────────────────────────

-- | Walk a single type declaration, emitting CLASS/INTERFACE/ENUM/RECORD
-- nodes and their members.
walkDeclarations :: JavaTypeDecl -> Analyzer ()

-- Class declaration
walkDeclarations (ClassDecl name mods _typeParams mExtends impls members _annots sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported

  let classExported = exported || isPublic mods
      nodeId = semanticId file "CLASS" name parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "CLASS"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = classExported
    , gnMetadata  = Map.fromList $
        [ ("visibility", MetaText (visibilityText mods))
        , ("abstract",   MetaBool ("abstract" `elem` mods))
        , ("final",      MetaBool ("final" `elem` mods))
        , ("static",     MetaBool (isStatic mods))
        ]
        ++ case mExtends of
             Just superType -> [("extends", MetaText (typeToName superType))]
             Nothing        -> []
        ++ case impls of
             [] -> []
             _  -> [("implements", MetaText (T.intercalate "," (map typeToName impls)))]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk members in class scope
  let classScope = Scope
        { scopeId           = nodeId
        , scopeKind         = ClassScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  let bodyAction = if classExported then withExported else id
  bodyAction $
    withScope classScope $
    withEnclosingClass nodeId $
    withNamedParent name $
      mapM_ walkMember members

-- Interface declaration
walkDeclarations (InterfaceDecl name mods _typeParams extends members _annots sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported

  let ifaceExported = exported || isPublic mods
      nodeId = semanticId file "INTERFACE" name parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "INTERFACE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = ifaceExported
    , gnMetadata  = Map.fromList $
        [ ("visibility", MetaText (visibilityText mods))
        ]
        ++ case extends of
             [] -> []
             _  -> [("extends", MetaText (T.intercalate "," (map typeToName extends)))]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  let ifaceScope = Scope
        { scopeId           = nodeId
        , scopeKind         = InterfaceScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  let bodyAction = if ifaceExported then withExported else id
  bodyAction $
    withScope ifaceScope $
    withEnclosingClass nodeId $
    withNamedParent name $
      mapM_ walkMember members

-- Enum declaration
walkDeclarations (EnumDecl name mods impls constants members _annots sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported

  let enumExported = exported || isPublic mods
      nodeId = semanticId file "ENUM" name parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "ENUM"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = enumExported
    , gnMetadata  = Map.fromList $
        [ ("visibility", MetaText (visibilityText mods))
        ]
        ++ case impls of
             [] -> []
             _  -> [("implements", MetaText (T.intercalate "," (map typeToName impls)))]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  let enumScope = Scope
        { scopeId           = nodeId
        , scopeKind         = EnumScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  let bodyAction = if enumExported then withExported else id
  bodyAction $
    withScope enumScope $
    withEnclosingClass nodeId $
    withNamedParent name $ do
      -- Walk enum constants
      mapM_ walkMember constants
      -- Walk other members
      mapM_ walkMember members

-- Record declaration
walkDeclarations (RecordDecl name mods _typeParams impls components members _annots sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported

  let recExported = exported || isPublic mods
      nodeId = semanticId file "RECORD" name parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "RECORD"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = recExported
    , gnMetadata  = Map.fromList $
        [ ("visibility", MetaText (visibilityText mods))
        ]
        ++ case impls of
             [] -> []
             _  -> [("implements", MetaText (T.intercalate "," (map typeToName impls)))]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk record components as parameters (emit VARIABLE nodes for x, y in record Point(int x, int y))
  mapM_ (walkParam nodeId) components

  let recScope = Scope
        { scopeId           = nodeId
        , scopeKind         = RecordScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  let bodyAction = if recExported then withExported else id
  bodyAction $
    withScope recScope $
    withEnclosingClass nodeId $
    withNamedParent name $
      mapM_ walkMember members

-- Annotation type declaration
walkDeclarations (AnnotationTypeDecl name mods members sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported

  let atExported = exported || isPublic mods
      nodeId = semanticId file "ANNOTATION_TYPE" name parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "ANNOTATION_TYPE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = atExported
    , gnMetadata  = Map.fromList
        [ ("visibility", MetaText (visibilityText mods))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  let atScope = Scope
        { scopeId           = nodeId
        , scopeKind         = ClassScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  let bodyAction = if atExported then withExported else id
  bodyAction $
    withScope atScope $
    withEnclosingClass nodeId $
    withNamedParent name $
      mapM_ walkMember members

-- ── Member walker ──────────────────────────────────────────────────────

-- | Walk a single class/interface/enum member.
walkMember :: JavaMember -> Analyzer ()

-- Method declaration
walkMember (MethodMember name mods _typeParams retType params throws mBody _annots sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported

  let methodExported = exported || isPublic mods
      nodeId = semanticId file "FUNCTION" name parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)
      throwCount = case mBody of
        Just body -> countThrows body
        Nothing   -> 0

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "FUNCTION"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = methodExported
    , gnMetadata  = Map.fromList $
        [ ("kind",             MetaText "method")
        , ("visibility",       MetaText (visibilityText mods))
        , ("abstract",         MetaBool ("abstract" `elem` mods))
        , ("static",           MetaBool (isStatic mods))
        , ("final",            MetaBool ("final" `elem` mods))
        , ("synchronized",     MetaBool ("synchronized" `elem` mods))
        , ("native",           MetaBool ("native" `elem` mods))
        , ("default",          MetaBool ("default" `elem` mods))
        , ("paramCount",       MetaInt (length params))
        , ("throwsCount",      MetaInt (length throws))
        , ("error_exit_count", MetaInt throwCount)
        , ("return_type",      MetaText (typeToName retType))
        ]
        ++ case throws of
             [] -> []
             _  -> [("throws", MetaText (T.intercalate "," (map typeToName throws)))]
    }

  -- CONTAINS edge from parent scope
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- HAS_METHOD edge from enclosing class
  encClass <- askEnclosingClass
  case encClass of
    Just classId -> emitEdge GraphEdge
      { geSource   = classId
      , geTarget   = nodeId
      , geType     = "HAS_METHOD"
      , geMetadata = Map.empty
      }
    Nothing -> pure ()

  -- Walk parameters
  mapM_ (walkParam nodeId) params

  -- Walk body in method scope
  case mBody of
    Just body -> do
      let fnScope = Scope
            { scopeId           = nodeId
            , scopeKind         = MethodScope
            , scopeDeclarations = mempty
            , scopeParent       = Nothing
            }
      let bodyAction = if methodExported then withExported else id
          staticAction = if isStatic mods then withStatic else id
      bodyAction $ staticAction $
        withScope fnScope $
        withEnclosingFn nodeId $
        withNamedParent name $ do
          walkStmt body
          walkErrorFlowStmt body
    Nothing -> pure ()

-- Constructor declaration
walkMember (ConstructorMember name mods _typeParams params throws body _annots sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported

  let ctorExported = exported || isPublic mods
      nodeId = semanticId file "FUNCTION" name parent (Just "ctor")
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)
      throwCount = countThrows body

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "FUNCTION"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = ctorExported
    , gnMetadata  = Map.fromList $
        [ ("kind",             MetaText "constructor")
        , ("visibility",       MetaText (visibilityText mods))
        , ("paramCount",       MetaInt (length params))
        , ("throwsCount",      MetaInt (length throws))
        , ("error_exit_count", MetaInt throwCount)
        ]
        ++ case throws of
             [] -> []
             _  -> [("throws", MetaText (T.intercalate "," (map typeToName throws)))]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- HAS_METHOD edge from enclosing class
  encClass <- askEnclosingClass
  case encClass of
    Just classId -> emitEdge GraphEdge
      { geSource   = classId
      , geTarget   = nodeId
      , geType     = "HAS_METHOD"
      , geMetadata = Map.empty
      }
    Nothing -> pure ()

  -- Walk parameters
  mapM_ (walkParam nodeId) params

  -- Walk body
  let ctorScope = Scope
        { scopeId           = nodeId
        , scopeKind         = ConstructorScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  let bodyAction = if ctorExported then withExported else id
  bodyAction $
    withScope ctorScope $
    withEnclosingFn nodeId $
    withNamedParent name $ do
      walkStmt body
      walkErrorFlowStmt body

-- Compact constructor (records)
walkMember (CompactConstructorMember name mods body _annots sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported

  let ccExported = exported || isPublic mods
      nodeId = semanticId file "FUNCTION" name parent (Just "compact_ctor")
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "FUNCTION"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = ccExported
    , gnMetadata  = Map.fromList
        [ ("kind",       MetaText "compact_constructor")
        , ("visibility", MetaText (visibilityText mods))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk body
  let ccScope = Scope
        { scopeId           = nodeId
        , scopeKind         = ConstructorScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope ccScope $
    withEnclosingFn nodeId $
    withNamedParent name $ do
      walkStmt body
      walkErrorFlowStmt body

-- Field declaration
walkMember (FieldMember mods fieldType variables _annots sp) = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent
  exported <- askExported

  let fieldExported = exported || isPublic mods
      line = posLine (spanStart sp)
      col  = posCol  (spanStart sp)

  mapM_ (walkFieldVar file scopeId parent fieldExported mods fieldType line col) variables

-- Enum constant
walkMember (EnumConstantMember name _args classBody _annots sp) = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent

  let nodeId = semanticId file "VARIABLE" name parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "VARIABLE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = True  -- enum constants are always accessible if enum is
    , gnMetadata  = Map.fromList
        [ ("kind",    MetaText "enum_constant")
        , ("mutable", MetaBool False)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- DERIVES: enum constant is an instance of its enclosing enum
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "DERIVES"
    , geMetadata = Map.empty
    }

  -- Walk anonymous class body if present
  mapM_ walkMember classBody

-- Initializer block
walkMember (InitializerMember isStaticInit body sp) = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent

  let kind = if isStaticInit then "static_init" else "instance_init"
      hash = contentHash [("line", T.pack (show (posLine (spanStart sp))))]
      nodeId = semanticId file "FUNCTION" kind parent (Just hash)
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)
      scopeKind' = if isStaticInit then StaticInitScope else InstanceInitScope

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "FUNCTION"
    , gnName      = kind
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",   MetaText kind)
        , ("static", MetaBool isStaticInit)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  let initScope = Scope
        { scopeId           = nodeId
        , scopeKind         = scopeKind'
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  let staticAction = if isStaticInit then withStatic else id
  staticAction $
    withScope initScope $
    withEnclosingFn nodeId $ do
      walkStmt body
      walkErrorFlowStmt body

-- Annotation member declaration
walkMember (AnnotationMemberDecl name retType _defaultVal sp) = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent

  let nodeId = semanticId file "FUNCTION" name parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "FUNCTION"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = True  -- annotation members are implicitly public
    , gnMetadata  = Map.fromList
        [ ("kind",        MetaText "annotation_element")
        , ("return_type", MetaText (typeToName retType))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- Nested type member
walkMember (NestedTypeMember typeDecl _sp) = do
  scopeId <- askScopeId

  -- Emit INNER_CLASS_OF edge
  let innerName = typeDeclName typeDecl
  file <- askFile
  parent <- askNamedParent
  let innerNodeId = semanticId file (typeDeclNodeType typeDecl) innerName parent Nothing

  -- Walk the nested type declaration
  walkDeclarations typeDecl

  -- Emit INNER_CLASS_OF edge from inner to outer
  emitEdge GraphEdge
    { geSource   = innerNodeId
    , geTarget   = scopeId
    , geType     = "INNER_CLASS_OF"
    , geMetadata = Map.empty
    }

-- Unknown member
walkMember (MemberUnknown _) = pure ()

-- ── Field variable walker ──────────────────────────────────────────────

-- | Walk a single variable in a field declaration.
walkFieldVar :: Text -> Text -> Maybe Text -> Bool -> [Text] -> JavaType -> Int -> Int
             -> JavaVariable -> Analyzer ()
walkFieldVar file scopeId parent fieldExported mods fieldType line _col var = do
  let varName = jvName var
      hash = contentHash [("line", T.pack (show line)), ("name", varName)]
      nodeId = semanticId file "VARIABLE" varName parent (Just hash)
      varLine = posLine (spanStart (jvSpan var))
      varCol  = posCol  (spanStart (jvSpan var))

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "VARIABLE"
    , gnName      = varName
    , gnFile      = file
    , gnLine      = varLine
    , gnColumn    = varCol
    , gnEndLine   = posLine (spanEnd (jvSpan var))
    , gnEndColumn = posCol  (spanEnd (jvSpan var))
    , gnExported  = fieldExported
    , gnMetadata  = Map.fromList
        [ ("kind",       MetaText "field")
        , ("visibility", MetaText (visibilityText mods))
        , ("static",     MetaBool (isStatic mods))
        , ("final",      MetaBool ("final" `elem` mods))
        , ("volatile",   MetaBool ("volatile" `elem` mods))
        , ("transient",  MetaBool ("transient" `elem` mods))
        , ("mutable",    MetaBool (not ("final" `elem` mods)))
        , ("type",       MetaText (typeToName fieldType))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- HAS_PROPERTY edge from enclosing class
  encClass <- askEnclosingClass
  case encClass of
    Just classId -> emitEdge GraphEdge
      { geSource   = classId
      , geTarget   = nodeId
      , geType     = "HAS_PROPERTY"
      , geMetadata = Map.empty
      }
    Nothing -> pure ()

  -- Walk init expression
  case jvInit var of
    Just expr -> walkExpr expr >> walkErrorFlow expr
    Nothing   -> pure ()

-- ── Parameter walker ──────────────────────────────────────────────────

-- | Walk a single parameter, emitting a VARIABLE node with kind=parameter.
walkParam :: Text -> JavaParam -> Analyzer ()
walkParam fnId param = do
  file <- askFile

  let name   = jpName param
      hash   = contentHash [("fn", fnId), ("name", name)]
      nodeId = semanticId file "VARIABLE" name Nothing (Just hash)
      line   = posLine (spanStart (jpSpan param))
      col    = posCol  (spanStart (jpSpan param))

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "VARIABLE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd (jpSpan param))
    , gnEndColumn = posCol  (spanEnd (jpSpan param))
    , gnExported  = False  -- parameters are never exported
    , gnMetadata  = Map.fromList
        [ ("kind",    MetaText "parameter")
        , ("final",   MetaBool (jpIsFinal param))
        , ("varargs", MetaBool (jpIsVarArgs param))
        ]
    }

  emitEdge GraphEdge
    { geSource   = fnId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- Note: Statement walking is handled by Rules.Expressions (walkStmt, walkStmts)

-- ── Helpers ──────────────────────────────────────────────────────────────

-- | Get the name from a type declaration.
typeDeclName :: JavaTypeDecl -> Text
typeDeclName (ClassDecl n _ _ _ _ _ _ _)       = n
typeDeclName (InterfaceDecl n _ _ _ _ _ _)      = n
typeDeclName (EnumDecl n _ _ _ _ _ _)           = n
typeDeclName (RecordDecl n _ _ _ _ _ _ _)       = n
typeDeclName (AnnotationTypeDecl n _ _ _)       = n

-- | Get the graph node type for a type declaration.
typeDeclNodeType :: JavaTypeDecl -> Text
typeDeclNodeType (ClassDecl {})          = "CLASS"
typeDeclNodeType (InterfaceDecl {})      = "INTERFACE"
typeDeclNodeType (EnumDecl {})           = "ENUM"
typeDeclNodeType (RecordDecl {})         = "RECORD"
typeDeclNodeType (AnnotationTypeDecl {}) = "ANNOTATION_TYPE"
