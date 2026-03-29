{-# LANGUAGE OverloadedStrings #-}
-- | Tests for the Java analyzer.
--
-- Verifies all Rules modules produce correct graph output:
--   * JavaAST FromJSON: parsing various AST structures
--   * Walker: MODULE node emission
--   * Declarations: CLASS, INTERFACE, ENUM, RECORD, FUNCTION, VARIABLE nodes
--   * Imports: IMPORT, IMPORT_BINDING nodes
--   * Types: EXTENDS, IMPLEMENTS, RETURNS, TYPE_OF deferred refs
--   * Annotations: ATTRIBUTE nodes, HAS_ATTRIBUTE edges
--   * ControlFlow: BRANCH, SCOPE nodes
--   * ErrorFlow: countThrows
--   * Exports: ExportInfo records for public items
module Main where

import Test.Hspec
import Data.Aeson (eitherDecode)
import qualified Data.ByteString.Lazy.Char8 as BLC
import qualified Data.Map.Strict as Map
import Data.List (find)
import Data.Maybe (isJust)
import Data.Text (Text)

import JavaAST
import Analysis.Types
import Analysis.Context (runAnalyzer)
import Analysis.Walker (walkFile)
import Grafema.SemanticId (makeModuleId)

-- ── Test helpers ────────────────────────────────────────────────────────

parseJavaFile :: String -> Either String JavaFile
parseJavaFile = eitherDecode . BLC.pack

analyzeWithPath :: Text -> JavaFile -> FileAnalysis
analyzeWithPath filePath ast =
  let moduleId = makeModuleId filePath
  in runAnalyzer filePath moduleId (jfPackage ast) (walkFile ast)

analyzeText :: JavaFile -> FileAnalysis
analyzeText = analyzeWithPath "src/com/example/Test.java"

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

-- ── Test data builders ──────────────────────────────────────────────────

mkSpan :: Int -> Int -> Int -> Int -> Span
mkSpan l1 c1 l2 c2 = Span (Pos l1 c1) (Pos l2 c2)

mkParam :: Text -> JavaType -> JavaParam
mkParam name ty = JavaParam
  { jpName     = name
  , jpType     = ty
  , jpIsFinal  = False
  , jpIsVarArgs = False
  , jpAnnotations = []
  , jpSpan     = mkSpan 1 0 1 10
  }

mkClassDecl :: Text -> [Text] -> Maybe JavaType -> [JavaType] -> [JavaMember] -> JavaTypeDecl
mkClassDecl name mods ext impls members = ClassDecl
  name mods [] ext impls members [] (mkSpan 1 0 10 1)

mkInterfaceDecl :: Text -> [Text] -> [JavaType] -> [JavaMember] -> JavaTypeDecl
mkInterfaceDecl name mods ext members = InterfaceDecl
  name mods [] ext members [] (mkSpan 1 0 10 1)

mkEnumDecl :: Text -> [Text] -> [JavaType] -> [JavaMember] -> [JavaMember] -> JavaTypeDecl
mkEnumDecl name mods impls constants members = EnumDecl
  name mods impls constants members [] (mkSpan 1 0 10 1)

mkMethod :: Text -> [Text] -> JavaType -> [JavaParam] -> Maybe JavaStmt -> JavaMember
mkMethod name mods retType params body = MethodMember
  name mods [] retType params [] body [] (mkSpan 3 2 8 2)

mkField :: [Text] -> JavaType -> [JavaVariable] -> JavaMember
mkField mods ty vars = FieldMember mods ty vars [] (mkSpan 2 2 2 20)

mkVar :: Text -> JavaVariable
mkVar name = JavaVariable
  { jvName = name
  , jvType = intType
  , jvInit = Nothing
  , jvSpan = mkSpan 2 2 2 10
  }

mkClassType :: Text -> JavaType
mkClassType name = ClassType name Nothing [] (mkSpan 1 0 1 5)

intType :: JavaType
intType = PrimitiveType "int" (mkSpan 1 0 1 3)

voidType :: JavaType
voidType = VoidType (mkSpan 1 0 1 4)

emptyBlock :: JavaStmt
emptyBlock = BlockStmt [] (mkSpan 3 0 3 2)

-- ── Tests ───────────────────────────────────────────────────────────────

main :: IO ()
main = hspec $ do

  -- ── JavaAST FromJSON ──────────────────────────────────────────────────

  describe "JavaAST FromJSON" $ do
    it "parses an empty file" $ do
      let json = "{}"
      case parseJavaFile json of
        Left err -> expectationFailure $ "Parse failed: " ++ err
        Right file -> do
          jfPackage file `shouldBe` Nothing
          jfImports file `shouldBe` []
          jfTypes file `shouldBe` []

    it "parses a file with package declaration" $ do
      let json = "{\"package\": \"com.example\"}"
      case parseJavaFile json of
        Left err -> expectationFailure $ "Parse failed: " ++ err
        Right file ->
          jfPackage file `shouldBe` Just "com.example"

    it "parses imports" $ do
      let json = "{\"imports\": [{\"name\": \"java.util.List\", \"static\": false, \"asterisk\": false, \"span\": {\"start\": {\"line\": 1, \"col\": 0}, \"end\": {\"line\": 1, \"col\": 25}}}]}"
      case parseJavaFile json of
        Left err -> expectationFailure $ "Parse failed: " ++ err
        Right file -> do
          length (jfImports file) `shouldBe` 1
          jiName (head (jfImports file)) `shouldBe` "java.util.List"

  -- ── Walker ────────────────────────────────────────────────────────────

  describe "Walker" $ do
    it "emits a MODULE node for an empty file" $ do
      let fa = analyzeText (JavaFile Nothing [] [])
      faFile fa `shouldBe` "src/com/example/Test.java"
      case findNodeByType "MODULE" fa of
        Nothing -> expectationFailure "No MODULE node found"
        Just modNode -> do
          gnType modNode `shouldBe` "MODULE"
          gnName modNode `shouldBe` "Test"
          gnExported modNode `shouldBe` True

    it "includes package in MODULE metadata" $ do
      let fa = analyzeText (JavaFile (Just "com.example") [] [])
      case findNodeByType "MODULE" fa of
        Nothing -> expectationFailure "No MODULE node found"
        Just modNode ->
          getMetaText "package" modNode `shouldBe` Just "com.example"

  -- ── Declarations: Class ──────────────────────────────────────────────

  describe "Declarations.Class" $ do
    it "emits CLASS node with correct metadata" $ do
      let cls = mkClassDecl "UserService" ["public", "abstract"] Nothing [] []
          fa = analyzeText (JavaFile (Just "com.example") [] [cls])
      case findNodeByType "CLASS" fa of
        Nothing -> expectationFailure "No CLASS node found"
        Just node -> do
          gnName node `shouldBe` "UserService"
          gnExported node `shouldBe` True
          getMetaText "visibility" node `shouldBe` Just "public"
          getMetaBool "abstract" node `shouldBe` Just True
          getMetaBool "final" node `shouldBe` Just False

    it "marks package-private class as not exported" $ do
      let cls = mkClassDecl "InternalHelper" [] Nothing [] []
          fa = analyzeText (JavaFile Nothing [] [cls])
      case findNodeByType "CLASS" fa of
        Nothing -> expectationFailure "No CLASS node found"
        Just node -> do
          gnExported node `shouldBe` False
          getMetaText "visibility" node `shouldBe` Just "package-private"

    it "includes extends metadata" $ do
      let cls = mkClassDecl "Child" ["public"] (Just (mkClassType "Parent")) [] []
          fa = analyzeText (JavaFile Nothing [] [cls])
      case findNodeByType "CLASS" fa of
        Nothing -> expectationFailure "No CLASS node"
        Just node ->
          getMetaText "extends" node `shouldBe` Just "Parent"

    it "includes implements metadata" $ do
      let cls = mkClassDecl "Svc" ["public"]
                  Nothing [mkClassType "Serializable", mkClassType "Cloneable"] []
          fa = analyzeText (JavaFile Nothing [] [cls])
      case findNodeByType "CLASS" fa of
        Nothing -> expectationFailure "No CLASS node"
        Just node ->
          getMetaText "implements" node `shouldBe` Just "Serializable,Cloneable"

    it "emits CONTAINS edge from MODULE to CLASS" $ do
      let cls = mkClassDecl "Foo" ["public"] Nothing [] []
          fa = analyzeText (JavaFile Nothing [] [cls])
          containsEdges = findEdgesByType "CONTAINS" fa
      length containsEdges `shouldSatisfy` (> 0)

  -- ── Declarations: Interface ──────────────────────────────────────────

  describe "Declarations.Interface" $ do
    it "emits INTERFACE node" $ do
      let iface = mkInterfaceDecl "Repository" ["public"] [] []
          fa = analyzeText (JavaFile Nothing [] [iface])
      case findNodeByType "INTERFACE" fa of
        Nothing -> expectationFailure "No INTERFACE node"
        Just node -> do
          gnName node `shouldBe` "Repository"
          gnExported node `shouldBe` True

    it "includes extends metadata for multi-extends" $ do
      let iface = mkInterfaceDecl "Extended" ["public"]
                    [mkClassType "BaseA", mkClassType "BaseB"] []
          fa = analyzeText (JavaFile Nothing [] [iface])
      case findNodeByType "INTERFACE" fa of
        Nothing -> expectationFailure "No INTERFACE node"
        Just node ->
          getMetaText "extends" node `shouldBe` Just "BaseA,BaseB"

  -- ── Declarations: Enum ───────────────────────────────────────────────

  describe "Declarations.Enum" $ do
    it "emits ENUM node" $ do
      let e = mkEnumDecl "Color" ["public"] [] [] []
          fa = analyzeText (JavaFile Nothing [] [e])
      case findNodeByType "ENUM" fa of
        Nothing -> expectationFailure "No ENUM node"
        Just node -> gnName node `shouldBe` "Color"

    it "emits VARIABLE nodes for enum constants" $ do
      let constant = EnumConstantMember "RED" [] [] [] (mkSpan 2 2 2 5)
          e = mkEnumDecl "Color" ["public"] [] [constant] []
          fa = analyzeText (JavaFile Nothing [] [e])
          vars = findNodesByType "VARIABLE" fa
          redVar = find (\n -> gnName n == "RED") vars
      isJust redVar `shouldBe` True
      case redVar of
        Just v -> getMetaText "kind" v `shouldBe` Just "enum_constant"
        Nothing -> expectationFailure "No RED variable"

  -- ── Declarations: Method ─────────────────────────────────────────────

  describe "Declarations.Method" $ do
    it "emits FUNCTION node with metadata" $ do
      let method = mkMethod "calculate" ["public", "static"]
                     intType [mkParam "x" intType, mkParam "y" intType]
                     (Just emptyBlock)
          cls = mkClassDecl "Math" ["public"] Nothing [] [method]
          fa = analyzeText (JavaFile Nothing [] [cls])
      case findNodeByName "calculate" fa of
        Nothing -> expectationFailure "No FUNCTION node named 'calculate'"
        Just node -> do
          gnType node `shouldBe` "FUNCTION"
          getMetaText "kind" node `shouldBe` Just "method"
          getMetaBool "static" node `shouldBe` Just True
          getMetaInt "paramCount" node `shouldBe` Just 2
          getMetaText "return_type" node `shouldBe` Just "int"

    it "emits HAS_METHOD edge" $ do
      let method = mkMethod "run" ["public"] voidType [] (Just emptyBlock)
          cls = mkClassDecl "Runner" ["public"] Nothing [] [method]
          fa = analyzeText (JavaFile Nothing [] [cls])
          hasMethodEdges = findEdgesByType "HAS_METHOD" fa
      length hasMethodEdges `shouldBe` 1

    it "emits VARIABLE nodes for parameters" $ do
      let method = mkMethod "add" ["public"] intType
                     [mkParam "a" intType, mkParam "b" intType]
                     (Just emptyBlock)
          cls = mkClassDecl "Calc" ["public"] Nothing [] [method]
          fa = analyzeText (JavaFile Nothing [] [cls])
          vars = findNodesByType "VARIABLE" fa
          paramVars = filter (\v -> getMetaText "kind" v == Just "parameter") vars
      length paramVars `shouldBe` 2

  -- ── Declarations: Constructor ────────────────────────────────────────

  describe "Declarations.Constructor" $ do
    it "emits FUNCTION node with kind=constructor" $ do
      let ctor = ConstructorMember "Foo" ["public"] [] [] [] emptyBlock [] (mkSpan 3 2 8 2)
          cls = mkClassDecl "Foo" ["public"] Nothing [] [ctor]
          fa = analyzeText (JavaFile Nothing [] [cls])
          fns = findNodesByType "FUNCTION" fa
          ctorNode = find (\n -> getMetaText "kind" n == Just "constructor") fns
      isJust ctorNode `shouldBe` True

  -- ── Declarations: Field ──────────────────────────────────────────────

  describe "Declarations.Field" $ do
    it "emits VARIABLE node with kind=field" $ do
      let field = mkField ["private"] intType [mkVar "count"]
          cls = mkClassDecl "Counter" ["public"] Nothing [] [field]
          fa = analyzeText (JavaFile Nothing [] [cls])
      case findNodeByName "count" fa of
        Nothing -> expectationFailure "No 'count' VARIABLE node"
        Just node -> do
          gnType node `shouldBe` "VARIABLE"
          getMetaText "kind" node `shouldBe` Just "field"
          getMetaText "visibility" node `shouldBe` Just "private"
          getMetaText "type" node `shouldBe` Just "int"
          getMetaBool "mutable" node `shouldBe` Just True

    it "marks final field as not mutable" $ do
      let field = mkField ["private", "final"] intType [mkVar "MAX"]
          cls = mkClassDecl "Config" ["public"] Nothing [] [field]
          fa = analyzeText (JavaFile Nothing [] [cls])
      case findNodeByName "MAX" fa of
        Nothing -> expectationFailure "No 'MAX' VARIABLE"
        Just node -> getMetaBool "mutable" node `shouldBe` Just False

    it "emits HAS_PROPERTY edge" $ do
      let field = mkField ["private"] intType [mkVar "x"]
          cls = mkClassDecl "Point" ["public"] Nothing [] [field]
          fa = analyzeText (JavaFile Nothing [] [cls])
          hasPropEdges = findEdgesByType "HAS_PROPERTY" fa
      length hasPropEdges `shouldBe` 1

  describe "Declarations.Enum (DERIVES)" $ do
    it "emits DERIVES edge from ENUM to enum constant" $ do
      let constant = EnumConstantMember "RED" [] [] [] (mkSpan 2 2 2 5)
          enumDecl = mkEnumDecl "Color" ["public"] [] [constant] []
          fa = analyzeText (JavaFile Nothing [] [enumDecl])
          derivesEdges = findEdgesByType "DERIVES" fa
      length derivesEdges `shouldBe` 1

    it "emits DERIVES for each enum constant" $ do
      let c1 = EnumConstantMember "RED" [] [] [] (mkSpan 2 2 2 5)
          c2 = EnumConstantMember "GREEN" [] [] [] (mkSpan 3 2 3 7)
          c3 = EnumConstantMember "BLUE" [] [] [] (mkSpan 4 2 4 6)
          enumDecl = mkEnumDecl "Color" ["public"] [] [c1, c2, c3] []
          fa = analyzeText (JavaFile Nothing [] [enumDecl])
          derivesEdges = findEdgesByType "DERIVES" fa
      length derivesEdges `shouldBe` 3

  -- ── Imports ──────────────────────────────────────────────────────────

  describe "Imports" $ do
    it "emits IMPORT and IMPORT_BINDING nodes" $ do
      let imp = JavaImport "java.util.List" False False (mkSpan 1 0 1 25)
          fa = analyzeText (JavaFile Nothing [imp] [])
          imports = findNodesByType "IMPORT" fa
          bindings = findNodesByType "IMPORT_BINDING" fa
      length imports `shouldBe` 1
      length bindings `shouldBe` 1

    it "handles static import" $ do
      let imp = JavaImport "java.lang.Math.abs" True False (mkSpan 1 0 1 30)
          fa = analyzeText (JavaFile Nothing [imp] [])
          imports = findNodesByType "IMPORT" fa
      case find (\n -> gnName n == "java.lang.Math.abs") imports of
        Nothing -> expectationFailure "No static import node"
        Just node ->
          getMetaBool "static" node `shouldBe` Just True

    it "handles wildcard import" $ do
      let imp = JavaImport "java.util.*" False True (mkSpan 1 0 1 20)
          fa = analyzeText (JavaFile Nothing [imp] [])
          imports = findNodesByType "IMPORT" fa
      case head imports of
        node -> getMetaBool "glob" node `shouldBe` Just True

  -- ── Types: deferred refs ─────────────────────────────────────────────

  describe "Types" $ do
    it "emits deferred EXTENDS ref" $ do
      let cls = mkClassDecl "Child" [] (Just (mkClassType "Parent")) [] []
          fa = analyzeText (JavaFile Nothing [] [cls])
          extendsRefs = filter (\r -> drEdgeType r == "EXTENDS") (faUnresolvedRefs fa)
      length extendsRefs `shouldBe` 1
      drName (head extendsRefs) `shouldBe` "Parent"

    it "emits deferred IMPLEMENTS refs" $ do
      let cls = mkClassDecl "Impl" []
                  Nothing [mkClassType "IfaceA", mkClassType "IfaceB"] []
          fa = analyzeText (JavaFile Nothing [] [cls])
          implRefs = filter (\r -> drEdgeType r == "IMPLEMENTS") (faUnresolvedRefs fa)
      length implRefs `shouldBe` 2

    it "emits deferred RETURNS ref for method" $ do
      let method = mkMethod "get" ["public"] (mkClassType "String") [] (Just emptyBlock)
          cls = mkClassDecl "Svc" [] Nothing [] [method]
          fa = analyzeText (JavaFile Nothing [] [cls])
          returnRefs = filter (\r -> drEdgeType r == "RETURNS") (faUnresolvedRefs fa)
      length returnRefs `shouldBe` 1
      drName (head returnRefs) `shouldBe` "String"

    it "emits TYPE_PARAMETER nodes" $ do
      let tp = JavaTypeParam "T" [] (mkSpan 1 10 1 11)
          cls = ClassDecl "Box" ["public"] [tp] Nothing [] [] [] (mkSpan 1 0 5 1)
          fa = analyzeText (JavaFile Nothing [] [cls])
          tpNodes = findNodesByType "TYPE_PARAMETER" fa
      length tpNodes `shouldBe` 1
      gnName (head tpNodes) `shouldBe` "T"

  -- ── Annotations ─────────────────────────────────────────────────────

  describe "Annotations" $ do
    it "emits ATTRIBUTE node for marker annotation" $ do
      let ann = MarkerAnnotation "Override" (mkSpan 2 2 2 11)
          method = MethodMember "run" ["public"] [] voidType [] [] (Just emptyBlock)
                     [ann] (mkSpan 3 2 5 2)
          cls = mkClassDecl "Runner" ["public"] Nothing [] [method]
          fa = analyzeText (JavaFile Nothing [] [cls])
          attrs = findNodesByType "ATTRIBUTE" fa
      case find (\n -> gnName n == "Override") attrs of
        Nothing -> expectationFailure "No @Override ATTRIBUTE node"
        Just node -> getMetaText "kind" node `shouldBe` Just "override"

    it "emits HAS_ATTRIBUTE edge" $ do
      let ann = MarkerAnnotation "Deprecated" (mkSpan 2 2 2 13)
          cls = ClassDecl "Old" ["public"] [] Nothing [] [] [ann] (mkSpan 3 0 5 1)
          fa = analyzeText (JavaFile Nothing [] [cls])
          hasAttrEdges = findEdgesByType "HAS_ATTRIBUTE" fa
      length hasAttrEdges `shouldBe` 1

    it "emits deferred OVERRIDES ref for @Override" $ do
      let ann = MarkerAnnotation "Override" (mkSpan 2 2 2 11)
          method = MethodMember "toString" ["public"] [] (mkClassType "String") [] []
                     (Just emptyBlock) [ann] (mkSpan 3 2 5 2)
          cls = mkClassDecl "Obj" ["public"] Nothing [] [method]
          fa = analyzeText (JavaFile Nothing [] [cls])
          overrideRefs = filter (\r -> drEdgeType r == "OVERRIDES") (faUnresolvedRefs fa)
      length overrideRefs `shouldBe` 1

  -- ── ControlFlow ─────────────────────────────────────────────────────

  describe "ControlFlow" $ do
    it "emits BRANCH node for if statement" $ do
      let ifStmt = IfStmt
                     (LiteralExpr "boolean" "true" (mkSpan 4 6 4 10))
                     emptyBlock
                     Nothing
                     (mkSpan 4 2 4 15)
          method = mkMethod "check" ["public"] voidType []
                     (Just (BlockStmt [ifStmt] (mkSpan 3 0 6 0)))
          cls = mkClassDecl "Checker" [] Nothing [] [method]
          fa = analyzeText (JavaFile Nothing [] [cls])
          branches = findNodesByType "BRANCH" fa
      case find (\n -> gnName n == "if") branches of
        Nothing -> expectationFailure "No if BRANCH node"
        Just node -> do
          getMetaText "kind" node `shouldBe` Just "if"
          getMetaBool "hasElse" node `shouldBe` Just False

    it "emits SCOPE node for try-catch" $ do
      let catchParam = mkParam "e" (mkClassType "Exception")
          catchClause = JavaCatchClause catchParam emptyBlock (mkSpan 6 2 7 2)
          tryStmt = TryStmt [] emptyBlock [catchClause] Nothing (mkSpan 4 2 8 2)
          method = mkMethod "risky" ["public"] voidType []
                     (Just (BlockStmt [tryStmt] (mkSpan 3 0 9 0)))
          cls = mkClassDecl "Handler" [] Nothing [] [method]
          fa = analyzeText (JavaFile Nothing [] [cls])
          scopes = findNodesByType "SCOPE" fa
      case find (\n -> gnName n == "try") scopes of
        Nothing -> expectationFailure "No try SCOPE node"
        Just node -> do
          getMetaText "kind" node `shouldBe` Just "try"
          getMetaInt "catchCount" node `shouldBe` Just 1

  describe "ControlFlow (additional)" $ do
    it "emits BRANCH node for ternary (ConditionalExpr)" $ do
      let ternary = ConditionalExpr
                      (NameExpr "flag" (mkSpan 4 10 4 14))
                      (LiteralExpr "int" "1" (mkSpan 4 17 4 18))
                      (LiteralExpr "int" "0" (mkSpan 4 21 4 22))
                      (mkSpan 4 10 4 22)
          method = mkMethod "pick" ["public"] intType []
                     (Just (BlockStmt [ExprStmt ternary (mkSpan 4 2 4 23)] (mkSpan 3 0 5 0)))
          cls = mkClassDecl "Picker" [] Nothing [] [method]
          fa = analyzeText (JavaFile Nothing [] [cls])
          branches = findNodesByType "BRANCH" fa
      case find (\n -> gnName n == "ternary") branches of
        Nothing -> expectationFailure "No ternary BRANCH node"
        Just node -> do
          getMetaText "kind" node `shouldBe` Just "ternary"
          getMetaInt "branchCount" node `shouldBe` Just 2

    it "emits BRANCH node for switch expression" $ do
      let entry = JavaSwitchEntry
                    { jseLabels    = [LiteralExpr "int" "1" (mkSpan 5 9 5 10)]
                    , jseIsDefault = False
                    , jseStmts     = [ExprStmt (LiteralExpr "string" "\"one\"" (mkSpan 5 14 5 19)) (mkSpan 5 14 5 20)]
                    , jseSpan      = mkSpan 5 4 5 20
                    }
          switchExpr = SwitchExpr
                         (NameExpr "x" (mkSpan 4 12 4 13))
                         [entry]
                         (mkSpan 4 4 6 4)
          method = mkMethod "label" ["public"] (mkClassType "String") []
                     (Just (BlockStmt [ExprStmt switchExpr (mkSpan 4 2 6 5)] (mkSpan 3 0 7 0)))
          cls = mkClassDecl "Labeler" [] Nothing [] [method]
          fa = analyzeText (JavaFile Nothing [] [cls])
          branches = findNodesByType "BRANCH" fa
      case find (\n -> getMetaText "kind" n == Just "switch_expr") branches of
        Nothing -> expectationFailure "No switch_expr BRANCH node"
        Just node -> do
          gnName node `shouldBe` "switch"
          getMetaInt "caseCount" node `shouldBe` Just 1

    it "emits ITERATES_OVER edge for for-each" $ do
      let loopVar = JavaVariable
                      { jvName = "item"
                      , jvType = mkClassType "String"
                      , jvInit = Nothing
                      , jvSpan = mkSpan 4 18 4 22
                      }
          forEach = ForEachStmt
                      loopVar
                      (NameExpr "items" (mkSpan 4 25 4 30))
                      emptyBlock
                      (mkSpan 4 2 5 2)
          method = mkMethod "loop" ["public"] voidType []
                     (Just (BlockStmt [forEach] (mkSpan 3 0 6 0)))
          cls = mkClassDecl "Looper" [] Nothing [] [method]
          fa = analyzeText (JavaFile Nothing [] [cls])
          iterEdges = findEdgesByType "ITERATES_OVER" fa
      length iterEdges `shouldBe` 1

  -- ── Expressions ─────────────────────────────────────────────────────

  describe "Expressions" $ do
    it "emits CALL node for method call" $ do
      let callExpr = MethodCallExpr "println" Nothing
                       [LiteralExpr "string" "\"hello\"" (mkSpan 4 20 4 27)]
                       [] (mkSpan 4 2 4 28)
          method = mkMethod "main" ["public", "static"] voidType []
                     (Just (BlockStmt [ExprStmt callExpr (mkSpan 4 2 4 29)] (mkSpan 3 0 5 0)))
          cls = mkClassDecl "App" ["public"] Nothing [] [method]
          fa = analyzeText (JavaFile Nothing [] [cls])
          calls = findNodesByType "CALL" fa
      case find (\n -> gnName n == "println") calls of
        Nothing -> expectationFailure "No 'println' CALL node"
        Just node -> do
          getMetaBool "method" node `shouldBe` Just True
          getMetaInt "argCount" node `shouldBe` Just 1

    it "emits CALL node for constructor call" $ do
      let newExpr = ObjectCreationExpr (mkClassType "ArrayList")
                      [] [] Nothing (mkSpan 4 10 4 25)
          method = mkMethod "init" ["public"] voidType []
                     (Just (BlockStmt [ExprStmt newExpr (mkSpan 4 2 4 26)] (mkSpan 3 0 5 0)))
          cls = mkClassDecl "Init" [] Nothing [] [method]
          fa = analyzeText (JavaFile Nothing [] [cls])
          calls = findNodesByType "CALL" fa
      case find (\n -> gnName n == "new ArrayList") calls of
        Nothing -> expectationFailure "No constructor CALL node"
        Just node ->
          getMetaText "kind" node `shouldBe` Just "constructor_call"

    it "emits LITERAL node" $ do
      let litExpr = LiteralExpr "int" "42" (mkSpan 4 10 4 12)
          method = mkMethod "get" ["public"] intType []
                     (Just (BlockStmt [ExprStmt litExpr (mkSpan 4 2 4 13)] (mkSpan 3 0 5 0)))
          cls = mkClassDecl "Lit" [] Nothing [] [method]
          fa = analyzeText (JavaFile Nothing [] [cls])
          lits = findNodesByType "LITERAL" fa
      length lits `shouldSatisfy` (> 0)
      case head lits of
        node -> do
          getMetaText "literal_type" node `shouldBe` Just "int"
          getMetaText "value" node `shouldBe` Just "42"

    it "emits CLOSURE node for lambda" $ do
      let lambda = LambdaExpr [mkParam "x" intType]
                     (NameExpr "x" (mkSpan 4 15 4 16))
                     "expression" (mkSpan 4 5 4 16)
          method = mkMethod "fn" ["public"] voidType []
                     (Just (BlockStmt [ExprStmt lambda (mkSpan 4 2 4 17)] (mkSpan 3 0 5 0)))
          cls = mkClassDecl "Lambda" [] Nothing [] [method]
          fa = analyzeText (JavaFile Nothing [] [cls])
          closures = findNodesByType "CLOSURE" fa
      length closures `shouldBe` 1

    it "emits VARIABLE node for local variable" $ do
      let localVar = VarDeclStmt [] [mkVar "count"] (mkSpan 4 2 4 15)
          method = mkMethod "init" ["public"] voidType []
                     (Just (BlockStmt [localVar] (mkSpan 3 0 5 0)))
          cls = mkClassDecl "Init" [] Nothing [] [method]
          fa = analyzeText (JavaFile Nothing [] [cls])
      case findNodeByName "count" fa of
        Nothing -> expectationFailure "No local var 'count'"
        Just node -> getMetaText "kind" node `shouldBe` Just "local"

  -- ── ErrorFlow ────────────────────────────────────────────────────────

  describe "ErrorFlow" $ do
    it "counts throw statements" $ do
      let body = BlockStmt
                   [ ThrowStmt (NameExpr "e" (mkSpan 4 8 4 9)) (mkSpan 4 2 4 10)
                   , ThrowStmt (NameExpr "e2" (mkSpan 5 8 5 10)) (mkSpan 5 2 5 11)
                   ] (mkSpan 3 0 6 0)
          method = mkMethod "fail" ["public"] voidType [] (Just body)
          cls = mkClassDecl "Failer" [] Nothing [] [method]
          fa = analyzeText (JavaFile Nothing [] [cls])
      case findNodeByName "fail" fa of
        Nothing -> expectationFailure "No FUNCTION 'fail'"
        Just node -> getMetaInt "error_exit_count" node `shouldBe` Just 2

    it "does not count throws inside lambdas" $ do
      let lambdaBody = BlockStmt
                         [ThrowStmt (NameExpr "e" (mkSpan 5 10 5 11)) (mkSpan 5 4 5 12)]
                         (mkSpan 4 15 6 3)
          lambda = LambdaBlockExpr [] lambdaBody (mkSpan 4 10 6 3)
          body = BlockStmt [ExprStmt lambda (mkSpan 4 2 6 4)] (mkSpan 3 0 7 0)
          method = mkMethod "safe" ["public"] voidType [] (Just body)
          cls = mkClassDecl "Safe" [] Nothing [] [method]
          fa = analyzeText (JavaFile Nothing [] [cls])
      case findNodeByName "safe" fa of
        Nothing -> expectationFailure "No FUNCTION 'safe'"
        Just node -> getMetaInt "error_exit_count" node `shouldBe` Just 0

  -- ── Exports ──────────────────────────────────────────────────────────

  describe "Exports" $ do
    it "exports public class" $ do
      let cls = mkClassDecl "PublicClass" ["public"] Nothing [] []
          fa = analyzeText (JavaFile Nothing [] [cls])
          exports = faExports fa
      case find (\e -> eiName e == "PublicClass") exports of
        Nothing -> expectationFailure "PublicClass not exported"
        Just ex -> eiKind ex `shouldBe` NamedExport

    it "does not export package-private class" $ do
      let cls = mkClassDecl "InternalClass" [] Nothing [] []
          fa = analyzeText (JavaFile Nothing [] [cls])
          exports = faExports fa
      find (\e -> eiName e == "InternalClass") exports `shouldBe` Nothing

    it "exports public method of public class" $ do
      let method = mkMethod "serve" ["public"] voidType [] (Just emptyBlock)
          cls = mkClassDecl "Api" ["public"] Nothing [] [method]
          fa = analyzeText (JavaFile Nothing [] [cls])
          exports = faExports fa
      isJust (find (\e -> eiName e == "Api.serve") exports) `shouldBe` True

  -- ── Nested types ────────────────────────────────────────────────────

  describe "Nested types" $ do
    it "emits INNER_CLASS_OF edge" $ do
      let inner = mkClassDecl "Inner" ["private", "static"] Nothing [] []
          nested = NestedTypeMember inner (mkSpan 5 2 8 2)
          outer = mkClassDecl "Outer" ["public"] Nothing [] [nested]
          fa = analyzeText (JavaFile Nothing [] [outer])
          innerEdges = findEdgesByType "INNER_CLASS_OF" fa
      length innerEdges `shouldBe` 1

    it "emits both outer and inner CLASS nodes" $ do
      let inner = mkClassDecl "Inner" [] Nothing [] []
          nested = NestedTypeMember inner (mkSpan 5 2 8 2)
          outer = mkClassDecl "Outer" ["public"] Nothing [] [nested]
          fa = analyzeText (JavaFile Nothing [] [outer])
          classes = findNodesByType "CLASS" fa
      length classes `shouldBe` 2

  -- ── Edge integrity ──────────────────────────────────────────────────

  describe "Edge integrity" $ do
    it "never produces self-loop edges" $ do
      let method = mkMethod "compute" ["public"]
                     (mkClassType "Result")
                     [mkParam "input" (mkClassType "Data")]
                     (Just emptyBlock)
          cls = mkClassDecl "Engine" ["public"]
                  (Just (mkClassType "Base"))
                  [mkClassType "Runnable"]
                  [method]
          fa = analyzeText (JavaFile Nothing [] [cls])
          selfLoops = filter (\e -> geSource e == geTarget e) (faEdges fa)
      selfLoops `shouldBe` []
