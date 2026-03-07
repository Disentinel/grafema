{-# LANGUAGE OverloadedStrings #-}
-- | Java call resolution plugin.
--
-- Resolves CALL nodes to their target FUNCTION/CLASS nodes, producing:
--   - CALLS edges: call site -> target function
--   - INSTANTIATES edges: constructor call -> target class
--
-- == Resolution Strategies
--
-- 1. Constructor calls ("new ClassName()"): extract class name from gnName,
--    emit INSTANTIATES edge to CLASS node, emit CALLS edge to constructor FUNCTION.
-- 2. Same-class method calls (no receiver or receiver="this"):
--    find FUNCTION with matching name in the same class (extracted from semantic ID).
-- 3. Static-style calls (receiver matches a class name):
--    find method in that class.
-- 4. super()/this() delegating constructor calls:
--    find constructor in same class (this) or superclass (super).
module CallResolution (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.List (foldl')
import Data.Text (Text)
import qualified Data.Text as T
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import System.IO (hPutStrLn, stderr)

-- | Class index: simple class name -> (file path, node ID).
type ClassIndex = Map Text (Text, Text)

-- | Method index: (class name, method name) -> [function node IDs] (list for overloads).
type MethodIndex = Map (Text, Text) [Text]

-- | Constructor index: class name -> [constructor node IDs].
type ConstructorIndex = Map Text [Text]

-- | Extends index: class name -> superclass name (from "extends" metadata).
type ExtendsIndex = Map Text Text

-- | Build class index from CLASS, INTERFACE, ENUM, RECORD nodes.
buildClassIndex :: [GraphNode] -> ClassIndex
buildClassIndex = foldl' go Map.empty
  where
    classTypes = Set.fromList ["CLASS", "INTERFACE", "ENUM", "RECORD"]

    go acc n
      | Set.member (gnType n) classTypes =
          Map.insert (gnName n) (gnFile n, gnId n) acc
      | otherwise = acc

-- | Build method index: (enclosingClass, methodName) -> [nodeId].
-- Groups by class and method name to handle overloads.
buildMethodIndex :: [GraphNode] -> MethodIndex
buildMethodIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "FUNCTION" =
          case extractParentClass (gnId n) of
            Just className ->
              let key = (className, gnName n)
              in Map.insertWith (++) key [gnId n] acc
            Nothing -> acc
      | otherwise = acc

-- | Build constructor index: className -> [constructor node IDs].
-- Constructors are FUNCTION nodes with kind="constructor" or kind="compact_constructor".
buildConstructorIndex :: [GraphNode] -> ConstructorIndex
buildConstructorIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "FUNCTION", isConstructor n =
          case extractParentClass (gnId n) of
            Just className ->
              Map.insertWith (++) className [gnId n] acc
            Nothing -> acc
      | otherwise = acc

    isConstructor node =
      case Map.lookup "kind" (gnMetadata node) of
        Just (MetaText "constructor")         -> True
        Just (MetaText "compact_constructor") -> True
        _                                     -> False

-- | Build extends index: className -> superclass name.
buildExtendsIndex :: [GraphNode] -> ExtendsIndex
buildExtendsIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "CLASS" =
          case getMetaText "extends" n of
            Just superName -> Map.insert (gnName n) superName acc
            Nothing        -> acc
      | otherwise = acc

-- | Extract parent class name from a semantic ID.
-- "file->CALL->name[in:ClassName,h:xxx]" -> Just "ClassName"
extractParentClass :: Text -> Maybe Text
extractParentClass sid =
  case T.breakOn "[in:" sid of
    (_, rest)
      | T.null rest -> Nothing
      | otherwise ->
          let afterPrefix = T.drop 4 rest
              (beforeClose, _) = T.breakOn "]" afterPrefix
              (cleanParent, _) = T.breakOn ",h:" beforeClose
          in if T.null cleanParent then Nothing else Just cleanParent

-- | Get a text metadata value from a node.
getMetaText :: Text -> GraphNode -> Maybe Text
getMetaText key node =
  case Map.lookup key (gnMetadata node) of
    Just (MetaText t) | not (T.null t) -> Just t
    _                                  -> Nothing

-- | Get a boolean metadata value from a node.
getMetaBool :: Text -> GraphNode -> Maybe Bool
getMetaBool key node =
  case Map.lookup key (gnMetadata node) of
    Just (MetaBool b) -> Just b
    _                 -> Nothing

-- | Get an integer metadata value from a node.
_getMetaInt :: Text -> GraphNode -> Maybe Int
_getMetaInt key node =
  case Map.lookup key (gnMetadata node) of
    Just (MetaInt i) -> Just i
    _                -> Nothing

-- | Helper: create an EmitEdge command with empty metadata.
mkEdge :: Text -> Text -> Text -> PluginCommand
mkEdge src dst edgeType = EmitEdge GraphEdge
  { geSource   = src
  , geTarget   = dst
  , geType     = edgeType
  , geMetadata = Map.empty
  }

-- | Resolve constructor calls ("new ClassName(...)").
--
-- Produces:
--   - INSTANTIATES edge: CALL -> CLASS node
--   - CALLS edge: CALL -> constructor FUNCTION (if found)
resolveConstructorCalls :: ClassIndex -> ConstructorIndex -> [GraphNode] -> [PluginCommand]
resolveConstructorCalls classIdx ctorIdx = concatMap go
  where
    go node
      | gnType node /= "CALL"    = []
      | not (isConstructorCall node) = []
      | otherwise =
          let className = extractClassName (gnName node)
          in case Map.lookup className classIdx of
               Nothing -> []
               Just (_file, classNodeId) ->
                 let instantiatesEdge = [mkEdge (gnId node) classNodeId "INSTANTIATES"]
                     callsEdges = case Map.lookup className ctorIdx of
                       Nothing    -> []
                       Just ctors -> pickConstructor node ctors
                 in instantiatesEdge ++ callsEdges

    isConstructorCall n =
      T.isPrefixOf "new " (gnName n)
      || getMetaText "kind" n == Just "constructor_call"

    -- Extract class name: "new ClassName" -> "ClassName"
    extractClassName name
      | T.isPrefixOf "new " name = T.strip (T.drop 4 name)
      | otherwise                = name

    -- Pick the best matching constructor (by arg count if available).
    -- If only one constructor exists, use it. Otherwise, try matching argCount.
    pickConstructor node_ [ctorId]   = [mkEdge (gnId node_) ctorId "CALLS"]
    pickConstructor node_ (c:_)     = [mkEdge (gnId node_) c "CALLS"]
    pickConstructor _     []        = []

-- | Resolve same-class method calls (no receiver, or receiver="this").
--
-- Extracts the parent class from the CALL's semantic ID and looks up the
-- method in that class.
resolveSameClassCalls :: MethodIndex -> [GraphNode] -> [PluginCommand]
resolveSameClassCalls methodIdx = concatMap go
  where
    go node
      | gnType node /= "CALL"     = []
      | isConstructorCall node     = []
      | isSuperOrThisCall node     = []
      | not (isSameClassCall node) = []
      | otherwise =
          case extractParentClass (gnId node) of
            Nothing -> []
            Just parentClass ->
              case Map.lookup (parentClass, gnName node) methodIdx of
                Nothing   -> []
                Just (m:_) -> [mkEdge (gnId node) m "CALLS"]
                Just []    -> []

    isSameClassCall n =
      let receiver = getMetaText "receiver" n
      in case receiver of
           Nothing     -> True
           Just ""     -> True
           Just "this" -> True
           _           -> False

-- | Resolve static-style calls where the receiver matches a class/interface/enum name.
resolveStaticCalls :: ClassIndex -> MethodIndex -> [GraphNode] -> [PluginCommand]
resolveStaticCalls classIdx methodIdx = concatMap go
  where
    go node
      | gnType node /= "CALL"     = []
      | isConstructorCall node     = []
      | isSuperOrThisCall node     = []
      | otherwise =
          case getMetaText "receiver" node of
            Nothing     -> []
            Just ""     -> []
            Just "this" -> []
            Just receiver
              | Map.member receiver classIdx ->
                  case Map.lookup (receiver, gnName node) methodIdx of
                    Nothing    -> []
                    Just (m:_) -> [mkEdge (gnId node) m "CALLS"]
                    Just []    -> []
              | otherwise -> []

-- | Resolve super() and this() delegating constructor calls.
--
-- - this(): find constructor in the same class
-- - super(): find constructor in the superclass (via "extends" metadata)
resolveSuperThisCalls :: ConstructorIndex -> ExtendsIndex -> [GraphNode] -> [PluginCommand]
resolveSuperThisCalls ctorIdx extendsIdx = concatMap go
  where
    go node
      | gnType node /= "CALL"     = []
      | not (isSuperOrThisCall node) = []
      | otherwise =
          case extractParentClass (gnId node) of
            Nothing -> []
            Just parentClass
              | gnName node == "this" || getMetaBool "isThis" node == Just True ->
                  -- this() -> constructor in same class
                  case Map.lookup parentClass ctorIdx of
                    Nothing    -> []
                    Just (c:_) -> [mkEdge (gnId node) c "CALLS"]
                    Just []    -> []
              | gnName node == "super" ->
                  -- super() -> constructor in superclass
                  case Map.lookup parentClass extendsIdx of
                    Nothing -> []
                    Just superClass ->
                      case Map.lookup superClass ctorIdx of
                        Nothing    -> []
                        Just (c:_) -> [mkEdge (gnId node) c "CALLS"]
                        Just []    -> []
              | otherwise -> []

-- | Check if a node is a constructor call (new expression).
isConstructorCall :: GraphNode -> Bool
isConstructorCall n =
  T.isPrefixOf "new " (gnName n)
  || getMetaText "kind" n == Just "constructor_call"

-- | Check if a node is a super() or this() delegating call.
isSuperOrThisCall :: GraphNode -> Bool
isSuperOrThisCall n =
  gnName n == "super"
  || gnName n == "this"
  || getMetaBool "isThis" n == Just True

-- | Core resolution logic.
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let classIdx   = buildClassIndex nodes
      methodIdx  = buildMethodIndex nodes
      ctorIdx    = buildConstructorIndex nodes
      extendsIdx = buildExtendsIndex nodes

  let constructorEdges  = resolveConstructorCalls classIdx ctorIdx nodes
      sameClassEdges    = resolveSameClassCalls methodIdx nodes
      staticEdges       = resolveStaticCalls classIdx methodIdx nodes
      superThisEdges    = resolveSuperThisCalls ctorIdx extendsIdx nodes

      allEdges = constructorEdges ++ sameClassEdges ++ staticEdges ++ superThisEdges

      callsCount = length [ () | EmitEdge e <- allEdges, geType e == "CALLS" ]
      instantiatesCount = length [ () | EmitEdge e <- allEdges, geType e == "INSTANTIATES" ]

  hPutStrLn stderr $
    "java-call-resolve: " ++ show (length allEdges) ++ " call edges"
    ++ " (CALLS=" ++ show callsCount
    ++ ", INSTANTIATES=" ++ show instantiatesCount ++ ")"

  return allEdges

-- | CLI entry: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands
