{-# LANGUAGE OverloadedStrings #-}
-- | Tests for the Kotlin analyzer.
--
-- Verifies all Rules modules produce correct graph output:
--   * KotlinAST FromJSON: parsing various AST structures
--   * Walker: MODULE node emission
--   * Declarations: CLASS, FUNCTION, VARIABLE, TYPE_ALIAS nodes
--   * Imports: IMPORT, IMPORT_BINDING nodes
--   * Types: EXTENDS, RETURNS, TYPE_OF deferred refs
--   * Annotations: ATTRIBUTE nodes, HAS_ATTRIBUTE edges
--   * ControlFlow: BRANCH, SCOPE nodes
--   * ErrorFlow: countThrows
--   * Exports: ExportInfo records for public items (public by default)
module Main where

import Test.Hspec
import Data.Aeson (eitherDecode)
import qualified Data.ByteString.Lazy.Char8 as BLC
import qualified Data.Map.Strict as Map
import Data.List (find)
import Data.Maybe (isJust)
import Data.Text (Text)

import KotlinAST
import Analysis.Types
import Analysis.Context (runAnalyzer)
import Analysis.Walker (walkFile)
import Grafema.SemanticId (makeModuleId)

-- Test helpers

parseKotlinFile :: String -> Either String KotlinFile
parseKotlinFile = eitherDecode . BLC.pack

analyzeWithPath :: Text -> KotlinFile -> FileAnalysis
analyzeWithPath filePath ast =
  let moduleId = makeModuleId filePath
  in runAnalyzer filePath moduleId (kfPackage ast) (walkFile ast)

analyzeText :: KotlinFile -> FileAnalysis
analyzeText = analyzeWithPath "src/com/example/Test.kt"

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

mkParam :: Text -> KotlinType -> KotlinParam
mkParam name ty = KotlinParam
  { kpName     = name
  , kpType     = ty
  , kpIsVal    = False
  , kpIsVar    = False
  , kpDefault  = Nothing
  , kpIsVararg = False
  , kpAnnotations = []
  , kpSpan     = mkSpan 1 0 1 10
  }

mkSimpleType :: Text -> KotlinType
mkSimpleType name = SimpleType name [] False (mkSpan 1 0 1 5)

intType :: KotlinType
intType = SimpleType "Int" [] False (mkSpan 1 0 1 3)

unitType :: KotlinType
unitType = SimpleType "Unit" [] False (mkSpan 1 0 1 4)

emptyBlock :: KotlinStmt
emptyBlock = BlockStmt [] (mkSpan 3 0 3 2)

mkClassDecl :: Text -> Text -> [Text] -> [KotlinType] -> [KotlinMember] -> KotlinDecl
mkClassDecl name kind mods supers members = ClassDecl
  name kind mods [] Nothing supers members [] (mkSpan 1 0 10 1)

mkFunDecl :: Text -> [Text] -> [KotlinParam] -> Maybe KotlinType -> Maybe KotlinStmt -> KotlinDecl
mkFunDecl name mods params retType body = FunDecl
  name mods [] Nothing params retType body [] (mkSpan 3 2 8 2)

mkPropertyDecl :: Text -> [Text] -> Bool -> Maybe KotlinType -> KotlinDecl
mkPropertyDecl name mods isVal propType = PropertyDecl
  name mods isVal propType Nothing Nothing Nothing False [] (mkSpan 2 2 2 20)

mkFunMember :: Text -> [Text] -> [KotlinParam] -> Maybe KotlinType -> Maybe KotlinStmt -> KotlinMember
mkFunMember name mods params retType body = FunMember
  name mods [] Nothing params retType body [] (mkSpan 3 2 8 2)

mkPropertyMember :: Text -> [Text] -> Bool -> Maybe KotlinType -> KotlinMember
mkPropertyMember name mods isVal propType = PropertyMember
  name mods isVal propType Nothing Nothing Nothing False [] (mkSpan 2 2 2 20)

-- Tests

main :: IO ()
main = hspec $ do

  -- KotlinAST FromJSON

  describe "KotlinAST FromJSON" $ do
    it "parses an empty file" $ do
      let json = "{}"
      case parseKotlinFile json of
        Left err -> expectationFailure $ "Parse failed: " ++ err
        Right file -> do
          kfPackage file `shouldBe` Nothing
          kfImports file `shouldBe` []
          kfDeclarations file `shouldBe` []

    it "parses a file with package declaration" $ do
      let json = "{\"package\": \"com.example\"}"
      case parseKotlinFile json of
        Left err -> expectationFailure $ "Parse failed: " ++ err
        Right file ->
          kfPackage file `shouldBe` Just "com.example"

    it "parses imports with alias" $ do
      let json = "{\"imports\": [{\"name\": \"com.example.Foo\", \"alias\": \"Bar\", \"asterisk\": false, \"span\": {\"start\": {\"line\": 1, \"col\": 0}, \"end\": {\"line\": 1, \"col\": 30}}}]}"
      case parseKotlinFile json of
        Left err -> expectationFailure $ "Parse failed: " ++ err
        Right file -> do
          length (kfImports file) `shouldBe` 1
          kiName (head (kfImports file)) `shouldBe` "com.example.Foo"
          kiAlias (head (kfImports file)) `shouldBe` Just "Bar"

  -- Walker

  describe "Walker" $ do
    it "emits a MODULE node for an empty file" $ do
      let fa = analyzeText (KotlinFile Nothing [] [])
      faFile fa `shouldBe` "src/com/example/Test.kt"
      case findNodeByType "MODULE" fa of
        Nothing -> expectationFailure "No MODULE node found"
        Just modNode -> do
          gnType modNode `shouldBe` "MODULE"
          gnName modNode `shouldBe` "Test"
          gnExported modNode `shouldBe` True

    it "includes package in MODULE metadata" $ do
      let fa = analyzeText (KotlinFile (Just "com.example") [] [])
      case findNodeByType "MODULE" fa of
        Nothing -> expectationFailure "No MODULE node found"
        Just modNode ->
          getMetaText "package" modNode `shouldBe` Just "com.example"

  -- Declarations: Class

  describe "Declarations.Class" $ do
    it "emits CLASS node with correct metadata" $ do
      let cls = mkClassDecl "UserService" "class" ["abstract"] [] []
          fa = analyzeText (KotlinFile (Just "com.example") [] [cls])
      case findNodeByType "CLASS" fa of
        Nothing -> expectationFailure "No CLASS node found"
        Just node -> do
          gnName node `shouldBe` "UserService"
          gnExported node `shouldBe` True  -- public by default in Kotlin
          getMetaText "kind" node `shouldBe` Just "class"
          getMetaBool "abstract" node `shouldBe` Just True

    it "marks private class as not exported" $ do
      let cls = mkClassDecl "InternalHelper" "class" ["private"] [] []
          fa = analyzeText (KotlinFile Nothing [] [cls])
      case findNodeByType "CLASS" fa of
        Nothing -> expectationFailure "No CLASS node found"
        Just node ->
          gnExported node `shouldBe` False

    it "emits data class with kind=data" $ do
      let cls = mkClassDecl "User" "data" [] [] []
          fa = analyzeText (KotlinFile Nothing [] [cls])
      case findNodeByType "CLASS" fa of
        Nothing -> expectationFailure "No CLASS node"
        Just node -> do
          getMetaText "kind" node `shouldBe` Just "data"
          getMetaBool "data" node `shouldBe` Just True

    it "emits CONTAINS edge from MODULE to CLASS" $ do
      let cls = mkClassDecl "Foo" "class" [] [] []
          fa = analyzeText (KotlinFile Nothing [] [cls])
          containsEdges = findEdgesByType "CONTAINS" fa
      length containsEdges `shouldSatisfy` (> 0)

  -- Declarations: Object

  describe "Declarations.Object" $ do
    it "emits CLASS node with kind=object and singleton=true" $ do
      let obj = ObjectDecl "AppConfig" [] [] [] [] (mkSpan 1 0 5 1)
          fa = analyzeText (KotlinFile Nothing [] [obj])
      case findNodeByType "CLASS" fa of
        Nothing -> expectationFailure "No CLASS node"
        Just node -> do
          gnName node `shouldBe` "AppConfig"
          getMetaText "kind" node `shouldBe` Just "object"
          getMetaBool "singleton" node `shouldBe` Just True

  -- Declarations: Function

  describe "Declarations.Function" $ do
    it "emits FUNCTION node for top-level function" $ do
      let fn = mkFunDecl "calculate" [] [mkParam "x" intType] (Just intType) (Just emptyBlock)
          fa = analyzeText (KotlinFile Nothing [] [fn])
      case findNodeByName "calculate" fa of
        Nothing -> expectationFailure "No FUNCTION node named 'calculate'"
        Just node -> do
          gnType node `shouldBe` "FUNCTION"
          getMetaText "kind" node `shouldBe` Just "function"
          getMetaInt "paramCount" node `shouldBe` Just 1

    it "marks suspend function" $ do
      let fn = mkFunDecl "fetch" ["suspend"] [] (Just unitType) (Just emptyBlock)
          fa = analyzeText (KotlinFile Nothing [] [fn])
      case findNodeByName "fetch" fa of
        Nothing -> expectationFailure "No FUNCTION node"
        Just node ->
          getMetaBool "suspend" node `shouldBe` Just True

    it "emits VARIABLE nodes for parameters" $ do
      let fn = mkFunDecl "add" [] [mkParam "a" intType, mkParam "b" intType] (Just intType) (Just emptyBlock)
          fa = analyzeText (KotlinFile Nothing [] [fn])
          vars = findNodesByType "VARIABLE" fa
          paramVars = filter (\v -> getMetaText "kind" v == Just "parameter") vars
      length paramVars `shouldBe` 2

  -- Declarations: Property

  describe "Declarations.Property" $ do
    it "emits VARIABLE node with kind=property" $ do
      let prop = mkPropertyDecl "count" [] False (Just intType)
          fa = analyzeText (KotlinFile Nothing [] [prop])
      case findNodeByName "count" fa of
        Nothing -> expectationFailure "No 'count' VARIABLE node"
        Just node -> do
          gnType node `shouldBe` "VARIABLE"
          getMetaText "kind" node `shouldBe` Just "property"
          getMetaBool "mutable" node `shouldBe` Just True  -- var

    it "marks val property as not mutable" $ do
      let prop = mkPropertyDecl "MAX" [] True (Just intType)
          fa = analyzeText (KotlinFile Nothing [] [prop])
      case findNodeByName "MAX" fa of
        Nothing -> expectationFailure "No 'MAX' VARIABLE"
        Just node -> getMetaBool "mutable" node `shouldBe` Just False

  -- Declarations: Method in class

  describe "Declarations.Method" $ do
    it "emits FUNCTION node with kind=method" $ do
      let method = mkFunMember "run" ["override"] [] (Just unitType) (Just emptyBlock)
          cls = mkClassDecl "Runner" "class" [] [] [method]
          fa = analyzeText (KotlinFile Nothing [] [cls])
      case findNodeByName "run" fa of
        Nothing -> expectationFailure "No FUNCTION 'run'"
        Just node -> do
          getMetaText "kind" node `shouldBe` Just "method"
          getMetaBool "override" node `shouldBe` Just True

    it "emits HAS_METHOD edge" $ do
      let method = mkFunMember "run" [] [] (Just unitType) (Just emptyBlock)
          cls = mkClassDecl "Runner" "class" [] [] [method]
          fa = analyzeText (KotlinFile Nothing [] [cls])
          hasMethodEdges = findEdgesByType "HAS_METHOD" fa
      length hasMethodEdges `shouldBe` 1

    it "emits HAS_PROPERTY edge for property member" $ do
      let prop = mkPropertyMember "x" [] True (Just intType)
          cls = mkClassDecl "Point" "class" [] [] [prop]
          fa = analyzeText (KotlinFile Nothing [] [cls])
          hasPropEdges = findEdgesByType "HAS_PROPERTY" fa
      length hasPropEdges `shouldBe` 1

  -- Imports

  describe "Imports" $ do
    it "emits IMPORT and IMPORT_BINDING nodes" $ do
      let imp = KotlinImport "com.example.Foo" Nothing False (mkSpan 1 0 1 25)
          fa = analyzeText (KotlinFile Nothing [imp] [])
          imports = findNodesByType "IMPORT" fa
          bindings = findNodesByType "IMPORT_BINDING" fa
      length imports `shouldBe` 1
      length bindings `shouldBe` 1

    it "handles aliased import" $ do
      let imp = KotlinImport "com.example.Foo" (Just "Bar") False (mkSpan 1 0 1 30)
          fa = analyzeText (KotlinFile Nothing [imp] [])
          bindings = findNodesByType "IMPORT_BINDING" fa
      case find (\n -> gnName n == "Bar") bindings of
        Nothing -> expectationFailure "No aliased IMPORT_BINDING node"
        Just node ->
          getMetaText "imported_name" node `shouldBe` Just "Foo"

    it "handles wildcard import" $ do
      let imp = KotlinImport "com.example.*" Nothing True (mkSpan 1 0 1 20)
          fa = analyzeText (KotlinFile Nothing [imp] [])
          imports = findNodesByType "IMPORT" fa
      case head imports of
        node -> getMetaBool "glob" node `shouldBe` Just True

  -- Types

  describe "Types" $ do
    it "emits deferred EXTENDS ref for supertype" $ do
      let cls = mkClassDecl "Child" "class" [] [mkSimpleType "Parent"] []
          fa = analyzeText (KotlinFile Nothing [] [cls])
          extendsRefs = filter (\r -> drEdgeType r == "EXTENDS") (faUnresolvedRefs fa)
      length extendsRefs `shouldBe` 1
      drName (head extendsRefs) `shouldBe` "Parent"

    it "emits deferred RETURNS ref for function" $ do
      let fn = mkFunDecl "get" [] [] (Just (mkSimpleType "String")) (Just emptyBlock)
          fa = analyzeText (KotlinFile Nothing [] [fn])
          returnRefs = filter (\r -> drEdgeType r == "RETURNS") (faUnresolvedRefs fa)
      length returnRefs `shouldBe` 1
      drName (head returnRefs) `shouldBe` "String"

    it "emits TYPE_PARAMETER nodes with variance" $ do
      let tp = KotlinTypeParam "T" (Just "out") [] False (mkSpan 1 10 1 15)
          cls = ClassDecl "Box" "class" [] [tp] Nothing [] [] [] (mkSpan 1 0 5 1)
          fa = analyzeText (KotlinFile Nothing [] [cls])
          tpNodes = findNodesByType "TYPE_PARAMETER" fa
      length tpNodes `shouldBe` 1
      case head tpNodes of
        node -> do
          gnName node `shouldBe` "T"
          getMetaText "variance" node `shouldBe` Just "out"

  -- Annotations

  describe "Annotations" $ do
    it "emits ATTRIBUTE node for marker annotation" $ do
      let ann = MarkerAnnotation "Deprecated" Nothing (mkSpan 2 2 2 13)
          cls = ClassDecl "Old" "class" [] [] Nothing [] [] [ann] (mkSpan 3 0 5 1)
          fa = analyzeText (KotlinFile Nothing [] [cls])
          attrs = findNodesByType "ATTRIBUTE" fa
      case find (\n -> gnName n == "Deprecated") attrs of
        Nothing -> expectationFailure "No @Deprecated ATTRIBUTE node"
        Just node -> getMetaText "kind" node `shouldBe` Just "diagnostic"

    it "emits HAS_ATTRIBUTE edge" $ do
      let ann = MarkerAnnotation "Deprecated" Nothing (mkSpan 2 2 2 13)
          cls = ClassDecl "Old" "class" [] [] Nothing [] [] [ann] (mkSpan 3 0 5 1)
          fa = analyzeText (KotlinFile Nothing [] [cls])
          hasAttrEdges = findEdgesByType "HAS_ATTRIBUTE" fa
      length hasAttrEdges `shouldBe` 1

  -- ControlFlow

  describe "ControlFlow" $ do
    it "emits BRANCH node for if statement" $ do
      let ifStmt = IfStmt
                     (LiteralExpr "Boolean" "true" (mkSpan 4 6 4 10))
                     emptyBlock
                     Nothing
                     (mkSpan 4 2 4 15)
          fn = mkFunDecl "check" [] [] (Just unitType)
                 (Just (BlockStmt [ifStmt] (mkSpan 3 0 6 0)))
          fa = analyzeText (KotlinFile Nothing [] [fn])
          branches = findNodesByType "BRANCH" fa
      case find (\n -> gnName n == "if") branches of
        Nothing -> expectationFailure "No if BRANCH node"
        Just node -> do
          getMetaText "kind" node `shouldBe` Just "if"
          getMetaBool "hasElse" node `shouldBe` Just False

    it "emits SCOPE node for try-catch" $ do
      let catchClause = KotlinCatchClause "e" (mkSimpleType "Exception") emptyBlock (mkSpan 6 2 7 2)
          tryStmt = TryStmt emptyBlock [catchClause] Nothing (mkSpan 4 2 8 2)
          fn = mkFunDecl "risky" [] [] (Just unitType)
                 (Just (BlockStmt [tryStmt] (mkSpan 3 0 9 0)))
          fa = analyzeText (KotlinFile Nothing [] [fn])
          scopes = findNodesByType "SCOPE" fa
      case find (\n -> gnName n == "try") scopes of
        Nothing -> expectationFailure "No try SCOPE node"
        Just node -> do
          getMetaText "kind" node `shouldBe` Just "try"
          getMetaInt "catchCount" node `shouldBe` Just 1

    it "emits ITERATES_OVER edge for for loop" $ do
      let loopVar = KotlinVariable
                      { kvName = "item"
                      , kvType = Just (mkSimpleType "String")
                      , kvInit = Nothing
                      , kvSpan = mkSpan 4 18 4 22
                      }
          forStmt = ForStmt
                      loopVar
                      (NameExpr "items" (mkSpan 4 25 4 30))
                      emptyBlock
                      (mkSpan 4 2 5 2)
          fn = mkFunDecl "loop" [] [] (Just unitType)
                 (Just (BlockStmt [forStmt] (mkSpan 3 0 6 0)))
          fa = analyzeText (KotlinFile Nothing [] [fn])
          iterEdges = findEdgesByType "ITERATES_OVER" fa
      length iterEdges `shouldBe` 1

  -- Expressions

  describe "Expressions" $ do
    it "emits CALL node for function call" $ do
      let callExpr = CallExpr "println" Nothing
                       [LiteralExpr "String" "\"hello\"" (mkSpan 4 20 4 27)]
                       [] (mkSpan 4 2 4 28)
          fn = mkFunDecl "main" [] [] (Just unitType)
                 (Just (BlockStmt [ExprStmt callExpr (mkSpan 4 2 4 29)] (mkSpan 3 0 5 0)))
          fa = analyzeText (KotlinFile Nothing [] [fn])
          calls = findNodesByType "CALL" fa
      case find (\n -> gnName n == "println") calls of
        Nothing -> expectationFailure "No 'println' CALL node"
        Just node ->
          getMetaInt "argCount" node `shouldBe` Just 1

    it "emits CALL node with safe_call=true for safe call" $ do
      let safeCall = SafeCallExpr
                       (NameExpr "obj" (mkSpan 4 2 4 5))
                       "method"
                       []
                       (mkSpan 4 2 4 15)
          fn = mkFunDecl "test" [] [] (Just unitType)
                 (Just (BlockStmt [ExprStmt safeCall (mkSpan 4 2 4 16)] (mkSpan 3 0 5 0)))
          fa = analyzeText (KotlinFile Nothing [] [fn])
          calls = findNodesByType "CALL" fa
      case find (\n -> gnName n == "method") calls of
        Nothing -> expectationFailure "No safe call CALL node"
        Just node ->
          getMetaBool "safe_call" node `shouldBe` Just True

    it "emits CLOSURE node for lambda" $ do
      let lambda = LambdaExpr [mkParam "x" intType]
                     (BlockStmt [] (mkSpan 4 10 4 16))
                     (mkSpan 4 5 4 16)
          fn = mkFunDecl "fn" [] [] (Just unitType)
                 (Just (BlockStmt [ExprStmt lambda (mkSpan 4 2 4 17)] (mkSpan 3 0 5 0)))
          fa = analyzeText (KotlinFile Nothing [] [fn])
          closures = findNodesByType "CLOSURE" fa
      length closures `shouldBe` 1

    it "emits LITERAL node" $ do
      let litExpr = LiteralExpr "Int" "42" (mkSpan 4 10 4 12)
          fn = mkFunDecl "get" [] [] (Just intType)
                 (Just (BlockStmt [ExprStmt litExpr (mkSpan 4 2 4 13)] (mkSpan 3 0 5 0)))
          fa = analyzeText (KotlinFile Nothing [] [fn])
          lits = findNodesByType "LITERAL" fa
      length lits `shouldSatisfy` (> 0)

    it "emits BRANCH node for when expression" $ do
      let entry = KotlinWhenEntry
                    { kweConditions = [LiteralExpr "Int" "1" (mkSpan 5 4 5 5)]
                    , kweBody       = ExprStmt (LiteralExpr "String" "\"one\"" (mkSpan 5 9 5 14)) (mkSpan 5 9 5 14)
                    , kweIsElse     = False
                    , kweSpan       = mkSpan 5 4 5 14
                    }
          whenExpr = WhenExpr
                       (Just (NameExpr "x" (mkSpan 4 7 4 8)))
                       [entry]
                       (mkSpan 4 2 6 2)
          fn = mkFunDecl "label" [] [] (Just (mkSimpleType "String"))
                 (Just (BlockStmt [ExprStmt whenExpr (mkSpan 4 2 6 3)] (mkSpan 3 0 7 0)))
          fa = analyzeText (KotlinFile Nothing [] [fn])
          branches = findNodesByType "BRANCH" fa
      case find (\n -> getMetaText "kind" n == Just "when") branches of
        Nothing -> expectationFailure "No when BRANCH node"
        Just node ->
          getMetaInt "caseCount" node `shouldBe` Just 1

    it "emits BRANCH node for elvis expression" $ do
      let elvis = ElvisExpr
                    (NameExpr "x" (mkSpan 4 2 4 3))
                    (LiteralExpr "Int" "0" (mkSpan 4 7 4 8))
                    (mkSpan 4 2 4 8)
          fn = mkFunDecl "safe" [] [] (Just intType)
                 (Just (BlockStmt [ExprStmt elvis (mkSpan 4 2 4 9)] (mkSpan 3 0 5 0)))
          fa = analyzeText (KotlinFile Nothing [] [fn])
          branches = findNodesByType "BRANCH" fa
      case find (\n -> getMetaText "kind" n == Just "elvis") branches of
        Nothing -> expectationFailure "No elvis BRANCH node"
        Just node ->
          getMetaInt "branchCount" node `shouldBe` Just 2

    it "emits VARIABLE node for local variable" $ do
      let localVar = VarDeclStmt True [KotlinVariable "count" (Just intType) Nothing (mkSpan 4 6 4 11)] (mkSpan 4 2 4 15)
          fn = mkFunDecl "init" [] [] (Just unitType)
                 (Just (BlockStmt [localVar] (mkSpan 3 0 5 0)))
          fa = analyzeText (KotlinFile Nothing [] [fn])
      case findNodeByName "count" fa of
        Nothing -> expectationFailure "No local var 'count'"
        Just node -> getMetaText "kind" node `shouldBe` Just "local"

  -- ErrorFlow

  describe "ErrorFlow" $ do
    it "counts throw statements" $ do
      let body = BlockStmt
                   [ ThrowStmt (NameExpr "e" (mkSpan 4 8 4 9)) (mkSpan 4 2 4 10)
                   , ThrowStmt (NameExpr "e2" (mkSpan 5 8 5 10)) (mkSpan 5 2 5 11)
                   ] (mkSpan 3 0 6 0)
          fn = mkFunDecl "fail" [] [] (Just unitType) (Just body)
          fa = analyzeText (KotlinFile Nothing [] [fn])
      case findNodeByName "fail" fa of
        Nothing -> expectationFailure "No FUNCTION 'fail'"
        Just node -> getMetaInt "error_exit_count" node `shouldBe` Just 2

    it "does not count throws inside lambdas" $ do
      let lambdaBody = BlockStmt
                         [ThrowStmt (NameExpr "e" (mkSpan 5 10 5 11)) (mkSpan 5 4 5 12)]
                         (mkSpan 4 15 6 3)
          lambda = LambdaExpr [] lambdaBody (mkSpan 4 10 6 3)
          body = BlockStmt [ExprStmt lambda (mkSpan 4 2 6 4)] (mkSpan 3 0 7 0)
          fn = mkFunDecl "safe" [] [] (Just unitType) (Just body)
          fa = analyzeText (KotlinFile Nothing [] [fn])
      case findNodeByName "safe" fa of
        Nothing -> expectationFailure "No FUNCTION 'safe'"
        Just node -> getMetaInt "error_exit_count" node `shouldBe` Just 0

  -- Exports

  describe "Exports" $ do
    it "exports public class (default visibility)" $ do
      let cls = mkClassDecl "PublicClass" "class" [] [] []
          fa = analyzeText (KotlinFile Nothing [] [cls])
          exports = faExports fa
      case find (\e -> eiName e == "PublicClass") exports of
        Nothing -> expectationFailure "PublicClass not exported"
        Just ex -> eiKind ex `shouldBe` NamedExport

    it "does not export private class" $ do
      let cls = mkClassDecl "PrivateClass" "class" ["private"] [] []
          fa = analyzeText (KotlinFile Nothing [] [cls])
          exports = faExports fa
      find (\e -> eiName e == "PrivateClass") exports `shouldBe` Nothing

    it "exports top-level function" $ do
      let fn = mkFunDecl "topLevel" [] [] (Just unitType) (Just emptyBlock)
          fa = analyzeText (KotlinFile Nothing [] [fn])
          exports = faExports fa
      isJust (find (\e -> eiName e == "topLevel") exports) `shouldBe` True

    it "exports top-level property" $ do
      let prop = mkPropertyDecl "VERSION" [] True (Just (mkSimpleType "String"))
          fa = analyzeText (KotlinFile Nothing [] [prop])
          exports = faExports fa
      isJust (find (\e -> eiName e == "VERSION") exports) `shouldBe` True

  -- Companion Object

  describe "Companion Object" $ do
    it "emits CLASS node with kind=companion" $ do
      let companion = CompanionObjectMember Nothing [] [] [] (mkSpan 3 2 5 2)
          cls = mkClassDecl "Outer" "class" [] [] [companion]
          fa = analyzeText (KotlinFile Nothing [] [cls])
          classes = findNodesByType "CLASS" fa
      case find (\n -> getMetaText "kind" n == Just "companion") classes of
        Nothing -> expectationFailure "No companion CLASS node"
        Just node -> getMetaBool "singleton" node `shouldBe` Just True

    it "emits COMPANION_OF edge" $ do
      let companion = CompanionObjectMember Nothing [] [] [] (mkSpan 3 2 5 2)
          cls = mkClassDecl "Outer" "class" [] [] [companion]
          fa = analyzeText (KotlinFile Nothing [] [cls])
          companionEdges = findEdgesByType "COMPANION_OF" fa
      length companionEdges `shouldBe` 1

  -- Edge integrity

  describe "Edge integrity" $ do
    it "never produces self-loop edges" $ do
      let method = mkFunMember "compute" [] [mkParam "input" (mkSimpleType "Data")] (Just (mkSimpleType "Result")) (Just emptyBlock)
          cls = mkClassDecl "Engine" "class" [] [mkSimpleType "Runnable"] [method]
          fa = analyzeText (KotlinFile Nothing [] [cls])
          selfLoops = filter (\e -> geSource e == geTarget e) (faEdges fa)
      selfLoops `shouldBe` []
