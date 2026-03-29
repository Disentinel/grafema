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

-- Test helpers

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

-- Tests

main :: IO ()
main = hspec $ do

  -- ImportResolution

  describe "ImportResolution" $ do

    it "resolves IMPORT node via qualified class name" $ do
      let importNode = mkNodeMeta
            "f1->IMPORT->com.example.Foo" "IMPORT" "com.example.Foo" "f1.kt"
            [("path", MetaText "com.example.Foo")]
          targetModule = mkNodeMeta
            "Foo.kt->MODULE->Foo.kt" "MODULE" "Foo.kt" "Foo.kt"
            [("package", MetaText "com.example")]
          targetClass = mkNode
            "Foo.kt->CLASS->Foo" "CLASS" "Foo" "Foo.kt"
          nodes = [importNode, targetModule, targetClass]
      cmds <- ImportResolution.resolveAll nodes
      let imports = findEdgesOfType "IMPORTS_FROM" cmds
      length imports `shouldBe` 1
      geTarget (head imports) `shouldBe` "Foo.kt->CLASS->Foo"

    it "resolves IMPORT_BINDING via source metadata" $ do
      let bindingNode = mkNodeMeta
            "f1->IMPORT_BINDING->MyList[h:x]" "IMPORT_BINDING" "MyList" "f1.kt"
            [("source", MetaText "com.example.MyList")]
          targetModule = mkNodeMeta
            "MyList.kt->MODULE->MyList.kt" "MODULE" "MyList.kt" "MyList.kt"
            [("package", MetaText "com.example")]
          targetClass = mkNode
            "MyList.kt->CLASS->MyList" "CLASS" "MyList" "MyList.kt"
          nodes = [bindingNode, targetClass, targetModule]
      cmds <- ImportResolution.resolveAll nodes
      let imports = findEdgesOfType "IMPORTS_FROM" cmds
      length imports `shouldBe` 1

    it "resolves aliased import via imported_name metadata" $ do
      -- import com.example.Foo as Bar
      let bindingNode = mkNodeMeta
            "f1->IMPORT_BINDING->Bar[h:x]" "IMPORT_BINDING" "Bar" "f1.kt"
            [ ("source", MetaText "com.example.Foo")
            , ("imported_name", MetaText "Foo")
            ]
          targetModule = mkNodeMeta
            "Foo.kt->MODULE->Foo.kt" "MODULE" "Foo.kt" "Foo.kt"
            [("package", MetaText "com.example")]
          targetClass = mkNode
            "Foo.kt->CLASS->Foo" "CLASS" "Foo" "Foo.kt"
          nodes = [bindingNode, targetModule, targetClass]
      cmds <- ImportResolution.resolveAll nodes
      let imports = findEdgesOfType "IMPORTS_FROM" cmds
      length imports `shouldBe` 1
      geTarget (head imports) `shouldBe` "Foo.kt->CLASS->Foo"

    it "produces no edges for unresolvable import" $ do
      let bindingNode = mkNodeMeta
            "f1->IMPORT_BINDING->Unknown[h:x]" "IMPORT_BINDING" "Unknown" "f1.kt"
            [("imported_name", MetaText "Unknown")]
          nodes = [bindingNode]
      cmds <- ImportResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

    it "indexes OBJECT nodes in class index" $ do
      let importNode = mkNodeMeta
            "f1->IMPORT->com.example.MyObj" "IMPORT" "com.example.MyObj" "f1.kt"
            []
          targetModule = mkNodeMeta
            "MyObj.kt->MODULE->MyObj.kt" "MODULE" "MyObj.kt" "MyObj.kt"
            [("package", MetaText "com.example")]
          targetObj = mkNode
            "MyObj.kt->OBJECT->MyObj" "OBJECT" "MyObj" "MyObj.kt"
          nodes = [importNode, targetModule, targetObj]
      cmds <- ImportResolution.resolveAll nodes
      let imports = findEdgesOfType "IMPORTS_FROM" cmds
      length imports `shouldBe` 1

  -- TypeResolution

  describe "TypeResolution" $ do

    it "resolves EXTENDS metadata to CLASS node" $ do
      let child = mkNodeMeta
            "f1->CLASS->Child" "CLASS" "Child" "f1.kt"
            [("extends", MetaText "Parent")]
          parent = mkNode
            "f2->CLASS->Parent" "CLASS" "Parent" "f2.kt"
          nodes = [child, parent]
      cmds <- TypeResolution.resolveAll nodes
      let extends = findEdgesOfType "EXTENDS" cmds
      length extends `shouldBe` 1
      geSource (head extends) `shouldBe` "f1->CLASS->Child"
      geTarget (head extends) `shouldBe` "f2->CLASS->Parent"

    it "resolves IMPLEMENTS metadata to INTERFACE node" $ do
      let cls = mkNodeMeta
            "f1->CLASS->Impl" "CLASS" "Impl" "f1.kt"
            [("implements", MetaText "Serializable")]
          iface = mkNode
            "f2->INTERFACE->Serializable" "INTERFACE" "Serializable" "f2.kt"
          nodes = [cls, iface]
      cmds <- TypeResolution.resolveAll nodes
      let impls = findEdgesOfType "IMPLEMENTS" cmds
      length impls `shouldBe` 1
      geTarget (head impls) `shouldBe` "f2->INTERFACE->Serializable"

    it "resolves multiple implements" $ do
      let cls = mkNodeMeta
            "f1->CLASS->Impl" "CLASS" "Impl" "f1.kt"
            [("implements", MetaText "Serializable,Comparable")]
          iface1 = mkNode
            "f2->INTERFACE->Serializable" "INTERFACE" "Serializable" "f2.kt"
          iface2 = mkNode
            "f3->INTERFACE->Comparable" "INTERFACE" "Comparable" "f3.kt"
          nodes = [cls, iface1, iface2]
      cmds <- TypeResolution.resolveAll nodes
      countEdgeType "IMPLEMENTS" cmds `shouldBe` 2

    it "resolves return_type metadata to RETURNS edge" $ do
      let fn = mkNodeMeta
            "f1->FUNCTION->getName[in:Person,h:x]" "FUNCTION" "getName" "f1.kt"
            [("return_type", MetaText "Address")]
          addrClass = mkNode
            "f2->CLASS->Address" "CLASS" "Address" "f2.kt"
          nodes = [fn, addrClass]
      cmds <- TypeResolution.resolveAll nodes
      let returns = findEdgesOfType "RETURNS" cmds
      length returns `shouldBe` 1

    it "skips Kotlin built-in types" $ do
      let fn1 = mkNodeMeta
            "f1->FUNCTION->getX[in:Point,h:x]" "FUNCTION" "getX" "f1.kt"
            [("return_type", MetaText "Int")]
          fn2 = mkNodeMeta
            "f1->FUNCTION->getName[in:Point,h:y]" "FUNCTION" "getName" "f1.kt"
            [("return_type", MetaText "String")]
          fn3 = mkNodeMeta
            "f1->FUNCTION->getItems[in:Point,h:z]" "FUNCTION" "getItems" "f1.kt"
            [("return_type", MetaText "List")]
          nodes = [fn1, fn2, fn3]
      cmds <- TypeResolution.resolveAll nodes
      countEdgeType "RETURNS" cmds `shouldBe` 0

    it "strips nullable marker before type lookup" $ do
      let var = mkNodeMeta
            "f1->VARIABLE->name[in:Foo,h:x]" "VARIABLE" "name" "f1.kt"
            [("type", MetaText "Person?")]
          cls = mkNode
            "f2->CLASS->Person" "CLASS" "Person" "f2.kt"
          nodes = [var, cls]
      cmds <- TypeResolution.resolveAll nodes
      let typeOf = findEdgesOfType "TYPE_OF" cmds
      length typeOf `shouldBe` 1

    it "resolves type metadata on VARIABLE to TYPE_OF edge" $ do
      let var = mkNodeMeta
            "f1->VARIABLE->count[in:Foo,h:x]" "VARIABLE" "count" "f1.kt"
            [("type", MetaText "Counter")]
          cls = mkNode
            "f2->CLASS->Counter" "CLASS" "Counter" "f2.kt"
          nodes = [var, cls]
      cmds <- TypeResolution.resolveAll nodes
      let typeOf = findEdgesOfType "TYPE_OF" cmds
      length typeOf `shouldBe` 1

  -- CallResolution

  describe "CallResolution" $ do

    it "resolves constructor call with INSTANTIATES edge" $ do
      let call = mkNodeMeta
            "f1->CALL->Foo[in:Main,h:x]" "CALL" "Foo" "f1.kt"
            [("kind", MetaText "constructor_call")]
          cls = mkNode
            "f2->CLASS->Foo" "CLASS" "Foo" "f2.kt"
          nodes = [call, cls]
      cmds <- CallResolution.resolveAll nodes
      countEdgeType "INSTANTIATES" cmds `shouldBe` 1

    it "resolves constructor call with CALLS edge to constructor" $ do
      let call = mkNodeMeta
            "f1->CALL->Foo[in:Main,h:x]" "CALL" "Foo" "f1.kt"
            [("kind", MetaText "constructor_call")]
          cls = mkNode
            "f2->CLASS->Foo" "CLASS" "Foo" "f2.kt"
          ctor = mkNodeMeta
            "f2->FUNCTION->Foo[in:Foo,h:ctor]" "FUNCTION" "Foo" "f2.kt"
            [("kind", MetaText "constructor")]
          nodes = [call, cls, ctor]
      cmds <- CallResolution.resolveAll nodes
      countEdgeType "CALLS" cmds `shouldBe` 1
      countEdgeType "INSTANTIATES" cmds `shouldBe` 1

    it "resolves same-class method call" $ do
      let call = mkNode
            "f1->CALL->helper[in:Service,h:x]" "CALL" "helper" "f1.kt"
          method = mkNode
            "f1->FUNCTION->helper[in:Service,h:y]" "FUNCTION" "helper" "f1.kt"
          nodes = [call, method]
      cmds <- CallResolution.resolveAll nodes
      countEdgeType "CALLS" cmds `shouldBe` 1

    it "resolves static call via receiver matching class name (companion)" $ do
      let call = mkNodeMeta
            "f1->CALL->create[in:Main,h:x]" "CALL" "create" "f1.kt"
            [("receiver", MetaText "Factory")]
          cls = mkNode
            "f2->CLASS->Factory" "CLASS" "Factory" "f2.kt"
          method = mkNode
            "f2->FUNCTION->create[in:Factory,h:y]" "FUNCTION" "create" "f2.kt"
          nodes = [call, cls, method]
      cmds <- CallResolution.resolveAll nodes
      countEdgeType "CALLS" cmds `shouldBe` 1

    it "resolves extension function call" $ do
      let call = mkNodeMeta
            "f1->CALL->format[in:Main,h:x]" "CALL" "format" "f1.kt"
            [ ("extension", MetaBool True)
            , ("receiverType", MetaText "Date")
            ]
          extFn = mkNodeMeta
            "f2->FUNCTION->format[h:y]" "FUNCTION" "format" "f2.kt"
            [ ("extension", MetaBool True)
            , ("receiverType", MetaText "Date")
            ]
          nodes = [call, extFn]
      cmds <- CallResolution.resolveAll nodes
      countEdgeType "CALLS" cmds `shouldBe` 1

    it "does not resolve extension call without matching receiverType" $ do
      let call = mkNodeMeta
            "f1->CALL->format[in:Main,h:x]" "CALL" "format" "f1.kt"
            [ ("extension", MetaBool True)
            , ("receiverType", MetaText "Date")
            ]
          extFn = mkNodeMeta
            "f2->FUNCTION->format[h:y]" "FUNCTION" "format" "f2.kt"
            [ ("extension", MetaBool True)
            , ("receiverType", MetaText "String")
            ]
          nodes = [call, extFn]
      cmds <- CallResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

    it "resolves this() delegating constructor call" $ do
      let call = mkNodeMeta
            "f1->CALL->this[in:Foo,h:x]" "CALL" "this" "f1.kt"
            [("isThis", MetaBool True)]
          ctor = mkNodeMeta
            "f1->FUNCTION->Foo[in:Foo,h:ctor]" "FUNCTION" "Foo" "f1.kt"
            [("kind", MetaText "constructor")]
          nodes = [call, ctor]
      cmds <- CallResolution.resolveAll nodes
      countEdgeType "CALLS" cmds `shouldBe` 1

    it "resolves super() call to parent class constructor" $ do
      let call = mkNode
            "f1->CALL->super[in:Child,h:x]" "CALL" "super" "f1.kt"
          childClass = mkNodeMeta
            "f1->CLASS->Child" "CLASS" "Child" "f1.kt"
            [("extends", MetaText "Parent")]
          parentCtor = mkNodeMeta
            "f2->FUNCTION->Parent[in:Parent,h:ctor]" "FUNCTION" "Parent" "f2.kt"
            [("kind", MetaText "constructor")]
          nodes = [call, childClass, parentCtor]
      cmds <- CallResolution.resolveAll nodes
      countEdgeType "CALLS" cmds `shouldBe` 1

    it "does not resolve call with unknown receiver" $ do
      let call = mkNodeMeta
            "f1->CALL->doStuff[in:Main,h:x]" "CALL" "doStuff" "f1.kt"
            [("receiver", MetaText "unknownVar")]
          nodes = [call]
      cmds <- CallResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

  -- AnnotationResolution

  describe "AnnotationResolution" $ do

    it "resolves ATTRIBUTE to ANNOTATION_TYPE by name" $ do
      let attr = mkNode
            "f1->ATTRIBUTE->Deprecated[in:Foo,h:x]" "ATTRIBUTE" "Deprecated" "f1.kt"
          annType = mkNode
            "f2->ANNOTATION_TYPE->Deprecated" "ANNOTATION_TYPE" "Deprecated" "f2.kt"
          nodes = [attr, annType]
      cmds <- AnnotationResolution.resolveAll nodes
      let edges = findEdgesOfType "ANNOTATION_RESOLVES_TO" cmds
      length edges `shouldBe` 1
      geSource (head edges) `shouldBe` gnId attr
      geTarget (head edges) `shouldBe` gnId annType

    it "resolves ATTRIBUTE to CLASS with kind=annotation" $ do
      let attr = mkNode
            "f1->ATTRIBUTE->MyAnnot[in:Foo,h:x]" "ATTRIBUTE" "MyAnnot" "f1.kt"
          annClass = mkNodeMeta
            "f2->CLASS->MyAnnot" "CLASS" "MyAnnot" "f2.kt"
            [("kind", MetaText "annotation")]
          nodes = [attr, annClass]
      cmds <- AnnotationResolution.resolveAll nodes
      let edges = findEdgesOfType "ANNOTATION_RESOLVES_TO" cmds
      length edges `shouldBe` 1

    it "does not resolve ATTRIBUTE without matching type" $ do
      let attr = mkNode
            "f1->ATTRIBUTE->JvmStatic[in:Foo,h:x]" "ATTRIBUTE" "JvmStatic" "f1.kt"
          nodes = [attr]
      cmds <- AnnotationResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

    it "resolves multiple annotations" $ do
      let attr1 = mkNode
            "f1->ATTRIBUTE->MyAnnot[in:Foo,h:x]" "ATTRIBUTE" "MyAnnot" "f1.kt"
          attr2 = mkNode
            "f1->ATTRIBUTE->MyAnnot[in:Bar,h:y]" "ATTRIBUTE" "MyAnnot" "f1.kt"
          annType = mkNode
            "f2->ANNOTATION_TYPE->MyAnnot" "ANNOTATION_TYPE" "MyAnnot" "f2.kt"
          nodes = [attr1, attr2, annType]
      cmds <- AnnotationResolution.resolveAll nodes
      countEdgeType "ANNOTATION_RESOLVES_TO" cmds `shouldBe` 2

  -- Edge integrity

  describe "Edge integrity" $ do

    it "never produces edges with empty source or target" $ do
      let cls = mkNodeMeta
            "f1->CLASS->Foo" "CLASS" "Foo" "f1.kt"
            [("extends", MetaText "Bar")]
          nodes = [cls]
      cmds <- TypeResolution.resolveAll nodes
      let badEdges = [ e | EmitEdge e <- cmds
                         , geSource e == "" || geTarget e == "" ]
      badEdges `shouldBe` []
