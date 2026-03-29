{-# LANGUAGE OverloadedStrings #-}
-- | Declarations rule: FUNCTION, VARIABLE, CONSTANT, PARAMETER nodes
-- for C/C++ declarations.
--
-- Handles these C/C++ AST constructs:
--   * 'FunctionDecl'    -> FUNCTION node (kind=function)
--   * 'MethodDecl'      -> FUNCTION node (kind=method)
--   * 'ConstructorDecl' -> FUNCTION node (kind=constructor)
--   * 'DestructorDecl'  -> FUNCTION node (kind=destructor)
--   * 'ConversionDecl'  -> FUNCTION node (kind=conversion)
--   * 'VarDecl'         -> VARIABLE/CONSTANT node
--   * 'ParamDecl'       -> PARAMETER node
--
-- Also emits CONTAINS, HAS_PARAMETER edges.
-- Walks function bodies by calling Rules.Statements and Rules.Expressions.
module Rules.Declarations
  ( walkDeclaration
  , walkParam
  , walkBodyChild
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import CppAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId, contentHash)
import {-# SOURCE #-} Rules.Statements (walkStmt)
import {-# SOURCE #-} Rules.Expressions (walkExpr)
import {-# SOURCE #-} Rules.DataTypes (walkDataType)
import Rules.Imports (walkImport)
import Rules.Templates (walkTemplate)
import Rules.Preprocessor (walkPreprocessor)
import Rules.Namespaces (walkNamespace)
import Rules.Lambdas (walkLambda)
import Rules.ErrorFlow (walkErrorFlow)
import Rules.Attributes (walkAttribute)
import Rules.TypeLevel (walkTypeLevel)

-- ── Helpers ────────────────────────────────────────────────────────────

posHash :: Int -> Int -> Text
posHash line col = contentHash
  [ ("line", T.pack (show line))
  , ("col",  T.pack (show col))
  ]

-- ── Top-level declaration walker ──────────────────────────────────────

walkDeclaration :: CppNode -> Analyzer ()

-- Function declaration (free function)
walkDeclaration node | nodeKind node == "FunctionDecl" = do
  file    <- askFile
  scopeId <- askScopeId

  let name     = maybe "<anonymous>" id (nodeName node)
      line     = nodeLine node
      col      = nodeColumn node
      endLine  = maybe line id (nodeEndLine node)
      endCol   = maybe col id (nodeEndColumn node)
      nodeId   = semanticId file "FUNCTION" name Nothing Nothing

      -- Extract metadata from fields
      isStatic    = lookupBoolField "isStatic" node
      isInline    = lookupBoolField "isInline" node
      isConstexpr = lookupBoolField "isConstexpr" node
      isExtern    = lookupBoolField "isExtern" node
      returnType  = lookupTextField "returnType" node
      isNoexcept  = lookupBoolField "noexcept" node
      isDeleted   = lookupBoolField "isDeleted" node
      isDefaulted = lookupBoolField "isDefaulted" node

      params   = lookupNodesField "params" node
      body     = lookupNodeField "body" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "FUNCTION"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = True
    , gnMetadata  = Map.fromList $
        [ ("kind",       MetaText "function")
        , ("paramCount", MetaInt (length params))
        ] ++
        [ ("isStatic",    MetaBool True) | isStatic ] ++
        [ ("isInline",    MetaBool True) | isInline ] ++
        [ ("isConstexpr", MetaBool True) | isConstexpr ] ++
        [ ("isExtern",    MetaBool True) | isExtern ] ++
        [ ("isDeleted",   MetaBool True) | isDeleted ] ++
        [ ("isDefaulted", MetaBool True) | isDefaulted ] ++
        [ ("noexcept",    MetaBool True) | isNoexcept ] ++
        [ ("returnType",  MetaText rt) | Just rt <- [returnType] ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk parameters
  mapM_ (walkParam file nodeId) params

  -- Walk attributes from children
  mapM_ walkAttribute (filter (\c -> nodeKind c == "Attribute") (nodeChildren node))

  -- Walk body in function scope
  case body of
    Just bodyNode -> do
      let fnScope = Scope
            { scopeId           = nodeId
            , scopeKind         = FunctionScope
            , scopeDeclarations = mempty
            , scopeParent       = Nothing
            }
      withScope fnScope $
        withEnclosingFn nodeId $
          walkStmt bodyNode
    Nothing -> pure ()

-- Method declaration (class member function)
walkDeclaration node | nodeKind node == "MethodDecl" = do
  file      <- askFile
  scopeId   <- askScopeId
  className <- askCurrentClass

  let name     = maybe "<anonymous>" id (nodeName node)
      line     = nodeLine node
      col      = nodeColumn node
      endLine  = maybe line id (nodeEndLine node)
      endCol   = maybe col id (nodeEndColumn node)
      parent   = className
      nodeId   = semanticId file "FUNCTION" name parent Nothing

      -- Extract metadata from fields
      isStatic    = lookupBoolField "isStatic" node
      isVirtual   = lookupBoolField "isVirtual" node
      isInline    = lookupBoolField "isInline" node
      isConstexpr = lookupBoolField "isConstexpr" node
      isPureVirt  = lookupBoolField "isPureVirtual" node
      isConst     = lookupBoolField "isConst" node
      isOverride  = lookupBoolField "isOverride" node
      isFinal     = lookupBoolField "isFinal" node
      isDeleted   = lookupBoolField "isDeleted" node
      isDefaulted = lookupBoolField "isDefaulted" node
      isNoexcept  = lookupBoolField "noexcept" node
      returnType  = lookupTextField "returnType" node
      access      = lookupTextField "access" node

      params   = lookupNodesField "params" node
      body     = lookupNodeField "body" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "FUNCTION"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = True
    , gnMetadata  = Map.fromList $
        [ ("kind",       MetaText "method")
        , ("paramCount", MetaInt (length params))
        ] ++
        [ ("isStatic",      MetaBool True) | isStatic ] ++
        [ ("isVirtual",     MetaBool True) | isVirtual ] ++
        [ ("isInline",      MetaBool True) | isInline ] ++
        [ ("isConstexpr",   MetaBool True) | isConstexpr ] ++
        [ ("isPureVirtual", MetaBool True) | isPureVirt ] ++
        [ ("isConst",       MetaBool True) | isConst ] ++
        [ ("isOverride",    MetaBool True) | isOverride ] ++
        [ ("isFinal",       MetaBool True) | isFinal ] ++
        [ ("isDeleted",     MetaBool True) | isDeleted ] ++
        [ ("isDefaulted",   MetaBool True) | isDefaulted ] ++
        [ ("noexcept",      MetaBool True) | isNoexcept ] ++
        [ ("returnType",    MetaText rt) | Just rt <- [returnType] ] ++
        [ ("access",        MetaText a)  | Just a  <- [access] ] ++
        [ ("receiver",      MetaText cn) | Just cn <- [className] ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk parameters
  mapM_ (walkParam file nodeId) params

  -- Walk attributes from children
  mapM_ walkAttribute (filter (\c -> nodeKind c == "Attribute") (nodeChildren node))

  -- Walk body
  case body of
    Just bodyNode -> do
      let fnScope = Scope
            { scopeId           = nodeId
            , scopeKind         = FunctionScope
            , scopeDeclarations = mempty
            , scopeParent       = Nothing
            }
      withScope fnScope $
        withEnclosingFn nodeId $
          walkStmt bodyNode
    Nothing -> pure ()

-- Constructor declaration
walkDeclaration node | nodeKind node == "ConstructorDecl" = do
  file      <- askFile
  scopeId   <- askScopeId
  className <- askCurrentClass

  let name     = maybe "<constructor>" id (nodeName node)
      line     = nodeLine node
      col      = nodeColumn node
      endLine  = maybe line id (nodeEndLine node)
      endCol   = maybe col id (nodeEndColumn node)
      parent   = className
      hash     = posHash line col
      nodeId   = semanticId file "FUNCTION" name parent (Just hash)

      isExplicit  = lookupBoolField "isExplicit" node
      isConstexpr = lookupBoolField "isConstexpr" node
      isDeleted   = lookupBoolField "isDeleted" node
      isDefaulted = lookupBoolField "isDefaulted" node
      isNoexcept  = lookupBoolField "noexcept" node
      access      = lookupTextField "access" node

      params      = lookupNodesField "params" node
      body        = lookupNodeField "body" node
      initList    = lookupNodesField "initializerList" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "FUNCTION"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = True
    , gnMetadata  = Map.fromList $
        [ ("kind",       MetaText "constructor")
        , ("paramCount", MetaInt (length params))
        ] ++
        [ ("isExplicit",  MetaBool True) | isExplicit ] ++
        [ ("isConstexpr", MetaBool True) | isConstexpr ] ++
        [ ("isDeleted",   MetaBool True) | isDeleted ] ++
        [ ("isDefaulted", MetaBool True) | isDefaulted ] ++
        [ ("noexcept",    MetaBool True) | isNoexcept ] ++
        [ ("access",      MetaText a)   | Just a <- [access] ] ++
        [ ("hasInitializerList", MetaBool True) | not (null initList) ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk parameters
  mapM_ (walkParam file nodeId) params

  -- Walk initializer list expressions
  mapM_ walkExpr initList

  -- Walk body
  case body of
    Just bodyNode -> do
      let fnScope = Scope
            { scopeId           = nodeId
            , scopeKind         = FunctionScope
            , scopeDeclarations = mempty
            , scopeParent       = Nothing
            }
      withScope fnScope $
        withEnclosingFn nodeId $
          walkStmt bodyNode
    Nothing -> pure ()

-- Destructor declaration
walkDeclaration node | nodeKind node == "DestructorDecl" = do
  file      <- askFile
  scopeId   <- askScopeId
  className <- askCurrentClass

  let name     = maybe "<destructor>" id (nodeName node)
      tilName  = "~" <> name
      line     = nodeLine node
      col      = nodeColumn node
      endLine  = maybe line id (nodeEndLine node)
      endCol   = maybe col id (nodeEndColumn node)
      parent   = className
      nodeId   = semanticId file "FUNCTION" tilName parent Nothing

      isVirtual = lookupBoolField "isVirtual" node
      isNoexcept = lookupBoolField "noexcept" node
      access    = lookupTextField "access" node

      body     = lookupNodeField "body" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "FUNCTION"
    , gnName      = tilName
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = True
    , gnMetadata  = Map.fromList $
        [ ("kind", MetaText "destructor")
        ] ++
        [ ("isVirtual", MetaBool True) | isVirtual ] ++
        [ ("noexcept",  MetaBool True) | isNoexcept ] ++
        [ ("access",    MetaText a)    | Just a <- [access] ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk body
  case body of
    Just bodyNode -> do
      let fnScope = Scope
            { scopeId           = nodeId
            , scopeKind         = FunctionScope
            , scopeDeclarations = mempty
            , scopeParent       = Nothing
            }
      withScope fnScope $
        withEnclosingFn nodeId $
          walkStmt bodyNode
    Nothing -> pure ()

-- Conversion operator declaration (operator int(), operator bool(), etc.)
walkDeclaration node | nodeKind node == "ConversionDecl" = do
  file      <- askFile
  scopeId   <- askScopeId
  className <- askCurrentClass

  let name     = maybe "operator" id (nodeName node)
      line     = nodeLine node
      col      = nodeColumn node
      endLine  = maybe line id (nodeEndLine node)
      endCol   = maybe col id (nodeEndColumn node)
      parent   = className
      nodeId   = semanticId file "FUNCTION" name parent Nothing

      isExplicit = lookupBoolField "isExplicit" node
      returnType = lookupTextField "returnType" node
      access     = lookupTextField "access" node

      body     = lookupNodeField "body" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "FUNCTION"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = True
    , gnMetadata  = Map.fromList $
        [ ("kind", MetaText "conversion")
        ] ++
        [ ("isExplicit", MetaBool True)  | isExplicit ] ++
        [ ("returnType", MetaText rt)    | Just rt <- [returnType] ] ++
        [ ("access",     MetaText a)     | Just a  <- [access] ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk body
  case body of
    Just bodyNode -> do
      let fnScope = Scope
            { scopeId           = nodeId
            , scopeKind         = FunctionScope
            , scopeDeclarations = mempty
            , scopeParent       = Nothing
            }
      withScope fnScope $
        withEnclosingFn nodeId $
          walkStmt bodyNode
    Nothing -> pure ()

-- Variable declaration
walkDeclaration node | nodeKind node == "VarDecl" = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let name     = maybe "<var>" id (nodeName node)
      line     = nodeLine node
      col      = nodeColumn node
      endLine  = maybe line id (nodeEndLine node)
      endCol   = maybe col id (nodeEndColumn node)
      parent   = encFn >>= extractName
      hash     = posHash line col

      isStatic      = lookupBoolField "isStatic" node
      isExtern      = lookupBoolField "isExtern" node
      isConst       = lookupBoolField "isConst" node
      isConstexpr   = lookupBoolField "isConstexpr" node
      isThreadLocal = lookupBoolField "isThreadLocal" node
      varType       = lookupTextField "varType" node
      storageClass  = lookupTextField "storageClass" node
      initExpr      = lookupNodeField "init" node

      -- Const or constexpr -> CONSTANT, otherwise VARIABLE
      graphType = if isConst || isConstexpr then "CONSTANT" else "VARIABLE"
      nodeId   = semanticId file graphType name parent (Just hash)

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
        [ ("kind",    MetaText "variable")
        , ("mutable", MetaBool (not isConst && not isConstexpr))
        ] ++
        [ ("isStatic",      MetaBool True) | isStatic ] ++
        [ ("isExtern",      MetaBool True) | isExtern ] ++
        [ ("isConst",       MetaBool True) | isConst ] ++
        [ ("isConstexpr",   MetaBool True) | isConstexpr ] ++
        [ ("isThreadLocal", MetaBool True) | isThreadLocal ] ++
        [ ("type",          MetaText vt)   | Just vt <- [varType] ] ++
        [ ("storageClass",  MetaText sc)   | Just sc <- [storageClass] ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Emit DECLARES edge from enclosing function to this variable
  case encFn of
    Just fnId -> emitEdge GraphEdge
      { geSource   = fnId
      , geTarget   = nodeId
      , geType     = "DECLARES"
      , geMetadata = Map.empty
      }
    Nothing -> pure ()

  -- Emit ASSIGNED_FROM edge if has initializer
  case initExpr of
    Just initNode -> do
      walkExpr initNode
      emitEdge GraphEdge
        { geSource   = nodeId
        , geTarget   = nodeId <> "::init"
        , geType     = "ASSIGNED_FROM"
        , geMetadata = Map.empty
        }
    Nothing -> pure ()

-- Parameter declaration
walkDeclaration node | nodeKind node == "ParamDecl" = do
  file  <- askFile
  encFn <- askEnclosingFn
  case encFn of
    Just fnId -> walkParam file fnId node
    Nothing   -> pure ()

-- Fallback
walkDeclaration _ = pure ()

-- ── Parameter walker ───────────────────────────────────────────────────

-- | Walk a parameter declaration, emitting PARAMETER node.
walkParam :: Text -> Text -> CppNode -> Analyzer ()
walkParam file fnId node = do
  let name = maybe "<unnamed>" id (nodeName node)
      line     = nodeLine node
      col      = nodeColumn node
      endLine  = maybe line id (nodeEndLine node)
      endCol   = maybe col id (nodeEndColumn node)
      hash     = contentHash [("fn", fnId), ("name", name)]
      nodeId   = semanticId file "PARAMETER" name Nothing (Just hash)
      paramType = lookupTextField "paramType" node
      hasDefault = lookupBoolField "hasDefault" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "PARAMETER"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False  -- parameters are never exported
    , gnMetadata  = Map.fromList $
        [ ("kind", MetaText "parameter")
        ] ++
        [ ("type",       MetaText pt) | Just pt <- [paramType] ] ++
        [ ("hasDefault", MetaBool True) | hasDefault ]
    }

  emitEdge GraphEdge
    { geSource   = fnId
    , geTarget   = nodeId
    , geType     = "HAS_PARAMETER"
    , geMetadata = Map.empty
    }

-- ── Body child dispatcher ─────────────────────────────────────────────

-- | Dispatch a child node inside a function/method body (or CompoundStmt)
-- to the appropriate rule module, ensuring all node kinds are handled.
-- This is the comprehensive dispatcher for function body contents.
walkBodyChild :: CppNode -> Analyzer ()
walkBodyChild child = case nodeKind child of
  -- Declarations
  "FunctionDecl"    -> walkDeclaration child
  "VarDecl"         -> walkDeclaration child
  "ParamDecl"       -> walkDeclaration child
  "MethodDecl"      -> walkDeclaration child
  "ConstructorDecl" -> walkDeclaration child
  "DestructorDecl"  -> walkDeclaration child
  "ConversionDecl"  -> walkDeclaration child
  -- Data types
  "ClassDecl"       -> walkDataType child
  "StructDecl"      -> walkDataType child
  "UnionDecl"       -> walkDataType child
  "EnumDecl"        -> walkDataType child
  "EnumConstantDecl" -> walkDataType child
  "FieldDecl"       -> walkDataType child
  "BaseSpecifier"   -> walkDataType child
  -- Imports
  "IncludeDirective" -> walkImport child
  "UsingDirective"  -> walkImport child
  "UsingDeclaration" -> walkImport child
  -- Namespaces
  "Namespace"       -> walkNamespace child
  -- Templates
  "ClassTemplate"              -> walkTemplate child
  "FunctionTemplate"           -> walkTemplate child
  "ClassTemplatePartialSpec"   -> walkTemplate child
  "TemplateTypeParam"          -> walkTemplate child
  "TemplateNonTypeParam"       -> walkTemplate child
  "TemplateTemplateParam"      -> walkTemplate child
  -- Preprocessor
  "MacroDefinition"  -> walkPreprocessor child
  "MacroExpansion"   -> walkPreprocessor child
  -- Type-level
  "TypedefDecl"      -> walkTypeLevel child
  "TypeAliasDecl"    -> walkTypeLevel child
  -- Attributes
  "Attribute"        -> walkAttribute child
  -- Statements
  "CompoundStmt"     -> walkStmt child
  "IfStmt"           -> walkStmt child
  "ForStmt"          -> walkStmt child
  "WhileStmt"        -> walkStmt child
  "DoStmt"           -> walkStmt child
  "RangeForStmt"     -> walkStmt child
  "SwitchStmt"       -> walkStmt child
  "CaseStmt"         -> walkStmt child
  "DefaultStmt"      -> walkStmt child
  "ReturnStmt"       -> walkStmt child
  "BreakStmt"        -> walkStmt child
  "ContinueStmt"    -> walkStmt child
  "GotoStmt"         -> walkStmt child
  "LabelStmt"        -> walkStmt child
  "DeclStmt"         -> walkStmt child
  "ExprStmt"         -> walkStmt child
  "NullStmt"         -> walkStmt child
  "CoReturn"         -> walkStmt child
  "CoAwait"          -> walkStmt child
  "CoYield"          -> walkStmt child
  -- Expressions
  "CallExpr"         -> walkExpr child
  "MemberRefExpr"    -> walkExpr child
  "DeclRefExpr"      -> walkExpr child
  "BinaryOperator"   -> walkExpr child
  "UnaryOperator"    -> walkExpr child
  "ConditionalOperator" -> walkExpr child
  "NewExpr"          -> walkExpr child
  "DeleteExpr"       -> walkExpr child
  "ArraySubscriptExpr" -> walkExpr child
  "ParenExpr"        -> walkExpr child
  "InitListExpr"     -> walkExpr child
  "ThisExpr"         -> walkExpr child
  "SizeofExpr"       -> walkExpr child
  "AlignofExpr"      -> walkExpr child
  "CommaExpr"        -> walkExpr child
  "CStyleCastExpr"   -> walkExpr child
  "StaticCastExpr"   -> walkExpr child
  "DynamicCastExpr"  -> walkExpr child
  "ReinterpretCastExpr" -> walkExpr child
  "ConstCastExpr"    -> walkExpr child
  "ImplicitCastExpr" -> walkExpr child
  "FunctionalCastExpr" -> walkExpr child
  -- Literals
  "IntegerLiteral"   -> walkExpr child
  "FloatingLiteral"  -> walkExpr child
  "StringLiteral"    -> walkExpr child
  "CharacterLiteral" -> walkExpr child
  "BoolLiteral"      -> walkExpr child
  "NullPtrLiteral"   -> walkExpr child
  "UserDefinedLiteral" -> walkExpr child
  -- Lambda
  "LambdaExpr"       -> walkLambda child
  -- Error flow
  "TryStmt"          -> walkErrorFlow child
  "CatchStmt"        -> walkErrorFlow child
  "ThrowExpr"        -> walkErrorFlow child
  -- Access specifier (handled by class scope)
  "AccessSpecifier"  -> pure ()
  -- Unknown: recursively walk children
  _                  -> mapM_ walkBodyChild (nodeChildren child)

-- ── Name extraction ────────────────────────────────────────────────────

-- | Extract the trailing name from a semantic ID.
extractName :: Text -> Maybe Text
extractName sid =
  case T.splitOn "->" sid of
    [] -> Nothing
    parts ->
      let lastPart = last parts
          name = T.takeWhile (/= '[') lastPart
      in if T.null name then Nothing else Just name
