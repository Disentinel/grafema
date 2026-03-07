{-# LANGUAGE OverloadedStrings #-}
-- | Kotlin call resolution plugin.
--
-- Resolves CALL nodes to their target FUNCTION/CLASS nodes, producing:
--   - CALLS edges: call site -> target function
--   - INSTANTIATES edges: constructor call -> target class
--
-- == Resolution Strategies
--
-- 1. Constructor calls ("ClassName()"): extract class name from gnName,
--    emit INSTANTIATES edge to CLASS node, emit CALLS edge to constructor FUNCTION.
-- 2. Same-class method calls (no receiver or receiver="this"):
--    find FUNCTION with matching name in the same class (extracted from semantic ID).
-- 3. Static-style calls (receiver matches a class name — companion object methods):
--    find method in that class.
-- 4. super/this delegation:
--    find constructor in same class (this) or superclass (super).
-- 5. Extension function calls: if CALL has extension=true and receiverType matches
--    a known class, find extension FUNCTION with matching name and receiverType.
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

-- | Extension function index: (receiverType, functionName) -> [function node IDs].
type ExtensionIndex = Map (Text, Text) [Text]

-- | Build class index from CLASS, INTERFACE, ENUM, OBJECT nodes.
buildClassIndex :: [GraphNode] -> ClassIndex
buildClassIndex = foldl' go Map.empty
  where
    classTypes = Set.fromList ["CLASS", "INTERFACE", "ENUM", "OBJECT"]

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
-- Constructors are FUNCTION nodes with kind="constructor" or kind="primary_constructor".
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
        Just (MetaText "primary_constructor") -> True
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

-- | Build extension function index: (receiverType, functionName) -> [nodeId].
-- Extension functions are FUNCTION nodes with extension=true and receiverType metadata.
buildExtensionIndex :: [GraphNode] -> ExtensionIndex
buildExtensionIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "FUNCTION"
      , getMetaBool "extension" n == Just True =
          case getMetaText "receiverType" n of
            Just recvType ->
              let key = (recvType, gnName n)
              in Map.insertWith (++) key [gnId n] acc
            Nothing -> acc
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

-- | Helper: create an EmitEdge command with empty metadata.
mkEdge :: Text -> Text -> Text -> PluginCommand
mkEdge src dst edgeType = EmitEdge GraphEdge
  { geSource   = src
  , geTarget   = dst
  , geType     = edgeType
  , geMetadata = Map.empty
  }

-- | Resolve constructor calls ("ClassName(...)").
--
-- In Kotlin, constructor calls look like regular function calls: "Foo()"
-- rather than "new Foo()". The parser marks them with kind="constructor_call".
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

    -- Extract class name: "new ClassName" -> "ClassName" (for compatibility)
    -- or just the name itself for Kotlin-style calls
    extractClassName name
      | T.isPrefixOf "new " name = T.strip (T.drop 4 name)
      | otherwise                = name

    -- Pick the best matching constructor.
    pickConstructor node_ [ctorId]   = [mkEdge (gnId node_) ctorId "CALLS"]
    pickConstructor node_ (c:_)     = [mkEdge (gnId node_) c "CALLS"]
    pickConstructor _     []        = []

-- | Resolve same-class method calls (no receiver, or receiver="this").
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

-- | Resolve static-style calls where the receiver matches a class name.
-- In Kotlin, these are typically companion object method calls.
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

-- | Resolve extension function calls.
--
-- If a CALL node has extension=true AND receiverType metadata matching a known class,
-- AND the function name matches a known extension function defined on that type,
-- emit a CALLS edge.
resolveExtensionCalls :: ExtensionIndex -> [GraphNode] -> [PluginCommand]
resolveExtensionCalls extIdx = concatMap go
  where
    go node
      | gnType node /= "CALL" = []
      | getMetaBool "extension" node /= Just True = []
      | otherwise =
          case getMetaText "receiverType" node of
            Nothing -> []
            Just recvType ->
              case Map.lookup (recvType, gnName node) extIdx of
                Nothing    -> []
                Just (f:_) -> [mkEdge (gnId node) f "CALLS"]
                Just []    -> []

-- | Check if a node is a constructor call.
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
      extIdx     = buildExtensionIndex nodes

  let constructorEdges  = resolveConstructorCalls classIdx ctorIdx nodes
      sameClassEdges    = resolveSameClassCalls methodIdx nodes
      staticEdges       = resolveStaticCalls classIdx methodIdx nodes
      superThisEdges    = resolveSuperThisCalls ctorIdx extendsIdx nodes
      extensionEdges    = resolveExtensionCalls extIdx nodes

      allEdges = constructorEdges ++ sameClassEdges ++ staticEdges
              ++ superThisEdges ++ extensionEdges

      callsCount = length [ () | EmitEdge e <- allEdges, geType e == "CALLS" ]
      instantiatesCount = length [ () | EmitEdge e <- allEdges, geType e == "INSTANTIATES" ]

  hPutStrLn stderr $
    "kotlin-call-resolve: " ++ show (length allEdges) ++ " call edges"
    ++ " (CALLS=" ++ show callsCount
    ++ ", INSTANTIATES=" ++ show instantiatesCount ++ ")"

  return allEdges

-- | CLI entry: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands
