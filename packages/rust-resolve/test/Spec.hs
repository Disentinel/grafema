{-# LANGUAGE OverloadedStrings #-}
-- | Tests for the Rust import resolution plugin.
--
-- Verifies:
-- * Module index building (file path -> MODULE node ID)
-- * Export index building (pub items only)
-- * Module tree construction (crate root, nested modules, mod.rs)
-- * IMPORT -> MODULE resolution
-- * IMPORT_BINDING -> declaration resolution via source metadata
-- * External crate imports produce no edges
-- * Multiple imports from same module
-- * Edge cases: empty nodes, private items
module Main where

import Test.Hspec
import Data.Text (Text)
import qualified Data.Map.Strict as Map

import RustImportResolution (resolveAll)
import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..))

-- ── Test node constructors ──────────────────────────────────────────

-- | Create a MODULE node for a Rust file.
mkModuleNode :: Text -> Text -> Text -> GraphNode
mkModuleNode name file nodeId = GraphNode
  { gnId        = nodeId
  , gnType      = "MODULE"
  , gnName      = name
  , gnFile      = file
  , gnLine      = 1
  , gnColumn    = 0
  , gnEndLine   = 0
  , gnEndColumn = 0
  , gnExported  = True
  , gnMetadata  = Map.empty
  }

-- | Create a FUNCTION node.
mkFunctionNode :: Text -> Text -> Text -> Bool -> GraphNode
mkFunctionNode name file nodeId exported = GraphNode
  { gnId        = nodeId
  , gnType      = "FUNCTION"
  , gnName      = name
  , gnFile      = file
  , gnLine      = 5
  , gnColumn    = 0
  , gnEndLine   = 10
  , gnEndColumn = 1
  , gnExported  = exported
  , gnMetadata  = Map.empty
  }

-- | Create a STRUCT node.
mkStructNode :: Text -> Text -> Text -> Bool -> GraphNode
mkStructNode name file nodeId exported = GraphNode
  { gnId        = nodeId
  , gnType      = "STRUCT"
  , gnName      = name
  , gnFile      = file
  , gnLine      = 3
  , gnColumn    = 0
  , gnEndLine   = 8
  , gnEndColumn = 1
  , gnExported  = exported
  , gnMetadata  = Map.empty
  }

-- | Create an ENUM node.
mkEnumNode :: Text -> Text -> Text -> Bool -> GraphNode
mkEnumNode name file nodeId exported = GraphNode
  { gnId        = nodeId
  , gnType      = "ENUM"
  , gnName      = name
  , gnFile      = file
  , gnLine      = 3
  , gnColumn    = 0
  , gnEndLine   = 8
  , gnEndColumn = 1
  , gnExported  = exported
  , gnMetadata  = Map.empty
  }

-- | Create a TRAIT node.
mkTraitNode :: Text -> Text -> Text -> Bool -> GraphNode
mkTraitNode name file nodeId exported = GraphNode
  { gnId        = nodeId
  , gnType      = "TRAIT"
  , gnName      = name
  , gnFile      = file
  , gnLine      = 3
  , gnColumn    = 0
  , gnEndLine   = 8
  , gnEndColumn = 1
  , gnExported  = exported
  , gnMetadata  = Map.empty
  }

-- | Create an IMPORT node (use statement at module level).
mkImportNode :: Text -> Text -> Text -> GraphNode
mkImportNode modulePath file nodeId = GraphNode
  { gnId        = nodeId
  , gnType      = "IMPORT"
  , gnName      = modulePath
  , gnFile      = file
  , gnLine      = 1
  , gnColumn    = 0
  , gnEndLine   = 1
  , gnEndColumn = 20
  , gnExported  = False
  , gnMetadata  = Map.empty
  }

-- | Create an IMPORT_BINDING node with source metadata.
-- The source metadata contains the full path (e.g. "crate::foo::Bar").
mkImportBindingNode :: Text -> Text -> Text -> Text -> GraphNode
mkImportBindingNode name source file nodeId = GraphNode
  { gnId        = nodeId
  , gnType      = "IMPORT_BINDING"
  , gnName      = name
  , gnFile      = file
  , gnLine      = 1
  , gnColumn    = 0
  , gnEndLine   = 1
  , gnEndColumn = 20
  , gnExported  = False
  , gnMetadata  = Map.fromList [("source", MetaText source)]
  }

-- ── Helpers ─────────────────────────────────────────────────────────

-- | Extract edges from plugin commands, ignoring EmitNode commands.
extractEdges :: [PluginCommand] -> [GraphEdge]
extractEdges = concatMap go
  where
    go (EmitEdge e) = [e]
    go _            = []

-- | Count IMPORTS_FROM edges in a list of plugin commands.
countImportsFrom :: [PluginCommand] -> Int
countImportsFrom cmds = length $ filter isImportsFrom (extractEdges cmds)
  where
    isImportsFrom e = geType e == "IMPORTS_FROM"

main :: IO ()
main = hspec $ do

  -- ── 1. Module index ──────────────────────────────────────────────
  describe "Module index" $ do

    it "builds index from MODULE nodes keyed by file path" $ do
      let nodes =
            [ mkModuleNode "foo" "src/foo.rs" "MODULE#src/foo.rs"
            , mkModuleNode "lib" "src/lib.rs" "MODULE#src/lib.rs"
            , mkFunctionNode "bar" "src/foo.rs" "src/foo.rs->FUNCTION->bar" True
            ]
      -- Verify via resolveAll that MODULE nodes are indexed
      -- (an IMPORT targeting "crate::foo" should resolve)
      commands <- resolveAll
        ( nodes ++
          [ mkImportNode "crate::foo" "src/main.rs" "src/main.rs->IMPORT->crate::foo"
          ]
        )
      let edges = extractEdges commands
      let moduleEdges = filter (\e -> geSource e == "src/main.rs->IMPORT->crate::foo") edges
      length moduleEdges `shouldBe` 1
      case moduleEdges of
        [edge] -> geTarget edge `shouldBe` "MODULE#src/foo.rs"
        _ -> expectationFailure "Expected 1 module edge"

  -- ── 2. Export index ──────────────────────────────────────────────
  describe "Export index" $ do

    it "includes pub items in export index" $ do
      let nodes =
            [ mkModuleNode "foo" "src/foo.rs" "MODULE#src/foo.rs"
            , mkFunctionNode "do_stuff" "src/foo.rs" "src/foo.rs->FUNCTION->do_stuff" True
            , mkImportBindingNode "do_stuff" "crate::foo::do_stuff" "src/main.rs"
                "src/main.rs->IMPORT_BINDING->do_stuff"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      let bindingEdges = filter (\e -> geSource e == "src/main.rs->IMPORT_BINDING->do_stuff") edges
      length bindingEdges `shouldBe` 1
      case bindingEdges of
        [edge] -> geTarget edge `shouldBe` "src/foo.rs->FUNCTION->do_stuff"
        _ -> expectationFailure "Expected 1 binding edge"

    it "excludes private items from export index" $ do
      let nodes =
            [ mkModuleNode "foo" "src/foo.rs" "MODULE#src/foo.rs"
            , mkFunctionNode "private_fn" "src/foo.rs" "src/foo.rs->FUNCTION->private_fn" False
            , mkImportBindingNode "private_fn" "crate::foo::private_fn" "src/main.rs"
                "src/main.rs->IMPORT_BINDING->private_fn"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      let bindingEdges = filter (\e -> geSource e == "src/main.rs->IMPORT_BINDING->private_fn") edges
      length bindingEdges `shouldBe` 0

  -- ── 3. Module tree ───────────────────────────────────────────────
  describe "Module tree" $ do

    it "maps crate root from lib.rs" $ do
      let nodes =
            [ mkModuleNode "lib" "src/lib.rs" "MODULE#src/lib.rs"
            , mkImportNode "crate" "src/foo.rs" "src/foo.rs->IMPORT->crate"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      let moduleEdges = filter (\e -> geSource e == "src/foo.rs->IMPORT->crate") edges
      length moduleEdges `shouldBe` 1
      case moduleEdges of
        [edge] -> geTarget edge `shouldBe` "MODULE#src/lib.rs"
        _ -> expectationFailure "Expected 1 edge to crate root"

    it "maps crate root from main.rs" $ do
      let nodes =
            [ mkModuleNode "main" "src/main.rs" "MODULE#src/main.rs"
            , mkImportNode "crate" "src/foo.rs" "src/foo.rs->IMPORT->crate"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      let moduleEdges = filter (\e -> geSource e == "src/foo.rs->IMPORT->crate") edges
      length moduleEdges `shouldBe` 1
      case moduleEdges of
        [edge] -> geTarget edge `shouldBe` "MODULE#src/main.rs"
        _ -> expectationFailure "Expected 1 edge to crate root"

    it "maps module from src/foo.rs" $ do
      let nodes =
            [ mkModuleNode "foo" "src/foo.rs" "MODULE#src/foo.rs"
            , mkImportNode "crate::foo" "src/main.rs" "src/main.rs->IMPORT->crate::foo"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      length edges `shouldBe` 1
      case edges of
        [edge] -> do
          geSource edge `shouldBe` "src/main.rs->IMPORT->crate::foo"
          geTarget edge `shouldBe` "MODULE#src/foo.rs"
        _ -> expectationFailure "Expected 1 edge"

    it "maps module from src/foo/mod.rs" $ do
      let nodes =
            [ mkModuleNode "foo" "src/foo/mod.rs" "MODULE#src/foo/mod.rs"
            , mkImportNode "crate::foo" "src/main.rs" "src/main.rs->IMPORT->crate::foo"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      length edges `shouldBe` 1
      case edges of
        [edge] -> do
          geSource edge `shouldBe` "src/main.rs->IMPORT->crate::foo"
          geTarget edge `shouldBe` "MODULE#src/foo/mod.rs"
        _ -> expectationFailure "Expected 1 edge"

    it "maps nested module from src/foo/bar.rs" $ do
      let nodes =
            [ mkModuleNode "bar" "src/foo/bar.rs" "MODULE#src/foo/bar.rs"
            , mkImportNode "crate::foo::bar" "src/main.rs" "src/main.rs->IMPORT->crate::foo::bar"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      length edges `shouldBe` 1
      case edges of
        [edge] -> do
          geSource edge `shouldBe` "src/main.rs->IMPORT->crate::foo::bar"
          geTarget edge `shouldBe` "MODULE#src/foo/bar.rs"
        _ -> expectationFailure "Expected 1 edge"

  -- ── 4. IMPORT -> MODULE resolution ───────────────────────────────
  describe "IMPORT -> MODULE resolution" $ do

    it "resolves IMPORT to MODULE in same crate" $ do
      let nodes =
            [ mkModuleNode "models" "src/models.rs" "MODULE#src/models.rs"
            , mkImportNode "crate::models" "src/main.rs" "src/main.rs->IMPORT->crate::models"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      length edges `shouldBe` 1
      case edges of
        [edge] -> do
          geType   edge `shouldBe` "IMPORTS_FROM"
          geSource edge `shouldBe` "src/main.rs->IMPORT->crate::models"
          geTarget edge `shouldBe` "MODULE#src/models.rs"
        _ -> expectationFailure $ "Expected 1 edge, got " ++ show (length edges)

  -- ── 5. IMPORT_BINDING -> declaration resolution ──────────────────
  describe "IMPORT_BINDING -> declaration resolution" $ do

    it "resolves crate::foo::Bar struct import" $ do
      let nodes =
            [ mkModuleNode  "foo" "src/foo.rs" "MODULE#src/foo.rs"
            , mkStructNode  "Bar" "src/foo.rs" "src/foo.rs->STRUCT->Bar" True
            , mkImportBindingNode "Bar" "crate::foo::Bar" "src/main.rs"
                "src/main.rs->IMPORT_BINDING->Bar"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      let bindingEdges = filter (\e -> geSource e == "src/main.rs->IMPORT_BINDING->Bar") edges
      length bindingEdges `shouldBe` 1
      case bindingEdges of
        [edge] -> do
          geType   edge `shouldBe` "IMPORTS_FROM"
          geTarget edge `shouldBe` "src/foo.rs->STRUCT->Bar"
        _ -> expectationFailure "Expected 1 binding edge"

    it "resolves function import from nested module" $ do
      let nodes =
            [ mkModuleNode    "bar" "src/foo/bar.rs" "MODULE#src/foo/bar.rs"
            , mkFunctionNode  "process" "src/foo/bar.rs" "src/foo/bar.rs->FUNCTION->process" True
            , mkImportBindingNode "process" "crate::foo::bar::process" "src/main.rs"
                "src/main.rs->IMPORT_BINDING->process"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      let bindingEdges = filter (\e -> geSource e == "src/main.rs->IMPORT_BINDING->process") edges
      length bindingEdges `shouldBe` 1
      case bindingEdges of
        [edge] -> geTarget edge `shouldBe` "src/foo/bar.rs->FUNCTION->process"
        _ -> expectationFailure "Expected 1 binding edge"

  -- ── 6. External crate imports ────────────────────────────────────
  describe "External crate imports" $ do

    it "skips std library imports" $ do
      let nodes =
            [ mkImportNode "std::io" "src/main.rs" "src/main.rs->IMPORT->std::io"
            , mkImportBindingNode "Read" "std::io::Read" "src/main.rs"
                "src/main.rs->IMPORT_BINDING->Read"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      length edges `shouldBe` 0

    it "skips third-party crate imports" $ do
      let nodes =
            [ mkImportNode "serde::Serialize" "src/main.rs" "src/main.rs->IMPORT->serde::Serialize"
            , mkImportBindingNode "Serialize" "serde::Serialize" "src/main.rs"
                "src/main.rs->IMPORT_BINDING->Serialize"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      length edges `shouldBe` 0

  -- ── 7. Pub visibility ────────────────────────────────────────────
  describe "Pub visibility" $ do

    it "resolves pub fn but not private fn" $ do
      let nodes =
            [ mkModuleNode    "utils" "src/utils.rs" "MODULE#src/utils.rs"
            , mkFunctionNode  "public_fn" "src/utils.rs" "src/utils.rs->FUNCTION->public_fn" True
            , mkFunctionNode  "private_fn" "src/utils.rs" "src/utils.rs->FUNCTION->private_fn" False
            , mkImportBindingNode "public_fn" "crate::utils::public_fn" "src/main.rs"
                "src/main.rs->IMPORT_BINDING->public_fn"
            , mkImportBindingNode "private_fn" "crate::utils::private_fn" "src/main.rs"
                "src/main.rs->IMPORT_BINDING->private_fn"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      -- public_fn should resolve
      let pubEdges = filter (\e -> geSource e == "src/main.rs->IMPORT_BINDING->public_fn") edges
      length pubEdges `shouldBe` 1
      -- private_fn should NOT resolve
      let privEdges = filter (\e -> geSource e == "src/main.rs->IMPORT_BINDING->private_fn") edges
      length privEdges `shouldBe` 0

  -- ── 8. Multiple bindings from same module ────────────────────────
  describe "Multiple bindings from same module" $ do

    it "resolves multiple imports from the same module" $ do
      let nodes =
            [ mkModuleNode    "models" "src/models.rs" "MODULE#src/models.rs"
            , mkStructNode    "User" "src/models.rs" "src/models.rs->STRUCT->User" True
            , mkStructNode    "Post" "src/models.rs" "src/models.rs->STRUCT->Post" True
            , mkEnumNode      "Role" "src/models.rs" "src/models.rs->ENUM->Role" True
            , mkImportBindingNode "User" "crate::models::User" "src/main.rs"
                "src/main.rs->IMPORT_BINDING->User"
            , mkImportBindingNode "Post" "crate::models::Post" "src/main.rs"
                "src/main.rs->IMPORT_BINDING->Post"
            , mkImportBindingNode "Role" "crate::models::Role" "src/main.rs"
                "src/main.rs->IMPORT_BINDING->Role"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      let bindingEdges = filter (\e ->
               geSource e == "src/main.rs->IMPORT_BINDING->User"
            || geSource e == "src/main.rs->IMPORT_BINDING->Post"
            || geSource e == "src/main.rs->IMPORT_BINDING->Role") edges
      length bindingEdges `shouldBe` 3

  -- ── 9. Empty nodes ───────────────────────────────────────────────
  describe "Empty nodes" $ do

    it "returns 0 edges for empty input" $ do
      commands <- resolveAll []
      countImportsFrom commands `shouldBe` 0

  -- ── 10. Trait resolution ─────────────────────────────────────────
  describe "Trait resolution" $ do

    it "resolves trait import" $ do
      let nodes =
            [ mkModuleNode   "traits" "src/traits.rs" "MODULE#src/traits.rs"
            , mkTraitNode    "Drawable" "src/traits.rs" "src/traits.rs->TRAIT->Drawable" True
            , mkImportBindingNode "Drawable" "crate::traits::Drawable" "src/main.rs"
                "src/main.rs->IMPORT_BINDING->Drawable"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      let bindingEdges = filter (\e -> geSource e == "src/main.rs->IMPORT_BINDING->Drawable") edges
      length bindingEdges `shouldBe` 1
      case bindingEdges of
        [edge] -> do
          geType   edge `shouldBe` "IMPORTS_FROM"
          geTarget edge `shouldBe` "src/traits.rs->TRAIT->Drawable"
        _ -> expectationFailure "Expected 1 binding edge"

  -- ── 11. No IMPORT_BINDING nodes ──────────────────────────────────
  describe "No IMPORT_BINDING nodes" $ do

    it "only produces IMPORT -> MODULE edges when no bindings exist" $ do
      let nodes =
            [ mkModuleNode "foo" "src/foo.rs" "MODULE#src/foo.rs"
            , mkModuleNode "bar" "src/bar.rs" "MODULE#src/bar.rs"
            , mkImportNode "crate::foo" "src/main.rs" "src/main.rs->IMPORT->crate::foo"
            , mkImportNode "crate::bar" "src/main.rs" "src/main.rs->IMPORT->crate::bar"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      length edges `shouldBe` 2
      -- Both should be IMPORTS_FROM edges
      mapM_ (\e -> geType e `shouldBe` "IMPORTS_FROM") edges
      let sources = map geSource edges
      sources `shouldContain` ["src/main.rs->IMPORT->crate::foo"]
      sources `shouldContain` ["src/main.rs->IMPORT->crate::bar"]

  -- ── 12. Missing source metadata ──────────────────────────────────
  describe "Missing source metadata" $ do

    it "produces no edge when IMPORT_BINDING has no source metadata" $ do
      let bindingNoMeta = GraphNode
            { gnId        = "src/main.rs->IMPORT_BINDING->Foo"
            , gnType      = "IMPORT_BINDING"
            , gnName      = "Foo"
            , gnFile      = "src/main.rs"
            , gnLine      = 1
            , gnColumn    = 0
            , gnEndLine   = 1
            , gnEndColumn = 10
            , gnExported  = False
            , gnMetadata  = Map.empty  -- no source metadata
            }
          nodes =
            [ mkModuleNode  "foo" "src/foo.rs" "MODULE#src/foo.rs"
            , mkStructNode  "Foo" "src/foo.rs" "src/foo.rs->STRUCT->Foo" True
            , bindingNoMeta
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      let bindingEdges = filter (\e -> geSource e == "src/main.rs->IMPORT_BINDING->Foo") edges
      length bindingEdges `shouldBe` 0
