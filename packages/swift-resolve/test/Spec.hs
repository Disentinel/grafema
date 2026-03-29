{-# LANGUAGE OverloadedStrings #-}
module Main where

import Test.Hspec
import Data.Text (Text)
import qualified Data.Map.Strict as Map

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..))
import qualified SwiftImportResolution
import qualified SwiftCallResolution
import qualified SwiftTypeResolution

-- ── Test helpers ──────────────────────────────────────────────────────

-- | Create a minimal Swift graph node for testing.
-- Always includes language=swift metadata.
mkNode :: Text -> Text -> Text -> Text -> GraphNode
mkNode nid ntype name file = GraphNode
  { gnId        = nid
  , gnType      = ntype
  , gnName      = name
  , gnFile      = file
  , gnLine      = 1
  , gnColumn    = 0
  , gnEndLine   = 1
  , gnEndColumn = 10
  , gnExported  = False
  , gnMetadata  = Map.singleton "language" (MetaText "swift")
  }

-- | Create a node with additional metadata (language=swift is always included).
mkNodeMeta :: Text -> Text -> Text -> Text -> [(Text, MetaValue)] -> GraphNode
mkNodeMeta nid ntype name file meta = (mkNode nid ntype name file)
  { gnMetadata = Map.fromList (("language", MetaText "swift") : meta) }

-- | Extract edges from plugin commands.
edgesOf :: [PluginCommand] -> [GraphEdge]
edgesOf = concatMap go
  where
    go (EmitEdge e) = [e]
    go _            = []

-- | Find edges of a specific type.
findEdgesOfType :: Text -> [PluginCommand] -> [GraphEdge]
findEdgesOfType t cmds = [ e | EmitEdge e <- cmds, geType e == t ]

-- | Check if an edge has resolvedVia metadata.
hasResolvedVia :: GraphEdge -> Bool
hasResolvedVia e = case Map.lookup "resolvedVia" (geMetadata e) of
  Just (MetaText _) -> True
  _                 -> False

-- ── Tests ─────────────────────────────────────────────────────────────

