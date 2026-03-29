{-# LANGUAGE OverloadedStrings #-}
-- | Haskell local reference resolution plugin.
--
-- Creates READS_FROM edges for REFERENCE nodes that refer to same-file
-- declarations (FUNCTION, VARIABLE, CONSTANT, DATA_TYPE, TYPE_SYNONYM,
-- CONSTRUCTOR, RECORD_FIELD, PARAMETER).
--
-- Also resolves standard Haskell names (pure, Just, Nothing, return, show, etc.)
-- by creating virtual HASKELL_GLOBAL nodes.
--
-- Skip logic:
--   - Imported names (IMPORT_BINDING) — handled by HaskellImportResolution
module HaskellLocalRefs (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import qualified Data.Set as Set
import Data.Set (Set)

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

-- | Declaration index: (file, name) -> node ID
type DeclIndex = Map (Text, Text) Text

-- | Import binding index: (file, localName)
type ImportIndex = Set (Text, Text)

-- ---------------------------------------------------------------------------
-- Index construction
-- ---------------------------------------------------------------------------

-- | Haskell node types that can be referenced as declarations.
declTypes :: [Text]
declTypes =
  [ "FUNCTION", "VARIABLE", "CONSTANT", "DATA_TYPE"
  , "TYPE_SYNONYM", "CONSTRUCTOR", "RECORD_FIELD"
  , "PARAMETER"
  ]

-- | Build declaration index.
buildDeclIndex :: [GraphNode] -> DeclIndex
buildDeclIndex nodes =
  Map.fromList
    [ ((gnFile n, gnName n), gnId n)
    | n <- nodes
    , gnType n `elem` declTypes
    , not (T.null (gnName n))
    ]

-- | Build import binding index to skip imported names.
buildImportIndex :: [GraphNode] -> ImportIndex
buildImportIndex nodes =
  Set.fromList
    [ (gnFile n, gnName n)
    | n <- nodes
    , gnType n == "IMPORT_BINDING"
    ]

-- | Standard Haskell names (Prelude, base library).
-- These are always in scope without explicit import.
haskellPreludeNames :: Set Text
haskellPreludeNames = Set.fromList
  [ -- Data constructors
    "True", "False", "Just", "Nothing", "Left", "Right"
  , "LT", "EQ", "GT", "IO"
  -- Common functions
  , "pure", "return", "show", "read", "print", "putStrLn", "putStr"
  , "getLine", "getContents", "interact"
  , "map", "filter", "foldl", "foldr", "foldl'", "concatMap", "zip"
  , "head", "tail", "init", "last", "length", "null", "reverse"
  , "take", "drop", "takeWhile", "dropWhile", "span", "break"
  , "elem", "notElem", "lookup", "concat", "replicate"
  , "any", "all", "and", "or", "sum", "product", "maximum", "minimum"
  , "id", "const", "flip", "not", "otherwise", "undefined", "error"
  , "fst", "snd", "curry", "uncurry"
  , "maybe", "either", "fromMaybe", "isJust", "isNothing"
  , "mapM", "mapM_", "forM", "forM_", "sequence", "sequence_"
  , "when", "unless", "guard", "void"
  -- Type classes
  , "Eq", "Ord", "Show", "Read", "Enum", "Bounded", "Num", "Integral"
  , "Fractional", "Floating", "Real", "RealFrac", "RealFloat"
  , "Functor", "Applicative", "Monad", "MonadIO", "Monoid", "Semigroup"
  , "Foldable", "Traversable"
  -- Types
  , "Int", "Integer", "Float", "Double", "Bool", "Char", "String"
  , "Maybe", "Either", "Ordering"
  -- Operators as functions
  , "succ", "pred", "toEnum", "fromEnum"
  , "compare", "max", "min"
  , "negate", "abs", "signum", "fromInteger"
  , "div", "mod", "quot", "rem"
  ]

-- ---------------------------------------------------------------------------
-- Resolution
-- ---------------------------------------------------------------------------

-- | Core resolution logic.
resolveAll :: [GraphNode] -> [PluginCommand]
resolveAll nodes =
  let declIndex   = buildDeclIndex nodes
      importIndex = buildImportIndex nodes
      refNodes    = filter (\n -> gnType n == "REFERENCE") nodes
      (cmds, _seen) = foldl (resolveRef declIndex importIndex)
                             ([], Set.empty :: Set Text) refNodes
  in cmds

-- | Resolve a single REFERENCE node.
-- Returns (accumulated commands, seen global names).
resolveRef :: DeclIndex -> ImportIndex -> ([PluginCommand], Set Text) -> GraphNode -> ([PluginCommand], Set Text)
resolveRef declIndex importIndex (acc, seen) refNode =
  let file = gnFile refNode
      name = gnName refNode
  in
    -- Skip imported names (handled by HaskellImportResolution)
    if Set.member (file, name) importIndex
      then (acc, seen)
    -- Try same-file declaration lookup
    else case Map.lookup (file, name) declIndex of
      Just targetId ->
        ( EmitEdge GraphEdge
            { geSource   = gnId refNode
            , geTarget   = targetId
            , geType     = "READS_FROM"
            , geMetadata = Map.singleton "resolvedVia" (MetaText "haskell-local-refs")
            } : acc
        , seen)
      Nothing ->
        -- Check if it's a known Prelude/base name
        if Set.member name haskellPreludeNames
          then
            let globalId = "HASKELL_GLOBAL::" <> name
                edge = EmitEdge GraphEdge
                  { geSource   = gnId refNode
                  , geTarget   = globalId
                  , geType     = "READS_FROM"
                  , geMetadata = Map.fromList
                      [ ("resolvedVia", MetaText "haskell-local-refs")
                      , ("globalCategory", MetaText "haskell-prelude")
                      ]
                  }
            in if Set.member name seen
                 then (edge : acc, seen)
                 else
                   let virtualNode = EmitNode GraphNode
                         { gnId        = globalId
                         , gnType      = "EXTERNAL_FUNCTION"
                         , gnName      = name
                         , gnFile      = ""
                         , gnExported  = False
                         , gnLine      = 0
                         , gnColumn    = 0
                         , gnEndLine   = 0
                         , gnEndColumn = 0
                         , gnMetadata  = Map.fromList
                             [ ("category", MetaText "haskell-prelude")
                             , ("source", MetaText "haskell-local-refs")
                             ]
                         }
                   in (edge : virtualNode : acc, Set.insert name seen)
          else (acc, seen)

-- ---------------------------------------------------------------------------
-- CLI entry point
-- ---------------------------------------------------------------------------

run :: IO ()
run = do
  nodes <- readNodesFromStdin
  writeCommandsToStdout (resolveAll nodes)
