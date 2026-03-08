{-# LANGUAGE OverloadedStrings #-}
-- | Same-file CALLS resolution plugin.
--
-- Creates CALLS edges for function calls where the callee is defined in the
-- same file. Handles:
--   - Direct calls: @foo()@ -> function foo in same file
--   - Method calls: @obj.method()@ -> METHOD node in same-file CLASS
--   - Constructor calls: names starting with uppercase that match a CLASS
--
-- This complements CrossFileCalls (handles imported functions) and Builtins
-- (handles Node.js builtins). Together they cover same-file + cross-file + builtins.
module SameFileCalls (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)
import ResolveUtil (extractClassFromId, buildImportIndex)

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import qualified Data.Set as Set
import Data.Set (Set)
import Data.Char (isUpper)

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

-- | Index of functions: (file, name) -> node ID
type FunctionIndex = Map (Text, Text) Text

-- | Index of methods: (file, className, methodName) -> node ID
type MethodIndex = Map (Text, Text, Text) Text

-- | Index of classes: (file, className) -> node ID
type ClassIndex = Map (Text, Text) Text

-- | Import binding index: (file, localName)
-- Used to skip calls that are imports (handled by CrossFileCalls/Builtins)
type ImportIndex = Set (Text, Text)

-- ---------------------------------------------------------------------------
-- Index construction
-- ---------------------------------------------------------------------------

-- | Build function index from FUNCTION, VARIABLE, and CONSTANT nodes.
-- Includes VARIABLE/CONSTANT to handle arrow functions and function expressions
-- assigned to variables (e.g., @const greet = () => {}@).
-- FUNCTION nodes take precedence over VARIABLE/CONSTANT with the same name
-- (Map.fromList keeps the last entry for duplicate keys).
buildFunctionIndex :: [GraphNode] -> FunctionIndex
buildFunctionIndex nodes =
  Map.fromList $
    -- VARIABLE/CONSTANT first (lower priority — overridden by FUNCTION if same key)
    [ ((gnFile n, gnName n), gnId n)
    | n <- nodes
    , gnType n == "VARIABLE" || gnType n == "CONSTANT"
    , not (T.null (gnName n))
    ] ++
    -- FUNCTION last (higher priority)
    [ ((gnFile n, gnName n), gnId n)
    | n <- nodes
    , gnType n == "FUNCTION"
    , not (T.null (gnName n))
    ]

-- | Build method index from FUNCTION nodes that have [in:ClassName] in their ID.
-- Methods are FUNCTION nodes with a parent class encoded in their semantic ID.
buildMethodIndex :: [GraphNode] -> MethodIndex
buildMethodIndex nodes =
  Map.fromList
    [ ((gnFile n, className, gnName n), gnId n)
    | n <- nodes
    , gnType n == "FUNCTION" || gnType n == "METHOD"
    , not (T.null (gnName n))
    , Just className <- [extractClassFromId (gnId n)]
    ]

-- | Build class index from CLASS nodes.
buildClassIndex :: [GraphNode] -> ClassIndex
buildClassIndex nodes =
  Map.fromList
    [ ((gnFile n, gnName n), gnId n)
    | n <- nodes
    , gnType n == "CLASS"
    , not (T.null (gnName n))
    ]

-- ---------------------------------------------------------------------------
-- Resolution
-- ---------------------------------------------------------------------------

-- | Core same-file CALLS resolution logic.
resolveAll :: [GraphNode] -> [PluginCommand]
resolveAll nodes =
  let funcIndex   = buildFunctionIndex nodes
      methodIndex = buildMethodIndex nodes
      classIndex  = buildClassIndex nodes
      importIndex = buildImportIndex nodes
      callNodes   = filter (\n -> gnType n == "CALL") nodes
  in concatMap (resolveCallNode funcIndex methodIndex classIndex importIndex) callNodes

-- | Resolve a single CALL node.
resolveCallNode :: FunctionIndex -> MethodIndex -> ClassIndex -> ImportIndex -> GraphNode -> [PluginCommand]
resolveCallNode funcIndex methodIndex classIndex importIndex callNode =
  let file   = gnFile callNode
      callee = gnName callNode
  in case T.breakOn "." callee of
    -- Method call: "obj.method" or "this.method" or "ClassName.staticMethod"
    (objectName, rest)
      | not (T.null rest) ->
          let methodName = T.drop 1 rest
          in resolveMethodCall funcIndex methodIndex classIndex file objectName methodName callNode
    -- Direct call: "foo"
      | otherwise ->
          -- Skip if this name is an import binding (handled by CrossFileCalls/Builtins)
          if Set.member (file, callee) importIndex
            then []
            else resolveDirectCall funcIndex classIndex file callee callNode

-- | Resolve a direct function call: foo()
resolveDirectCall :: FunctionIndex -> ClassIndex -> Text -> Text -> GraphNode -> [PluginCommand]
resolveDirectCall funcIndex classIndex file callee callNode =
  -- Try 1: Look up as a function in same file
  case Map.lookup (file, callee) funcIndex of
    Just targetId -> [mkCallsEdge callNode targetId]
    Nothing ->
      -- Try 2: If starts with uppercase, might be a constructor call: new Foo() or Foo()
      if not (T.null callee) && isUpper (T.head callee)
        then case Map.lookup (file, callee) classIndex of
          Just classId -> [mkCallsEdge callNode classId]
          Nothing      -> []
        else []

-- | Resolve a method call: obj.method()
resolveMethodCall :: FunctionIndex -> MethodIndex -> ClassIndex -> Text -> Text -> Text -> GraphNode -> [PluginCommand]
resolveMethodCall _funcIndex methodIndex _classIndex file objectName methodName callNode
  -- "this.method()" or "super.method()" -> look up in enclosing class
  | objectName == "this" || objectName == "super" =
      case extractClassFromId (gnId callNode) of
        Just className ->
          case Map.lookup (file, className, methodName) methodIndex of
            Just targetId -> [mkCallsEdge callNode targetId]
            Nothing       -> []
        Nothing -> []
  -- "ClassName.staticMethod()" -> look up as a static method on that class
  | not (T.null objectName) && isUpper (T.head objectName) =
      case Map.lookup (file, objectName, methodName) methodIndex of
        Just targetId -> [mkCallsEdge callNode targetId]
        Nothing       -> []
  -- "obj.method()" where obj is a variable -> can't resolve without type info
  | otherwise = []

-- | Create a CALLS edge.
mkCallsEdge :: GraphNode -> Text -> PluginCommand
mkCallsEdge callNode targetId = EmitEdge GraphEdge
  { geSource   = gnId callNode
  , geTarget   = targetId
  , geType     = "CALLS"
  , geMetadata = Map.singleton "resolvedVia" (MetaText "same-file-calls")
  }

-- ---------------------------------------------------------------------------
-- CLI entry point
-- ---------------------------------------------------------------------------

run :: IO ()
run = do
  nodes <- readNodesFromStdin
  writeCommandsToStdout (resolveAll nodes)
