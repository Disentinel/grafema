{-# LANGUAGE OverloadedStrings #-}
-- | Declarations rule: FUNCTION, CLASS (struct), INTERFACE, VARIABLE,
-- CONSTANT nodes for Go top-level and nested declarations.
--
-- Handles these Go AST constructs:
--   * 'FuncDecl' (no receiver)   -> FUNCTION node (kind=function)
--   * 'FuncDecl' (with receiver) -> FUNCTION node (kind=method)
--   * 'StructTypeDecl'           -> CLASS node (kind=struct)
--   * 'InterfaceTypeDecl'        -> INTERFACE node
--   * 'VarDecl'                  -> VARIABLE nodes
--   * 'ConstDecl'                -> CONSTANT nodes
--   * 'TypeAliasDecl'            -> CLASS node (kind=type_alias)
--
-- Also emits CONTAINS, HAS_PROPERTY, EXTENDS edges.
-- Walks function bodies by calling Rules.ControlFlow and Rules.Calls.
--
-- Called from 'Analysis.Walker.walkFile' for each top-level declaration.
module Rules.Declarations
  ( walkDeclarations
  , walkMember
  , walkParam
  ) where

import Data.Char (isUpper)
import Data.List (findIndex)
import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import GoAST
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
    , askEnclosingFn
    , withScope
    , withEnclosingFn
    , withReceiver
    )
import Grafema.SemanticId (semanticId, contentHash)
import Rules.Calls (walkExpr)
import Rules.ControlFlow (walkStmt)

-- ── Export detection ─────────────────────────────────────────────────────

-- | In Go, names starting with an uppercase letter are exported.
isExported :: Text -> Bool
isExported name = case T.uncons name of
  Just (c, _) -> isUpper c
  Nothing     -> False

-- ── Span helpers ─────────────────────────────────────────────────────────

spanLC :: Span -> (Int, Int)
spanLC sp = (posLine (spanStart sp), posCol (spanStart sp))

_posHash :: Int -> Int -> Text
_posHash line col = contentHash
  [ ("line", T.pack (show line))
  , ("col",  T.pack (show col))
  ]

-- ── Extract name from semantic ID ────────────────────────────────────────

extractName :: Text -> Maybe Text
extractName sid =
  case T.splitOn "->" sid of
    [] -> Nothing
    parts ->
      let lastPart = last parts
          name = T.takeWhile (/= '[') lastPart
      in if T.null name then Nothing else Just name

-- ── Top-level declaration walker ─────────────────────────────────────────

-- | Walk a single Go declaration, emitting graph nodes and edges.
walkDeclarations :: GoDecl -> Analyzer ()

-- Function declaration (no receiver) → FUNCTION node
walkDeclarations (FuncDecl name Nothing _typeParams params results mBody sp) = do
  file    <- askFile
  scopeId <- askScopeId

  let nodeId = semanticId file "FUNCTION" name Nothing Nothing
      (line, col) = spanLC sp
      contextIdx = findIndex (isContextType . gpParamType) params
      possibleIdx = findIndex (isPossibleContextType . gpParamType) params
      contextMeta = case contextIdx of
        Just idx -> [ ("accepts_context", MetaBool True)
                    , ("context_param_index", MetaInt idx) ]
        Nothing  -> case possibleIdx of
          Just idx -> [ ("possible_context", MetaBool True)
                      , ("context_param_index", MetaInt idx) ]
          Nothing  -> []
      errorIdx = findIndex (isErrorType . gpParamType) results
      errorMeta = case errorIdx of
        Just idx -> [ ("returns_error", MetaBool True)
                    , ("error_return_index", MetaInt idx) ]
        Nothing  -> []

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "FUNCTION"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = isExported name
    , gnMetadata  = Map.fromList $
        [ ("kind",        MetaText "function")
        , ("paramCount",  MetaInt (length params))
        , ("returnCount", MetaInt (length results))
        ] ++
        [ ("return_type", MetaText returnType)
        | not (null results)
        , let returnType = T.intercalate "," (map (goTypeToName . gpParamType) results)
        ] ++
        contextMeta ++
        errorMeta
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk parameters
  mapM_ (walkParam file nodeId) params

  -- Walk body in function scope
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
          walkStmt body
    Nothing -> pure ()

