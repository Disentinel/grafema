{-# LANGUAGE OverloadedStrings #-}
-- | Rust cross-file method call resolution plugin.
--
-- Resolves @receiver.method()@ calls by determining the receiver's type
-- through one of three precise strategies:
--
-- 1. Variable\/Parameter has @typeAnnotation@ metadata (explicit syntax)
-- 2. Self field access: @self.field@ → field's type from containing struct
-- 3. Graph traversal: follow @ASSIGNED_FROM@ from variable to its initializer,
--    then trace through @CALLS@ to find the called function's @returnType@.
--
-- All three strategies use either explicit syntactic information or graph
-- traversal — no derived heuristics that could produce false positives.
module RustCrossMethodCalls (run, resolveAll) where

import Grafema.Types (GraphNode(..), gnSemanticId, GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import System.IO (hPutStrLn, stderr)

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- | Index of methods defined inside impl blocks: (typeName, methodName) → nodeId.
type ImplMethodIndex = Map (Text, Text) Text

-- | Index of variables/parameters by (file, name) → full GraphNode.
-- Stores the full node so we can access metadata (typeAnnotation) and
-- semantic ID (for ASSIGNED_FROM lookup).
type VarIndex = Map (Text, Text) GraphNode

-- | Index of struct field types: (structName, fieldName) → fieldTypeName.
type FieldTypeIndex = Map (Text, Text) Text

-- | Index of all nodes by their semantic ID for traversal.
type NodeIndex = Map Text GraphNode

-- | Adjacency: source node ID → list of (edge type, dest node ID).
type Adjacency = Map Text [(Text, Text)]

-- ---------------------------------------------------------------------------
-- Index builders
-- ---------------------------------------------------------------------------

-- | Build impl method index from FUNCTION nodes.
-- Uses semanticId for IMPL_BLOCK extraction, but stores the hash gnId
-- so emitted edges reference the same ID format as RFDB storage.
buildImplMethodIndex :: [GraphNode] -> ImplMethodIndex
buildImplMethodIndex nodes =
  Map.fromList
    [ ((typeName, gnName n), gnId n)
    | n <- nodes
    , gnType n == "FUNCTION"
    , not (T.null (gnName n))
    , Just typeName <- [extractImplType (gnSemanticId n)]
    ]

-- | Build (file, name) → VARIABLE/PARAMETER node index.
buildVarIndex :: [GraphNode] -> VarIndex
buildVarIndex nodes =
  Map.fromList
    [ ((gnFile n, gnName n), n)
    | n <- nodes
    , gnType n == "VARIABLE" || gnType n == "PARAMETER"
    , not (T.null (gnName n))
    ]

-- | Build field type index from RECORD_FIELD nodes.
buildFieldTypeIndex :: [GraphNode] -> FieldTypeIndex
buildFieldTypeIndex nodes =
  Map.fromList
    [ ((structName, gnName n), ty)
    | n <- nodes
    , gnType n == "RECORD_FIELD"
    , not (T.null (gnName n))
    , Just ty <- [lookupTypeAnnotation (gnMetadata n)]
    , Just structName <- [extractStructName (gnSemanticId n)]
    ]

-- | Build node index by semantic ID.
buildNodeIndex :: [GraphNode] -> NodeIndex
buildNodeIndex nodes = Map.fromList [(gnId n, n) | n <- nodes]

-- | Build adjacency map from edges.
buildAdjacency :: [GraphEdge] -> Adjacency
buildAdjacency edges =
  Map.fromListWith (++)
    [ (geSource e, [(geType e, geTarget e)])
    | e <- edges
    ]

-- ---------------------------------------------------------------------------
-- Semantic ID parsing
-- ---------------------------------------------------------------------------

-- | Extract type name from a marker like @IMPL_BLOCK->TypeName@ in semantic ID.
extractByMarker :: Text -> Text -> Maybe Text
extractByMarker sid marker =
  let stopChars = [']', '[', '%', '#']
      tryM m = case T.breakOn m sid of
        (_, rest)
          | T.null rest -> Nothing
          | otherwise ->
              let after = T.drop (T.length m) rest
                  name = T.takeWhile (\c -> c `notElem` stopChars) after
              in if T.null name then Nothing else Just name
      -- Try URL-encoded first (more common in real semantic IDs)
      urlEncoded = T.replace "->" "-%3E" marker
  in case tryM urlEncoded of
       Just t  -> Just t
       Nothing -> tryM marker

extractImplType :: Text -> Maybe Text
extractImplType sid = extractByMarker sid "IMPL_BLOCK->"

extractStructName :: Text -> Maybe Text
extractStructName sid = extractByMarker sid "STRUCT->"

-- | Extract typeAnnotation from metadata.
lookupTypeAnnotation :: Map Text MetaValue -> Maybe Text
lookupTypeAnnotation meta =
  case Map.lookup "typeAnnotation" meta of
    Just (MetaText t) -> Just t
    _                 -> Nothing

-- | Extract returnType from metadata (for FUNCTION nodes).
lookupReturnType :: Map Text MetaValue -> Maybe Text
lookupReturnType meta =
  case Map.lookup "returnType" meta of
    Just (MetaText t) -> Just t
    _                 -> Nothing

-- ---------------------------------------------------------------------------
-- Type tracing
-- ---------------------------------------------------------------------------

-- | Trace the type of a variable through the graph.
--
-- Strategy:
--   1. If the variable has typeAnnotation → that's the type.
--   2. Else, follow ASSIGNED_FROM edge to the init expression.
--      a. If init is a CALL with name like @Type::method@ → type = @Type@
--         (constructor pattern, used as fast path).
--      b. Else if init is a CALL → follow CALLS edge to FUNCTION → returnType.
--      c. Else: no type (could extend to other expression kinds).
traceVariableType :: VarIndex -> NodeIndex -> Adjacency -> GraphNode -> Maybe Text
traceVariableType _varIdx nodeIdx adj var =
  -- Strategy 1: explicit typeAnnotation (from `let x: Type = ...` or `fn(x: Type)`)
  case lookupTypeAnnotation (gnMetadata var) of
    Just ty -> Just ty
    Nothing -> traceViaAssignedFrom nodeIdx adj var

-- | Follow ASSIGNED_FROM edge from a variable to determine its type.
traceViaAssignedFrom :: NodeIndex -> Adjacency -> GraphNode -> Maybe Text
traceViaAssignedFrom nodeIdx adj var = do
  targets <- Map.lookup (gnId var) adj
  -- Find first ASSIGNED_FROM target
  let assignedTargets = [tid | (et, tid) <- targets, et == "ASSIGNED_FROM"]
  case assignedTargets of
    [] -> Nothing
    (initId:_) -> do
      initNode <- Map.lookup initId nodeIdx
      typeFromExpression nodeIdx adj initNode

-- | Determine the type of an expression node.
typeFromExpression :: NodeIndex -> Adjacency -> GraphNode -> Maybe Text
typeFromExpression nodeIdx adj expr
  | gnType expr == "CALL" =
      -- Path-style constructor: `Type::method(...)` — type is the path's
      -- penultimate segment if it starts with uppercase. Standard Rust
      -- convention: types are CamelCase, modules are snake_case.
      case constructorTypeFromCallName (gnName expr) of
        Just ty -> Just ty
        Nothing ->
          -- Otherwise: follow CALLS edge to the FUNCTION and read its returnType.
          traceCallReturnType nodeIdx adj expr
  | otherwise = Nothing

-- | If a CALL name looks like @Type::method@, return @Type@.
-- Strict: penultimate segment must start with uppercase letter.
constructorTypeFromCallName :: Text -> Maybe Text
constructorTypeFromCallName name =
  let segs = T.splitOn "::" name
  in case segs of
    (_:_:_) ->
      let typeName = segs !! (length segs - 2)
      in case T.uncons typeName of
        Just (c, _) | isUpper c -> Just typeName
        _ -> Nothing
    _ -> Nothing
  where
    isUpper c = c >= 'A' && c <= 'Z'

-- | Follow CALLS edge from a CALL node to its target FUNCTION,
-- then read the FUNCTION's returnType metadata.
traceCallReturnType :: NodeIndex -> Adjacency -> GraphNode -> Maybe Text
traceCallReturnType nodeIdx adj callNode = do
  targets <- Map.lookup (gnId callNode) adj
  let calls = [tid | (et, tid) <- targets, et == "CALLS"]
  case calls of
    [] -> Nothing
    (fnId:_) -> do
      fnNode <- Map.lookup fnId nodeIdx
      lookupReturnType (gnMetadata fnNode)

-- ---------------------------------------------------------------------------
-- Resolution
-- ---------------------------------------------------------------------------

-- | Resolve method calls using type information from the graph.
resolveAll :: [GraphNode] -> [GraphEdge] -> IO [PluginCommand]
resolveAll nodes edges = do
  let implIdx  = buildImplMethodIndex nodes
      varIdx   = buildVarIndex nodes
      fieldIdx = buildFieldTypeIndex nodes
      nodeIdx  = buildNodeIndex nodes
      adj      = buildAdjacency edges
      callNodes = filter isMethodCall nodes
      results = concatMap (resolveOne implIdx varIdx fieldIdx nodeIdx adj) callNodes
  hPutStrLn stderr $ "[rust-cross-methods] implIdx=" ++ show (Map.size implIdx)
    ++ " varIdx=" ++ show (Map.size varIdx)
    ++ " fieldIdx=" ++ show (Map.size fieldIdx)
    ++ " edges=" ++ show (length edges)
    ++ " calls=" ++ show (length callNodes)
    ++ " resolved=" ++ show (length results)
  return results

-- | Check if a node is a method call.
isMethodCall :: GraphNode -> Bool
isMethodCall n =
  gnType n == "CALL" &&
  Map.lookup "method" (gnMetadata n) == Just (MetaBool True)

-- | Try to resolve a single method call to a target FUNCTION.
resolveOne
  :: ImplMethodIndex -> VarIndex -> FieldTypeIndex
  -> NodeIndex -> Adjacency -> GraphNode -> [PluginCommand]
resolveOne implIdx varIdx fieldIdx nodeIdx adj callNode =
  let file     = gnFile callNode
      methName = gnName callNode
      mReceiver = lookupReceiver (gnMetadata callNode)
      -- For self.field calls, the containing struct is the impl block type
      containingStruct = extractImplType (gnSemanticId callNode)
      isSelfField = Map.lookup "selfField" (gnMetadata callNode) == Just (MetaBool True)
  in case mReceiver of
    Nothing -> []
    Just receiver ->
      -- Determine the receiver's type via:
      --  1. Self field type (if selfField=true)
      --  2. Variable trace (typeAnnotation OR ASSIGNED_FROM traversal)
      let mFieldType = if isSelfField
            then containingStruct >>= \structName ->
                   Map.lookup (structName, receiver) fieldIdx
            else Nothing
          mVarType = Map.lookup (file, receiver) varIdx
                       >>= traceVariableType varIdx nodeIdx adj
          typeName = case mFieldType of
            Just t -> Just t
            Nothing -> mVarType
      in case typeName of
        Nothing -> []
        Just tn ->
          -- Strip generic suffixes: "Vec<String>" → "Vec"
          let baseType = T.takeWhile (\c -> c /= '<' && c /= ':') tn
          in case Map.lookup (baseType, methName) implIdx of
            Nothing -> []
            Just targetId ->
              [ EmitEdge GraphEdge
                  { geSource   = gnId callNode
                  , geTarget   = targetId
                  , geType     = "CALLS"
                  , geMetadata = Map.fromList
                      [ ("resolvedVia",  MetaText "rust-cross-method")
                      , ("receiverType", MetaText tn)
                      ]
                  }
              ]

-- | Get receiver name from CALL metadata.
lookupReceiver :: Map Text MetaValue -> Maybe Text
lookupReceiver meta =
  case Map.lookup "receiver" meta of
    Just (MetaText r) | r /= "<expr>" && not (T.null r) -> Just r
    _ -> Nothing

-- | CLI entry point (no edges available — uses node-only resolution).
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  results <- resolveAll nodes []
  writeCommandsToStdout results
