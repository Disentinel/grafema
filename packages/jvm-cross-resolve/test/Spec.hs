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

-- | Count edges of a specific type.
countEdgeType :: Text -> [PluginCommand] -> Int
countEdgeType t cmds = length [ () | EmitEdge e <- cmds, geType e == t ]

-- | Find edges of a specific type.
findEdgesOfType :: Text -> [PluginCommand] -> [GraphEdge]
findEdgesOfType t cmds = [ e | EmitEdge e <- cmds, geType e == t ]

-- | Check that all emitted edges have cross_language=true metadata.
allCrossLanguage :: [PluginCommand] -> Bool
allCrossLanguage cmds = all hasCrossLang (edgesOf cmds)
  where
    hasCrossLang e = Map.lookup "cross_language" (geMetadata e) == Just (MetaBool True)

-- ── Tests ─────────────────────────────────────────────────────────────

main :: IO ()
main = hspec $ do

  -- ── CrossImportResolution ──────────────────────────────────────────

  describe "CrossImportResolution" $ do

    it "resolves Kotlin file importing Java class" $ do
      let importNode = mkNodeMeta
            "App.kt->IMPORT->com.example.Foo" "IMPORT" "com.example.Foo" "App.kt"
            [("path", MetaText "com.example.Foo")]
          targetModule = mkNodeMeta
            "Foo.java->MODULE->Foo.java" "MODULE" "Foo.java" "Foo.java"
            [("package", MetaText "com.example")]
          targetClass = mkNode
            "Foo.java->CLASS->Foo" "CLASS" "Foo" "Foo.java"
          nodes = [importNode, targetModule, targetClass]
      cmds <- CrossImportResolution.resolveAll nodes
      let imports = findEdgesOfType "IMPORTS_FROM" cmds
      length imports `shouldBe` 1
      geTarget (head imports) `shouldBe` "Foo.java->CLASS->Foo"
      allCrossLanguage cmds `shouldBe` True

    it "resolves Java file importing Kotlin class" $ do
      let importNode = mkNodeMeta
            "Main.java->IMPORT->com.example.Bar" "IMPORT" "com.example.Bar" "Main.java"
            [("path", MetaText "com.example.Bar")]
          targetModule = mkNodeMeta
            "Bar.kt->MODULE->Bar.kt" "MODULE" "Bar.kt" "Bar.kt"
            [("package", MetaText "com.example")]
          targetClass = mkNode
            "Bar.kt->CLASS->Bar" "CLASS" "Bar" "Bar.kt"
          nodes = [importNode, targetModule, targetClass]
      cmds <- CrossImportResolution.resolveAll nodes
      let imports = findEdgesOfType "IMPORTS_FROM" cmds
      length imports `shouldBe` 1
      geTarget (head imports) `shouldBe` "Bar.kt->CLASS->Bar"

    it "does NOT emit edge for same-language Java->Java import" $ do
      let importNode = mkNodeMeta
            "Main.java->IMPORT->com.example.Foo" "IMPORT" "com.example.Foo" "Main.java"
            [("path", MetaText "com.example.Foo")]
          targetModule = mkNodeMeta
            "Foo.java->MODULE->Foo.java" "MODULE" "Foo.java" "Foo.java"
            [("package", MetaText "com.example")]
          targetClass = mkNode
            "Foo.java->CLASS->Foo" "CLASS" "Foo" "Foo.java"
          nodes = [importNode, targetModule, targetClass]
      cmds <- CrossImportResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

    it "does NOT emit edge for same-language Kotlin->Kotlin import" $ do
      let importNode = mkNodeMeta
            "App.kt->IMPORT->com.example.Bar" "IMPORT" "com.example.Bar" "App.kt"
            [("path", MetaText "com.example.Bar")]
          targetModule = mkNodeMeta
            "Bar.kt->MODULE->Bar.kt" "MODULE" "Bar.kt" "Bar.kt"
            [("package", MetaText "com.example")]
          targetClass = mkNode
            "Bar.kt->CLASS->Bar" "CLASS" "Bar" "Bar.kt"
          nodes = [importNode, targetModule, targetClass]
      cmds <- CrossImportResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

    it "resolves IMPORT_BINDING via source metadata (cross-language)" $ do
      let bindingNode = mkNodeMeta
            "App.kt->IMPORT_BINDING->Foo[h:x]" "IMPORT_BINDING" "Foo" "App.kt"
            [("source", MetaText "com.example.Foo")]
          targetModule = mkNodeMeta
            "Foo.java->MODULE->Foo.java" "MODULE" "Foo.java" "Foo.java"
            [("package", MetaText "com.example")]
          targetClass = mkNode
            "Foo.java->CLASS->Foo" "CLASS" "Foo" "Foo.java"
          nodes = [bindingNode, targetModule, targetClass]
      cmds <- CrossImportResolution.resolveAll nodes
      let imports = findEdgesOfType "IMPORTS_FROM" cmds
      length imports `shouldBe` 1

    it "handles .kts file extension" $ do
      let importNode = mkNodeMeta
            "build.gradle.kts->IMPORT->com.example.Config" "IMPORT" "com.example.Config" "build.gradle.kts"
            [("path", MetaText "com.example.Config")]
          targetModule = mkNodeMeta
            "Config.java->MODULE->Config.java" "MODULE" "Config.java" "Config.java"
            [("package", MetaText "com.example")]
          targetClass = mkNode
            "Config.java->CLASS->Config" "CLASS" "Config" "Config.java"
          nodes = [importNode, targetModule, targetClass]
      cmds <- CrossImportResolution.resolveAll nodes
      length (edgesOf cmds) `shouldBe` 1

    it "produces no edges for empty node list" $ do
      cmds <- CrossImportResolution.resolveAll []
      edgesOf cmds `shouldBe` []

    it "produces no edges for unresolvable import" $ do
      let importNode = mkNodeMeta
            "App.kt->IMPORT->com.external.Unknown" "IMPORT" "com.external.Unknown" "App.kt"
            [("path", MetaText "com.external.Unknown")]
          nodes = [importNode]
      cmds <- CrossImportResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

  -- ── CrossTypeResolution ────────────────────────────────────────────

  describe "CrossTypeResolution" $ do

    it "resolves Kotlin class extending Java class" $ do
      let child = mkNodeMeta
            "Child.kt->CLASS->Child" "CLASS" "Child" "Child.kt"
            [("extends", MetaText "Parent")]
          parent = mkNode
            "Parent.java->CLASS->Parent" "CLASS" "Parent" "Parent.java"
          nodes = [child, parent]
      cmds <- CrossTypeResolution.resolveAll nodes
      let extends = findEdgesOfType "EXTENDS" cmds
      length extends `shouldBe` 1
      geSource (head extends) `shouldBe` "Child.kt->CLASS->Child"
      geTarget (head extends) `shouldBe` "Parent.java->CLASS->Parent"
      allCrossLanguage cmds `shouldBe` True

    it "resolves Java class implementing Kotlin interface" $ do
      let cls = mkNodeMeta
            "Impl.java->CLASS->Impl" "CLASS" "Impl" "Impl.java"
            [("implements", MetaText "KotlinService")]
          iface = mkNode
            "KotlinService.kt->INTERFACE->KotlinService" "INTERFACE" "KotlinService" "KotlinService.kt"
          nodes = [cls, iface]
      cmds <- CrossTypeResolution.resolveAll nodes
      let impls = findEdgesOfType "IMPLEMENTS" cmds
      length impls `shouldBe` 1

    it "does NOT emit edge for same-language extends (Java->Java)" $ do
      let child = mkNodeMeta
            "Child.java->CLASS->Child" "CLASS" "Child" "Child.java"
            [("extends", MetaText "Parent")]
          parent = mkNode
            "Parent.java->CLASS->Parent" "CLASS" "Parent" "Parent.java"
          nodes = [child, parent]
      cmds <- CrossTypeResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

    it "does NOT emit edge for same-language extends (Kotlin->Kotlin)" $ do
      let child = mkNodeMeta
            "Child.kt->CLASS->Child" "CLASS" "Child" "Child.kt"
            [("extends", MetaText "Parent")]
          parent = mkNode
            "Parent.kt->CLASS->Parent" "CLASS" "Parent" "Parent.kt"
          nodes = [child, parent]
      cmds <- CrossTypeResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

    it "resolves cross-language RETURNS edge" $ do
      let fn = mkNodeMeta
            "Service.kt->FUNCTION->getConfig[in:Service,h:x]" "FUNCTION" "getConfig" "Service.kt"
            [("return_type", MetaText "JavaConfig")]
          cls = mkNode
            "JavaConfig.java->CLASS->JavaConfig" "CLASS" "JavaConfig" "JavaConfig.java"
          nodes = [fn, cls]
      cmds <- CrossTypeResolution.resolveAll nodes
      let returns = findEdgesOfType "RETURNS" cmds
      length returns `shouldBe` 1

    it "resolves cross-language TYPE_OF edge" $ do
      let var = mkNodeMeta
            "App.kt->VARIABLE->config[in:App,h:x]" "VARIABLE" "config" "App.kt"
            [("type", MetaText "JavaConfig")]
          cls = mkNode
            "JavaConfig.java->CLASS->JavaConfig" "CLASS" "JavaConfig" "JavaConfig.java"
          nodes = [var, cls]
      cmds <- CrossTypeResolution.resolveAll nodes
      let typeOf = findEdgesOfType "TYPE_OF" cmds
      length typeOf `shouldBe` 1

    it "resolves cross-language THROWS_TYPE edge" $ do
      let fn = mkNodeMeta
            "Service.kt->FUNCTION->process[in:Service,h:x]" "FUNCTION" "process" "Service.kt"
            [("throws", MetaText "JavaException")]
          exc = mkNode
            "JavaException.java->CLASS->JavaException" "CLASS" "JavaException" "JavaException.java"
          nodes = [fn, exc]
      cmds <- CrossTypeResolution.resolveAll nodes
      let throws = findEdgesOfType "THROWS_TYPE" cmds
      length throws `shouldBe` 1

    it "produces no edges for empty node list" $ do
      cmds <- CrossTypeResolution.resolveAll []
      edgesOf cmds `shouldBe` []

    it "skips builtin types" $ do
      let fn = mkNodeMeta
            "Service.kt->FUNCTION->getX[in:Service,h:x]" "FUNCTION" "getX" "Service.kt"
            [("return_type", MetaText "Int")]
          nodes = [fn]
      cmds <- CrossTypeResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

  -- ── CrossCallResolution ────────────────────────────────────────────

  describe "CrossCallResolution" $ do

    it "resolves Kotlin calling Java static method" $ do
      let call = mkNodeMeta
            "App.kt->CALL->parse[in:App,h:x]" "CALL" "parse" "App.kt"
            [("receiver", MetaText "JavaUtils")]
          cls = mkNode
            "JavaUtils.java->CLASS->JavaUtils" "CLASS" "JavaUtils" "JavaUtils.java"
          method = mkNode
            "JavaUtils.java->FUNCTION->parse[in:JavaUtils,h:y]" "FUNCTION" "parse" "JavaUtils.java"
          nodes = [call, cls, method]
      cmds <- CrossCallResolution.resolveAll nodes
      let calls = findEdgesOfType "CALLS" cmds
      length calls `shouldBe` 1
      geTarget (head calls) `shouldBe` "JavaUtils.java->FUNCTION->parse[in:JavaUtils,h:y]"
      allCrossLanguage cmds `shouldBe` True

    it "resolves Java instantiating Kotlin class" $ do
      let call = mkNodeMeta
            "Main.java->CALL->new KotlinData[in:Main,h:x]" "CALL" "new KotlinData" "Main.java"
            [("kind", MetaText "constructor_call")]
          cls = mkNode
            "KotlinData.kt->CLASS->KotlinData" "CLASS" "KotlinData" "KotlinData.kt"
          nodes = [call, cls]
      cmds <- CrossCallResolution.resolveAll nodes
      countEdgeType "INSTANTIATES" cmds `shouldBe` 1

    it "resolves Java calling Kotlin constructor with CALLS edge" $ do
      let call = mkNodeMeta
            "Main.java->CALL->new KotlinData[in:Main,h:x]" "CALL" "new KotlinData" "Main.java"
            [("kind", MetaText "constructor_call")]
          cls = mkNode
            "KotlinData.kt->CLASS->KotlinData" "CLASS" "KotlinData" "KotlinData.kt"
          ctor = mkNodeMeta
            "KotlinData.kt->FUNCTION->KotlinData[in:KotlinData,h:ctor]" "FUNCTION" "KotlinData" "KotlinData.kt"
            [("kind", MetaText "primary_constructor")]
          nodes = [call, cls, ctor]
      cmds <- CrossCallResolution.resolveAll nodes
      countEdgeType "INSTANTIATES" cmds `shouldBe` 1
      countEdgeType "CALLS" cmds `shouldBe` 1

    it "does NOT emit edge for same-language call (Java->Java)" $ do
      let call = mkNodeMeta
            "Main.java->CALL->parse[in:Main,h:x]" "CALL" "parse" "Main.java"
            [("receiver", MetaText "Utils")]
          cls = mkNode
            "Utils.java->CLASS->Utils" "CLASS" "Utils" "Utils.java"
          method = mkNode
            "Utils.java->FUNCTION->parse[in:Utils,h:y]" "FUNCTION" "parse" "Utils.java"
          nodes = [call, cls, method]
      cmds <- CrossCallResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

    it "does NOT emit edge for same-language call (Kotlin->Kotlin)" $ do
      let call = mkNodeMeta
            "App.kt->CALL->process[in:App,h:x]" "CALL" "process" "App.kt"
            [("receiver", MetaText "Service")]
          cls = mkNode
            "Service.kt->CLASS->Service" "CLASS" "Service" "Service.kt"
          method = mkNode
            "Service.kt->FUNCTION->process[in:Service,h:y]" "FUNCTION" "process" "Service.kt"
          nodes = [call, cls, method]
      cmds <- CrossCallResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

    it "resolves super() to Java superclass constructor from Kotlin" $ do
      let call = mkNode
            "Child.kt->CALL->super[in:Child,h:x]" "CALL" "super" "Child.kt"
          childClass = mkNodeMeta
            "Child.kt->CLASS->Child" "CLASS" "Child" "Child.kt"
            [("extends", MetaText "Parent")]
          parentCtor = mkNodeMeta
            "Parent.java->FUNCTION->Parent[in:Parent,h:ctor]" "FUNCTION" "Parent" "Parent.java"
            [("kind", MetaText "constructor")]
          nodes = [call, childClass, parentCtor]
      cmds <- CrossCallResolution.resolveAll nodes
      countEdgeType "CALLS" cmds `shouldBe` 1

    it "does NOT resolve super() when superclass is same language" $ do
      let call = mkNode
            "Child.kt->CALL->super[in:Child,h:x]" "CALL" "super" "Child.kt"
          childClass = mkNodeMeta
            "Child.kt->CLASS->Child" "CLASS" "Child" "Child.kt"
            [("extends", MetaText "Parent")]
          parentCtor = mkNodeMeta
            "Parent.kt->FUNCTION->Parent[in:Parent,h:ctor]" "FUNCTION" "Parent" "Parent.kt"
            [("kind", MetaText "constructor")]
          nodes = [call, childClass, parentCtor]
      cmds <- CrossCallResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

    it "produces no edges for empty node list" $ do
      cmds <- CrossCallResolution.resolveAll []
      edgesOf cmds `shouldBe` []

    it "produces no edges for missing targets" $ do
      let call = mkNodeMeta
            "App.kt->CALL->unknown[in:App,h:x]" "CALL" "unknown" "App.kt"
            [("receiver", MetaText "NonExistent")]
          nodes = [call]
      cmds <- CrossCallResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

  -- ── Edge integrity ────────────────────────────────────────────────

  describe "Edge integrity" $ do

    it "never produces edges with empty source or target" $ do
      let cls = mkNodeMeta
            "Child.kt->CLASS->Child" "CLASS" "Child" "Child.kt"
            [("extends", MetaText "Parent")]
          parent = mkNode
            "Parent.java->CLASS->Parent" "CLASS" "Parent" "Parent.java"
          nodes = [cls, parent]
      cmds <- CrossTypeResolution.resolveAll nodes
      let badEdges = [ e | EmitEdge e <- cmds
                         , geSource e == "" || geTarget e == "" ]
      badEdges `shouldBe` []

    it "all emitted edges have cross_language metadata" $ do
      let importNode = mkNodeMeta
            "App.kt->IMPORT->com.example.Foo" "IMPORT" "com.example.Foo" "App.kt"
            [("path", MetaText "com.example.Foo")]
          targetModule = mkNodeMeta
            "Foo.java->MODULE->Foo.java" "MODULE" "Foo.java" "Foo.java"
            [("package", MetaText "com.example")]
          targetClass = mkNode
            "Foo.java->CLASS->Foo" "CLASS" "Foo" "Foo.java"
          child = mkNodeMeta
            "Child.kt->CLASS->Child" "CLASS" "Child" "Child.kt"
            [("extends", MetaText "Foo")]
          nodes = [importNode, targetModule, targetClass, child]
      importCmds <- CrossImportResolution.resolveAll nodes
      typeCmds   <- CrossTypeResolution.resolveAll nodes
      let allCmds = importCmds ++ typeCmds
      allCrossLanguage allCmds `shouldBe` True
