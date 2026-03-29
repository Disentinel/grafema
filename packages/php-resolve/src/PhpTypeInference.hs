{-# LANGUAGE OverloadedStrings #-}
-- | PHP type inference from annotations.
--
-- Resolves type references from PHP type hints to produce typed edges:
--   - TYPE_OF edges: VARIABLE (parameter/property with type hint) -> CLASS/INTERFACE/TRAIT
--   - RETURNS edges: FUNCTION (with return_type) -> CLASS/INTERFACE/TRAIT
--
-- Handles @self@/@static@ type hints by resolving them to the enclosing class.
module PhpTypeInference (run, resolveAll) where

import Grafema.Types (GraphNode(..))
import Grafema.Protocol (PluginCommand, readNodesFromStdin, writeCommandsToStdout)
import PhpIndex

import qualified Data.Map.Strict as Map
import System.IO (hPutStrLn, stderr)

-- | Resolve TYPE_OF and RETURNS edges from PHP type annotations.
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let modIdx   = buildModuleIndex nodes
      nameIdx  = buildNameIndex nodes modIdx
      impIdx   = buildImportIndex nodes
      fnClsIdx = buildFunctionClassIndex nodes

      typeOfEdges  = resolveTypeOf modIdx impIdx nameIdx fnClsIdx nodes
      returnsEdges = resolveReturns modIdx impIdx nameIdx nodes

      allEdges = typeOfEdges ++ returnsEdges

  hPutStrLn stderr $
    "php-type-inference: " ++ show (length allEdges) ++ " edges"
    ++ " (TYPE_OF=" ++ show (length typeOfEdges)
    ++ ", RETURNS=" ++ show (length returnsEdges) ++ ")"

  return allEdges

-- | Resolve TYPE_OF edges: VARIABLE nodes with "type" metadata.
--
-- For each VARIABLE with a @type@ metadata field (parameters, properties):
--   1. Normalize the type (strip @?@, handle unions, filter primitives)
--   2. If @self@/@static@, resolve to enclosing class via FunctionClassIndex
--   3. Look up the FQ name in the project
--   4. Emit TYPE_OF edge if found
resolveTypeOf :: ModuleIndex -> ImportIndex -> NameIndex -> FunctionClassIndex -> [GraphNode] -> [PluginCommand]
resolveTypeOf modIdx impIdx nameIdx fnClsIdx = concatMap go
  where
    go node
      | gnType node /= "VARIABLE" = []
      | otherwise =
          case getMetaText "type" node of
            Nothing -> []
            Just rawType ->
              case normalizePhpType rawType of
                Nothing -> []  -- primitive or unsupported
                Just typeName
                  | isSpecialSelfType typeName ->
                      -- self/static: resolve to enclosing class.
                      -- For a VARIABLE, [in:] gives the function name.
                      -- Use FunctionClassIndex to find the class.
                      case extractEnclosingName (gnId node) of
                        Nothing -> []
                        Just fnName ->
                          case Map.lookup (gnFile node, fnName) fnClsIdx of
                            Nothing -> []
                            Just className ->
                              case lookupFQName className (gnFile node) modIdx impIdx nameIdx of
                                Just (_, targetId) -> [mkEdge (gnId node) targetId "TYPE_OF"]
                                Nothing -> []
                  | otherwise ->
                      case lookupFQName typeName (gnFile node) modIdx impIdx nameIdx of
                        Just (_, targetId) -> [mkEdge (gnId node) targetId "TYPE_OF"]
                        Nothing -> []

-- | Resolve RETURNS edges: FUNCTION nodes with "return_type" metadata.
--
-- For each FUNCTION with a @return_type@ metadata field:
--   1. Normalize the type
--   2. If @self@/@static@, resolve to enclosing class via @[in:]@ annotation
--   3. Look up the FQ name in the project
--   4. Emit RETURNS edge if found
resolveReturns :: ModuleIndex -> ImportIndex -> NameIndex -> [GraphNode] -> [PluginCommand]
resolveReturns modIdx impIdx nameIdx = concatMap go
  where
    go node
      | gnType node /= "FUNCTION" = []
      | otherwise =
          case getMetaText "return_type" node of
            Nothing -> []
            Just rawType ->
              case normalizePhpType rawType of
                Nothing -> []  -- primitive or unsupported
                Just typeName
                  | isSpecialSelfType typeName ->
                      -- self/static: FUNCTION's [in:] gives the class directly
                      case extractParentClass (gnId node) of
                        Nothing -> []
                        Just className ->
                          case lookupFQName className (gnFile node) modIdx impIdx nameIdx of
                            Just (_, targetId) -> [mkEdge (gnId node) targetId "RETURNS"]
                            Nothing -> []
                  | otherwise ->
                      case lookupFQName typeName (gnFile node) modIdx impIdx nameIdx of
                        Just (_, targetId) -> [mkEdge (gnId node) targetId "RETURNS"]
                        Nothing -> []

-- | CLI entry: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands
