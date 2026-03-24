{-# LANGUAGE OverloadedStrings #-}
-- | Python call resolution plugin.
--
-- Resolves CALL nodes to their target FUNCTION nodes, producing CALLS edges.
--
-- == Resolution Strategies
--
-- 1. Same-file function calls (no receiver):
--    find FUNCTION with matching name in same file.
-- 2. Method calls with type info (virtual dispatch):
--    look up receiver variable's type via TYPE_OF edges, expand through
--    class hierarchy (EXTENDS), resolve method in base + all subclasses.
-- 3. Method calls without type info (fallback):
--    find FUNCTION with matching name in any class.
-- 4. Cross-file function calls:
--    if not found in same file, search all files for a function with matching name.
module CallResolution (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.List (foldl', nub)
import Data.Text (Text)
import qualified Data.Text as T
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import Data.Set (Set)
import qualified Data.Set as Set
import System.IO (hPutStrLn, stderr)

-- | Function index: (file, name) -> [node IDs]
type FunctionIndex = Map (Text, Text) [Text]

-- | Method index: (class_name, method_name) -> [node IDs]
type MethodIndex = Map (Text, Text) [Text]

-- | Type index: (file, variable_name) -> class_name
-- Built from TYPE_OF edges: VARIABLE -> CLASS
type TypeIndex = Map (Text, Text) Text

-- | Class hierarchy: parent_class_name -> [child_class_names]
type HierarchyIndex = Map Text [Text]

-- | Class name -> CLASS node ID (for looking up class info)
type ClassIndex = Map Text Text

-- | Build function index from FUNCTION nodes.
buildFunctionIndex :: [GraphNode] -> FunctionIndex
buildFunctionIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "FUNCTION" =
          let key = (gnFile n, gnName n)
          in Map.insertWith (++) key [gnId n] acc
      | otherwise = acc

-- | Build method index: (enclosingClass, methodName) -> [nodeId].
-- Methods are FUNCTION nodes with kind=method/classmethod/staticmethod.
buildMethodIndex :: [GraphNode] -> MethodIndex
buildMethodIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "FUNCTION"
      , Just kind <- getMetaText "kind" n
      , kind `elem` ["method", "classmethod", "staticmethod"] =
          -- Extract class name from semantic ID: file->FUNCTION->name[in:ClassName]
          case extractClassName (gnId n) of
            Just cls -> Map.insertWith (++) (cls, gnName n) [gnId n] acc
            Nothing  -> acc
      | otherwise = acc

-- | Build type index from VARIABLE nodes' annotation metadata.
-- Returns: (file, varName) -> className
-- We look at VARIABLE nodes with "annotation" metadata and match
-- against known CLASS names. Also handles "type[ClassName]" annotations.
buildTypeIndex :: [GraphNode] -> TypeIndex
buildTypeIndex nodes =
  let classNames = Set.fromList [gnName n | n <- nodes, gnType n == "CLASS"]
      -- Extract type annotations from VARIABLE nodes
      vars = [(gnFile n, gnName n, parseAnnotation ann)
             | n <- nodes
             , gnType n == "VARIABLE"
             , Just ann <- [getMetaText "annotation" n]
             ]
      -- Also try "type_annotation" key as fallback
      vars2 = [(gnFile n, gnName n, parseAnnotation ann)
              | n <- nodes
              , gnType n == "VARIABLE"
              , Nothing <- [getMetaText "annotation" n]
              , Just ann <- [getMetaText "type_annotation" n]
              ]
  in Map.fromList [((f, vn), ann) | (f, vn, ann) <- vars ++ vars2, ann `Set.member` classNames]

-- | Parse type annotation to extract the class name.
-- "StageBase" -> "StageBase"
-- "type[StageBase]" -> "StageBase"
-- "list[str]" -> "list" (probably won't match any class)
-- "dict[str, type[StageBase]]" -> tries to extract inner type
parseAnnotation :: Text -> Text
parseAnnotation ann
  | "type[" `T.isPrefixOf` ann =
      -- Extract inner: "type[StageBase]" -> "StageBase"
      T.dropEnd 1 (T.drop 5 ann)
  | otherwise = ann

-- | Build class hierarchy index from CLASS nodes' "bases" metadata.
-- Parent -> [children]. The "bases" field contains comma-separated
-- base class names (e.g., "StageBase" or "BaseModel,Serializable").
buildHierarchyIndex :: [GraphNode] -> HierarchyIndex
buildHierarchyIndex nodes =
  let classes = [n | n <- nodes, gnType n == "CLASS"]
      -- Parse bases metadata: "StageBase" or "Base1,Base2"
      pairs = [ (T.strip base, gnName n)
              | n <- classes
              , Just basesStr <- [getMetaText "bases" n]
              , base <- T.splitOn "," basesStr
              , not (T.null (T.strip base))
              ]
  in foldl' (\acc (parent, child) ->
        Map.insertWith (++) parent [child] acc
     ) Map.empty pairs

-- | Expand a class name to itself + all subclasses (transitive).
expandHierarchy :: HierarchyIndex -> Text -> [Text]
expandHierarchy hier root = go Set.empty [root]
  where
    go visited [] = Set.toList visited
    go visited (cls:rest)
      | cls `Set.member` visited = go visited rest
      | otherwise =
          let children = Map.findWithDefault [] cls hier
          in go (Set.insert cls visited) (children ++ rest)

-- | Extract class name from a semantic ID.
-- Handles both legacy arrow format and URI format:
--   Legacy: "file->FUNCTION->name[in:ClassName,h:xxx]"
--   URI:    "grafema://host/file#FUNCTION-%3Ename%5Bin:ClassName,h:xxx%5D"
extractClassName :: Text -> Maybe Text
extractClassName nodeId =
  -- Try both [in: and %5Bin: (URL-encoded)
  let tryRaw = case T.breakOn "[in:" nodeId of
        (_, rest)
          | T.null rest -> Nothing
          | otherwise ->
              let afterPrefix = T.drop 4 rest
                  (beforeClose, _) = T.breakOn "]" afterPrefix
                  (cleanParent, _) = T.breakOn ",h:" beforeClose
              in if T.null cleanParent then Nothing else Just cleanParent
      tryEncoded = case T.breakOn "%5Bin:" nodeId of
        (_, rest)
          | T.null rest -> Nothing
          | otherwise ->
              let afterPrefix = T.drop 6 rest  -- "%5Bin:" is 6 chars
                  (beforeClose, _) = T.breakOn "%5D" afterPrefix
                  (cleanParent, _) = T.breakOn ",h:" beforeClose
              in if T.null cleanParent then Nothing else Just cleanParent
  in case tryRaw of
       Just x  -> Just x
       Nothing -> tryEncoded

-- | Get a text metadata value from a node.
getMetaText :: Text -> GraphNode -> Maybe Text
getMetaText key node =
  case Map.lookup key (gnMetadata node) of
    Just (MetaText t) | not (T.null t) -> Just t
    _                                  -> Nothing

-- | Helper: create an EmitEdge command.
mkEdge :: Text -> Text -> Text -> Map Text MetaValue -> PluginCommand
mkEdge src dst edgeType meta = EmitEdge GraphEdge
  { geSource   = src
  , geTarget   = dst
  , geType     = edgeType
  , geMetadata = meta
  }

-- | Core resolution logic.
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let funcIdx   = buildFunctionIndex nodes
      methodIdx = buildMethodIndex nodes
      typeIdx   = buildTypeIndex nodes
      hierIdx   = buildHierarchyIndex nodes
      callNodes = filter (\n -> gnType n == "CALL") nodes

  let allEdges = concatMap (resolveCall funcIdx methodIdx typeIdx hierIdx) callNodes

  hPutStrLn stderr $
    "python-call-resolve: " ++ show (length allEdges) ++ " call edges"

  return allEdges

resolveCall :: FunctionIndex -> MethodIndex -> TypeIndex -> HierarchyIndex -> GraphNode -> [PluginCommand]
resolveCall funcIdx methodIdx typeIdx hierIdx callNode =
  let callName = gnName callNode
      callFile = gnFile callNode
      mReceiver = getMetaText "receiver" callNode
  in case mReceiver of
       Just receiver ->
         -- Method call: try type-aware resolution first
         let -- Look up receiver's type (try multiple name variants)
             candidates = nub $ filter (not . T.null)
               [ receiver                    -- exact: "stage"
               , if T.isPrefixOf "_" receiver
                 then T.drop 1 receiver      -- strip leading _: "_stage" -> "stage"
                 else ""
               , if T.isPrefixOf "self._" receiver
                 then T.drop 6 receiver      -- "self._stage" -> "stage"
                 else if T.isPrefixOf "self." receiver
                      then T.drop 5 receiver -- "self.stage" -> "stage"
                      else ""
               ]
             receiverType2 = case concatMap (\c -> maybe [] (\t -> [t]) (Map.lookup (callFile, c) typeIdx)) candidates of
               (t:_) -> Just t
               []    -> Nothing
         in case receiverType2 of
              Just baseClass ->
                -- Virtual dispatch: expand class hierarchy and find method in all classes
                let allClasses = expandHierarchy hierIdx baseClass
                    targets = nub $ concatMap (\cls ->
                      Map.findWithDefault [] (cls, callName) methodIdx
                      ) allClasses
                in case targets of
                     [] ->
                       -- Fallback: try imprecise match
                       resolveMethodImprecise methodIdx callNode callName
                     _ ->
                       -- Emit CALLS edge to each implementation
                       map (\tid -> mkEdge (gnId callNode) tid "CALLS"
                             (Map.fromList [("dispatch", MetaText "virtual")])
                           ) targets
              Nothing ->
                -- No type info: fall back to imprecise method matching
                resolveMethodImprecise methodIdx callNode callName
       Nothing ->
         -- Function call: look up in same file first, then cross-file
         case Map.lookup (callFile, callName) funcIdx of
           Just (target:_) -> [mkEdge (gnId callNode) target "CALLS" Map.empty]
           _ ->
             -- Cross-file: find any function with this name
             let matches = [ mid | ((_, fname), mids) <- Map.toList funcIdx
                                 , fname == callName
                                 , mid <- mids ]
             in case matches of
                  (target:_) -> [mkEdge (gnId callNode) target "CALLS" Map.empty]
                  [] -> []

-- | Imprecise method resolution: match by method name across all classes.
resolveMethodImprecise :: MethodIndex -> GraphNode -> Text -> [PluginCommand]
resolveMethodImprecise methodIdx callNode callName =
  let matches = [ mid | ((_, mname), mids) <- Map.toList methodIdx
                      , mname == callName
                      , mid <- mids ]
  in case matches of
       (target:_) -> [mkEdge (gnId callNode) target "CALLS" Map.empty]
       [] -> []

-- | CLI entry: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands
