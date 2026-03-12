{-# LANGUAGE OverloadedStrings #-}
module Main where

import Test.Hspec
import Data.Text (Text)
import qualified Data.Map.Strict as Map

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..))
import qualified CrossImportResolution
import qualified CrossTypeResolution
import qualified CrossCallResolution

-- ── Test helpers ──────────────────────────────────────────────────────

-- | Create a minimal graph node for testing.
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
  , gnMetadata  = Map.empty
  }

-- | Create a node with metadata.
mkNodeMeta :: Text -> Text -> Text -> Text -> [(Text, MetaValue)] -> GraphNode
mkNodeMeta nid ntype name file meta = (mkNode nid ntype name file)
  { gnMetadata = Map.fromList meta }

-- | Extract edges from plugin commands.
edgesOf :: [PluginCommand] -> [GraphEdge]
edgesOf = concatMap go
  where
    go (EmitEdge e) = [e]
    go _            = []

-- | Find edges of a specific type.
findEdgesOfType :: Text -> [PluginCommand] -> [GraphEdge]
findEdgesOfType t cmds = [ e | EmitEdge e <- cmds, geType e == t ]

-- | Check if an edge has a specific metadata value.
hasMeta :: Text -> Text -> GraphEdge -> Bool
hasMeta key val e = Map.lookup key (geMetadata e) == Just (MetaText val)

-- ── Tests ─────────────────────────────────────────────────────────────

main :: IO ()
main = hspec $ do

  -- ── CrossImportResolution ──────────────────────────────────────────

  describe "CrossImportResolution" $ do

    it "resolves bridging import: Obj-C import -> Swift module" $ do
      let importNode = mkNode
            "MyClass.m->IMPORT->ViewModel" "IMPORT" "ViewModel" "MyClass.m"
          swiftModule = mkNode
            "ViewModel.swift->MODULE->ViewModel" "MODULE" "ViewModel" "ViewModel.swift"
          nodes = [importNode, swiftModule]
      cmds <- CrossImportResolution.resolveAll nodes
      let imports = findEdgesOfType "IMPORTS_FROM" cmds
      length imports `shouldBe` 1
      geSource (head imports) `shouldBe` "MyClass.m->IMPORT->ViewModel"

    it "resolves bridging import: Swift import -> Obj-C module" $ do
      let importNode = mkNode
            "App.swift->IMPORT->MyClass.h" "IMPORT" "MyClass.h" "App.swift"
          objcModule = mkNode
            "MyClass.h->MODULE->MyClass" "MODULE" "MyClass" "MyClass.h"
          nodes = [importNode, objcModule]
      cmds <- CrossImportResolution.resolveAll nodes
      let imports = findEdgesOfType "IMPORTS_FROM" cmds
      length imports `shouldBe` 1

    it "does NOT resolve same-language import (Swift -> Swift)" $ do
      let importNode = mkNode
            "App.swift->IMPORT->Utils" "IMPORT" "Utils" "App.swift"
          swiftModule = mkNode
            "Utils.swift->MODULE->Utils" "MODULE" "Utils" "Utils.swift"
          nodes = [importNode, swiftModule]
      cmds <- CrossImportResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

    it "does NOT resolve same-language import (Obj-C -> Obj-C)" $ do
      let importNode = mkNode
            "MyClass.m->IMPORT->Utils.h" "IMPORT" "Utils.h" "MyClass.m"
          objcModule = mkNode
            "Utils.h->MODULE->Utils" "MODULE" "Utils" "Utils.h"
          nodes = [importNode, objcModule]
      cmds <- CrossImportResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

    it "produces no edges for unresolvable import" $ do
      let importNode = mkNode
            "MyClass.m->IMPORT->Unknown.h" "IMPORT" "Unknown.h" "MyClass.m"
          nodes = [importNode]
      cmds <- CrossImportResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

    it "produces no edges for empty node list" $ do
      cmds <- CrossImportResolution.resolveAll []
      edgesOf cmds `shouldBe` []

    it "adds bridging metadata to import edges" $ do
      let importNode = mkNode
            "MyClass.m->IMPORT->ViewModel.swift" "IMPORT" "ViewModel.swift" "MyClass.m"
          swiftModule = mkNode
            "ViewModel.swift->MODULE->ViewModel" "MODULE" "ViewModel" "ViewModel.swift"
          nodes = [importNode, swiftModule]
      cmds <- CrossImportResolution.resolveAll nodes
      let edges = edgesOf cmds
      length edges `shouldBe` 1
      hasMeta "bridging" "true" (head edges) `shouldBe` True
      hasMeta "resolvedVia" "apple-cross-import" (head edges) `shouldBe` True

  -- ── CrossTypeResolution ────────────────────────────────────────────

  describe "CrossTypeResolution" $ do

    it "resolves BRIDGES_TO: Swift class -> Obj-C class with same name" $ do
      let swiftClass = mkNodeMeta
            "MyClass.swift->CLASS->MyClass" "CLASS" "MyClass" "MyClass.swift"
            [("language", MetaText "swift")]
          objcClass = mkNodeMeta
            "MyClass.h->CLASS->MyClass" "CLASS" "MyClass" "MyClass.h"
            [("language", MetaText "objc")]
          nodes = [swiftClass, objcClass]
      cmds <- CrossTypeResolution.resolveAll nodes
      let bridges = findEdgesOfType "BRIDGES_TO" cmds
      length bridges `shouldBe` 1
      geSource (head bridges) `shouldBe` "MyClass.swift->CLASS->MyClass"
      geTarget (head bridges) `shouldBe` "MyClass.h->CLASS->MyClass"

    it "does NOT bridge Swift class to Swift class" $ do
      let class1 = mkNodeMeta
            "A.swift->CLASS->Foo" "CLASS" "Foo" "A.swift"
            [("language", MetaText "swift")]
          class2 = mkNodeMeta
            "B.swift->CLASS->Foo" "CLASS" "Foo" "B.swift"
            [("language", MetaText "swift")]
          nodes = [class1, class2]
      cmds <- CrossTypeResolution.resolveAll nodes
      findEdgesOfType "BRIDGES_TO" cmds `shouldBe` []

    it "resolves cross-language EXTENDS: Swift class extends Obj-C class" $ do
      let swiftClass = mkNodeMeta
            "MyVC.swift->CLASS->MyVC" "CLASS" "MyVC" "MyVC.swift"
            [("language", MetaText "swift"), ("extends", MetaText "UIViewController")]
          objcClass = mkNodeMeta
            "UIKit.h->CLASS->UIViewController" "CLASS" "UIViewController" "UIKit.h"
            [("language", MetaText "objc")]
          nodes = [swiftClass, objcClass]
      cmds <- CrossTypeResolution.resolveAll nodes
      let extends = findEdgesOfType "EXTENDS" cmds
      length extends `shouldBe` 1
      geTarget (head extends) `shouldBe` "UIKit.h->CLASS->UIViewController"

    it "does NOT emit EXTENDS for builtin types (NSObject)" $ do
      let swiftClass = mkNodeMeta
            "MyClass.swift->CLASS->MyClass" "CLASS" "MyClass" "MyClass.swift"
            [("language", MetaText "swift"), ("extends", MetaText "NSObject")]
          objcClass = mkNodeMeta
            "Foundation.h->CLASS->NSObject" "CLASS" "NSObject" "Foundation.h"
            [("language", MetaText "objc")]
          nodes = [swiftClass, objcClass]
      cmds <- CrossTypeResolution.resolveAll nodes
      findEdgesOfType "EXTENDS" cmds `shouldBe` []

    it "resolves cross-language IMPLEMENTS: Swift class implements Obj-C protocol" $ do
      let swiftClass = mkNodeMeta
            "MyClass.swift->CLASS->MyClass" "CLASS" "MyClass" "MyClass.swift"
            [("language", MetaText "swift"), ("implements", MetaText "NSCoding")]
          objcProto = mkNodeMeta
            "Foundation.h->CLASS->NSCoding" "CLASS" "NSCoding" "Foundation.h"
            [("language", MetaText "objc"), ("kind", MetaText "objc_protocol")]
          nodes = [swiftClass, objcProto]
      cmds <- CrossTypeResolution.resolveAll nodes
      let impls = findEdgesOfType "IMPLEMENTS" cmds
      length impls `shouldBe` 1

    it "resolves multiple IMPLEMENTS from comma-separated list" $ do
      let swiftClass = mkNodeMeta
            "MyClass.swift->CLASS->MyClass" "CLASS" "MyClass" "MyClass.swift"
            [("language", MetaText "swift"), ("implements", MetaText "NSCoding, NSCopying")]
          proto1 = mkNodeMeta
            "Foundation.h->CLASS->NSCoding" "CLASS" "NSCoding" "Foundation.h"
            [("language", MetaText "objc")]
          proto2 = mkNodeMeta
            "Foundation.h->CLASS->NSCopying" "CLASS" "NSCopying" "Foundation.h"
            [("language", MetaText "objc")]
          nodes = [swiftClass, proto1, proto2]
      cmds <- CrossTypeResolution.resolveAll nodes
      let impls = findEdgesOfType "IMPLEMENTS" cmds
      length impls `shouldBe` 2

    it "resolves RETURNS: Swift function returning Obj-C type" $ do
      let swiftFunc = mkNodeMeta
            "Factory.swift->FUNCTION->create" "FUNCTION" "create" "Factory.swift"
            [("language", MetaText "swift"), ("return_type", MetaText "UIView")]
          objcClass = mkNodeMeta
            "UIKit.h->CLASS->UIView" "CLASS" "UIView" "UIKit.h"
            [("language", MetaText "objc")]
          nodes = [swiftFunc, objcClass]
      cmds <- CrossTypeResolution.resolveAll nodes
      let returns = findEdgesOfType "RETURNS" cmds
      length returns `shouldBe` 1

    it "resolves TYPE_OF: Swift variable typed with Obj-C type" $ do
      let swiftVar = mkNodeMeta
            "App.swift->VARIABLE->view" "VARIABLE" "view" "App.swift"
            [("language", MetaText "swift"), ("type", MetaText "UIView")]
          objcClass = mkNodeMeta
            "UIKit.h->CLASS->UIView" "CLASS" "UIView" "UIKit.h"
            [("language", MetaText "objc")]
          nodes = [swiftVar, objcClass]
      cmds <- CrossTypeResolution.resolveAll nodes
      let typeOfs = findEdgesOfType "TYPE_OF" cmds
      length typeOfs `shouldBe` 1

    it "produces no edges for empty node list" $ do
      cmds <- CrossTypeResolution.resolveAll []
      edgesOf cmds `shouldBe` []

    it "all edges have resolvedVia metadata" $ do
      let swiftClass = mkNodeMeta
            "MyClass.swift->CLASS->MyClass" "CLASS" "MyClass" "MyClass.swift"
            [("language", MetaText "swift")]
          objcClass = mkNodeMeta
            "MyClass.h->CLASS->MyClass" "CLASS" "MyClass" "MyClass.h"
            [("language", MetaText "objc")]
          nodes = [swiftClass, objcClass]
      cmds <- CrossTypeResolution.resolveAll nodes
      let allHave = all (hasMeta "resolvedVia" "apple-cross-type") (edgesOf cmds)
      allHave `shouldBe` True

  -- ── CrossCallResolution ────────────────────────────────────────────

  describe "CrossCallResolution" $ do

    it "resolves receiver-based call: Swift call -> Obj-C method" $ do
      let swiftCall = mkNodeMeta
            "App.swift->CALL->doSetup[in:AppDelegate]" "CALL" "doSetup" "App.swift"
            [("receiver", MetaText "AppDelegate")]
          objcClass = mkNodeMeta
            "AppDelegate.h->CLASS->AppDelegate" "CLASS" "AppDelegate" "AppDelegate.h"
            [("language", MetaText "objc")]
          objcMethod = mkNode
            "AppDelegate.h->FUNCTION->doSetup[in:AppDelegate]" "FUNCTION" "doSetup" "AppDelegate.h"
          nodes = [swiftCall, objcClass, objcMethod]
      cmds <- CrossCallResolution.resolveAll nodes
      let calls = findEdgesOfType "CALLS" cmds
      length calls `shouldBe` 1
      hasMeta "crossLanguage" "swift-to-objc" (head calls) `shouldBe` True

    it "resolves receiver-based call: Obj-C call -> Swift method" $ do
      let objcCall = mkNodeMeta
            "AppDelegate.m->CALL->fetchData[in:DataManager]" "CALL" "fetchData" "AppDelegate.m"
            [("receiver", MetaText "DataManager")]
          swiftClass = mkNodeMeta
            "DataManager.swift->CLASS->DataManager" "CLASS" "DataManager" "DataManager.swift"
            [("language", MetaText "swift")]
          swiftMethod = mkNode
            "DataManager.swift->FUNCTION->fetchData[in:DataManager]" "FUNCTION" "fetchData" "DataManager.swift"
          nodes = [objcCall, swiftClass, swiftMethod]
      cmds <- CrossCallResolution.resolveAll nodes
      let calls = findEdgesOfType "CALLS" cmds
      length calls `shouldBe` 1
      hasMeta "crossLanguage" "objc-to-swift" (head calls) `shouldBe` True

    it "does NOT resolve same-language receiver call (Swift -> Swift)" $ do
      let swiftCall = mkNodeMeta
            "App.swift->CALL->doSetup[in:VC]" "CALL" "doSetup" "App.swift"
            [("receiver", MetaText "VC")]
          swiftClass = mkNodeMeta
            "VC.swift->CLASS->VC" "CLASS" "VC" "VC.swift"
            [("language", MetaText "swift")]
          swiftMethod = mkNode
            "VC.swift->FUNCTION->doSetup[in:VC]" "FUNCTION" "doSetup" "VC.swift"
          nodes = [swiftCall, swiftClass, swiftMethod]
      cmds <- CrossCallResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

    it "skips calls with receiver self or super" $ do
      let callSelf = mkNodeMeta
            "App.swift->CALL->foo" "CALL" "foo" "App.swift"
            [("receiver", MetaText "self")]
          callSuper = mkNodeMeta
            "App.swift->CALL->bar" "CALL" "bar" "App.swift"
            [("receiver", MetaText "super")]
          nodes = [callSelf, callSuper]
      cmds <- CrossCallResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

    it "resolves Obj-C message send to Swift method" $ do
      let objcMsg = mkNodeMeta
            "AppDelegate.m->CALL->loadData" "CALL" "loadData" "AppDelegate.m"
            [("kind", MetaText "objc_message")]
          swiftMethod = mkNode
            "DataManager.swift->FUNCTION->loadData[in:DataManager]" "FUNCTION" "loadData" "DataManager.swift"
          nodes = [objcMsg, swiftMethod]
      cmds <- CrossCallResolution.resolveAll nodes
      let calls = findEdgesOfType "CALLS" cmds
      length calls `shouldBe` 1
      hasMeta "crossLanguage" "objc-to-swift" (head calls) `shouldBe` True

    it "does NOT resolve message send to same-language method" $ do
      let objcMsg = mkNodeMeta
            "AppDelegate.m->CALL->init" "CALL" "init" "AppDelegate.m"
            [("kind", MetaText "objc_message")]
          objcMethod = mkNode
            "NSObject.h->FUNCTION->init[in:NSObject]" "FUNCTION" "init" "NSObject.h"
          nodes = [objcMsg, objcMethod]
      cmds <- CrossCallResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

    it "produces no edges for empty node list" $ do
      cmds <- CrossCallResolution.resolveAll []
      edgesOf cmds `shouldBe` []

    it "all edges have crossLanguage and resolvedVia metadata" $ do
      let objcMsg = mkNodeMeta
            "AppDelegate.m->CALL->save" "CALL" "save" "AppDelegate.m"
            [("kind", MetaText "objc_message")]
          swiftMethod = mkNode
            "Store.swift->FUNCTION->save[in:Store]" "FUNCTION" "save" "Store.swift"
          nodes = [objcMsg, swiftMethod]
      cmds <- CrossCallResolution.resolveAll nodes
      let edges = edgesOf cmds
      length edges `shouldBe` 1
      hasMeta "crossLanguage" "objc-to-swift" (head edges) `shouldBe` True
      hasMeta "resolvedVia" "apple-cross-call" (head edges) `shouldBe` True

  -- ── Edge integrity ────────────────────────────────────────────────

  describe "Edge integrity" $ do

    it "never produces edges with empty source or target" $ do
      let swiftClass = mkNodeMeta
            "MyClass.swift->CLASS->MyClass" "CLASS" "MyClass" "MyClass.swift"
            [("language", MetaText "swift")]
          objcClass = mkNodeMeta
            "MyClass.h->CLASS->MyClass" "CLASS" "MyClass" "MyClass.h"
            [("language", MetaText "objc")]
          nodes = [swiftClass, objcClass]
      cmds <- CrossTypeResolution.resolveAll nodes
      let badEdges = [ e | EmitEdge e <- cmds
                         , geSource e == "" || geTarget e == "" ]
      badEdges `shouldBe` []
