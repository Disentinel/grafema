{-# LANGUAGE OverloadedStrings #-}
module Main where

import Test.Hspec
import Data.Text (Text)
import qualified Data.Map.Strict as Map

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..))
import qualified ImportResolution
import qualified TypeResolution
import qualified CallResolution
import qualified AnnotationResolution

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

-- ── Tests ─────────────────────────────────────────────────────────────

main :: IO ()
main = hspec $ do

  -- ── ImportResolution ──────────────────────────────────────────────

  describe "ImportResolution" $ do

    it "resolves IMPORT node via qualified class name" $ do
      -- IMPORT name is the qualified import path; class index maps package.ClassName
      let importNode = mkNodeMeta
            "f1->IMPORT->com.example.Foo" "IMPORT" "com.example.Foo" "f1.java"
            [("path", MetaText "com.example.Foo")]
          -- MODULE for the target file provides the package
          targetModule = mkNodeMeta
            "Foo.java->MODULE->Foo.java" "MODULE" "Foo.java" "Foo.java"
            [("package", MetaText "com.example")]
          -- CLASS in the target file
          targetClass = mkNode
            "Foo.java->CLASS->Foo" "CLASS" "Foo" "Foo.java"
          nodes = [importNode, targetModule, targetClass]
      cmds <- ImportResolution.resolveAll nodes
      let imports = findEdgesOfType "IMPORTS_FROM" cmds
      length imports `shouldBe` 1
      geTarget (head imports) `shouldBe` "Foo.java->CLASS->Foo"

    it "resolves IMPORT_BINDING via source metadata" $ do
      let bindingNode = mkNodeMeta
            "f1->IMPORT_BINDING->List[h:x]" "IMPORT_BINDING" "List" "f1.java"
            [("source", MetaText "com.example.List")]
          targetModule = mkNodeMeta
            "List.java->MODULE->List.java" "MODULE" "List.java" "List.java"
            [("package", MetaText "com.example")]
          targetClass = mkNode
            "List.java->CLASS->List" "CLASS" "List" "List.java"
          nodes = [bindingNode, targetClass, targetModule]
      cmds <- ImportResolution.resolveAll nodes
      let imports = findEdgesOfType "IMPORTS_FROM" cmds
      length imports `shouldBe` 1

    it "produces no edges for unresolvable import" $ do
      let bindingNode = mkNodeMeta
            "f1->IMPORT_BINDING->Unknown[h:x]" "IMPORT_BINDING" "Unknown" "f1.java"
            [("imported_name", MetaText "Unknown")]
          nodes = [bindingNode]
      cmds <- ImportResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

  -- ── TypeResolution ────────────────────────────────────────────────

  describe "TypeResolution" $ do

    it "resolves EXTENDS metadata to CLASS node" $ do
      let child = mkNodeMeta
            "f1->CLASS->Child" "CLASS" "Child" "f1.java"
            [("extends", MetaText "Parent")]
          parent = mkNode
            "f2->CLASS->Parent" "CLASS" "Parent" "f2.java"
          nodes = [child, parent]
      cmds <- TypeResolution.resolveAll nodes
      let extends = findEdgesOfType "EXTENDS" cmds
      length extends `shouldBe` 1
      geSource (head extends) `shouldBe` "f1->CLASS->Child"
      geTarget (head extends) `shouldBe` "f2->CLASS->Parent"

    it "resolves IMPLEMENTS metadata to INTERFACE node" $ do
      let cls = mkNodeMeta
            "f1->CLASS->Impl" "CLASS" "Impl" "f1.java"
            [("implements", MetaText "Serializable")]
          iface = mkNode
            "f2->INTERFACE->Serializable" "INTERFACE" "Serializable" "f2.java"
          nodes = [cls, iface]
      cmds <- TypeResolution.resolveAll nodes
      let impls = findEdgesOfType "IMPLEMENTS" cmds
      length impls `shouldBe` 1
      geTarget (head impls) `shouldBe` "f2->INTERFACE->Serializable"

    it "resolves multiple implements" $ do
      let cls = mkNodeMeta
            "f1->CLASS->Impl" "CLASS" "Impl" "f1.java"
            [("implements", MetaText "Serializable,Comparable")]
          iface1 = mkNode
            "f2->INTERFACE->Serializable" "INTERFACE" "Serializable" "f2.java"
          iface2 = mkNode
            "f3->INTERFACE->Comparable" "INTERFACE" "Comparable" "f3.java"
          nodes = [cls, iface1, iface2]
      cmds <- TypeResolution.resolveAll nodes
      countEdgeType "IMPLEMENTS" cmds `shouldBe` 2

    it "resolves return_type metadata to RETURNS edge" $ do
      let fn = mkNodeMeta
            "f1->FUNCTION->getName[in:Person,h:x]" "FUNCTION" "getName" "f1.java"
            [("return_type", MetaText "String")]
          strClass = mkNode
            "f2->CLASS->String" "CLASS" "String" "f2.java"
          nodes = [fn, strClass]
      cmds <- TypeResolution.resolveAll nodes
      let returns = findEdgesOfType "RETURNS" cmds
      length returns `shouldBe` 1

    it "resolves throws metadata to THROWS_TYPE edge" $ do
      let fn = mkNodeMeta
            "f1->FUNCTION->read[in:Reader,h:x]" "FUNCTION" "read" "f1.java"
            [("throws", MetaText "IOException")]
          exc = mkNode
            "f2->CLASS->IOException" "CLASS" "IOException" "f2.java"
          nodes = [fn, exc]
      cmds <- TypeResolution.resolveAll nodes
      let throws = findEdgesOfType "THROWS_TYPE" cmds
      length throws `shouldBe` 1

    it "resolves type metadata on VARIABLE to TYPE_OF edge" $ do
      let var = mkNodeMeta
            "f1->VARIABLE->count[in:Foo,h:x]" "VARIABLE" "count" "f1.java"
            [("type", MetaText "ArrayList")]
          cls = mkNode
            "f2->CLASS->ArrayList" "CLASS" "ArrayList" "f2.java"
          nodes = [var, cls]
      cmds <- TypeResolution.resolveAll nodes
      let typeOf = findEdgesOfType "TYPE_OF" cmds
      length typeOf `shouldBe` 1

    it "skips primitive return types" $ do
      let fn = mkNodeMeta
            "f1->FUNCTION->getX[in:Point,h:x]" "FUNCTION" "getX" "f1.java"
            [("return_type", MetaText "int")]
          nodes = [fn]
      cmds <- TypeResolution.resolveAll nodes
      countEdgeType "RETURNS" cmds `shouldBe` 0

  -- ── CallResolution ────────────────────────────────────────────────

  describe "CallResolution" $ do

    it "resolves constructor call with INSTANTIATES edge" $ do
      let call = mkNodeMeta
            "f1->CALL->new Foo[in:Main,h:x]" "CALL" "new Foo" "f1.java"
            [("kind", MetaText "constructor_call")]
          cls = mkNode
            "f2->CLASS->Foo" "CLASS" "Foo" "f2.java"
          nodes = [call, cls]
      cmds <- CallResolution.resolveAll nodes
      countEdgeType "INSTANTIATES" cmds `shouldBe` 1

    it "resolves constructor call with CALLS edge to constructor" $ do
      let call = mkNodeMeta
            "f1->CALL->new Foo[in:Main,h:x]" "CALL" "new Foo" "f1.java"
            [("kind", MetaText "constructor_call")]
          cls = mkNode
            "f2->CLASS->Foo" "CLASS" "Foo" "f2.java"
          ctor = mkNodeMeta
            "f2->FUNCTION->Foo[in:Foo,h:ctor]" "FUNCTION" "Foo" "f2.java"
            [("kind", MetaText "constructor")]
          nodes = [call, cls, ctor]
      cmds <- CallResolution.resolveAll nodes
      countEdgeType "CALLS" cmds `shouldBe` 1
      countEdgeType "INSTANTIATES" cmds `shouldBe` 1

    it "resolves same-class method call" $ do
      let call = mkNode
            "f1->CALL->helper[in:Service,h:x]" "CALL" "helper" "f1.java"
          method = mkNode
            "f1->FUNCTION->helper[in:Service,h:y]" "FUNCTION" "helper" "f1.java"
          nodes = [call, method]
      cmds <- CallResolution.resolveAll nodes
      countEdgeType "CALLS" cmds `shouldBe` 1

    it "resolves static call via receiver matching class name" $ do
      let call = mkNodeMeta
            "f1->CALL->valueOf[in:Main,h:x]" "CALL" "valueOf" "f1.java"
            [("receiver", MetaText "Integer")]
          cls = mkNode
            "f2->CLASS->Integer" "CLASS" "Integer" "f2.java"
          method = mkNode
            "f2->FUNCTION->valueOf[in:Integer,h:y]" "FUNCTION" "valueOf" "f2.java"
          nodes = [call, cls, method]
      cmds <- CallResolution.resolveAll nodes
      countEdgeType "CALLS" cmds `shouldBe` 1

    it "resolves this() delegating constructor call" $ do
      let call = mkNodeMeta
            "f1->CALL->this[in:Foo,h:x]" "CALL" "this" "f1.java"
            [("isThis", MetaBool True)]
          ctor = mkNodeMeta
            "f1->FUNCTION->Foo[in:Foo,h:ctor]" "FUNCTION" "Foo" "f1.java"
            [("kind", MetaText "constructor")]
          nodes = [call, ctor]
      cmds <- CallResolution.resolveAll nodes
      countEdgeType "CALLS" cmds `shouldBe` 1

    it "resolves super() call to parent class constructor" $ do
      let call = mkNode
            "f1->CALL->super[in:Child,h:x]" "CALL" "super" "f1.java"
          childClass = mkNodeMeta
            "f1->CLASS->Child" "CLASS" "Child" "f1.java"
            [("extends", MetaText "Parent")]
          parentCtor = mkNodeMeta
            "f2->FUNCTION->Parent[in:Parent,h:ctor]" "FUNCTION" "Parent" "f2.java"
            [("kind", MetaText "constructor")]
          nodes = [call, childClass, parentCtor]
      cmds <- CallResolution.resolveAll nodes
      countEdgeType "CALLS" cmds `shouldBe` 1

    it "does not resolve call with unknown receiver" $ do
      let call = mkNodeMeta
            "f1->CALL->doStuff[in:Main,h:x]" "CALL" "doStuff" "f1.java"
            [("receiver", MetaText "unknownVar")]
          nodes = [call]
      cmds <- CallResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

    it "does not produce duplicate edges for same call" $ do
      -- A constructor call should not also match same-class or static patterns
      let call = mkNodeMeta
            "f1->CALL->new Foo[in:Main,h:x]" "CALL" "new Foo" "f1.java"
            [("kind", MetaText "constructor_call")]
          cls = mkNode
            "f2->CLASS->Foo" "CLASS" "Foo" "f2.java"
          nodes = [call, cls]
      cmds <- CallResolution.resolveAll nodes
      -- Should have exactly 1 INSTANTIATES, 0 CALLS (no constructor FUNCTION node)
      countEdgeType "INSTANTIATES" cmds `shouldBe` 1
      countEdgeType "CALLS" cmds `shouldBe` 0

  -- ── AnnotationResolution ──────────────────────────────────────────

  describe "AnnotationResolution" $ do

    it "resolves ATTRIBUTE to ANNOTATION_TYPE by name" $ do
      let attr = mkNode
            "f1->ATTRIBUTE->Override[in:Foo,h:x]" "ATTRIBUTE" "Override" "f1.java"
          annType = mkNode
            "f2->ANNOTATION_TYPE->Override" "ANNOTATION_TYPE" "Override" "f2.java"
          nodes = [attr, annType]
      cmds <- AnnotationResolution.resolveAll nodes
      let edges = findEdgesOfType "ANNOTATION_RESOLVES_TO" cmds
      length edges `shouldBe` 1
      geSource (head edges) `shouldBe` gnId attr
      geTarget (head edges) `shouldBe` gnId annType

    it "does not resolve ATTRIBUTE without matching ANNOTATION_TYPE" $ do
      let attr = mkNode
            "f1->ATTRIBUTE->Deprecated[in:Foo,h:x]" "ATTRIBUTE" "Deprecated" "f1.java"
          nodes = [attr]
      cmds <- AnnotationResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

    it "resolves multiple annotations" $ do
      let attr1 = mkNode
            "f1->ATTRIBUTE->MyAnnot[in:Foo,h:x]" "ATTRIBUTE" "MyAnnot" "f1.java"
          attr2 = mkNode
            "f1->ATTRIBUTE->MyAnnot[in:Bar,h:y]" "ATTRIBUTE" "MyAnnot" "f1.java"
          annType = mkNode
            "f2->ANNOTATION_TYPE->MyAnnot" "ANNOTATION_TYPE" "MyAnnot" "f2.java"
          nodes = [attr1, attr2, annType]
      cmds <- AnnotationResolution.resolveAll nodes
      countEdgeType "ANNOTATION_RESOLVES_TO" cmds `shouldBe` 2

  -- ── Edge integrity ────────────────────────────────────────────────

  describe "Edge integrity" $ do

    it "never produces edges with empty source or target" $ do
      let cls = mkNodeMeta
            "f1->CLASS->Foo" "CLASS" "Foo" "f1.java"
            [("extends", MetaText "Bar")]
          nodes = [cls]
      cmds <- TypeResolution.resolveAll nodes
      let badEdges = [ e | EmitEdge e <- cmds
                         , geSource e == "" || geTarget e == "" ]
      badEdges `shouldBe` []
