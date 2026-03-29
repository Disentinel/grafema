{-# LANGUAGE OverloadedStrings #-}
module PhpCallResolution (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)
import PhpIndex

import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import System.IO (hPutStrLn, stderr)

resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let modIdx      = buildModuleIndex nodes
      nameIdx     = buildNameIndex nodes modIdx
      impIdx      = buildImportIndex nodes
      methodIdx   = buildMethodIndex nodes
      paramIdx    = buildParamTypeIndex nodes
      fnClsIdx    = buildFunctionClassIndex nodes
      extendsIdx  = buildClassExtendsIndex nodes
      traitsIdx   = buildClassTraitsIndex nodes
      propTypeIdx = buildPropertyTypeIndex nodes
      callNodes   = filter (\n -> gnType n == "CALL") nodes

  let constructorEdges = resolveConstructors modIdx impIdx nameIdx callNodes
      staticEdges      = resolveStaticCalls modIdx impIdx nameIdx methodIdx fnClsIdx extendsIdx callNodes
      thisEdges        = resolveThisCalls methodIdx extendsIdx traitsIdx callNodes
      propEdges        = resolvePropertyCalls modIdx impIdx nameIdx methodIdx fnClsIdx extendsIdx traitsIdx propTypeIdx callNodes
      instanceEdges    = resolveInstanceMethods modIdx impIdx nameIdx methodIdx paramIdx fnClsIdx extendsIdx traitsIdx callNodes
      functionEdges    = resolveFunctionCalls modIdx impIdx nameIdx callNodes

      allEdges = constructorEdges ++ staticEdges ++ thisEdges ++ propEdges ++ instanceEdges ++ functionEdges

      callsCount = length [ () | EmitEdge e <- allEdges, geType e == "CALLS" ]
      instantiatesCount = length [ () | EmitEdge e <- allEdges, geType e == "INSTANTIATES" ]

  hPutStrLn stderr $
    "php-call-resolve: " ++ show (length allEdges) ++ " call edges"
    ++ " (CALLS=" ++ show callsCount
    ++ ", INSTANTIATES=" ++ show instantiatesCount ++ ")"

  return allEdges

-- Constructor calls: metadata.kind == "constructor", name is class name
resolveConstructors :: ModuleIndex -> ImportIndex -> NameIndex -> [GraphNode] -> [PluginCommand]
resolveConstructors modIdx impIdx nameIdx = concatMap go
  where
    go node
      | getMetaText "kind" node /= Just "constructor" = []
      | otherwise =
          let className = extractClassName (gnName node)
          in case lookupFQName className (gnFile node) modIdx impIdx nameIdx of
               Just (_file, classId) -> [mkEdge (gnId node) classId "INSTANTIATES"]
               Nothing -> []

    -- Extract class name: "new ClassName" -> "ClassName"
    extractClassName name
      | "new " `T.isPrefixOf` name = T.strip (T.drop 4 name)
      | otherwise                  = name

-- Static calls: metadata.static == true, receiver is class name (or self/static/parent)
resolveStaticCalls :: ModuleIndex -> ImportIndex -> NameIndex -> MethodIndex -> FunctionClassIndex -> ClassExtendsIndex -> [GraphNode] -> [PluginCommand]
resolveStaticCalls modIdx impIdx nameIdx methodIdx fnClsIdx extendsIdx = concatMap go
  where
    go node
      | getMetaBool "static" node /= Just True = []
      | otherwise =
          case getMetaText "receiver" node of
            Nothing -> []
            Just rawReceiver ->
              let receiverLower = T.toLower rawReceiver
                  -- Resolve self/static/parent to actual class name
                  resolvedClass
                    | receiverLower == "self" || receiverLower == "static" =
                        -- Get enclosing function, then its class
                        case extractEnclosingName (gnId node) of
                          Nothing -> Nothing
                          Just fnName -> Map.lookup (gnFile node, fnName) fnClsIdx
                    | receiverLower == "parent" =
                        -- Get enclosing class, then its parent
                        case extractEnclosingName (gnId node) of
                          Nothing -> Nothing
                          Just fnName ->
                            case Map.lookup (gnFile node, fnName) fnClsIdx of
                              Nothing -> Nothing
                              Just cls -> Map.lookup cls extendsIdx
                    | otherwise = Just rawReceiver
              in case resolvedClass of
                   Nothing -> []
                   Just className ->
                     -- Verify the class exists (try FQ name resolution)
                     case lookupFQName className (gnFile node) modIdx impIdx nameIdx of
                       Nothing -> []
                       Just _ ->
                         -- Look up the method in the class
                         case Map.lookup (className, gnName node) methodIdx of
                           Just (m:_) -> [mkEdge (gnId node) m "CALLS"]
                           _ -> []

-- $this->method() calls: receiver is "$this"
-- Walks inheritance chain + traits to find the method.
resolveThisCalls :: MethodIndex -> ClassExtendsIndex -> ClassTraitsIndex -> [GraphNode] -> [PluginCommand]
resolveThisCalls methodIdx extendsIdx traitsIdx = concatMap go
  where
    go node
      | getMetaText "receiver" node /= Just "$this" = []
      | otherwise =
          case extractParentClass (gnId node) of
            Nothing -> []
            Just parentClass ->
              case lookupMethodInHierarchy methodIdx extendsIdx traitsIdx parentClass (gnName node) 10 of
                Just m  -> [mkEdge (gnId node) m "CALLS"]
                Nothing -> []

-- Property-based calls: $this->prop->method() where prop is a typed property.
-- Receiver pattern: "$this->propName"
-- Resolution: extract propName → enclosing class → PropertyTypeIndex → type → method
resolvePropertyCalls :: ModuleIndex -> ImportIndex -> NameIndex -> MethodIndex -> FunctionClassIndex -> ClassExtendsIndex -> ClassTraitsIndex -> PropertyTypeIndex -> [GraphNode] -> [PluginCommand]
resolvePropertyCalls modIdx impIdx nameIdx methodIdx fnClsIdx extendsIdx traitsIdx propTypeIdx = concatMap go
  where
    go node
      | getMetaBool "static" node == Just True = []
      | getMetaText "kind" node == Just "constructor" = []
      | otherwise =
          case getMetaText "receiver" node of
            Nothing -> []
            Just receiver
              | "$this->" `T.isPrefixOf` receiver ->
                  let propName = T.drop 7 receiver  -- strip "$this->"
                  in case extractEnclosingName (gnId node) of
                       Nothing -> []
                       Just fnName ->
                         -- Resolve enclosing class via FunctionClassIndex, then direct Map.lookup
                         case Map.lookup (gnFile node, fnName) fnClsIdx of
                           Nothing -> []
                           Just className ->
                             case Map.lookup (className, propName) propTypeIdx of
                               Nothing -> []
                               Just rawType ->
                                 case normalizePhpType rawType of
                                   Nothing -> []
                                   Just typeName ->
                                     case lookupFQName typeName (gnFile node) modIdx impIdx nameIdx of
                                       Nothing -> []
                                       Just _ ->
                                         case lookupMethodInHierarchy methodIdx extendsIdx traitsIdx typeName (gnName node) 10 of
                                           Just m  -> [mkEdge (gnId node) m "CALLS"]
                                           Nothing -> []
              | otherwise -> []

-- Instance method calls: $receiver->method() where receiver type is known from ParamTypeIndex
-- For each CALL with method=true, non-$this receiver, not static:
--   1. Strip "$" from receiver -> varName
--   2. Extract [in:fnName] from CALL's semantic ID
--   3. Look up (file, fnName, varName) in ParamTypeIndex -> typeName
--   4. normalizePhpType -> lookupFQName -> get className
--   5. Look up (className, methodName) in MethodIndex -> emit CALLS edge
resolveInstanceMethods :: ModuleIndex -> ImportIndex -> NameIndex -> MethodIndex -> ParamTypeIndex -> FunctionClassIndex -> ClassExtendsIndex -> ClassTraitsIndex -> [GraphNode] -> [PluginCommand]
resolveInstanceMethods _modIdx _impIdx _nameIdx methodIdx paramIdx fnClsIdx extendsIdx traitsIdx = concatMap go
  where
    go node
      -- Must have a receiver that is not $this and not static
      | getMetaBool "static" node == Just True = []
      | getMetaText "kind" node == Just "constructor" = []
      | otherwise =
          case getMetaText "receiver" node of
            Nothing -> []
            Just receiver
              | receiver == "$this" -> []
              | not ("$" `T.isPrefixOf` receiver) -> []  -- not a variable receiver
              | otherwise ->
                  case extractEnclosingName (gnId node) of
                       Nothing -> []
                       Just fnName ->
                         case Map.lookup (gnFile node, fnName, receiver) paramIdx of
                           Nothing -> []
                           Just rawType ->
                             case normalizePhpType rawType of
                               Nothing -> []
                               Just typeName ->
                                 -- Resolve the type name to a class (handle self/static)
                                 let resolvedName
                                       | isSpecialSelfType typeName =
                                           -- self/static: look up enclosing class via FunctionClassIndex
                                           case Map.lookup (gnFile node, fnName) fnClsIdx of
                                             Just cls -> cls
                                             Nothing  -> typeName  -- fallback
                                       | otherwise = typeName
                                 in case lookupMethodInHierarchy methodIdx extendsIdx traitsIdx resolvedName (gnName node) 10 of
                                      Just m  -> [mkEdge (gnId node) m "CALLS"]
                                      Nothing -> []

-- Plain function calls (no receiver, not constructor, not static)
resolveFunctionCalls :: ModuleIndex -> ImportIndex -> NameIndex -> [GraphNode] -> [PluginCommand]
resolveFunctionCalls modIdx impIdx nameIdx = concatMap go
  where
    go node
      | isSpecialCall node = []
      | otherwise =
          case lookupFQName (gnName node) (gnFile node) modIdx impIdx nameIdx of
            Just (_, targetId) -> [mkEdge (gnId node) targetId "CALLS"]
            Nothing -> []

    isSpecialCall n =
      getMetaText "kind" n == Just "constructor"
      || getMetaBool "static" n == Just True
      || case getMetaText "receiver" n of
           Nothing -> False
           Just "" -> False
           Just _  -> True

run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands
