{-# LANGUAGE OverloadedStrings #-}
-- | BEAM local reference resolution plugin.
--
-- Creates CALLS edges for CALL nodes that refer to same-file
-- FUNCTION definitions. Uses (file, name) index for O(1) lookup.
--
-- For BEAM, function identity is name+arity, so we match
-- CALL.name against FUNCTION.name (both include arity: "foo/2").
--
-- Also creates virtual BEAM_GLOBAL nodes for well-known
-- Elixir/Erlang standard library functions (Kernel, Enum, etc.).
module BeamLocalRefs (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import qualified Data.Set as Set
import Data.Set (Set)

-- | Declaration index: (file, name) -> node ID
-- For BEAM, name includes arity: "foo/2", "bar/1"
type DeclIndex = Map (Text, Text) Text

-- | Build declaration index from FUNCTION nodes.
buildDeclIndex :: [GraphNode] -> DeclIndex
buildDeclIndex nodes =
  Map.fromList
    [ ((gnFile n, gnName n), gnId n)
    | n <- nodes
    , gnType n == "FUNCTION"
    , not (T.null (gnName n))
    ]

-- | Also build a name-only index for calls without arity info.
-- (file, basename) -> node ID
type NameIndex = Map (Text, Text) Text

buildNameIndex :: [GraphNode] -> NameIndex
buildNameIndex nodes =
  Map.fromList
    [ ((gnFile n, extractBaseName (gnName n)), gnId n)
    | n <- nodes
    , gnType n == "FUNCTION"
    , not (T.null (gnName n))
    ]

-- | Extract base name from "foo/2" -> "foo"
extractBaseName :: Text -> Text
extractBaseName t = case T.breakOn "/" t of
  (name, _) -> name

-- | Well-known Elixir/Erlang functions always in scope.
beamBuiltins :: Set Text
beamBuiltins = Set.fromList
  [ -- Kernel functions (auto-imported in Elixir)
    "is_atom", "is_binary", "is_boolean", "is_float", "is_function"
  , "is_integer", "is_list", "is_map", "is_nil", "is_number"
  , "is_pid", "is_port", "is_reference", "is_tuple"
  , "abs", "ceil", "div", "elem", "floor", "hd", "tl"
  , "length", "map_size", "max", "min", "node", "not"
  , "put_elem", "rem", "round", "self", "send", "trunc"
  , "tuple_size", "spawn", "spawn_link", "spawn_monitor"
  , "throw", "exit", "raise"
  -- IO
  , "inspect", "puts"
  -- Erlang BIFs
  , "erlang", "io", "lists", "maps", "ets", "gen_server"
  , "supervisor", "application"
  ]

-- | Core resolution logic.
resolveAll :: [GraphNode] -> [PluginCommand]
resolveAll nodes =
  let declIndex = buildDeclIndex nodes
      nameIndex = buildNameIndex nodes
      callNodes = filter (\n -> gnType n == "CALL") nodes
      (cmds, _seen) = foldl (resolveCall declIndex nameIndex)
                             ([], Set.empty :: Set Text) callNodes
  in cmds

-- | Resolve a single CALL node.
resolveCall :: DeclIndex -> NameIndex -> ([PluginCommand], Set Text) -> GraphNode -> ([PluginCommand], Set Text)
resolveCall declIndex nameIndex (acc, seen) callNode =
  let file = gnFile callNode
      name = gnName callNode
      baseName = extractBaseName name
  in
    -- Try exact match with arity first: "foo/2"
    case Map.lookup (file, name) declIndex of
      Just targetId ->
        ( EmitEdge GraphEdge
            { geSource   = gnId callNode
            , geTarget   = targetId
            , geType     = "CALLS"
            , geMetadata = Map.singleton "resolvedVia" (MetaText "beam-local-refs")
            } : acc
        , seen)
      Nothing ->
        -- Try name-only match (for calls without explicit arity)
        case Map.lookup (file, baseName) nameIndex of
          Just targetId ->
            ( EmitEdge GraphEdge
                { geSource   = gnId callNode
                , geTarget   = targetId
                , geType     = "CALLS"
                , geMetadata = Map.singleton "resolvedVia" (MetaText "beam-local-refs")
                } : acc
            , seen)
          Nothing ->
            -- Check if it's a known builtin
            if Set.member baseName beamBuiltins
              then
                let globalId = "BEAM_GLOBAL::" <> baseName
                    edge = EmitEdge GraphEdge
                      { geSource   = gnId callNode
                      , geTarget   = globalId
                      , geType     = "CALLS"
                      , geMetadata = Map.fromList
                          [ ("resolvedVia", MetaText "beam-local-refs")
                          , ("globalCategory", MetaText "beam-builtin")
                          ]
                      }
                in if Set.member baseName seen
                     then (edge : acc, seen)
                     else
                       let virtualNode = EmitNode GraphNode
                             { gnId        = globalId
                             , gnType      = "EXTERNAL_FUNCTION"
                             , gnName      = baseName
                             , gnFile      = ""
                             , gnExported  = False
                             , gnLine      = 0
                             , gnColumn    = 0
                             , gnEndLine   = 0
                             , gnEndColumn = 0
                             , gnMetadata  = Map.fromList
                                 [ ("category", MetaText "beam-builtin")
                                 , ("source", MetaText "beam-local-refs")
                                 ]
                             }
                       in (edge : virtualNode : acc, Set.insert baseName seen)
              else (acc, seen)

-- | CLI entry point.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  writeCommandsToStdout (resolveAll nodes)
