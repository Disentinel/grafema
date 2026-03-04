{-# LANGUAGE OverloadedStrings #-}
-- | Tests for the Haskell import resolution plugin.
--
-- Verifies:
-- * IMPORT -> MODULE resolution via module index
-- * IMPORT_BINDING -> FUNCTION/DATA_TYPE resolution via export index
-- * Implicit exports (no EXPORT_BINDING nodes) vs explicit exports
-- * External packages (not in module index) produce no edges
-- * Semantic ID parsing with hash suffixes
-- * Multiple imports from same module
-- * Edge cases: empty nodes, no bindings
module Main where

import Test.Hspec
import Data.Text (Text)
import qualified Data.Map.Strict as Map

import HaskellImportResolution (resolveAll)
import Grafema.Types (GraphNode(..), GraphEdge(..))
import Grafema.Protocol (PluginCommand(..))

-- ── Test node constructors ──────────────────────────────────────────

mkModuleNode :: Text -> Text -> Text -> GraphNode
mkModuleNode name file nodeId = GraphNode
  { gnId       = nodeId
  , gnType     = "MODULE"
  , gnName     = name
  , gnFile     = file
  , gnLine     = 1
  , gnColumn   = 0
  , gnExported = True
  , gnMetadata = Map.empty
  }

mkFunctionNode :: Text -> Text -> Text -> Bool -> GraphNode
mkFunctionNode name file nodeId exported = GraphNode
  { gnId       = nodeId
  , gnType     = "FUNCTION"
  , gnName     = name
  , gnFile     = file
  , gnLine     = 5
  , gnColumn   = 0
  , gnExported = exported
  , gnMetadata = Map.empty
  }

mkImportNode :: Text -> Text -> Text -> GraphNode
mkImportNode moduleName file nodeId = GraphNode
  { gnId       = nodeId
  , gnType     = "IMPORT"
  , gnName     = moduleName
  , gnFile     = file
  , gnLine     = 1
  , gnColumn   = 0
  , gnExported = False
  , gnMetadata = Map.empty
  }

mkImportBindingNode :: Text -> Text -> Text -> Text -> GraphNode
mkImportBindingNode name _moduleName file nodeId = GraphNode
  { gnId       = nodeId
  , gnType     = "IMPORT_BINDING"
  , gnName     = name
  , gnFile     = file
  , gnLine     = 1
  , gnColumn   = 0
  , gnExported = False
  , gnMetadata = Map.empty
  }

mkExportBindingNode :: Text -> Text -> Text -> GraphNode
mkExportBindingNode name file nodeId = GraphNode
  { gnId       = nodeId
  , gnType     = "EXPORT_BINDING"
  , gnName     = name
  , gnFile     = file
  , gnLine     = 0
  , gnColumn   = 0
  , gnExported = True
  , gnMetadata = Map.empty
  }

mkDataTypeNode :: Text -> Text -> Text -> GraphNode
mkDataTypeNode name file nodeId = GraphNode
  { gnId       = nodeId
  , gnType     = "DATA_TYPE"
  , gnName     = name
  , gnFile     = file
  , gnLine     = 3
  , gnColumn   = 0
  , gnExported = True
  , gnMetadata = Map.empty
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

  -- ── 1. IMPORT -> MODULE resolution ──────────────────────────────
  describe "IMPORT -> MODULE resolution" $ do

    it "resolves IMPORT to MODULE in same project" $ do
      let nodes =
            [ mkModuleNode "Lib" "src/Lib.hs" "MODULE#src/Lib.hs"
            , mkImportNode "Lib" "src/Main.hs" "src/Main.hs->IMPORT->Lib"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      length edges `shouldBe` 1
      case edges of
        [edge] -> do
          geType   edge `shouldBe` "IMPORTS_FROM"
          geSource edge `shouldBe` "src/Main.hs->IMPORT->Lib"
          geTarget edge `shouldBe` "MODULE#src/Lib.hs"
        _ -> expectationFailure $ "Expected 1 edge, got " ++ show (length edges)

  -- ── 2. IMPORT_BINDING -> FUNCTION (implicit exports) ────────────
  describe "IMPORT_BINDING -> FUNCTION (implicit exports)" $ do

    it "resolves binding to function when no EXPORT_BINDING exists" $ do
      let nodes =
            [ mkModuleNode   "Lib" "src/Lib.hs" "MODULE#src/Lib.hs"
            , mkFunctionNode "foo" "src/Lib.hs" "src/Lib.hs->FUNCTION->foo" True
            , mkImportNode   "Lib" "src/Main.hs" "src/Main.hs->IMPORT->Lib"
            , mkImportBindingNode "foo" "Lib" "src/Main.hs"
                "src/Main.hs->IMPORT_BINDING->foo[in:Lib]"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      -- Should have: 1 IMPORT->MODULE edge + 1 IMPORT_BINDING->FUNCTION edge
      let bindingEdges = filter (\e -> geSource e == "src/Main.hs->IMPORT_BINDING->foo[in:Lib]") edges
      length bindingEdges `shouldBe` 1
      case bindingEdges of
        [edge] -> do
          geType   edge `shouldBe` "IMPORTS_FROM"
          geTarget edge `shouldBe` "src/Lib.hs->FUNCTION->foo"
        _ -> expectationFailure $ "Expected 1 binding edge, got " ++ show (length bindingEdges)

  -- ── 3. Explicit exports ──────────────────────────────────────────
  describe "Explicit exports" $ do

    it "resolves binding to exported function, rejects non-exported" $ do
      let nodes =
            [ mkModuleNode       "Lib" "src/Lib.hs" "MODULE#src/Lib.hs"
            , mkFunctionNode     "foo" "src/Lib.hs" "src/Lib.hs->FUNCTION->foo" True
            , mkFunctionNode     "bar" "src/Lib.hs" "src/Lib.hs->FUNCTION->bar" True
            , mkExportBindingNode "foo" "src/Lib.hs" "src/Lib.hs->EXPORT_BINDING->foo"
            -- bar is NOT in export list
            , mkImportNode       "Lib" "src/Main.hs" "src/Main.hs->IMPORT->Lib"
            , mkImportBindingNode "foo" "Lib" "src/Main.hs"
                "src/Main.hs->IMPORT_BINDING->foo[in:Lib]"
            , mkImportBindingNode "bar" "Lib" "src/Main.hs"
                "src/Main.hs->IMPORT_BINDING->bar[in:Lib]"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      -- foo should resolve (it's in the export list)
      let fooEdges = filter (\e -> geSource e == "src/Main.hs->IMPORT_BINDING->foo[in:Lib]") edges
      case fooEdges of
        [edge] -> geTarget edge `shouldBe` "src/Lib.hs->EXPORT_BINDING->foo"
        _      -> expectationFailure $ "Expected 1 foo edge, got " ++ show (length fooEdges)
      -- bar should NOT resolve (not in the export list)
      let barEdges = filter (\e -> geSource e == "src/Main.hs->IMPORT_BINDING->bar[in:Lib]") edges
      length barEdges `shouldBe` 0

  -- ── 4. External package (not in module index) ───────────────────
  describe "External package" $ do

    it "produces no edges for modules not in the index" $ do
      let nodes =
            [ mkImportNode "Data.Map" "src/Main.hs" "src/Main.hs->IMPORT->Data.Map"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      length edges `shouldBe` 0

  -- ── 5. DATA_TYPE resolution ─────────────────────────────────────
  describe "DATA_TYPE resolution" $ do

    it "resolves binding to DATA_TYPE" $ do
      let nodes =
            [ mkModuleNode   "Types" "src/Types.hs" "MODULE#src/Types.hs"
            , mkDataTypeNode "Color" "src/Types.hs" "src/Types.hs->DATA_TYPE->Color"
            , mkImportNode   "Types" "src/Main.hs" "src/Main.hs->IMPORT->Types"
            , mkImportBindingNode "Color" "Types" "src/Main.hs"
                "src/Main.hs->IMPORT_BINDING->Color[in:Types]"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      let bindingEdges = filter (\e -> geSource e == "src/Main.hs->IMPORT_BINDING->Color[in:Types]") edges
      length bindingEdges `shouldBe` 1
      case bindingEdges of
        [edge] -> do
          geType   edge `shouldBe` "IMPORTS_FROM"
          geTarget edge `shouldBe` "src/Types.hs->DATA_TYPE->Color"
        _ -> expectationFailure $ "Expected 1 binding edge, got " ++ show (length bindingEdges)

  -- ── 6. Multiple imports from same module ────────────────────────
  describe "Multiple imports from same module" $ do

    it "resolves multiple bindings from the same module" $ do
      let nodes =
            [ mkModuleNode   "Lib" "src/Lib.hs" "MODULE#src/Lib.hs"
            , mkFunctionNode "foo" "src/Lib.hs" "src/Lib.hs->FUNCTION->foo" True
            , mkFunctionNode "bar" "src/Lib.hs" "src/Lib.hs->FUNCTION->bar" True
            , mkImportNode   "Lib" "src/Main.hs" "src/Main.hs->IMPORT->Lib"
            , mkImportBindingNode "foo" "Lib" "src/Main.hs"
                "src/Main.hs->IMPORT_BINDING->foo[in:Lib]"
            , mkImportBindingNode "bar" "Lib" "src/Main.hs"
                "src/Main.hs->IMPORT_BINDING->bar[in:Lib]"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      let bindingEdges = filter (\e ->
                geSource e == "src/Main.hs->IMPORT_BINDING->foo[in:Lib]"
             || geSource e == "src/Main.hs->IMPORT_BINDING->bar[in:Lib]") edges
      length bindingEdges `shouldBe` 2

  -- ── 7. Empty nodes ──────────────────────────────────────────────
  describe "Empty nodes" $ do

    it "returns 0 edges for empty input" $ do
      commands <- resolveAll []
      countImportsFrom commands `shouldBe` 0

  -- ── 8. No IMPORT_BINDING nodes ──────────────────────────────────
  describe "No IMPORT_BINDING nodes" $ do

    it "only produces IMPORT -> MODULE edges when no bindings exist" $ do
      let nodes =
            [ mkModuleNode "Lib"  "src/Lib.hs"  "MODULE#src/Lib.hs"
            , mkModuleNode "Util" "src/Util.hs" "MODULE#src/Util.hs"
            , mkImportNode "Lib"  "src/Main.hs" "src/Main.hs->IMPORT->Lib"
            , mkImportNode "Util" "src/Main.hs" "src/Main.hs->IMPORT->Util"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      length edges `shouldBe` 2
      -- Both should be IMPORT -> MODULE edges
      mapM_ (\e -> geType e `shouldBe` "IMPORTS_FROM") edges
      let sources = map geSource edges
      sources `shouldContain` ["src/Main.hs->IMPORT->Lib"]
      sources `shouldContain` ["src/Main.hs->IMPORT->Util"]

  -- ── 9. Semantic ID with hash suffix ─────────────────────────────
  describe "Semantic ID with hash suffix" $ do

    it "extracts module name from ID with hash suffix" $ do
      let nodes =
            [ mkModuleNode   "Lib" "src/Lib.hs" "MODULE#src/Lib.hs"
            , mkFunctionNode "foo" "src/Lib.hs" "src/Lib.hs->FUNCTION->foo" True
            , mkImportNode   "Lib" "src/Main.hs" "src/Main.hs->IMPORT->Lib"
            , mkImportBindingNode "foo" "Lib" "src/Main.hs"
                "src/Main.hs->IMPORT_BINDING->foo[in:Lib,h:5:0]"
            ]
      commands <- resolveAll nodes
      let edges = extractEdges commands
      let bindingEdges = filter (\e -> geSource e == "src/Main.hs->IMPORT_BINDING->foo[in:Lib,h:5:0]") edges
      length bindingEdges `shouldBe` 1
      case bindingEdges of
        [edge] -> do
          geType   edge `shouldBe` "IMPORTS_FROM"
          geTarget edge `shouldBe` "src/Lib.hs->FUNCTION->foo"
        _ -> expectationFailure $ "Expected 1 binding edge, got " ++ show (length bindingEdges)
