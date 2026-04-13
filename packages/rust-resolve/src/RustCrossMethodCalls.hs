{-# LANGUAGE OverloadedStrings #-}
-- | Rust cross-file method call resolution.
--
-- Determines the type of method call receivers via three precise strategies:
--
-- 1. Variable\/Parameter has @typeAnnotation@ metadata (explicit syntax)
-- 2. Self field access: @self.field@ → field's type from containing struct
-- 3. Graph traversal: follow @ASSIGNED_FROM@ from receiver variable to its
--    initializer, then either match the constructor pattern or trace through
--    @CALLS@ to read the called function's @returnType@.
--
-- All graph traversal primitives come from "Grafema.GraphTraversal".
-- This module only contains Rust-specific resolution logic.
module RustCrossMethodCalls (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..), gnSemanticId)
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)
import qualified Grafema.GraphTraversal as G

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import System.IO (hPutStrLn, stderr)

-- ---------------------------------------------------------------------------
-- Rust-specific indexes
-- ---------------------------------------------------------------------------

-- | (typeName, methodName) → method node ID. Built from FUNCTION nodes
-- whose semantic ID contains @IMPL_BLOCK->TypeName@.
type ImplMethodIndex = Map (Text, Text) Text

-- | (file, varName) → VARIABLE/PARAMETER node.
type VarIndex = Map (Text, Text) GraphNode

-- | (structName, fieldName) → field type. Built from RECORD_FIELD nodes
-- with typeAnnotation metadata.
type FieldTypeIndex = Map (Text, Text) Text

-- ---------------------------------------------------------------------------
-- Index builders
-- ---------------------------------------------------------------------------

buildImplMethodIndex :: [GraphNode] -> ImplMethodIndex
buildImplMethodIndex nodes =
  Map.fromList
    [ ((typeName, gnName n), gnId n)
    | n <- nodes
    , gnType n == "FUNCTION"
    , not (T.null (gnName n))
    , Just typeName <- [G.extractByMarker (gnSemanticId n) "IMPL_BLOCK->"]
    ]

buildVarIndex :: [GraphNode] -> VarIndex
buildVarIndex nodes =
  Map.fromList
    [ ((gnFile n, gnName n), n)
    | n <- nodes
    , gnType n == "VARIABLE" || gnType n == "PARAMETER"
    , not (T.null (gnName n))
    ]

buildFieldTypeIndex :: [GraphNode] -> FieldTypeIndex
buildFieldTypeIndex nodes =
  Map.fromList
    [ ((structName, gnName n), ty)
    | n <- nodes
    , gnType n == "RECORD_FIELD"
    , not (T.null (gnName n))
    , Just ty <- [G.lookupMetaText "typeAnnotation" n]
    , Just structName <- [G.extractByMarker (gnSemanticId n) "STRUCT->"]
    ]

-- ---------------------------------------------------------------------------
-- Type tracing
-- ---------------------------------------------------------------------------

-- | Determine the type of a variable.
--
-- 1. If the variable has @typeAnnotation@ metadata → that's the type.
-- 2. Else, follow ASSIGNED_FROM to the init expression and infer from there.
traceVariableType :: G.NodeIndex -> G.Adjacency -> GraphNode -> Maybe Text
traceVariableType nodeIdx adj var =
  case G.lookupMetaText "typeAnnotation" var of
    Just ty -> Just ty
    Nothing -> do
      initNode <- G.followEdge "ASSIGNED_FROM" nodeIdx adj (gnId var)
      typeFromExpression nodeIdx adj initNode

-- | Determine the type of an expression node.
typeFromExpression :: G.NodeIndex -> G.Adjacency -> GraphNode -> Maybe Text
typeFromExpression nodeIdx adj expr
  | gnType expr == "CALL" =
      case constructorTypeFromCallName (gnName expr) of
        Just ty -> Just ty
        Nothing -> do
          -- Follow CALLS edge to FUNCTION, read its returnType
          fnNode <- G.followEdge "CALLS" nodeIdx adj (gnId expr)
          G.lookupMetaText "returnType" fnNode
  | otherwise = Nothing

-- | If a CALL name looks like @Type::method@, return @Type@.
-- Standard Rust convention: types are CamelCase, modules are snake_case.
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

-- ---------------------------------------------------------------------------
-- Resolution
-- ---------------------------------------------------------------------------

resolveAll :: [GraphNode] -> [GraphEdge] -> IO [PluginCommand]
resolveAll nodes edges = do
  let implIdx  = buildImplMethodIndex nodes
      varIdx   = buildVarIndex nodes
      fieldIdx = buildFieldTypeIndex nodes
      nodeIdx  = G.buildNodeIndex nodes
      adj      = G.buildAdjacency edges
      callNodes = filter isMethodCall nodes
      results = concatMap (resolveOne implIdx varIdx fieldIdx nodeIdx adj) callNodes
  hPutStrLn stderr $ "[rust-cross-methods] implIdx=" ++ show (Map.size implIdx)
    ++ " varIdx=" ++ show (Map.size varIdx)
    ++ " fieldIdx=" ++ show (Map.size fieldIdx)
    ++ " edges=" ++ show (length edges)
    ++ " calls=" ++ show (length callNodes)
    ++ " resolved=" ++ show (length results)
  return results

isMethodCall :: GraphNode -> Bool
isMethodCall n =
  gnType n == "CALL" && G.lookupMetaBool "method" n == Just True

resolveOne
  :: ImplMethodIndex -> VarIndex -> FieldTypeIndex
  -> G.NodeIndex -> G.Adjacency -> GraphNode -> [PluginCommand]
resolveOne implIdx varIdx fieldIdx nodeIdx adj callNode =
  let file     = gnFile callNode
      methName = gnName callNode
      mReceiver = lookupReceiver callNode
      containingStruct = G.extractByMarker (gnSemanticId callNode) "IMPL_BLOCK->"
      isSelfField = G.lookupMetaBool "selfField" callNode == Just True
  in case mReceiver of
    Nothing -> []
    Just receiver ->
      let mFieldType = if isSelfField
            then containingStruct >>= \structName ->
                   Map.lookup (structName, receiver) fieldIdx
            else Nothing
          mVarType = Map.lookup (file, receiver) varIdx
                       >>= traceVariableType nodeIdx adj
          typeName = case mFieldType of
            Just t  -> Just t
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

lookupReceiver :: GraphNode -> Maybe Text
lookupReceiver node = case G.lookupMetaText "receiver" node of
  Just r | r /= "<expr>" && not (T.null r) -> Just r
  _ -> Nothing

run :: IO ()
run = do
  nodes <- readNodesFromStdin
  results <- resolveAll nodes []
  writeCommandsToStdout results
