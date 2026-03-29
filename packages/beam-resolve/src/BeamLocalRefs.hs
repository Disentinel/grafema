{-# LANGUAGE OverloadedStrings #-}
-- | BEAM local reference resolution plugin.
--
-- Creates CALLS edges for CALL nodes that refer to same-file
-- FUNCTION definitions. Uses (file, name) index for O(1) lookup.
--
-- For BEAM, function identity is name+arity, so we match
-- CALL.name against FUNCTION.name (both include arity: "foo/2").
--
-- Also resolves cross-file qualified calls like @Accounts.list_users()@
-- to their target FUNCTION node. Qualified calls are identified by a
-- dot in the call name. The module part is matched by suffix against
-- MODULE node names, and the function part is looked up in the
-- module-qualified function index.
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
import Data.Maybe (listToMaybe)

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

-- | Cross-file qualified function index: "ModuleName.func_name" -> node ID.
-- Built from MODULE nodes (for module names) and FUNCTION nodes
-- (for functions belonging to those modules, identified by [in:ModuleName]
-- in their semantic ID).
type QualifiedIndex = Map Text Text

-- | Module suffix index: maps each suffix of a module name to its full name.
-- E.g., for module "MyApp.Accounts":
--   "Accounts" -> ["MyApp.Accounts"]
--   "MyApp.Accounts" -> ["MyApp.Accounts"]
-- Used to resolve short aliases like Accounts.list_users to MyApp.Accounts.list_users.
type ModuleSuffixIndex = Map Text [Text]

-- | Build cross-file qualified function index and module suffix index.
--
-- For each FUNCTION node, extract its containing module from the
-- semantic ID pattern "[in:ModuleName]". Build keys like
-- "ModuleName.func_base_name" -> node ID.
--
-- For suffix matching, also build entries for each dot-suffix of the
-- module name.
buildQualifiedIndex :: [GraphNode] -> (QualifiedIndex, ModuleSuffixIndex)
buildQualifiedIndex nodes =
  let -- Collect all module names from MODULE nodes
      moduleNames = [ gnName n | n <- nodes, gnType n == "MODULE", not (T.null (gnName n)) ]

      -- Build suffix index: each suffix of a module name maps to that module name
      suffixIdx = foldl addModuleSuffixes Map.empty moduleNames

      -- Build qualified index from FUNCTION nodes
      qualIdx = Map.fromList
        [ (modName <> "." <> extractBaseName (gnName n), gnId n)
        | n <- nodes
        , gnType n == "FUNCTION"
        , not (T.null (gnName n))
        , Just modName <- [extractModuleFromId (gnId n)]
        ]
  in (qualIdx, suffixIdx)

-- | Add all dot-suffixes of a module name to the suffix index.
-- E.g., "MyApp.Accounts" -> suffixes: ["MyApp.Accounts", "Accounts"]
addModuleSuffixes :: ModuleSuffixIndex -> Text -> ModuleSuffixIndex
addModuleSuffixes idx modName =
  foldl (\acc sfx -> Map.insertWith (++) sfx [modName] acc) idx (dotSuffixes modName)

-- | Get all dot-suffixes of a dotted name.
-- "A.B.C" -> ["A.B.C", "B.C", "C"]
dotSuffixes :: Text -> [Text]
dotSuffixes t
  | T.null t  = []
  | otherwise = t : case T.breakOn "." t of
      (_, rest)
        | T.null rest -> []
        | otherwise   -> dotSuffixes (T.drop 1 rest)

-- | Extract module name from a FUNCTION node's semantic ID.
-- Pattern: "file->FUNCTION->func_name[in:ModuleName]"
-- Returns the ModuleName from the [in:...] suffix.
extractModuleFromId :: Text -> Maybe Text
extractModuleFromId nodeId =
  case T.breakOn "[in:" nodeId of
    (_, rest)
      | T.null rest -> Nothing
      | otherwise   ->
          let afterPrefix = T.drop 4 rest  -- drop "[in:"
          in case T.breakOn "]" afterPrefix of
            (modName, suffix)
              | T.null suffix -> Nothing
              | otherwise     -> Just modName

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
      (qualIndex, suffixIndex) = buildQualifiedIndex nodes
      callNodes = filter (\n -> gnType n == "CALL") nodes
      (cmds, _seen) = foldl (resolveCall declIndex nameIndex qualIndex suffixIndex)
                             ([], Set.empty :: Set Text) callNodes
  in cmds

-- | Check if a call name is a qualified call (contains a dot).
-- "Accounts.list_users" -> True
-- "helper" -> False
isQualifiedCall :: Text -> Bool
isQualifiedCall name = T.any (== '.') name

-- | Split a qualified call name into (modulePart, funcPart).
-- "Accounts.list_users" -> ("Accounts", "list_users")
-- Uses the LAST dot as separator (module can have dots).
splitQualifiedCall :: Text -> (Text, Text)
splitQualifiedCall name =
  let parts = T.splitOn "." name
      funcPart = last parts
      modPart = T.intercalate "." (init parts)
  in (modPart, funcPart)

-- | Look up a qualified call in the cross-file index.
-- Tries exact match first, then suffix-based matching.
lookupQualified :: QualifiedIndex -> ModuleSuffixIndex -> Text -> Text -> Maybe Text
lookupQualified qualIdx suffixIdx modAlias funcName =
  -- Try exact qualified key first: "ModAlias.func_name"
  let exactKey = modAlias <> "." <> funcName
  in case Map.lookup exactKey qualIdx of
    Just targetId -> Just targetId
    Nothing ->
      -- Try suffix-based: modAlias might be a short alias.
      -- Look up full module names that end with modAlias.
      case Map.lookup modAlias suffixIdx of
        Just fullModNames ->
          -- Try each full module name
          listToMaybe [ targetId
                      | fullMod <- fullModNames
                      , let key = fullMod <> "." <> funcName
                      , Just targetId <- [Map.lookup key qualIdx]
                      ]
        Nothing -> Nothing

-- | Resolve a single CALL node.
resolveCall :: DeclIndex -> NameIndex -> QualifiedIndex -> ModuleSuffixIndex
            -> ([PluginCommand], Set Text) -> GraphNode -> ([PluginCommand], Set Text)
resolveCall declIndex nameIndex qualIndex suffixIndex (acc, seen) callNode =
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
            -- Try cross-file qualified call resolution
            if isQualifiedCall baseName
              then
                let (modAlias, funcName) = splitQualifiedCall baseName
                in case lookupQualified qualIndex suffixIndex modAlias funcName of
                  Just targetId ->
                    ( EmitEdge GraphEdge
                        { geSource   = gnId callNode
                        , geTarget   = targetId
                        , geType     = "CALLS"
                        , geMetadata = Map.fromList
                            [ ("resolvedVia", MetaText "beam-local-refs")
                            , ("crossFile", MetaBool True)
                            ]
                        } : acc
                    , seen)
                  Nothing -> tryBuiltin baseName acc seen callNode
              else tryBuiltin baseName acc seen callNode

-- | Try to resolve a call as a known builtin, or leave it unresolved.
tryBuiltin :: Text -> [PluginCommand] -> Set Text -> GraphNode -> ([PluginCommand], Set Text)
tryBuiltin baseName acc seen callNode =
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