-- Method declaration (with receiver) → FUNCTION node with kind=method
walkDeclarations (FuncDecl name (Just recv) _typeParams params results mBody sp) = do
  file    <- askFile
  scopeId <- askScopeId

  let recvType = grTypeName recv
      nodeId = semanticId file "FUNCTION" name (Just recvType) Nothing
      (line, col) = spanLC sp
      contextIdx = findIndex (isContextType . gpParamType) params
      possibleIdx = findIndex (isPossibleContextType . gpParamType) params
      contextMeta = case contextIdx of
        Just idx -> [ ("accepts_context", MetaBool True)
                    , ("context_param_index", MetaInt idx) ]
        Nothing  -> case possibleIdx of
          Just idx -> [ ("possible_context", MetaBool True)
                      , ("context_param_index", MetaInt idx) ]
          Nothing  -> []
      errorIdx = findIndex (isErrorType . gpParamType) results
      errorMeta = case errorIdx of
        Just idx -> [ ("returns_error", MetaBool True)
                    , ("error_return_index", MetaInt idx) ]
        Nothing  -> []

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "FUNCTION"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = isExported name
    , gnMetadata  = Map.fromList $
        [ ("kind",             MetaText "method")
        , ("receiver",         MetaText recvType)
        , ("pointer_receiver", MetaBool (grPointer recv))
        , ("paramCount",       MetaInt (length params))
        , ("returnCount",      MetaInt (length results))
        ] ++
        [ ("return_type", MetaText returnType)
        | not (null results)
        , let returnType = T.intercalate "," (map (goTypeToName . gpParamType) results)
        ] ++
        contextMeta ++
        errorMeta
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk parameters
  mapM_ (walkParam file nodeId) params

  -- Walk body in method scope with receiver context
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
        withReceiver recvType (grPointer recv) $
          walkStmt body
    Nothing -> pure ()

-- Struct type declaration → CLASS node with kind=struct
walkDeclarations (StructTypeDecl name fields _typeParams sp) = do
  file    <- askFile
  scopeId <- askScopeId

  let nodeId = semanticId file "CLASS" name Nothing Nothing
      (line, col) = spanLC sp

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "CLASS"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = isExported name
    , gnMetadata  = Map.singleton "kind" (MetaText "struct")
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk fields
  mapM_ (walkField file nodeId name) fields

-- Interface type declaration → INTERFACE node
walkDeclarations (InterfaceTypeDecl name methods embeds _typeParams sp) = do
  file    <- askFile
  scopeId <- askScopeId

  let nodeId = semanticId file "INTERFACE" name Nothing Nothing
      (line, col) = spanLC sp

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "INTERFACE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = isExported name
    , gnMetadata  = Map.empty
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk method signatures
  mapM_ (walkInterfaceMethod file nodeId name) methods

  -- Walk embedded interfaces → EXTENDS edges
  mapM_ (walkEmbed file nodeId) embeds

