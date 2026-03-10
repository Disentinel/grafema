{-# LANGUAGE OverloadedStrings #-}
-- | Post-pass: resolve intra-file references using scope chain from graph data.
--
-- After 'walkProgram' produces the full 'FileAnalysis', this module reconstructs
-- the scope tree from emitted SCOPE nodes, HAS_SCOPE edges, and DECLARES edges,
-- then walks the scope chain for each ScopeLookup/CallResolve deferred ref.
--
-- Cross-file refs (ImportResolve, ExportLookup, TypeResolve, AliasResolve) are
-- passed through unchanged.
module Analysis.Resolve (resolveFileRefs) where

import Data.Text (Text)
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Analysis.Types

-- | Resolve intra-file deferred references by walking the scope chain.
--
-- Pure function: @FileAnalysis -> FileAnalysis@.
--
--   * ScopeLookup / CallResolve: resolved via scope chain walk.
--     If found, a new edge is emitted. If not found, the REFERENCE node
--     gets @resolved: false@ metadata.
--   * ImportResolve / ExportLookup / TypeResolve / AliasResolve: kept as-is
--     in 'faUnresolvedRefs' (cross-file, not resolvable here).
resolveFileRefs :: FileAnalysis -> FileAnalysis
resolveFileRefs fa =
  let -- Build index: nodeId -> nodeName (for looking up declared names)
      nodeNameMap :: Map.Map Text Text
      nodeNameMap = Map.fromList [(gnId n, gnName n) | n <- faNodes fa]

      -- Build index: scopeId -> [(name, declNodeId)] from DECLARES edges
      declsByScope :: Map.Map Text [(Text, Text)]
      declsByScope = Map.fromListWith (++)
        [ (geSource e, [(name, geTarget e)])
        | e <- faEdges fa
        , geType e == "DECLARES"
        , let name = Map.findWithDefault "" (geTarget e) nodeNameMap
        , name /= ""  -- skip nodes without names
        ]

      -- Build index: childScopeId -> parentScopeId from HAS_SCOPE edges
      parentMap :: Map.Map Text Text
      parentMap = Map.fromList
        [ (geTarget e, geSource e)
        | e <- faEdges fa
        , geType e == "HAS_SCOPE"
        ]

      -- Walk scope chain looking for a name declaration
      lookupInChain :: Text -> Text -> Maybe Text
      lookupInChain name scope =
        case Map.lookup scope declsByScope of
          Just decls ->
            case lookup name decls of
              Just nodeId -> Just nodeId
              Nothing     -> walkParent name scope
          Nothing -> walkParent name scope

      walkParent :: Text -> Text -> Maybe Text
      walkParent name scope =
        case Map.lookup scope parentMap of
          Just parentScope -> lookupInChain name parentScope
          Nothing          -> Nothing  -- reached root, not found

      -- Process each deferred ref: resolve or keep
      processRef :: DeferredRef
                 -> ([GraphEdge], [DeferredRef], [Text])
                 -> ([GraphEdge], [DeferredRef], [Text])
      processRef ref (edges, refs, unresolvedIds) =
        case drKind ref of
          ScopeLookup -> resolveInScope ref edges refs unresolvedIds
          CallResolve -> resolveInScope ref edges refs unresolvedIds
          _           -> (edges, ref : refs, unresolvedIds)

      resolveInScope :: DeferredRef
                     -> [GraphEdge] -> [DeferredRef] -> [Text]
                     -> ([GraphEdge], [DeferredRef], [Text])
      resolveInScope ref edges refs unresolvedIds =
        case drScopeId ref of
          Nothing -> (edges, refs, drFromNodeId ref : unresolvedIds)
          Just startScope ->
            case lookupInChain (drName ref) startScope of
              Just targetId ->
                let newEdge = GraphEdge
                      { geSource   = drFromNodeId ref
                      , geTarget   = targetId
                      , geType     = drEdgeType ref
                      , geMetadata = Map.empty
                      }
                in (newEdge : edges, refs, unresolvedIds)
              Nothing ->
                (edges, refs, drFromNodeId ref : unresolvedIds)

      (newEdges, remainingRefs, unresolvedNodeIds) =
        foldr processRef ([], [], []) (faUnresolvedRefs fa)

      -- Mark unresolved REFERENCE nodes with resolved:false metadata
      unresolvedSet :: Set.Set Text
      unresolvedSet = Set.fromList unresolvedNodeIds

      updatedNodes :: [GraphNode]
      updatedNodes = map markUnresolved (faNodes fa)

      markUnresolved :: GraphNode -> GraphNode
      markUnresolved n
        | Set.member (gnId n) unresolvedSet && gnType n == "REFERENCE"
        = n { gnMetadata = Map.insert "resolved" (MetaBool False) (gnMetadata n) }
        | otherwise = n

  in fa { faNodes          = updatedNodes
        , faEdges          = faEdges fa ++ newEdges
        , faUnresolvedRefs = remainingRefs
        }
