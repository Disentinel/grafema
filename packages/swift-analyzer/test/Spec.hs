{-# LANGUAGE OverloadedStrings #-}
-- | Tests for the Swift analyzer.
--
-- Verifies all Rules modules produce correct graph output:
--   * SwiftAST FromJSON: parsing various AST structures
--   * Walker: MODULE node emission
--   * Declarations: CLASS (struct/class/enum/protocol/actor), FUNCTION, VARIABLE, TYPE_ALIAS nodes
--   * Imports: IMPORT nodes
--   * Types: EXTENDS deferred refs, TYPE_PARAMETER nodes
--   * Methods: FUNCTION nodes for init/deinit/subscript
module Main where

import Test.Hspec
import qualified Data.Map.Strict as Map
import Data.List (find)
import Data.Text (Text)

import SwiftAST
import Analysis.Types
import Analysis.Context (runAnalyzer)
import Analysis.Walker (walkFile)
import Grafema.SemanticId (makeModuleId)

-- Test helpers

analyzeWithPath :: Text -> SwiftFile -> FileAnalysis
analyzeWithPath filePath ast =
  let moduleId = makeModuleId filePath
  in runAnalyzer filePath moduleId (walkFile ast)

analyzeText :: SwiftFile -> FileAnalysis
analyzeText = analyzeWithPath "Sources/Example/Test.swift"

findNodeByType :: Text -> FileAnalysis -> Maybe GraphNode
findNodeByType nodeType fa = find (\n -> gnType n == nodeType) (faNodes fa)

findNodeByName :: Text -> FileAnalysis -> Maybe GraphNode
findNodeByName name fa = find (\n -> gnName n == name) (faNodes fa)

findNodesByType :: Text -> FileAnalysis -> [GraphNode]
findNodesByType nodeType fa = filter (\n -> gnType n == nodeType) (faNodes fa)

findEdgesByType :: Text -> FileAnalysis -> [GraphEdge]
findEdgesByType edgeType fa = filter (\e -> geType e == edgeType) (faEdges fa)

getMetaText :: Text -> GraphNode -> Maybe Text
getMetaText key node =
  case Map.lookup key (gnMetadata node) of
    Just (MetaText t) -> Just t
    _ -> Nothing

getMetaBool :: Text -> GraphNode -> Maybe Bool
getMetaBool key node =
  case Map.lookup key (gnMetadata node) of
    Just (MetaBool b) -> Just b
    _ -> Nothing

getMetaInt :: Text -> GraphNode -> Maybe Int
getMetaInt key node =
  case Map.lookup key (gnMetadata node) of
    Just (MetaInt i) -> Just i
    _ -> Nothing

-- Test data builders

mkSpan :: Int -> Int -> Int -> Int -> Span
mkSpan l1 c1 l2 c2 = Span (Pos l1 c1) (Pos l2 c2)

mkSimpleType :: Text -> SwiftType
mkSimpleType name = SimpleType name []

mkBinding :: Text -> SwiftBinding
mkBinding name = SwiftBinding
  { sbPattern = IdentifierPattern name
  , sbType = Nothing
  , sbInitializer = Nothing
  , sbAccessors = []
  , sbSpan = mkSpan 2 2 2 20
  }

-- Tests

main :: IO ()
main = hspec $ do

  -- Walker

  describe "Walker" $ do
    it "emits a MODULE node for an empty file" $ do
      let fa = analyzeText (SwiftFile Nothing [] [])
      faFile fa `shouldBe` "Sources/Example/Test.swift"
      case findNodeByType "MODULE" fa of
        Nothing -> expectationFailure "No MODULE node found"
        Just modNode -> do
          gnType modNode `shouldBe` "MODULE"
          gnName modNode `shouldBe` "Test"
          gnExported modNode `shouldBe` True
          getMetaText "language" modNode `shouldBe` Just "swift"

  -- Declarations: Struct

  describe "Declarations.Struct" $ do
    it "emits CLASS node with kind=struct" $ do
      let decl = StructDecl "Point" [] [] [] [] [] (mkSpan 1 0 5 1)
          fa = analyzeText (SwiftFile Nothing [] [decl])
      case findNodeByName "Point" fa of
        Nothing -> expectationFailure "No CLASS node named 'Point'"
        Just node -> do
          gnType node `shouldBe` "CLASS"
          getMetaText "kind" node `shouldBe` Just "struct"
          gnExported node `shouldBe` True  -- internal by default

    it "marks private struct as not exported" $ do
      let decl = StructDecl "InternalHelper" ["private"] [] [] [] [] (mkSpan 1 0 5 1)
          fa = analyzeText (SwiftFile Nothing [] [decl])
      case findNodeByName "InternalHelper" fa of
        Nothing -> expectationFailure "No CLASS node"
        Just node -> gnExported node `shouldBe` False

  -- Declarations: Class

  describe "Declarations.Class" $ do
    it "emits CLASS node with kind=class" $ do
      let decl = ClassDecl "ViewController" [] [] [] [] [] (mkSpan 1 0 10 1)
          fa = analyzeText (SwiftFile Nothing [] [decl])
      case findNodeByName "ViewController" fa of
        Nothing -> expectationFailure "No CLASS node"
        Just node -> do
          gnType node `shouldBe` "CLASS"
          getMetaText "kind" node `shouldBe` Just "class"

    it "marks open class" $ do
      let decl = ClassDecl "Base" ["open"] [] [] [] [] (mkSpan 1 0 5 1)
          fa = analyzeText (SwiftFile Nothing [] [decl])
      case findNodeByName "Base" fa of
        Nothing -> expectationFailure "No CLASS node"
        Just node -> do
          getMetaBool "open" node `shouldBe` Just True
          getMetaText "visibility" node `shouldBe` Just "open"

  -- Declarations: Enum

  describe "Declarations.Enum" $ do
    it "emits CLASS node with kind=enum" $ do
      let decl = EnumDecl "Direction" [] [] [] [] [] (mkSpan 1 0 5 1)
          fa = analyzeText (SwiftFile Nothing [] [decl])
      case findNodeByName "Direction" fa of
        Nothing -> expectationFailure "No CLASS node"
        Just node -> getMetaText "kind" node `shouldBe` Just "enum"

  -- Declarations: Protocol

  describe "Declarations.Protocol" $ do
    it "emits CLASS node with kind=protocol" $ do
      let decl = ProtocolDecl "Drawable" [] [] [] [] (mkSpan 1 0 5 1)
          fa = analyzeText (SwiftFile Nothing [] [decl])
      case findNodeByName "Drawable" fa of
        Nothing -> expectationFailure "No CLASS node"
        Just node -> getMetaText "kind" node `shouldBe` Just "protocol"

  -- Declarations: Actor

  describe "Declarations.Actor" $ do
    it "emits CLASS node with kind=actor" $ do
      let decl = ActorDecl "DataStore" [] [] [] [] [] (mkSpan 1 0 5 1)
          fa = analyzeText (SwiftFile Nothing [] [decl])
      case findNodeByName "DataStore" fa of
        Nothing -> expectationFailure "No CLASS node"
        Just node -> do
          getMetaText "kind" node `shouldBe` Just "actor"
          getMetaBool "actorIsolated" node `shouldBe` Just True

  -- Declarations: Function

  describe "Declarations.Function" $ do
    it "emits FUNCTION node for top-level function" $ do
      let decl = FuncDecl "calculate" [] [] [] Nothing Nothing [] False False (mkSpan 3 0 5 1)
          fa = analyzeText (SwiftFile Nothing [] [decl])
      case findNodeByName "calculate" fa of
        Nothing -> expectationFailure "No FUNCTION node"
        Just node -> do
          gnType node `shouldBe` "FUNCTION"
          getMetaText "kind" node `shouldBe` Just "function"

    it "marks async throwing function" $ do
      let decl = FuncDecl "fetch" [] [] [] Nothing Nothing [] True True (mkSpan 3 0 5 1)
          fa = analyzeText (SwiftFile Nothing [] [decl])
      case findNodeByName "fetch" fa of
        Nothing -> expectationFailure "No FUNCTION node"
        Just node -> do
          getMetaBool "isAsync" node `shouldBe` Just True
          getMetaBool "throws" node `shouldBe` Just True

    it "marks method inside class" $ do
      let method = FuncDecl "run" ["override"] [] [] Nothing Nothing [] False False (mkSpan 3 2 5 2)
          cls = ClassDecl "Runner" [] [] [] [method] [] (mkSpan 1 0 6 1)
          fa = analyzeText (SwiftFile Nothing [] [cls])
      case findNodeByName "run" fa of
        Nothing -> expectationFailure "No FUNCTION node"
        Just node -> do
          getMetaText "kind" node `shouldBe` Just "method"
          getMetaBool "override" node `shouldBe` Just True

    it "emits HAS_METHOD edge" $ do
      let method = FuncDecl "run" [] [] [] Nothing Nothing [] False False (mkSpan 3 2 5 2)
          cls = ClassDecl "Runner" [] [] [] [method] [] (mkSpan 1 0 6 1)
          fa = analyzeText (SwiftFile Nothing [] [cls])
          hasMethodEdges = findEdgesByType "HAS_METHOD" fa
      length hasMethodEdges `shouldBe` 1

  -- Declarations: Variable

  describe "Declarations.Variable" $ do
    it "emits VARIABLE node with kind=property" $ do
      let decl = VarDecl [] "var" [mkBinding "count"] [] (mkSpan 2 0 2 20)
          fa = analyzeText (SwiftFile Nothing [] [decl])
      case findNodeByName "count" fa of
        Nothing -> expectationFailure "No VARIABLE node"
        Just node -> do
          gnType node `shouldBe` "VARIABLE"
          getMetaText "kind" node `shouldBe` Just "property"
          getMetaText "bindingSpecifier" node `shouldBe` Just "var"

  -- Declarations: Init/Deinit

  describe "Declarations.Init" $ do
    it "emits FUNCTION node for init" $ do
      let decl = InitDecl [] [] Nothing [] False False False (mkSpan 3 2 5 2)
          cls = ClassDecl "Foo" [] [] [] [decl] [] (mkSpan 1 0 6 1)
          fa = analyzeText (SwiftFile Nothing [] [cls])
      case findNodeByName "init" fa of
        Nothing -> expectationFailure "No FUNCTION 'init' node"
        Just node -> getMetaText "kind" node `shouldBe` Just "init"

    it "emits FUNCTION node for deinit" $ do
      let decl = DeinitDecl Nothing [] (mkSpan 3 2 5 2)
          cls = ClassDecl "Foo" [] [] [] [decl] [] (mkSpan 1 0 6 1)
          fa = analyzeText (SwiftFile Nothing [] [cls])
      case findNodeByName "deinit" fa of
        Nothing -> expectationFailure "No FUNCTION 'deinit' node"
        Just node -> getMetaText "kind" node `shouldBe` Just "deinit"

  -- Declarations: TypeAlias

  describe "Declarations.TypeAlias" $ do
    it "emits TYPE_ALIAS node" $ do
      let decl = TypeAliasDecl "StringArray" [] (ArrayType (mkSimpleType "String")) [] [] (mkSpan 1 0 1 30)
          fa = analyzeText (SwiftFile Nothing [] [decl])
      case findNodeByName "StringArray" fa of
        Nothing -> expectationFailure "No TYPE_ALIAS node"
        Just node -> gnType node `shouldBe` "TYPE_ALIAS"

  -- Declarations: EnumCase

  describe "Declarations.EnumCase" $ do
    it "emits VARIABLE node for each enum case element" $ do
      let element = SwiftEnumCaseElement "north" Nothing [] (mkSpan 2 2 2 10)
          decl = EnumCaseDecl [element] [] (mkSpan 2 0 2 15)
          enum = EnumDecl "Direction" [] [] [] [decl] [] (mkSpan 1 0 5 1)
          fa = analyzeText (SwiftFile Nothing [] [enum])
      case findNodeByName "north" fa of
        Nothing -> expectationFailure "No VARIABLE 'north' node"
        Just node -> getMetaText "kind" node `shouldBe` Just "enum_case"

  -- Imports

  describe "Imports" $ do
    it "emits IMPORT node" $ do
      let imp = SwiftImport "Foundation" Nothing False (mkSpan 1 0 1 18)
          fa = analyzeText (SwiftFile Nothing [imp] [])
          imports = findNodesByType "IMPORT" fa
      length imports `shouldBe` 1
      gnName (head imports) `shouldBe` "Foundation"

  -- Types

  describe "Types" $ do
    it "emits deferred EXTENDS ref for inherited type" $ do
      let cls = ClassDecl "Child" [] [] [mkSimpleType "Parent"] [] [] (mkSpan 1 0 5 1)
          fa = analyzeText (SwiftFile Nothing [] [cls])
          extendsRefs = filter (\r -> drEdgeType r == "EXTENDS") (faUnresolvedRefs fa)
      length extendsRefs `shouldBe` 1
      drName (head extendsRefs) `shouldBe` "Parent"

    it "emits TYPE_PARAMETER nodes for generic params" $ do
      let gp = SwiftGenericParam "T" Nothing False
          cls = StructDecl "Box" [] [gp] [] [] [] (mkSpan 1 0 5 1)
          fa = analyzeText (SwiftFile Nothing [] [cls])
          tpNodes = findNodesByType "TYPE_PARAMETER" fa
      length tpNodes `shouldBe` 1
      gnName (head tpNodes) `shouldBe` "T"

  -- CONTAINS edges

  describe "CONTAINS edges" $ do
    it "emits CONTAINS edge from MODULE to declarations" $ do
      let decl = StructDecl "Foo" [] [] [] [] [] (mkSpan 1 0 5 1)
          fa = analyzeText (SwiftFile Nothing [] [decl])
          containsEdges = findEdgesByType "CONTAINS" fa
      length containsEdges `shouldSatisfy` (> 0)

  -- Edge integrity

  describe "Edge integrity" $ do
    it "never produces self-loop edges" $ do
      let method = FuncDecl "compute" [] [] [] Nothing Nothing [] False False (mkSpan 3 2 5 2)
          cls = ClassDecl "Engine" [] [] [mkSimpleType "Runnable"] [method] [] (mkSpan 1 0 6 1)
          fa = analyzeText (SwiftFile Nothing [] [cls])
          selfLoops = filter (\e -> geSource e == geTarget e) (faEdges fa)
      selfLoops `shouldBe` []
