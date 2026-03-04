{-# LANGUAGE OverloadedStrings #-}
-- | Phase 7 post-pass: type class virtual dispatch tracking.
--
-- After the main analysis pass completes, this module inspects the
-- resulting 'FileAnalysis' to detect calls that target type class
-- methods. When a CALL node's name matches a method declared in a
-- TYPE_CLASS (via HAS_METHOD edges to TYPE_SIGNATURE nodes), a
-- DISPATCHES_VIA edge is emitted from the CALL to the method's
-- TYPE_SIGNATURE node.
--
-- This is intra-file best-effort analysis: type class methods defined
-- in other modules cannot be detected here.
module Rules.Dispatch
  ( checkDispatch
  ) where

import Data.Text (Text)
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set

import Analysis.Types (FileAnalysis(..), GraphNode(..), GraphEdge(..))

-- | Check for type class virtual dispatch in the completed analysis.
--
-- Returns DISPATCHES_VIA edges from CALL nodes to TYPE_SIGNATURE nodes
-- when the call name matches a type class method name.
--
-- Strategy:
-- 1. Collect all TYPE_CLASS nodes.
-- 2. Find HAS_METHOD edges from TYPE_CLASS to TYPE_SIGNATURE nodes.
-- 3. Build a map from method name to TYPE_SIGNATURE node ID.
-- 4. For each CALL node, check if its name is in the method map.
-- 5. Emit DISPATCHES_VIA edges for matches.
checkDispatch :: FileAnalysis -> [GraphEdge]
checkDispatch fa =
  let methodMap = collectClassMethods fa  -- Map MethodName TypeSignatureNodeId
      calls     = [ n | n <- faNodes fa, gnType n == "CALL" ]
  in [ GraphEdge
         { geSource   = gnId call
         , geTarget   = sigNodeId
         , geType     = "DISPATCHES_VIA"
         , geMetadata = Map.empty
         }
     | call <- calls
     , Just sigNodeId <- [Map.lookup (gnName call) methodMap]
     ]

-- | Collect type class methods as a map from method name to the
-- TYPE_SIGNATURE node ID.
--
-- Walks HAS_METHOD edges from TYPE_CLASS nodes to TYPE_SIGNATURE nodes,
-- building a map from the signature's name to its node ID.
collectClassMethods :: FileAnalysis -> Map.Map Text Text
collectClassMethods fa =
  let -- Collect TYPE_CLASS node IDs
      classIds = Set.fromList [ gnId n | n <- faNodes fa, gnType n == "TYPE_CLASS" ]
      -- Find HAS_METHOD edges originating from TYPE_CLASS nodes
      methodEdges = [ e | e <- faEdges fa
                    , geType e == "HAS_METHOD"
                    , Set.member (geSource e) classIds
                    ]
      -- Build map from TYPE_SIGNATURE node ID -> name
      sigNodes = Map.fromList [ (gnId n, gnName n) | n <- faNodes fa, gnType n == "TYPE_SIGNATURE" ]
      -- Build method name -> signature node ID map
  in Map.fromList
       [ (sigName, geTarget edge)
       | edge <- methodEdges
       , Just sigName <- [Map.lookup (geTarget edge) sigNodes]
       ]
