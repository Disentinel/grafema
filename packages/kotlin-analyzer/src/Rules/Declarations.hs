{-# LANGUAGE OverloadedStrings #-}
-- | Declarations rule for Kotlin.
--
-- Handles:
--   * ClassDecl     -> CLASS node (metadata: kind=class|data|sealed|enum|value|annotation|inner)
--   * ObjectDecl    -> CLASS node (metadata: kind=object, singleton=true)
--   * CompanionObj  -> CLASS node (metadata: kind=companion)
--   * FunDecl       -> FUNCTION node (metadata: suspend, extension, receiverType, etc.)
--   * PropertyDecl  -> VARIABLE node (metadata: kind=property, hasGetter, hasSetter, etc.)
--   * TypeAliasDecl -> TYPE_ALIAS node
--   * PrimaryConstructor -> FUNCTION node (kind=primary_constructor)
--   * SecondaryConstructor -> FUNCTION node (kind=secondary_constructor)
--   * InitBlock     -> FUNCTION node (kind=init_block)
--   * EnumEntry     -> VARIABLE node (kind=enum_entry)
--
-- Also emits CONTAINS, HAS_METHOD, HAS_PROPERTY, INNER_CLASS_OF, COMPANION_OF edges.
module Rules.Declarations
  ( walkDeclaration
  , walkMember
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Maybe (isJust)

import KotlinAST
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
    , withEnclosingObject
    , withNamedParent
    , withExported
    )
import Grafema.SemanticId (semanticId, contentHash)
import Rules.Expressions (walkExpr, walkStmt)
import Rules.ErrorFlow (walkErrorFlowStmt, countThrows)
import Rules.Types (typeToName)

-- Visibility helpers

-- | In Kotlin, everything is public by default.
-- Private items are not exported.
isPrivate :: [Text] -> Bool
isPrivate mods = "private" `elem` mods

visibilityText :: [Text] -> Text
visibilityText mods
  | "public"    `elem` mods = "public"
  | "protected" `elem` mods = "protected"
  | "private"   `elem` mods = "private"
  | "internal"  `elem` mods = "internal"
  | otherwise                = "public"  -- Kotlin default

-- | Is the declaration exported? In Kotlin, public by default.
-- Only private declarations are not exported.
isExportable :: [Text] -> Bool
isExportable mods = not (isPrivate mods)

-- Top-level declaration walker

-- | Walk a single top-level or nested declaration.
walkDeclaration :: KotlinDecl -> Analyzer ()

-- Class declaration (class, data, sealed, enum, inner, value, annotation)
walkDeclaration (ClassDecl name kind mods _typeParams mPrimaryCtor _supers members _annots sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported

  let classExported = exported && isExportable mods
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
        [ ("kind",       MetaText kind)
        , ("visibility", MetaText (visibilityText mods))
        , ("abstract",   MetaBool ("abstract" `elem` mods))
        , ("open",       MetaBool ("open" `elem` mods))
        , ("sealed",     MetaBool (kind == "sealed"))
        , ("data",       MetaBool (kind == "data"))
        , ("inner",      MetaBool (kind == "inner" || "inner" `elem` mods))
        , ("value",      MetaBool (kind == "value"))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk primary constructor if present
  case mPrimaryCtor of
    Just pctor -> walkPrimaryConstructor file nodeId name pctor
    Nothing    -> pure ()

  -- Walk members in class scope
  let classScope = Scope
        { scopeId           = nodeId
        , scopeKind         = ClassScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope classScope $
    withEnclosingClass nodeId $
    withNamedParent name $
    withExported classExported $
      mapM_ walkMember members

-- Object declaration
walkDeclaration (ObjectDecl name mods _supers members _annots sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported

  let objExported = exported && isExportable mods
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
    , gnExported  = objExported
    , gnMetadata  = Map.fromList
        [ ("kind",       MetaText "object")
        , ("visibility", MetaText (visibilityText mods))
        , ("singleton",  MetaBool True)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  let objScope = Scope
        { scopeId           = nodeId
        , scopeKind         = ObjectScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope objScope $
    withEnclosingClass nodeId $
    withEnclosingObject nodeId $
    withNamedParent name $
    withExported objExported $
      mapM_ walkMember members

-- Top-level function declaration
walkDeclaration (FunDecl name mods _typeParams mReceiver params mRetType mBody _annots sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported

  let fnExported = exported && isExportable mods
      nodeId = semanticId file "FUNCTION" name parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)
      throwCount = case mBody of
        Just body -> countThrows body
        Nothing   -> 0
      isExtension = isJust mReceiver

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "FUNCTION"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = fnExported
    , gnMetadata  = Map.fromList $
        [ ("kind",             MetaText "function")
        , ("visibility",       MetaText (visibilityText mods))
        , ("suspend",          MetaBool ("suspend" `elem` mods))
        , ("inline",           MetaBool ("inline" `elem` mods))
        , ("infix",            MetaBool ("infix" `elem` mods))
        , ("operator",         MetaBool ("operator" `elem` mods))
        , ("tailrec",          MetaBool ("tailrec" `elem` mods))
        , ("external",         MetaBool ("external" `elem` mods))
        , ("extension",        MetaBool isExtension)
        , ("paramCount",       MetaInt (length params))
        , ("error_exit_count", MetaInt throwCount)
        ]
        ++ [ ("receiverType", MetaText (typeToName rt)) | Just rt <- [mReceiver] ]
        ++ [ ("return_type", MetaText (typeToName rt)) | Just rt <- [mRetType] ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk parameters
  mapM_ (walkParam nodeId) params

  -- Walk body
  case mBody of
    Just body -> do
      let fnScope = Scope
            { scopeId           = nodeId
            , scopeKind         = FunctionScope
            , scopeDeclarations = mempty
            , scopeParent       = Nothing
            }
      withScope fnScope $
        withEnclosingFn nodeId $
        withNamedParent name $ do
          walkStmt body
          walkErrorFlowStmt body
    Nothing -> pure ()

-- Top-level property declaration
walkDeclaration (PropertyDecl name mods isVal mPropType mInit mGetter mSetter delegated _annots sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported

  let propExported = exported && isExportable mods
      nodeId = semanticId file "VARIABLE" name parent Nothing
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
    , gnExported  = propExported
    , gnMetadata  = Map.fromList $
        [ ("kind",       MetaText "property")
        , ("visibility", MetaText (visibilityText mods))
        , ("mutable",    MetaBool (not isVal))
        , ("const",      MetaBool ("const" `elem` mods))
        , ("lateinit",   MetaBool ("lateinit" `elem` mods))
        , ("delegated",  MetaBool delegated)
        , ("hasGetter",  MetaBool (isJust mGetter))
        , ("hasSetter",  MetaBool (isJust mSetter))
        ]
        ++ [ ("type", MetaText (typeToName pt)) | Just pt <- [mPropType] ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk initializer
  case mInit of
    Just expr -> walkExpr expr
    Nothing   -> pure ()

-- Type alias declaration
walkDeclaration (TypeAliasDecl name mods _typeParams aliasedType _annots sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported

  let taExported = exported && isExportable mods
      nodeId = semanticId file "TYPE_ALIAS" name parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "TYPE_ALIAS"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = taExported
    , gnMetadata  = Map.fromList
        [ ("visibility",  MetaText (visibilityText mods))
        , ("aliasedType", MetaText (typeToName aliasedType))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- Unknown declaration
walkDeclaration (DeclUnknown _) = pure ()

-- Member walker

-- | Walk a single class/object member.
walkMember :: KotlinMember -> Analyzer ()

-- Method member
walkMember (FunMember name mods _typeParams mReceiver params mRetType mBody _annots sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported

  let methodExported = exported && isExportable mods
      nodeId = semanticId file "FUNCTION" name parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)
      throwCount = case mBody of
        Just body -> countThrows body
        Nothing   -> 0
      isExtension = isJust mReceiver

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
        , ("open",             MetaBool ("open" `elem` mods))
        , ("override",         MetaBool ("override" `elem` mods))
        , ("suspend",          MetaBool ("suspend" `elem` mods))
        , ("inline",           MetaBool ("inline" `elem` mods))
        , ("infix",            MetaBool ("infix" `elem` mods))
        , ("operator",         MetaBool ("operator" `elem` mods))
        , ("tailrec",          MetaBool ("tailrec" `elem` mods))
        , ("extension",        MetaBool isExtension)
        , ("paramCount",       MetaInt (length params))
        , ("error_exit_count", MetaInt throwCount)
        ]
        ++ [ ("receiverType", MetaText (typeToName rt)) | Just rt <- [mReceiver] ]
        ++ [ ("return_type", MetaText (typeToName rt)) | Just rt <- [mRetType] ]
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
  case mBody of
    Just body -> do
      let fnScope = Scope
            { scopeId           = nodeId
            , scopeKind         = FunctionScope
            , scopeDeclarations = mempty
            , scopeParent       = Nothing
            }
      withScope fnScope $
        withEnclosingFn nodeId $
        withNamedParent name $ do
          walkStmt body
          walkErrorFlowStmt body
    Nothing -> pure ()

-- Property member
walkMember (PropertyMember name mods isVal mPropType mInit mGetter mSetter delegated _annots sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported

  let propExported = exported && isExportable mods
      nodeId = semanticId file "VARIABLE" name parent Nothing
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
    , gnExported  = propExported
    , gnMetadata  = Map.fromList $
        [ ("kind",       MetaText "property")
        , ("visibility", MetaText (visibilityText mods))
        , ("mutable",    MetaBool (not isVal))
        , ("const",      MetaBool ("const" `elem` mods))
        , ("lateinit",   MetaBool ("lateinit" `elem` mods))
        , ("override",   MetaBool ("override" `elem` mods))
        , ("delegated",  MetaBool delegated)
        , ("hasGetter",  MetaBool (isJust mGetter))
        , ("hasSetter",  MetaBool (isJust mSetter))
        ]
        ++ [ ("type", MetaText (typeToName pt)) | Just pt <- [mPropType] ]
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

  -- Walk initializer
  case mInit of
    Just expr -> walkExpr expr
    Nothing   -> pure ()

-- Secondary constructor
walkMember (SecondaryConstructor mods params _delegation _delegArgs mBody _annots sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported

  let ctorExported = exported && isExportable mods
      name   = "<constructor>"
      nodeId = semanticId file "FUNCTION" name parent (Just "secondary_ctor")
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
    , gnExported  = ctorExported
    , gnMetadata  = Map.fromList
        [ ("kind",       MetaText "secondary_constructor")
        , ("visibility", MetaText (visibilityText mods))
        , ("paramCount", MetaInt (length params))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  encClass <- askEnclosingClass
  case encClass of
    Just classId -> emitEdge GraphEdge
      { geSource   = classId
      , geTarget   = nodeId
      , geType     = "HAS_METHOD"
      , geMetadata = Map.empty
      }
    Nothing -> pure ()

  mapM_ (walkParam nodeId) params

  case mBody of
    Just body -> do
      let ctorScope = Scope
            { scopeId           = nodeId
            , scopeKind         = ConstructorScope
            , scopeDeclarations = mempty
            , scopeParent       = Nothing
            }
      withScope ctorScope $
        withEnclosingFn nodeId $ do
          walkStmt body
          walkErrorFlowStmt body
    Nothing -> pure ()

-- Init block
walkMember (InitBlock body sp) = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent

  let hash = contentHash [("line", T.pack (show (posLine (spanStart sp))))]
      nodeId = semanticId file "FUNCTION" "init" parent (Just hash)
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "FUNCTION"
    , gnName      = "init"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind", MetaText "init_block")
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
        , scopeKind         = InitScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope initScope $
    withEnclosingFn nodeId $ do
      walkStmt body
      walkErrorFlowStmt body

-- Companion object member
walkMember (CompanionObjectMember mName _supers members _annots sp) = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent

  let name   = maybe "Companion" id mName
      nodeId = semanticId file "CLASS" name parent (Just "companion")
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
    , gnExported  = True
    , gnMetadata  = Map.fromList
        [ ("kind",      MetaText "companion")
        , ("singleton", MetaBool True)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- COMPANION_OF edge from companion to enclosing class
  encClass <- askEnclosingClass
  case encClass of
    Just classId -> emitEdge GraphEdge
      { geSource   = nodeId
      , geTarget   = classId
      , geType     = "COMPANION_OF"
      , geMetadata = Map.empty
      }
    Nothing -> pure ()

  let compScope = Scope
        { scopeId           = nodeId
        , scopeKind         = CompanionScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope compScope $
    withEnclosingClass nodeId $
    withEnclosingObject nodeId $
    withNamedParent name $
      mapM_ walkMember members

-- Nested class member
walkMember (NestedClassMember decl _sp) = do
  scopeId <- askScopeId

  -- Walk the nested declaration
  walkDeclaration decl

  -- Emit INNER_CLASS_OF edge
  let innerName = declName' decl
  file <- askFile
  parent <- askNamedParent
  let innerNodeId = semanticId file (declNodeType decl) innerName parent Nothing
  emitEdge GraphEdge
    { geSource   = innerNodeId
    , geTarget   = scopeId
    , geType     = "INNER_CLASS_OF"
    , geMetadata = Map.empty
    }

-- Enum entry
walkMember (EnumEntryMember name _args classBody _annots sp) = do
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
    , gnExported  = True
    , gnMetadata  = Map.fromList
        [ ("kind",    MetaText "enum_entry")
        , ("mutable", MetaBool False)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- DERIVES edge
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "DERIVES"
    , geMetadata = Map.empty
    }

  -- Walk enum entry body members if present
  mapM_ walkMember classBody

-- Unknown member
walkMember (MemberUnknown _) = pure ()

-- Primary constructor walker

walkPrimaryConstructor :: Text -> Text -> Text -> KotlinPrimaryConstructor -> Analyzer ()
walkPrimaryConstructor file classId className pctor = do
  let nodeId = semanticId file "FUNCTION" className Nothing (Just "primary_ctor")
      line   = posLine (spanStart (kpcSpan pctor))
      col    = posCol  (spanStart (kpcSpan pctor))
      mods   = kpcModifiers pctor

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "FUNCTION"
    , gnName      = className
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd (kpcSpan pctor))
    , gnEndColumn = posCol  (spanEnd (kpcSpan pctor))
    , gnExported  = isExportable mods
    , gnMetadata  = Map.fromList
        [ ("kind",       MetaText "primary_constructor")
        , ("visibility", MetaText (visibilityText mods))
        , ("paramCount", MetaInt (length (kpcParams pctor)))
        ]
    }

  emitEdge GraphEdge
    { geSource   = classId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  emitEdge GraphEdge
    { geSource   = classId
    , geTarget   = nodeId
    , geType     = "HAS_METHOD"
    , geMetadata = Map.empty
    }

  -- Walk primary constructor params
  -- val/var params also create VARIABLE (property) nodes
  mapM_ (walkPrimaryCtorParam file classId nodeId) (kpcParams pctor)

-- Primary constructor parameter walker

walkPrimaryCtorParam :: Text -> Text -> Text -> KotlinParam -> Analyzer ()
walkPrimaryCtorParam file classId ctorId param = do
  let name   = kpName param
      hash   = contentHash [("fn", ctorId), ("name", name)]
      paramId = semanticId file "VARIABLE" name Nothing (Just hash)
      line   = posLine (spanStart (kpSpan param))
      col    = posCol  (spanStart (kpSpan param))

  -- Emit parameter node
  emitNode GraphNode
    { gnId        = paramId
    , gnType      = "VARIABLE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd (kpSpan param))
    , gnEndColumn = posCol  (spanEnd (kpSpan param))
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",   MetaText "parameter")
        , ("vararg", MetaBool (kpIsVararg param))
        ]
    }

  emitEdge GraphEdge
    { geSource   = ctorId
    , geTarget   = paramId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- If val/var, also emit a property on the class
  if kpIsVal param || kpIsVar param
    then do
      let propHash = contentHash [("class", classId), ("name", name)]
          propId = semanticId file "VARIABLE" name Nothing (Just propHash)
      emitNode GraphNode
        { gnId        = propId
        , gnType      = "VARIABLE"
        , gnName      = name
        , gnFile      = file
        , gnLine      = line
        , gnColumn    = col
        , gnEndLine   = posLine (spanEnd (kpSpan param))
        , gnEndColumn = posCol  (spanEnd (kpSpan param))
        , gnExported  = True
        , gnMetadata  = Map.fromList
            [ ("kind",    MetaText "property")
            , ("mutable", MetaBool (kpIsVar param))
            ]
        }
      emitEdge GraphEdge
        { geSource   = classId
        , geTarget   = propId
        , geType     = "HAS_PROPERTY"
        , geMetadata = Map.empty
        }
    else pure ()

-- Parameter walker

walkParam :: Text -> KotlinParam -> Analyzer ()
walkParam fnId param = do
  file <- askFile

  let name   = kpName param
      hash   = contentHash [("fn", fnId), ("name", name)]
      nodeId = semanticId file "VARIABLE" name Nothing (Just hash)
      line   = posLine (spanStart (kpSpan param))
      col    = posCol  (spanStart (kpSpan param))

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "VARIABLE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd (kpSpan param))
    , gnEndColumn = posCol  (spanEnd (kpSpan param))
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",   MetaText "parameter")
        , ("vararg", MetaBool (kpIsVararg param))
        ]
    }

  emitEdge GraphEdge
    { geSource   = fnId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- Helpers

declName' :: KotlinDecl -> Text
declName' (ClassDecl n _ _ _ _ _ _ _ _)       = n
declName' (ObjectDecl n _ _ _ _ _)            = n
declName' (FunDecl n _ _ _ _ _ _ _ _)         = n
declName' (PropertyDecl n _ _ _ _ _ _ _ _ _)  = n
declName' (TypeAliasDecl n _ _ _ _ _)         = n
declName' (DeclUnknown _)                     = "<unknown>"

declNodeType :: KotlinDecl -> Text
declNodeType (ClassDecl {})     = "CLASS"
declNodeType (ObjectDecl {})    = "CLASS"
declNodeType (FunDecl {})       = "FUNCTION"
declNodeType (PropertyDecl {})  = "VARIABLE"
declNodeType (TypeAliasDecl {}) = "TYPE_ALIAS"
declNodeType (DeclUnknown {})   = "UNKNOWN"
