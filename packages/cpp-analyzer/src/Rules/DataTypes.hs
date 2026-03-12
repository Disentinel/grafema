{-# LANGUAGE OverloadedStrings #-}
-- | Data type declarations: CLASS, STRUCT, UNION, ENUM nodes.
--
-- Handles these C/C++ AST constructs:
--   * 'ClassDecl'         -> CLASS node
--   * 'StructDecl'        -> STRUCT node
--   * 'UnionDecl'         -> UNION node
--   * 'EnumDecl'          -> ENUM node
--   * 'EnumConstantDecl'  -> ENUM_MEMBER node
--   * 'FieldDecl'         -> VARIABLE node (kind=field)
--   * 'BaseSpecifier'     -> deferred InheritanceResolve
--
-- Also emits CONTAINS, HAS_MEMBER, EXTENDS edges.
module Rules.DataTypes
  ( walkDataType
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import CppAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId, contentHash)
import {-# SOURCE #-} Rules.Declarations (walkDeclaration)
import {-# SOURCE #-} Rules.Expressions (walkExpr)
import Rules.Templates (walkTemplate)
import Rules.TypeLevel (walkTypeLevel)
import Rules.Imports (walkImport)
import Rules.Attributes (walkAttribute)

-- ── Helpers ────────────────────────────────────────────────────────────

posHash :: Int -> Int -> Text
posHash line col = contentHash
  [ ("line", T.pack (show line))
  , ("col",  T.pack (show col))
  ]

-- ── Top-level data type walker ────────────────────────────────────────

walkDataType :: CppNode -> Analyzer ()

-- Class declaration
walkDataType node | nodeKind node == "ClassDecl" = do
  file    <- askFile
  scopeId <- askScopeId

  let name    = maybe "<anonymous>" id (nodeName node)
      line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)

      isFinal    = lookupBoolField "isFinal" node
      isAbstract = lookupBoolField "isAbstract" node

      -- Abstract classes emit INTERFACE instead of CLASS
      graphType = if isAbstract then "INTERFACE" else "CLASS"
      nodeId  = semanticId file graphType name Nothing Nothing

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = graphType
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = True
    , gnMetadata  = Map.fromList $
        [ ("kind", MetaText (if isAbstract then "interface" else "class"))
        ] ++
        [ ("isFinal",    MetaBool True) | isFinal ] ++
        [ ("isAbstract", MetaBool True) | isAbstract ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk members in class scope with private default access
  let classScope = Scope
        { scopeId           = nodeId
        , scopeKind         = ClassScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope classScope $
    withClass name $
      withAccessSpec Private $
        walkClassMembers file nodeId (nodeChildren node)

-- Struct declaration
walkDataType node | nodeKind node == "StructDecl" = do
  file    <- askFile
  scopeId <- askScopeId

  let name    = maybe "<anonymous>" id (nodeName node)
      line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)
      nodeId  = semanticId file "STRUCT" name Nothing Nothing

      isFinal = lookupBoolField "isFinal" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "STRUCT"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = True
    , gnMetadata  = Map.fromList $
        [ ("kind", MetaText "struct")
        ] ++
        [ ("isFinal", MetaBool True) | isFinal ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk members in class scope with public default access (struct default)
  let classScope = Scope
        { scopeId           = nodeId
        , scopeKind         = ClassScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope classScope $
    withClass name $
      withAccessSpec Public $
        walkClassMembers file nodeId (nodeChildren node)

-- Union declaration
walkDataType node | nodeKind node == "UnionDecl" = do
  file    <- askFile
  scopeId <- askScopeId

  let name    = maybe "<anonymous>" id (nodeName node)
      line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)
      nodeId  = semanticId file "UNION" name Nothing Nothing

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "UNION"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = True
    , gnMetadata  = Map.singleton "kind" (MetaText "union")
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk members in class scope with public default access
  let classScope = Scope
        { scopeId           = nodeId
        , scopeKind         = ClassScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope classScope $
    withClass name $
      withAccessSpec Public $
        walkClassMembers file nodeId (nodeChildren node)

-- Enum declaration
walkDataType node | nodeKind node == "EnumDecl" = do
  file    <- askFile
  scopeId <- askScopeId

  let name    = maybe "<anonymous>" id (nodeName node)
      line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)
      nodeId  = semanticId file "ENUM" name Nothing Nothing

      isScoped    = lookupBoolField "isScoped" node
      underlyType = lookupTextField "underlyingType" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "ENUM"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = True
    , gnMetadata  = Map.fromList $
        [ ("kind", MetaText "enum")
        ] ++
        [ ("isScoped",       MetaBool True) | isScoped ] ++
        [ ("underlyingType", MetaText ut)   | Just ut <- [underlyType] ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk enum constants
  mapM_ (walkEnumConstant file nodeId name) (nodeChildren node)

-- Enum constant (member of enum)
walkDataType node | nodeKind node == "EnumConstantDecl" = do
  file    <- askFile
  scopeId <- askScopeId

  let name    = maybe "<member>" id (nodeName node)
      line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)
      hash    = posHash line col
      nodeId  = semanticId file "ENUM_MEMBER" name Nothing (Just hash)

      value = lookupTextField "value" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "ENUM_MEMBER"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = True
    , gnMetadata  = Map.fromList $
        [ ("kind",    MetaText "enum_member")
        , ("mutable", MetaBool False)
        ] ++
        [ ("value", MetaText v) | Just v <- [value] ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "HAS_MEMBER"
    , geMetadata = Map.empty
    }

-- Field declaration (class/struct member variable)
walkDataType node | nodeKind node == "FieldDecl" = do
  file      <- askFile
  scopeId   <- askScopeId
  className <- askCurrentClass

  let name    = maybe "<field>" id (nodeName node)
      line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)
      parent  = className
      nodeId  = semanticId file "VARIABLE" name parent Nothing

      fieldType  = lookupTextField "fieldType" node
      access     = lookupTextField "access" node
      isMutable  = lookupBoolField "isMutable" node
      isStatic   = lookupBoolField "isStatic" node
      isBitField = lookupBoolField "isBitField" node
      bitWidth   = lookupIntField "bitWidth" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "VARIABLE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = True
    , gnMetadata  = Map.fromList $
        [ ("kind",    MetaText "field")
        , ("mutable", MetaBool True)
        ] ++
        [ ("type",       MetaText ft) | Just ft <- [fieldType] ] ++
        [ ("access",     MetaText a)  | Just a  <- [access] ] ++
        [ ("isMutable",  MetaBool True) | isMutable ] ++
        [ ("isStatic",   MetaBool True) | isStatic ] ++
        [ ("isBitField", MetaBool True) | isBitField ] ++
        [ ("bitWidth",   MetaInt bw)    | Just bw <- [bitWidth] ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "HAS_MEMBER"
    , geMetadata = Map.empty
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "HAS_PROPERTY"
    , geMetadata = Map.empty
    }

-- Base specifier (inheritance)
walkDataType node | nodeKind node == "BaseSpecifier" = do
  file    <- askFile
  scopeId <- askScopeId

  let baseName = maybe "<base>" id (nodeName node)
      line     = nodeLine node
      col      = nodeColumn node
      access   = lookupTextField "access" node
      isVirt   = lookupBoolField "isVirtual" node

  emitDeferred DeferredRef
    { drKind       = InheritanceResolve
    , drName       = baseName
    , drFromNodeId = scopeId
    , drEdgeType   = "EXTENDS"
    , drScopeId    = Nothing
    , drSource     = Nothing
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = Nothing
    , drMetadata   = Map.fromList $
        [ ("isVirtual", MetaBool True) | isVirt ] ++
        [ ("access",    MetaText a)    | Just a <- [access] ]
    }

-- Fallback
walkDataType _ = pure ()

-- ── Class members walker ──────────────────────────────────────────────

-- | Walk class/struct/union members, handling access specifiers.
walkClassMembers :: Text -> Text -> [CppNode] -> Analyzer ()
walkClassMembers _file _classId [] = pure ()
walkClassMembers file classId (child:rest) = do
  case nodeKind child of
    "AccessSpecifier" -> do
      let newAccess = case lookupTextField "specifier" child of
            Just "public"    -> Public
            Just "protected" -> Protected
            Just "private"   -> Private
            _                -> DefaultAccess
      withAccessSpec newAccess $
        walkClassMembers file classId rest

    "FieldDecl"        -> walkDataType child >> walkClassMembers file classId rest
    "MethodDecl"       -> walkDeclaration child >> walkClassMembers file classId rest
    "ConstructorDecl"  -> walkDeclaration child >> walkClassMembers file classId rest
    "DestructorDecl"   -> walkDeclaration child >> walkClassMembers file classId rest
    "ConversionDecl"   -> walkDeclaration child >> walkClassMembers file classId rest
    "ClassDecl"        -> walkDataType child >> walkClassMembers file classId rest
    "StructDecl"       -> walkDataType child >> walkClassMembers file classId rest
    "UnionDecl"        -> walkDataType child >> walkClassMembers file classId rest
    "EnumDecl"         -> walkDataType child >> walkClassMembers file classId rest
    "BaseSpecifier"    -> walkDataType child >> walkClassMembers file classId rest
    "FunctionDecl"     -> walkDeclaration child >> walkClassMembers file classId rest
    "VarDecl"          -> walkDeclaration child >> walkClassMembers file classId rest
    "ClassTemplate"    -> walkTemplate child >> walkClassMembers file classId rest
    "FunctionTemplate" -> walkTemplate child >> walkClassMembers file classId rest
    "TypedefDecl"      -> walkTypeLevel child >> walkClassMembers file classId rest
    "TypeAliasDecl"    -> walkTypeLevel child >> walkClassMembers file classId rest
    "UsingDirective"   -> walkImport child >> walkClassMembers file classId rest
    "UsingDeclaration" -> walkImport child >> walkClassMembers file classId rest
    "FriendDecl"       -> walkClassMembers file classId rest
    "Attribute"        -> walkAttribute child >> walkClassMembers file classId rest
    _                  -> walkClassMembers file classId rest

-- ── Enum constant walker ──────────────────────────────────────────────

walkEnumConstant :: Text -> Text -> Text -> CppNode -> Analyzer ()
walkEnumConstant file enumId enumName node
  | nodeKind node == "EnumConstantDecl" = do
    let name    = maybe "<member>" id (nodeName node)
        line    = nodeLine node
        col     = nodeColumn node
        endLine = maybe line id (nodeEndLine node)
        endCol  = maybe col id (nodeEndColumn node)
        nodeId  = semanticId file "ENUM_MEMBER" name (Just enumName) Nothing

        value = lookupTextField "value" node

    emitNode GraphNode
      { gnId        = nodeId
      , gnType      = "ENUM_MEMBER"
      , gnName      = name
      , gnFile      = file
      , gnLine      = line
      , gnColumn    = col
      , gnEndLine   = endLine
      , gnEndColumn = endCol
      , gnExported  = True
      , gnMetadata  = Map.fromList $
          [ ("kind",    MetaText "enum_member")
          , ("mutable", MetaBool False)
          ] ++
          [ ("value", MetaText v) | Just v <- [value] ]
      }

    emitEdge GraphEdge
      { geSource   = enumId
      , geTarget   = nodeId
      , geType     = "HAS_MEMBER"
      , geMetadata = Map.empty
      }

    -- Walk initializer expression if present
    mapM_ walkExpr (lookupNodesField "init" node)

  | otherwise = pure ()