-- Var declaration → VARIABLE nodes
walkDeclarations (VarDecl specs sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn
  let parent = encFn >>= extractName
      (line, _col) = spanLC sp

  mapM_ (walkVarSpec file scopeId parent line True) specs

-- Const declaration → CONSTANT nodes
walkDeclarations (ConstDecl specs sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn
  let parent = encFn >>= extractName
      (line, _col) = spanLC sp

  mapM_ (walkConstSpec file scopeId parent line) specs

-- Type alias declaration → CLASS node with kind=type_alias
walkDeclarations (TypeAliasDecl name _aliasOf sp) = do
  file    <- askFile
  scopeId <- askScopeId

  let nodeId = semanticId file "CLASS" name Nothing Nothing
      (line, col) = spanLC sp

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "CLASS"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = isExported name
    , gnMetadata  = Map.singleton "kind" (MetaText "type_alias")
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- ── Field walker (struct fields) ─────────────────────────────────────────

-- | Walk a struct field, emitting VARIABLE node with kind=field.
-- Exported as walkMember for use by other modules.
walkMember :: GoFieldDef -> Analyzer ()
walkMember field = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn
  let parent = encFn >>= extractName
  walkFieldInner file scopeId parent field

-- | Walk a struct field within a known struct context.
walkField :: Text -> Text -> Text -> GoFieldDef -> Analyzer ()
walkField file structId structName field = do
  let fieldName = gfdName field
      fieldNodeId = semanticId file "VARIABLE" fieldName (Just structName) Nothing
      (fLine, fCol) = spanLC (gfdSpan field)

  emitNode GraphNode
    { gnId        = fieldNodeId
    , gnType      = "VARIABLE"
    , gnName      = fieldName
    , gnFile      = file
    , gnLine      = fLine
    , gnColumn    = fCol
    , gnEndLine   = posLine (spanEnd (gfdSpan field))
    , gnEndColumn = posCol  (spanEnd (gfdSpan field))
    , gnExported  = isExported fieldName
    , gnMetadata  = Map.fromList
        [ ("kind",     MetaText "field")
        , ("mutable",  MetaBool True)
        , ("embedded", MetaBool (gfdEmbedded field))
        , ("type",     MetaText (goTypeToName (gfdFieldType field)))
        ]
        <> case gfdTag field of
             Just tag -> Map.singleton "tag" (MetaText tag)
             Nothing  -> Map.empty
    }

  -- CONTAINS edge from struct
  emitEdge GraphEdge
    { geSource   = structId
    , geTarget   = fieldNodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- HAS_PROPERTY edge from struct
  emitEdge GraphEdge
    { geSource   = structId
    , geTarget   = fieldNodeId
    , geType     = "HAS_PROPERTY"
    , geMetadata = Map.empty
    }

  -- If embedded field → EXTENDS edge from struct to embedded type
  if gfdEmbedded field
    then do
      let embeddedTypeName = goTypeToName (gfdFieldType field)
      emitEdge GraphEdge
        { geSource   = structId
        , geTarget   = embeddedTypeName
        , geType     = "EXTENDS"
        , geMetadata = Map.singleton "embedded" (MetaBool True)
        }
    else pure ()

-- | Walk a field in a generic context (for walkMember).
walkFieldInner :: Text -> Text -> Maybe Text -> GoFieldDef -> Analyzer ()
walkFieldInner file scopeId parent field = do
  let fieldName = gfdName field
      fieldNodeId = semanticId file "VARIABLE" fieldName parent Nothing
      (fLine, fCol) = spanLC (gfdSpan field)

  emitNode GraphNode
    { gnId        = fieldNodeId
    , gnType      = "VARIABLE"
    , gnName      = fieldName
    , gnFile      = file
    , gnLine      = fLine
    , gnColumn    = fCol
    , gnEndLine   = posLine (spanEnd (gfdSpan field))
    , gnEndColumn = posCol  (spanEnd (gfdSpan field))
    , gnExported  = isExported fieldName
    , gnMetadata  = Map.fromList
        [ ("kind",    MetaText "field")
        , ("mutable", MetaBool True)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = fieldNodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- ── Interface method walker ──────────────────────────────────────────────

-- | Walk an interface method signature, emitting FUNCTION node.
walkInterfaceMethod :: Text -> Text -> Text -> GoMethodSig -> Analyzer ()
walkInterfaceMethod file ifaceId ifaceName sig = do
  let methodName = gmsName sig
      methodId = semanticId file "FUNCTION" methodName (Just ifaceName) Nothing
      (mLine, mCol) = spanLC (gmsSpan sig)

  emitNode GraphNode
    { gnId        = methodId
    , gnType      = "FUNCTION"
    , gnName      = methodName
    , gnFile      = file
    , gnLine      = mLine
    , gnColumn    = mCol
    , gnEndLine   = posLine (spanEnd (gmsSpan sig))
    , gnEndColumn = posCol  (spanEnd (gmsSpan sig))
    , gnExported  = isExported methodName
    , gnMetadata  = Map.fromList
        [ ("kind",        MetaText "interface_method")
        , ("paramCount",  MetaInt (length (gmsParams sig)))
        , ("returnCount", MetaInt (length (gmsResults sig)))
        ]
    }

  emitEdge GraphEdge
    { geSource   = ifaceId
    , geTarget   = methodId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- ── Embedded interface walker ────────────────────────────────────────────

-- | Walk an embedded interface type, emitting EXTENDS edge.
walkEmbed :: Text -> Text -> GoType -> Analyzer ()
walkEmbed _file ifaceId embeddedType = do
  let embeddedName = goTypeToName embeddedType
  emitEdge GraphEdge
    { geSource   = ifaceId
    , geTarget   = embeddedName
    , geType     = "EXTENDS"
    , geMetadata = Map.singleton "embedded" (MetaBool True)
    }

-- ── Var/Const spec walkers ───────────────────────────────────────────────

-- | Walk a var spec, emitting VARIABLE nodes.
walkVarSpec :: Text -> Text -> Maybe Text -> Int -> Bool -> GoVarSpec -> Analyzer ()
walkVarSpec file scopeId parent _declLine _mutable spec = do
  let (specLine, _specCol) = spanLC (gvsSpan spec)
  mapM_ (\varName -> do
    let hash = contentHash [("line", T.pack (show specLine)), ("name", varName)]
        nodeId = semanticId file "VARIABLE" varName parent (Just hash)
        (vLine, vCol) = spanLC (gvsSpan spec)

    emitNode GraphNode
      { gnId        = nodeId
      , gnType      = "VARIABLE"
      , gnName      = varName
      , gnFile      = file
      , gnLine      = vLine
      , gnColumn    = vCol
      , gnEndLine   = posLine (spanEnd (gvsSpan spec))
      , gnEndColumn = posCol  (spanEnd (gvsSpan spec))
      , gnExported  = isExported varName
      , gnMetadata  = Map.fromList $
          [ ("kind",    MetaText "variable")
          , ("mutable", MetaBool True)
          ] ++
          [ ("type", MetaText (goTypeToName ty)) | Just ty <- [gvsType spec] ] ++
          channelMeta (gvsType spec)
      }

    emitEdge GraphEdge
      { geSource   = scopeId
      , geTarget   = nodeId
      , geType     = "CONTAINS"
      , geMetadata = Map.empty
      }
    ) (gvsNames spec)

  -- Walk value expressions
  mapM_ walkExpr (gvsValues spec)

-- | Walk a const spec, emitting CONSTANT nodes.
walkConstSpec :: Text -> Text -> Maybe Text -> Int -> GoVarSpec -> Analyzer ()
walkConstSpec file scopeId parent _declLine spec = do
  let (specLine, _specCol) = spanLC (gvsSpan spec)
  mapM_ (\constName -> do
    let hash = contentHash [("line", T.pack (show specLine)), ("name", constName)]
        nodeId = semanticId file "CONSTANT" constName parent (Just hash)
        (cLine, cCol) = spanLC (gvsSpan spec)

    emitNode GraphNode
      { gnId        = nodeId
      , gnType      = "CONSTANT"
      , gnName      = constName
      , gnFile      = file
      , gnLine      = cLine
      , gnColumn    = cCol
      , gnEndLine   = posLine (spanEnd (gvsSpan spec))
      , gnEndColumn = posCol  (spanEnd (gvsSpan spec))
      , gnExported  = isExported constName
      , gnMetadata  = Map.fromList
          [ ("kind",    MetaText "constant")
          , ("mutable", MetaBool False)
          ]
      }

    emitEdge GraphEdge
      { geSource   = scopeId
      , geTarget   = nodeId
      , geType     = "CONTAINS"
      , geMetadata = Map.empty
      }
    ) (gvsNames spec)

  -- Walk value expressions
  mapM_ walkExpr (gvsValues spec)

-- ── Parameter walker ─────────────────────────────────────────────────────

-- | Walk a function parameter, emitting VARIABLE node with kind=parameter.
walkParam :: Text -> Text -> GoParam -> Analyzer ()
walkParam file fnId param = do
  case gpName param of
    Nothing -> pure ()  -- unnamed parameter, skip
    Just name -> do
      let hash   = contentHash [("fn", fnId), ("name", name)]
          nodeId = semanticId file "VARIABLE" name Nothing (Just hash)
          (pLine, pCol) = spanLC (gpSpan param)

      emitNode GraphNode
        { gnId        = nodeId
        , gnType      = "VARIABLE"
        , gnName      = name
        , gnFile      = file
        , gnLine      = pLine
        , gnColumn    = pCol
        , gnEndLine   = posLine (spanEnd (gpSpan param))
        , gnEndColumn = posCol  (spanEnd (gpSpan param))
        , gnExported  = False  -- parameters are never exported
        , gnMetadata  = Map.fromList $
            [ ("kind",     MetaText "parameter")
            , ("variadic", MetaBool (gpVariadic param))
            , ("type",     MetaText (goTypeToName (gpParamType param)))
            ] ++
            [ ("context_param", MetaBool True) | isContextType (gpParamType param) ] ++
            [ ("possible_context_param", MetaBool True) | isPossibleContextType (gpParamType param) ] ++
            channelMeta (Just (gpParamType param))
        }

      emitEdge GraphEdge
        { geSource   = fnId
        , geTarget   = nodeId
        , geType     = "CONTAINS"
        , geMetadata = Map.empty
        }

-- ── Type name extraction ─────────────────────────────────────────────────

-- | Extract channel metadata from a type, if it's a channel.
channelMeta :: Maybe GoType -> [(Text, MetaValue)]
channelMeta (Just (ChanTypeNode dir valType _)) =
  [ ("channel",         MetaBool True)
  , ("chan_dir",         MetaText dir)
  , ("chan_value_type",  MetaText (goTypeToName valType))
  ]
channelMeta _ = []

-- | Check if a type is the builtin error interface.
-- In Go, @error@ is a predeclared identifier (lowercase, no package qualifier).
isErrorType :: GoType -> Bool
isErrorType (IdentType "error" _) = True
isErrorType _                     = False

-- | Check if a type is certainly context.Context (including *context.Context).
-- Only matches the canonical import: @import "context"@ → @context.Context@.
isContextType :: GoType -> Bool
isContextType (SelectorType (IdentNode "context" _) "Context" _) = True
isContextType (StarType inner _) = isContextType inner
isContextType _ = False

-- | Check if a type is possibly context.Context but can't be confirmed.
-- Catches aliased imports (@import ctx "context"@ → @ctx.Context@) and
-- dot imports (@import . "context"@ → bare @Context@).
-- Returns True only for uncertain cases; certain matches return False
-- (use 'isContextType' for those).
isPossibleContextType :: GoType -> Bool
isPossibleContextType t | isContextType t = False  -- already certain
isPossibleContextType (SelectorType _ "Context" _) = True   -- aliased.Context
isPossibleContextType (IdentType "Context" _)      = True   -- dot import Context
isPossibleContextType (StarType inner _)           = isPossibleContextType inner
isPossibleContextType _                            = False

-- | Extract a human-readable name from a GoType.
goTypeToName :: GoType -> Text
goTypeToName (IdentType n _)      = n
goTypeToName (SelectorType _ sel _) = sel
goTypeToName (StarType inner _)   = "*" <> goTypeToName inner
goTypeToName (ArrayTypeNode elt _ _) = "[]" <> goTypeToName elt
goTypeToName (MapTypeNode k v _)  = "map[" <> goTypeToName k <> "]" <> goTypeToName v
goTypeToName (ChanTypeNode _ v _) = "chan " <> goTypeToName v
goTypeToName (FuncTypeNode _ _ _) = "func"
goTypeToName (InterfaceTypeNode _ _) = "interface{}"
goTypeToName (StructTypeNode _ _) = "struct{}"
goTypeToName (EllipsisType elt _) = "..." <> goTypeToName elt
goTypeToName (TypeUnknown _)      = "<unknown>"
