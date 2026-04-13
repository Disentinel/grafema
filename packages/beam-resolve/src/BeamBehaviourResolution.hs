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
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.Set (Set)

-- | Module-name index: module name -> (node ID, file).
--
-- Earlier versions parsed @gnId@ to recover the file path, which only
-- worked for legacy arrow-form IDs. In production the orchestrator sends
-- @gnId@ as a numeric hash, so we keep the file alongside the ID at
-- index-build time and never parse IDs (REG-1097).
type ModuleIndex = Map Text (Text, Text)

-- | File-keyed index: file -> module node ID. Used to find the module
-- that owns a given @\@behaviour@ IMPORT site.
type FileModuleIndex = Map Text Text

-- | Build module indices.
buildIndices :: [GraphNode] -> (ModuleIndex, FileModuleIndex)
buildIndices nodes =
  let mods = [ n | n <- nodes, gnType n == "MODULE" ]
      byName = Map.fromList [ (gnName n, (gnId n, gnFile n)) | n <- mods ]
      byFile = Map.fromList [ (gnFile n, gnId n) | n <- mods ]
  in (byName, byFile)

-- | Find IMPORT nodes that declare a behaviour relationship.
--
-- Two analyzer markers count:
--
--   * @kind = \"behaviour\"@ — the explicit @\@behaviour Foo@ form.
--   * @kind = \"use\"@ — the @use Foo@ macro form. In Elixir convention,
--     @use@ is the canonical way to opt into a behaviour (GenServer,
--     Supervisor, Agent, ExUnit.Case, …); the macro expands to
--     @\@behaviour@ plus boilerplate injections at compile time.
--     beam-analyzer doesn't run macros, so it can't see the implicit
--     @\@behaviour@ — but for the dominant use cases the @use@ alone is
--     a reliable signal that the importing module implements that target.
findBehaviourImports :: [GraphNode] -> [GraphNode]
findBehaviourImports = filter isBehaviourImport

isBehaviourImport :: GraphNode -> Bool
isBehaviourImport n =
  gnType n == "IMPORT" &&
  case Map.lookup "kind" (gnMetadata n) of
    Just (MetaText k) -> k == "behaviour" || k == "use"
    _                 -> False

-- | Resolve all behaviour declarations.
resolveAll :: [GraphNode] -> [PluginCommand]
resolveAll nodes =
  let (moduleIdx, fileIdx) = buildIndices nodes
      behaviourImports     = findBehaviourImports nodes
      (cmds, _seen) = foldl (resolveBehaviour moduleIdx fileIdx)
                            ([], Set.empty :: Set Text)
                            behaviourImports
  in cmds

-- | Stable virtual node ID for a stdlib/external module that the analyzed
-- project depends on but doesn't define. Mirrors the @BEAM_GLOBAL::@
-- prefix used by 'BeamRuntimeGlobals' for stdlib functions, so downstream
-- tooling can recognise external references uniformly.
virtualModuleId :: Text -> Text
virtualModuleId name = "BEAM_GLOBAL::Module::" <> name

-- | Resolve a single @behaviour / @use@ import to an IMPLEMENTS edge.
--
-- Resolution strategy:
--
--   1. If the target module is in the analyzed project, link to its real
--      MODULE node.
--   2. Otherwise the target is stdlib or an external dependency
--      (GenServer, ExUnit.Case, Plug.Router, …). Emit a virtual MODULE
--      node tagged @category=elixir-external@ and link to it. Multiple
--      implementers of the same external behaviour share one virtual node
--      via the seen-set — analogous to how 'BeamRuntimeGlobals' dedupes
--      stdlib function references.
resolveBehaviour
  :: ModuleIndex
  -> FileModuleIndex
  -> ([PluginCommand], Set Text)
  -> GraphNode
  -> ([PluginCommand], Set Text)
resolveBehaviour moduleIdx fileIdx (acc, seen) importNode =
  let behaviourName = gnName importNode
      importFile    = gnFile importNode
      importKind    = case Map.lookup "kind" (gnMetadata importNode) of
        Just (MetaText k) -> k
        _                 -> "behaviour"
  in case Map.lookup importFile fileIdx of
    Nothing -> (acc, seen)
    Just implModuleId ->
      let (targetId, targetCmds, seen') =
            case Map.lookup behaviourName moduleIdx of
              Just (realId, _) -> (realId, [], seen)
              Nothing ->
                let vid = virtualModuleId behaviourName
                    virtualNode = EmitNode GraphNode
                      { gnId        = vid
                      , gnType      = "MODULE"
                      , gnName      = behaviourName
                      , gnFile      = "<runtime/elixir>"
                      , gnLine      = 0
                      , gnColumn    = 0
                      , gnEndLine   = 0
                      , gnEndColumn = 0
                      , gnExported  = True
                      , gnMetadata  = Map.fromList
                          [ ("category", MetaText "elixir-external")
                          , ("source",   MetaText "beam-behaviours")
                          ]
                      }
                in if Set.member vid seen
                     then (vid, [], seen)
                     else (vid, [virtualNode], Set.insert vid seen)
          edge = EmitEdge GraphEdge
            { geSource   = implModuleId
            , geTarget   = targetId
            , geType     = "IMPLEMENTS"
            , geMetadata = Map.fromList
                [ ("resolvedVia", MetaText "beam-behaviours")
                , ("kind",        MetaText "behaviour")
                , ("via",         MetaText importKind)
                ]
            }
      in (acc ++ targetCmds ++ [edge], seen')

-- | CLI entry point.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  writeCommandsToStdout (resolveAll nodes)