main :: IO ()
main = hspec $ do

  -- ── SwiftImportResolution ──────────────────────────────────────────

  describe "SwiftImportResolution" $ do

    it "resolves import to matching MODULE node" $ do
      let importNode = mkNode
            "App.swift->IMPORT->Foundation" "IMPORT" "Foundation" "App.swift"
          targetModule = mkNode
            "Foundation.swift->MODULE->Foundation" "MODULE" "Foundation" "Foundation.swift"
          nodes = [importNode, targetModule]
      cmds <- SwiftImportResolution.resolveAll nodes
      let imports = findEdgesOfType "IMPORTS_FROM" cmds
      length imports `shouldBe` 1
      geSource (head imports) `shouldBe` "App.swift->IMPORT->Foundation"
      geTarget (head imports) `shouldBe` "Foundation.swift->MODULE->Foundation"

    it "produces no edges for unresolvable import" $ do
      let importNode = mkNode
            "App.swift->IMPORT->ExternalLib" "IMPORT" "ExternalLib" "App.swift"
          nodes = [importNode]
      cmds <- SwiftImportResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

    it "produces no edges for empty node list" $ do
      cmds <- SwiftImportResolution.resolveAll []
      edgesOf cmds `shouldBe` []

    it "ignores non-Swift nodes" $ do
      let importNode = GraphNode
            { gnId        = "App.java->IMPORT->Foundation"
            , gnType      = "IMPORT"
            , gnName      = "Foundation"
            , gnFile      = "App.java"
            , gnLine      = 1
            , gnColumn    = 0
            , gnEndLine   = 1
            , gnEndColumn = 10
            , gnExported  = False
            , gnMetadata  = Map.singleton "language" (MetaText "java")
            }
          targetModule = mkNode
            "Foundation.swift->MODULE->Foundation" "MODULE" "Foundation" "Foundation.swift"
          nodes = [importNode, targetModule]
      cmds <- SwiftImportResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

  -- ── SwiftCallResolution ────────────────────────────────────────────

  describe "SwiftCallResolution" $ do

    it "resolves cross-file function call" $ do
      let call = mkNode
            "App.swift->CALL->helper" "CALL" "helper" "App.swift"
          func = mkNode
            "Utils.swift->FUNCTION->helper" "FUNCTION" "helper" "Utils.swift"
          nodes = [call, func]
      cmds <- SwiftCallResolution.resolveAll nodes
      let calls = findEdgesOfType "CALLS" cmds
      length calls `shouldBe` 1
      geTarget (head calls) `shouldBe` "Utils.swift->FUNCTION->helper"

    it "does not resolve same-file function call" $ do
      let call = mkNode
            "App.swift->CALL->helper" "CALL" "helper" "App.swift"
          func = mkNode
            "App.swift->FUNCTION->helper" "FUNCTION" "helper" "App.swift"
          nodes = [call, func]
      cmds <- SwiftCallResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

    it "produces no edges for unresolvable call" $ do
      let call = mkNode
            "App.swift->CALL->unknown" "CALL" "unknown" "App.swift"
          nodes = [call]
      cmds <- SwiftCallResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

    it "produces no edges for empty node list" $ do
      cmds <- SwiftCallResolution.resolveAll []
      edgesOf cmds `shouldBe` []

  -- ── SwiftTypeResolution ────────────────────────────────────────────

  describe "SwiftTypeResolution" $ do

    it "resolves extension to its extended type" $ do
      let ext = mkNodeMeta
            "Extensions.swift->EXTENSION->Array" "EXTENSION" "Array" "Extensions.swift"
            [("extendedType", MetaText "Array")]
          cls = mkNode
            "Array.swift->CLASS->Array" "CLASS" "Array" "Array.swift"
          nodes = [ext, cls]
      cmds <- SwiftTypeResolution.resolveAll nodes
      let extends = findEdgesOfType "EXTENDS" cmds
      length extends `shouldBe` 1
      geSource (head extends) `shouldBe` "Extensions.swift->EXTENSION->Array"
      geTarget (head extends) `shouldBe` "Array.swift->CLASS->Array"

    it "resolves extension using node name when extendedType metadata missing" $ do
      let ext = mkNode
            "Extensions.swift->EXTENSION->MyClass" "EXTENSION" "MyClass" "Extensions.swift"
          cls = mkNode
            "MyClass.swift->CLASS->MyClass" "CLASS" "MyClass" "MyClass.swift"
          nodes = [ext, cls]
      cmds <- SwiftTypeResolution.resolveAll nodes
      let extends = findEdgesOfType "EXTENDS" cmds
      length extends `shouldBe` 1

    it "produces no edges for unresolvable extension" $ do
      let ext = mkNode
            "Extensions.swift->EXTENSION->ExternalType" "EXTENSION" "ExternalType" "Extensions.swift"
          nodes = [ext]
      cmds <- SwiftTypeResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

    it "produces no edges for empty node list" $ do
      cmds <- SwiftTypeResolution.resolveAll []
      edgesOf cmds `shouldBe` []

  -- ── Edge integrity ────────────────────────────────────────────────

  describe "Edge integrity" $ do

    it "never produces edges with empty source or target" $ do
      let ext = mkNodeMeta
            "Extensions.swift->EXTENSION->Array" "EXTENSION" "Array" "Extensions.swift"
            [("extendedType", MetaText "Array")]
          cls = mkNode
            "Array.swift->CLASS->Array" "CLASS" "Array" "Array.swift"
          nodes = [ext, cls]
      cmds <- SwiftTypeResolution.resolveAll nodes
      let badEdges = [ e | EmitEdge e <- cmds
                         , geSource e == "" || geTarget e == "" ]
      badEdges `shouldBe` []

    it "all emitted edges have resolvedVia metadata" $ do
      let importNode = mkNode
            "App.swift->IMPORT->Utils" "IMPORT" "Utils" "App.swift"
          targetModule = mkNode
            "Utils.swift->MODULE->Utils" "MODULE" "Utils" "Utils.swift"
          nodes = [importNode, targetModule]
      cmds <- SwiftImportResolution.resolveAll nodes
      let allHaveResolvedVia = all hasResolvedVia (edgesOf cmds)
      allHaveResolvedVia `shouldBe` True
