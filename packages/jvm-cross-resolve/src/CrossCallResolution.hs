{-# LANGUAGE OverloadedStrings #-}
-- | JVM cross-language call resolution plugin.
--
-- Resolves CALL nodes to their target FUNCTION/CLASS nodes across the
-- Java/Kotlin language boundary, producing (cross-language only):
--   - CALLS edges: call site -> target function
--   - INSTANTIATES edges: constructor call -> target class
--
-- Same-language call edges are already handled by java-resolve and kotlin-resolve.
--
-- == Resolution Strategies
--
-- 1. Constructor calls: extract class name, emit INSTANTIATES + CALLS
--    (only if target class is in a different language).
-- 2. Static-style calls: receiver matches a class name in the other language.
-- 3. Same-class calls are skipped (always same-language by definition).
-- 4. super()/this() delegation: resolve to constructor in superclass
--    (only if superclass is in a different language).
module CrossCallResolution (run, resolveAll) where

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

-- | Method index: (class name, method name) -> [(file path, function node ID)].
type MethodIndex = Map (Text, Text) [(Text, Text)]

-- | Constructor index: class name -> [(file path, constructor node ID)].
type ConstructorIndex = Map Text [(Text, Text)]

-- | Extends index: class name -> superclass name.
type ExtendsIndex = Map Text Text

-- | Check if a file path belongs to a Java source file.
isJavaFile :: Text -> Bool
isJavaFile f = T.isSuffixOf ".java" f

-- | Check if a file path belongs to a Kotlin source file.
isKotlinFile :: Text -> Bool
isKotlinFile f = T.isSuffixOf ".kt" f || T.isSuffixOf ".kts" f

-- | Check if two file paths belong to different JVM languages.
isCrossLanguage :: Text -> Text -> Bool
isCrossLanguage srcFile dstFile =
  (isJavaFile srcFile && isKotlinFile dstFile) ||
  (isKotlinFile srcFile && isJavaFile dstFile)

-- | Build unified class index from CLASS, INTERFACE, ENUM, RECORD, OBJECT nodes.
buildClassIndex :: [GraphNode] -> ClassIndex
buildClassIndex = foldl' go Map.empty
  where
    classTypes = Set.fromList ["CLASS", "INTERFACE", "ENUM", "RECORD", "OBJECT"]

    go acc n
      | Set.member (gnType n) classTypes =
          Map.insert (gnName n) (gnFile n, gnId n) acc
      | otherwise = acc

-- | Build method index: (enclosingClass, methodName) -> [(file, nodeId)].
buildMethodIndex :: [GraphNode] -> MethodIndex
buildMethodIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "FUNCTION" =
          case extractParentClass (gnId n) of
            Just className ->
              let key = (className, gnName n)
              in Map.insertWith (++) key [(gnFile n, gnId n)] acc
            Nothing -> acc
      | otherwise = acc

-- | Build constructor index: className -> [(file, constructor node ID)].
buildConstructorIndex :: [GraphNode] -> ConstructorIndex
buildConstructorIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "FUNCTION", isConstructor n =
          case extractParentClass (gnId n) of
            Just className ->
              Map.insertWith (++) className [(gnFile n, gnId n)] acc
            Nothing -> acc
      | otherwise = acc

    isConstructor node =
      case Map.lookup "kind" (gnMetadata node) of
        Just (MetaText "constructor")           -> True
        Just (MetaText "compact_constructor")   -> True
        Just (MetaText "primary_constructor")   -> True
        _                                       -> False

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

-- | Helper: create an EmitEdge command with cross_language metadata.
mkCrossEdge :: Text -> Text -> Text -> PluginCommand
mkCrossEdge src dst edgeType = EmitEdge GraphEdge
  { geSource   = src
  , geTarget   = dst
  , geType     = edgeType
  , geMetadata = Map.singleton "cross_language" (MetaBool True)
  }

-- | Resolve constructor calls across language boundaries.
--
-- Produces (cross-language only):
--   - INSTANTIATES edge: CALL -> CLASS node
--   - CALLS edge: CALL -> constructor FUNCTION (if found)
resolveConstructorCalls :: ClassIndex -> ConstructorIndex -> [GraphNode] -> [PluginCommand]
resolveConstructorCalls classIdx ctorIdx = concatMap go
  where
    go node
      | gnType node /= "CALL"         = []
      | not (isConstructorCall node)   = []
      | otherwise =
          let className = extractClassName (gnName node)
          in case Map.lookup className classIdx of
               Nothing -> []
               Just (classFile, classNodeId)
                 | not (isCrossLanguage (gnFile node) classFile) -> []
                 | otherwise ->
                     let instantiatesEdge = [mkCrossEdge (gnId node) classNodeId "INSTANTIATES"]
                         callsEdges = case Map.lookup className ctorIdx of
                           Nothing    -> []
                           Just ctors -> pickCrossConstructor (gnFile node) (gnId node) ctors
                     in instantiatesEdge ++ callsEdges

    extractClassName name
      | T.isPrefixOf "new " name = T.strip (T.drop 4 name)
      | otherwise                = name

    pickCrossConstructor srcFile callId ctors =
      case filter (\(f, _) -> isCrossLanguage srcFile f) ctors of
        ((_, ctorId):_) -> [mkCrossEdge callId ctorId "CALLS"]
        []              -> []

-- | Resolve static-style calls where the receiver matches a class name
-- in a different language.
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
                    Nothing      -> []
                    Just methods ->
                      case filter (\(f, _) -> isCrossLanguage (gnFile node) f) methods of
                        ((_, m):_) -> [mkCrossEdge (gnId node) m "CALLS"]
                        []         -> []
              | otherwise -> []

-- | Resolve super() calls that cross language boundaries.
--
-- super() -> constructor in superclass (only if superclass is in a different language).
resolveSuperCalls :: ConstructorIndex -> ExtendsIndex -> [GraphNode] -> [PluginCommand]
resolveSuperCalls ctorIdx extendsIdx = concatMap go
  where
    go node
      | gnType node /= "CALL"           = []
      | not (isSuperOrThisCall node)     = []
      | gnName node /= "super"          = []
      | otherwise =
          case extractParentClass (gnId node) of
            Nothing -> []
            Just parentClass ->
              case Map.lookup parentClass extendsIdx of
                Nothing -> []
                Just superClass ->
                  case Map.lookup superClass ctorIdx of
                    Nothing    -> []
                    Just ctors ->
                      case filter (\(f, _) -> isCrossLanguage (gnFile node) f) ctors of
                        ((_, c):_) -> [mkCrossEdge (gnId node) c "CALLS"]
                        []         -> []

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

  let constructorEdges = resolveConstructorCalls classIdx ctorIdx nodes
      staticEdges      = resolveStaticCalls classIdx methodIdx nodes
      superEdges       = resolveSuperCalls ctorIdx extendsIdx nodes

      allEdges = constructorEdges ++ staticEdges ++ superEdges

      callsCount = length [ () | EmitEdge e <- allEdges, geType e == "CALLS" ]
      instantiatesCount = length [ () | EmitEdge e <- allEdges, geType e == "INSTANTIATES" ]

  hPutStrLn stderr $
    "jvm-cross-calls: " ++ show (length allEdges) ++ " call edges"
    ++ " (CALLS=" ++ show callsCount
    ++ ", INSTANTIATES=" ++ show instantiatesCount ++ ")"

  return allEdges

-- | CLI entry: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands
