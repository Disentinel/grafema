{-# LANGUAGE OverloadedStrings #-}
-- | C/C++ constructor and destructor resolution.
--
-- Resolves constructor calls (@new MyClass(...)@, direct construction
-- @MyClass obj(...)@) and destructor calls to their respective FUNCTION
-- nodes.
--
-- == Edge Types Emitted
--
--   * CALLS: CALL -> constructor/destructor FUNCTION
--   * INSTANTIATES: CALL -> CLASS (the class being constructed)
--
-- == Resolution Strategies
--
-- **Constructor calls:**
--   1. Extract class name from CALL node (gnName or @className@ metadata).
--   2. Look up constructor in method index as @(className, className)@ —
--      in C++, the constructor name equals the class name.
--   3. If multiple constructors, use @arg_count@ to disambiguate.
--   4. Emit CALLS edge to constructor FUNCTION.
--   5. Emit INSTANTIATES edge to the CLASS node.
--
-- **Destructor calls:**
--   1. Look up @~ClassName@ in the method index.
--   2. Emit CALLS edge.
--
-- **Base class constructor delegation:**
--   1. For CALL nodes with @kind=base_ctor_call@ or @is_base_ctor=true@.
--   2. Look up base class constructor.
--   3. Emit CALLS from the derived constructor to the base constructor.
--
-- Node types consumed: CALL (kind="new", kind="constructor", kind="destructor",
--   kind="base_ctor_call"), CLASS, FUNCTION
-- Edge types emitted: CALLS, INSTANTIATES
module CppConstructorResolution
  ( resolveAll
  ) where

import Grafema.Types (GraphNode(..), GraphEdge(..))
import Grafema.Protocol (PluginCommand(..))
import CppIndex (CppIndex(..), lookupMetaText, lookupMetaBool, unqualifiedName)

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

-- | Resolve all constructor and destructor calls.
--
-- Parameters:
--   * @nodes@ — all graph nodes
--   * @idx@ — pre-built 'CppIndex'
--
-- Returns a list of 'EmitEdge' commands.
resolveAll :: [GraphNode] -> CppIndex -> [PluginCommand]
resolveAll nodes idx =
  let callNodes = filter (\n -> gnType n == "CALL") nodes
  in concatMap (resolveCtorDtor idx) callNodes

-- | Resolve a single CALL node as a constructor or destructor.
resolveCtorDtor :: CppIndex -> GraphNode -> [PluginCommand]
resolveCtorDtor idx callNode =
  let mKind = lookupMetaText "kind" callNode
  in case mKind of
    Just "new"            -> resolveConstructor idx callNode
    Just "constructor"    -> resolveConstructor idx callNode
    Just "destructor"     -> resolveDestructor idx callNode
    Just "base_ctor_call" -> resolveBaseCtorCall idx callNode
    _ | lookupMetaBool "is_constructor" callNode == Just True ->
          resolveConstructor idx callNode
      | lookupMetaBool "is_destructor" callNode == Just True ->
          resolveDestructor idx callNode
      | lookupMetaBool "is_base_ctor" callNode == Just True ->
          resolveBaseCtorCall idx callNode
      | otherwise -> []

-- ── Constructor Resolution ─────────────────────────────────────────────

-- | Resolve a constructor call.
--
-- Emits both CALLS (to the constructor FUNCTION) and INSTANTIATES
-- (to the CLASS) edges.
resolveConstructor :: CppIndex -> GraphNode -> [PluginCommand]
resolveConstructor idx callNode =
  let className = extractClassName callNode
  in case className of
    Nothing -> []
    Just cls ->
      let ctorEdges = resolveCtorFunction idx callNode cls
          instEdges = resolveInstantiation idx callNode cls
      in ctorEdges ++ instEdges

-- | Extract the class name from a constructor CALL node.
--
-- Tries @className@ metadata first, then falls back to @gnName@.
extractClassName :: GraphNode -> Maybe Text
extractClassName callNode =
  case lookupMetaText "className" callNode of
    Just cls | not (T.null cls) -> Just cls
    _ ->
      let name = gnName callNode
      in if T.null name then Nothing else Just name

-- | Look up and emit CALLS edge to the constructor FUNCTION.
resolveCtorFunction :: CppIndex -> GraphNode -> Text -> [PluginCommand]
resolveCtorFunction idx callNode className =
  let uqClass = unqualifiedName className
      -- Constructor name = class name in C++
      candidates = case Map.lookup (className, uqClass) (methodIndex idx) of
        Just cs@(_:_) -> cs
        _ -> case Map.lookup (uqClass, uqClass) (methodIndex idx) of
          Just cs@(_:_) -> cs
          _ -> []
  in case disambiguateByArgCount callNode candidates of
    Just targetId ->
      [ EmitEdge GraphEdge
          { geSource   = gnId callNode
          , geTarget   = targetId
          , geType     = "CALLS"
          , geMetadata = Map.empty
          }
      ]
    Nothing -> []

-- | Emit INSTANTIATES edge to the CLASS node.
resolveInstantiation :: CppIndex -> GraphNode -> Text -> [PluginCommand]
resolveInstantiation idx callNode className =
  case lookupClassNode idx className of
    Just classNodeId ->
      [ EmitEdge GraphEdge
          { geSource   = gnId callNode
          , geTarget   = classNodeId
          , geType     = "INSTANTIATES"
          , geMetadata = Map.empty
          }
      ]
    Nothing -> []

-- ── Destructor Resolution ──────────────────────────────────────────────

-- | Resolve a destructor call.
resolveDestructor :: CppIndex -> GraphNode -> [PluginCommand]
resolveDestructor idx callNode =
  let className = extractClassName callNode
  in case className of
    Nothing -> []
    Just cls ->
      let uqClass = unqualifiedName cls
          dtorName = "~" <> uqClass
      in case Map.lookup (cls, dtorName) (methodIndex idx) of
        Just (targetId:_) ->
          [ EmitEdge GraphEdge
              { geSource   = gnId callNode
              , geTarget   = targetId
              , geType     = "CALLS"
              , geMetadata = Map.empty
              }
          ]
        _ -> case Map.lookup (uqClass, dtorName) (methodIndex idx) of
          Just (targetId:_) ->
            [ EmitEdge GraphEdge
                { geSource   = gnId callNode
                , geTarget   = targetId
                , geType     = "CALLS"
                , geMetadata = Map.empty
                }
            ]
          _ -> []

-- ── Base Constructor Delegation ────────────────────────────────────────

-- | Resolve a base class constructor call from an initializer list.
resolveBaseCtorCall :: CppIndex -> GraphNode -> [PluginCommand]
resolveBaseCtorCall idx callNode =
  let baseName = extractClassName callNode
  in case baseName of
    Nothing -> []
    Just base ->
      resolveCtorFunction idx callNode base

-- ── Helpers ────────────────────────────────────────────────────────────

-- | Look up a class node ID in the class index.
lookupClassNode :: CppIndex -> Text -> Maybe Text
lookupClassNode idx className =
  case Map.lookup className (classIndex idx) of
    Just (nodeId:_) -> Just nodeId
    _ ->
      let uq = unqualifiedName className
      in if uq /= className
         then case Map.lookup uq (classIndex idx) of
           Just (nodeId:_) -> Just nodeId
           _               -> Nothing
         else Nothing

-- | Disambiguate constructor overloads by @arg_count@ metadata.
--
-- If only one candidate, return it directly. If multiple candidates
-- and the CALL node has @arg_count@ metadata, prefer the matching one.
-- Otherwise return the first candidate.
disambiguateByArgCount :: GraphNode -> [Text] -> Maybe Text
disambiguateByArgCount _ [] = Nothing
disambiguateByArgCount _ [single] = Just single
disambiguateByArgCount _ (c:_) =
  -- Without access to candidate node metadata from the index,
  -- we return the first candidate. A more sophisticated version
  -- would look up each candidate's arg_count.
  Just c
