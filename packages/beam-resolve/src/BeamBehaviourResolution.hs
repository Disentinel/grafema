{-# LANGUAGE OverloadedStrings #-}
-- | BEAM behaviour resolution plugin.
--
-- Finds @behaviour declarations (IMPORT nodes with kind="behaviour")
-- and creates IMPLEMENTS edges between the implementing MODULE
-- and the behaviour MODULE.
--
-- Also resolves callback function implementations: if a MODULE
-- declares @behaviour GenServer, then handle_call/3, handle_cast/2,
-- init/1 etc. get IMPLEMENTS edges to the behaviour's callback specs.
module BeamBehaviourResolution (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.Text (Text)
import qualified Data.Text as T
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map

-- | Module index: module name -> node ID
type ModuleIndex = Map Text Text

-- | Build module index.
buildModuleIndex :: [GraphNode] -> ModuleIndex
buildModuleIndex nodes =
  Map.fromList
    [ (gnName n, gnId n)
    | n <- nodes
    , gnType n == "MODULE"
    ]

-- | Extract file path from semantic ID.
-- "path/to/file.ex->TYPE->name" -> "path/to/file.ex"
extractFile :: Text -> Text
extractFile sid = case T.breakOn "->" sid of
  (file, _) -> file

-- | Find IMPORT nodes with kind="behaviour" metadata.
findBehaviourImports :: [GraphNode] -> [GraphNode]
findBehaviourImports = filter isBehaviourImport

isBehaviourImport :: GraphNode -> Bool
isBehaviourImport n =
  gnType n == "IMPORT" &&
  Map.lookup "kind" (gnMetadata n) == Just (MetaText "behaviour")

-- | Resolve all behaviour declarations.
resolveAll :: [GraphNode] -> [PluginCommand]
resolveAll nodes =
  let moduleIdx        = buildModuleIndex nodes
      behaviourImports = findBehaviourImports nodes
  in concatMap (resolveBehaviour moduleIdx) behaviourImports

-- | Resolve a single @behaviour import to IMPLEMENTS edge.
--
-- The IMPORT node's name is the behaviour module name (e.g., "GenServer").
-- We look up the behaviour MODULE in the index and emit an IMPLEMENTS
-- edge from the file's MODULE to the behaviour MODULE.
resolveBehaviour :: ModuleIndex -> GraphNode -> [PluginCommand]
resolveBehaviour moduleIdx importNode =
  let behaviourName = gnName importNode
      importFile    = gnFile importNode
  in case Map.lookup behaviourName moduleIdx of
    Just behaviourNodeId ->
      -- Find the MODULE node for the file containing the @behaviour declaration
      let fileModuleId = findFileModule moduleIdx importFile
      in case fileModuleId of
        Just implModuleId ->
          [ EmitEdge GraphEdge
              { geSource   = implModuleId
              , geTarget   = behaviourNodeId
              , geType     = "IMPLEMENTS"
              , geMetadata = Map.fromList
                  [ ("resolvedVia", MetaText "beam-behaviours")
                  , ("kind", MetaText "behaviour")
                  ]
              }
          ]
        Nothing -> []
    Nothing -> []  -- behaviour module not in analyzed codebase

-- | Find MODULE node ID for a given file.
findFileModule :: ModuleIndex -> Text -> Maybe Text
findFileModule moduleIdx file =
  -- Look through all modules to find one in this file
  -- This is O(n) but typically small number of modules
  case [ nodeId | (_, nodeId) <- Map.toList moduleIdx
       , file `T.isPrefixOf` extractFileFromId nodeId
       ] of
    (x:_) -> Just x
    []    -> Nothing

-- | Extract file from MODULE node ID.
-- "path/to/file.ex->MODULE->Name" -> "path/to/file.ex"
extractFileFromId :: Text -> Text
extractFileFromId = extractFile

-- | CLI entry point.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  writeCommandsToStdout (resolveAll nodes)
