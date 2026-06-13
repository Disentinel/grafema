{-# LANGUAGE OverloadedStrings #-}
module Main (main) where

import Test.Hspec
import qualified Data.ByteString.Lazy as BL
import Data.Aeson (eitherDecode)
import qualified Data.Text
import Data.Text (Text)
import qualified Data.Map.Strict as Map
import Data.List (nub)

import AST.Types (ASTNode)
import AST.Decode ()
import Analysis.Types
import Analysis.Context (runAnalyzer)
import Analysis.Walker (walkProgram)
import Analysis.Resolve (resolveFileRefs)
import Analysis.NodeId (makeModuleId)

-- | Run analyzer on an AST JSON string, return FileAnalysis
analyzeAST :: BL.ByteString -> FileAnalysis
analyzeAST json =
  case eitherDecode json :: Either String ASTNode of
    Left err -> error $ "Test AST decode failed: " ++ err
    Right ast ->
      let file = "test.js"
          modId = makeModuleId file
          raw = runAnalyzer file modId (walkProgram ast)
      in resolveFileRefs raw

-- | Check if an edge of given type exists between source and target
hasEdge :: Text -> Text -> Text -> FileAnalysis -> Bool
hasEdge typ src dst fa = any (\e -> geType e == typ && geSource e == src && geTarget e == dst) (faEdges fa)

-- | Check if any edge of given type exists FROM source
hasEdgeFrom :: Text -> Text -> FileAnalysis -> Bool
hasEdgeFrom typ src fa = any (\e -> geType e == typ && geSource e == src) (faEdges fa)

-- | Check if a node with given type and name exists
hasNode :: Text -> Text -> FileAnalysis -> Bool
hasNode typ name fa = any (\n -> gnType n == typ && gnName n == name) (faNodes fa)

-- | Find node by type and name (returns Maybe)
findNode :: Text -> Text -> FileAnalysis -> Maybe GraphNode
findNode typ name fa = case filter (\n -> gnType n == typ && gnName n == name) (faNodes fa) of
  (n:_) -> Just n
  []    -> Nothing

-- | Find all nodes by type and name
findNodes :: Text -> Text -> FileAnalysis -> [GraphNode]
findNodes typ name fa = filter (\n -> gnType n == typ && gnName n == name) (faNodes fa)

-- | Check if a node has metadata resolved=false
isUnresolved :: GraphNode -> Bool
isUnresolved n = Map.lookup "resolved" (gnMetadata n) == Just (MetaBool False)

-- | Check if an export with given name and kind exists
hasExport :: Text -> ExportKind -> FileAnalysis -> Bool
hasExport name kind fa = any (\e -> eiName e == name && eiKind e == kind) (faExports fa)

-- | Require a node by type and name; fail the test if not found
requireNode :: Text -> Text -> FileAnalysis -> IO GraphNode
requireNode typ name fa = case findNode typ name fa of
  Just n  -> return n
  Nothing -> error $ "Expected " ++ show typ ++ " node named " ++ show name ++ " not found"


main :: IO ()
main = hspec $ do
  describe "Scope Resolution"
    scopeResolutionTests
  describe "Exports"
    exportTests
  describe "Edge Cases"
    edgeCaseTests
  describe "Import Resolution Data"
    importResolutionTests
  describe "TypeScript Interfaces"
    interfaceTests
  describe "CALL argCount metadata"
    callArgCountTests
  describe "Chained call receivers"
    chainedCallTests


scopeResolutionTests :: Spec
scopeResolutionTests = do

  -- Test 1: const x = 1; x; -- READS_FROM edge from REFERENCE to CONSTANT
  it "resolves variable reference to its declaration" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":20,\"body\":["
          , "{\"type\":\"VariableDeclaration\",\"start\":0,\"end\":14,\"kind\":\"const\",\"declarations\":["
          , "{\"type\":\"VariableDeclarator\",\"start\":6,\"end\":13,"
          , "\"id\":{\"type\":\"Identifier\",\"start\":6,\"end\":7,\"name\":\"x\"},"
          , "\"init\":{\"type\":\"Literal\",\"start\":10,\"end\":11,\"value\":1,\"raw\":\"1\"}}"
          , "]},"
          , "{\"type\":\"ExpressionStatement\",\"start\":15,\"end\":17,"
          , "\"expression\":{\"type\":\"Identifier\",\"start\":15,\"end\":16,\"name\":\"x\"}}"
          , "]}"
          ]
    hasNode "CONSTANT" "x" fa `shouldBe` True
    hasNode "REFERENCE" "x" fa `shouldBe` True
    constNode <- requireNode "CONSTANT" "x" fa
    refNode <- requireNode "REFERENCE" "x" fa
    hasEdge "READS_FROM" (gnId refNode) (gnId constNode) fa `shouldBe` True

  -- Test 2: function f() {} f(); -- CALLS edge from CALL to FUNCTION
  it "resolves function call to its declaration" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":30,\"body\":["
          , "{\"type\":\"FunctionDeclaration\",\"start\":0,\"end\":15,"
          , "\"id\":{\"type\":\"Identifier\",\"start\":9,\"end\":10,\"name\":\"f\"},"
          , "\"params\":[],\"body\":{\"type\":\"BlockStatement\",\"start\":13,\"end\":15,\"body\":[]},"
          , "\"async\":false,\"generator\":false},"
          , "{\"type\":\"ExpressionStatement\",\"start\":16,\"end\":20,"
          , "\"expression\":{\"type\":\"CallExpression\",\"start\":16,\"end\":19,"
          , "\"callee\":{\"type\":\"Identifier\",\"start\":16,\"end\":17,\"name\":\"f\"},"
          , "\"arguments\":[]}}"
          , "]}"
          ]
    hasNode "FUNCTION" "f" fa `shouldBe` True
    hasNode "CALL" "f" fa `shouldBe` True
    fnNode <- requireNode "FUNCTION" "f" fa
    callNode <- requireNode "CALL" "f" fa
    hasEdge "CALLS" (gnId callNode) (gnId fnNode) fa `shouldBe` True

  -- Test 3: const x = 1; function f() { return x; } -- closure reference
  it "resolves cross-scope closure reference" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":50,\"body\":["
          , "{\"type\":\"VariableDeclaration\",\"start\":0,\"end\":14,\"kind\":\"const\",\"declarations\":["
          , "{\"type\":\"VariableDeclarator\",\"start\":6,\"end\":13,"
          , "\"id\":{\"type\":\"Identifier\",\"start\":6,\"end\":7,\"name\":\"x\"},"
          , "\"init\":{\"type\":\"Literal\",\"start\":10,\"end\":11,\"value\":1,\"raw\":\"1\"}}"
          , "]},"
          , "{\"type\":\"FunctionDeclaration\",\"start\":15,\"end\":50,"
          , "\"id\":{\"type\":\"Identifier\",\"start\":24,\"end\":25,\"name\":\"f\"},"
          , "\"params\":[],\"body\":{\"type\":\"BlockStatement\",\"start\":28,\"end\":50,\"body\":["
          , "{\"type\":\"ReturnStatement\",\"start\":30,\"end\":40,"
          , "\"argument\":{\"type\":\"Identifier\",\"start\":37,\"end\":38,\"name\":\"x\"}}"
          , "]},\"async\":false,\"generator\":false}"
          , "]}"
          ]
    constNode <- requireNode "CONSTANT" "x" fa
    let constId = gnId constNode
        refNodesList = findNodes "REFERENCE" "x" fa
    any (\ref -> hasEdge "READS_FROM" (gnId ref) constId fa) refNodesList `shouldBe` True

  -- Test 4: foo; -- REFERENCE with resolved:false
  it "marks unresolved references" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":5,\"body\":["
          , "{\"type\":\"ExpressionStatement\",\"start\":0,\"end\":4,"
          , "\"expression\":{\"type\":\"Identifier\",\"start\":0,\"end\":3,\"name\":\"foo\"}}"
          , "]}"
          ]
    refNode <- requireNode "REFERENCE" "foo" fa
    isUnresolved refNode `shouldBe` True
    hasEdgeFrom "READS_FROM" (gnId refNode) fa `shouldBe` False

  -- Test 5: function f(a) { return a; } -- parameter resolution
  it "resolves parameter reference" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":30,\"body\":["
          , "{\"type\":\"FunctionDeclaration\",\"start\":0,\"end\":30,"
          , "\"id\":{\"type\":\"Identifier\",\"start\":9,\"end\":10,\"name\":\"f\"},"
          , "\"params\":[{\"type\":\"Identifier\",\"start\":11,\"end\":12,\"name\":\"a\"}],"
          , "\"body\":{\"type\":\"BlockStatement\",\"start\":14,\"end\":30,\"body\":["
          , "{\"type\":\"ReturnStatement\",\"start\":16,\"end\":26,"
          , "\"argument\":{\"type\":\"Identifier\",\"start\":23,\"end\":24,\"name\":\"a\"}}"
          , "]},\"async\":false,\"generator\":false}"
          , "]}"
          ]
    hasNode "PARAMETER" "a" fa `shouldBe` True
    hasNode "REFERENCE" "a" fa `shouldBe` True
    paramNode <- requireNode "PARAMETER" "a" fa
    let paramId = gnId paramNode
        refNodesList = findNodes "REFERENCE" "a" fa
    any (\ref -> hasEdge "READS_FROM" (gnId ref) paramId fa) refNodesList `shouldBe` True


exportTests :: Spec
exportTests = do

  -- Test 6: export function foo() {} -- named export
  it "detects named export function" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":30,\"body\":["
          , "{\"type\":\"ExportNamedDeclaration\",\"start\":0,\"end\":30,"
          , "\"declaration\":{\"type\":\"FunctionDeclaration\",\"start\":7,\"end\":30,"
          , "\"id\":{\"type\":\"Identifier\",\"start\":16,\"end\":19,\"name\":\"foo\"},"
          , "\"params\":[],\"body\":{\"type\":\"BlockStatement\",\"start\":22,\"end\":24,\"body\":[]},"
          , "\"async\":false,\"generator\":false},"
          , "\"specifiers\":[]}"
          , "]}"
          ]
    hasExport "foo" NamedExport fa `shouldBe` True

  -- Test 7: export default function bar() {} -- default export
  it "detects default export" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":35,\"body\":["
          , "{\"type\":\"ExportDefaultDeclaration\",\"start\":0,\"end\":35,"
          , "\"declaration\":{\"type\":\"FunctionDeclaration\",\"start\":15,\"end\":35,"
          , "\"id\":{\"type\":\"Identifier\",\"start\":24,\"end\":27,\"name\":\"bar\"},"
          , "\"params\":[],\"body\":{\"type\":\"BlockStatement\",\"start\":30,\"end\":32,\"body\":[]},"
          , "\"async\":false,\"generator\":false}}"
          , "]}"
          ]
    hasExport "default" DefaultExport fa `shouldBe` True

  -- Test 8: export * from './utils' -- star re-export
  it "detects star re-export" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":25,\"body\":["
          , "{\"type\":\"ExportAllDeclaration\",\"start\":0,\"end\":25,"
          , "\"source\":{\"type\":\"Literal\",\"start\":14,\"end\":23,\"value\":\"./utils\",\"raw\":\"'./utils'\"}}"
          , "]}"
          ]
    hasExport "*" ReExport fa `shouldBe` True

  -- Test 8b: two `export function` statements in one file must NOT collapse into
  -- a single EXPORT node. On HEAD both ExportNamedDeclarations mint the constant
  -- sid `test.js->EXPORT->named` (Declarations.hs:617), so they merge in-graph —
  -- the second statement's node identity and position are lost. Each statement
  -- must own a distinct EXPORT node.
  it "emits a distinct EXPORT node per named-export statement" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":62,\"body\":["
          , "{\"type\":\"ExportNamedDeclaration\",\"start\":0,\"end\":30,"
          , "\"declaration\":{\"type\":\"FunctionDeclaration\",\"start\":7,\"end\":30,"
          , "\"id\":{\"type\":\"Identifier\",\"start\":16,\"end\":19,\"name\":\"foo\"},"
          , "\"params\":[],\"body\":{\"type\":\"BlockStatement\",\"start\":22,\"end\":24,\"body\":[]},"
          , "\"async\":false,\"generator\":false},"
          , "\"specifiers\":[]},"
          , "{\"type\":\"ExportNamedDeclaration\",\"start\":31,\"end\":61,"
          , "\"declaration\":{\"type\":\"FunctionDeclaration\",\"start\":38,\"end\":61,"
          , "\"id\":{\"type\":\"Identifier\",\"start\":47,\"end\":50,\"name\":\"baz\"},"
          , "\"params\":[],\"body\":{\"type\":\"BlockStatement\",\"start\":53,\"end\":55,\"body\":[]},"
          , "\"async\":false,\"generator\":false},"
          , "\"specifiers\":[]}"
          , "]}"
          ]
    -- both names reach the export index (true on HEAD already — sanity)
    hasExport "foo" NamedExport fa `shouldBe` True
    hasExport "baz" NamedExport fa `shouldBe` True
    -- but the two statements must be TWO distinct EXPORT nodes, not one merged id
    let exportIds = nub (map gnId (findNodes "EXPORT" "named" fa))
    length exportIds `shouldBe` 2

  -- Test 8c: the same sid-collision class on the star arm — two
  -- `export * from './utils'` statements (duplicate source) mint the constant
  -- sid `test.js->EXPORT->*:./utils` (Declarations.hs:695) and merge. Each
  -- statement must own a distinct EXPORT node.
  it "emits a distinct EXPORT node per star re-export statement (duplicate source)" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":50,\"body\":["
          , "{\"type\":\"ExportAllDeclaration\",\"start\":0,\"end\":25,"
          , "\"source\":{\"type\":\"Literal\",\"start\":14,\"end\":23,\"value\":\"./utils\",\"raw\":\"'./utils'\"}},"
          , "{\"type\":\"ExportAllDeclaration\",\"start\":26,\"end\":50,"
          , "\"source\":{\"type\":\"Literal\",\"start\":40,\"end\":49,\"value\":\"./utils\",\"raw\":\"'./utils'\"}}"
          , "]}"
          ]
    let exportIds = nub (map gnId (findNodes "EXPORT" "*:./utils" fa))
    length exportIds `shouldBe` 2


edgeCaseTests :: Spec
edgeCaseTests = do

  -- Test 9: const x = 1; function f() { const x = 2; return x; } -- shadowing
  it "resolves shadowed variable to inner declaration" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":60,\"body\":["
          , "{\"type\":\"VariableDeclaration\",\"start\":0,\"end\":14,\"kind\":\"const\",\"declarations\":["
          , "{\"type\":\"VariableDeclarator\",\"start\":6,\"end\":13,"
          , "\"id\":{\"type\":\"Identifier\",\"start\":6,\"end\":7,\"name\":\"x\"},"
          , "\"init\":{\"type\":\"Literal\",\"start\":10,\"end\":11,\"value\":1,\"raw\":\"1\"}}"
          , "]},"
          , "{\"type\":\"FunctionDeclaration\",\"start\":15,\"end\":60,"
          , "\"id\":{\"type\":\"Identifier\",\"start\":24,\"end\":25,\"name\":\"f\"},"
          , "\"params\":[],\"body\":{\"type\":\"BlockStatement\",\"start\":28,\"end\":60,\"body\":["
          , "{\"type\":\"VariableDeclaration\",\"start\":30,\"end\":44,\"kind\":\"const\",\"declarations\":["
          , "{\"type\":\"VariableDeclarator\",\"start\":36,\"end\":43,"
          , "\"id\":{\"type\":\"Identifier\",\"start\":36,\"end\":37,\"name\":\"x\"},"
          , "\"init\":{\"type\":\"Literal\",\"start\":40,\"end\":41,\"value\":2,\"raw\":\"2\"}}"
          , "]},"
          , "{\"type\":\"ReturnStatement\",\"start\":45,\"end\":55,"
          , "\"argument\":{\"type\":\"Identifier\",\"start\":52,\"end\":53,\"name\":\"x\"}}"
          , "]},\"async\":false,\"generator\":false}"
          , "]}"
          ]
    -- There should be two CONSTANT nodes named "x"
    let constNodes = findNodes "CONSTANT" "x" fa
    length constNodes `shouldSatisfy` (>= 2)
    -- Find the inner CONSTANT (the one with parent "f" in its semantic ID)
    -- Semantic IDs: outer = "test.js->CONSTANT->x", inner = "test.js->CONSTANT->x[in:f]"
    let innerConst = filter (\n -> gnId n == "test.js->CONSTANT->x[in:f]") constNodes
        outerConst = filter (\n -> gnId n == "test.js->CONSTANT->x") constNodes
    length innerConst `shouldBe` 1
    length outerConst `shouldBe` 1
    -- The REFERENCE inside f should resolve to the inner const, not the outer
    let refNodesList = findNodes "REFERENCE" "x" fa
        innerConstId = case innerConst of
          (n:_) -> gnId n
          []    -> error "inner CONSTANT x not found"
        outerConstId = case outerConst of
          (n:_) -> gnId n
          []    -> error "outer CONSTANT x not found"
    -- The return x inside f should read from the inner const
    let refsReadingInner = filter (\ref -> hasEdge "READS_FROM" (gnId ref) innerConstId fa) refNodesList
        refsReadingOuter = filter (\ref -> hasEdge "READS_FROM" (gnId ref) outerConstId fa) refNodesList
    length refsReadingInner `shouldSatisfy` (>= 1)
    -- No reference should read from the outer const (it is shadowed)
    length refsReadingOuter `shouldBe` 0

  -- Test 10: try {} catch (e) { e; } -- catch binding resolution
  it "resolves catch binding reference" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":30,\"body\":["
          , "{\"type\":\"TryStatement\",\"start\":0,\"end\":30,"
          , "\"block\":{\"type\":\"BlockStatement\",\"start\":4,\"end\":6,\"body\":[]},"
          , "\"handler\":{\"type\":\"CatchClause\",\"start\":7,\"end\":30,"
          , "\"param\":{\"type\":\"Identifier\",\"start\":14,\"end\":15,\"name\":\"e\"},"
          , "\"body\":{\"type\":\"BlockStatement\",\"start\":17,\"end\":30,\"body\":["
          , "{\"type\":\"ExpressionStatement\",\"start\":19,\"end\":22,"
          , "\"expression\":{\"type\":\"Identifier\",\"start\":19,\"end\":20,\"name\":\"e\"}}"
          , "]}},"
          , "\"finalizer\":null}"
          , "]}"
          ]
    hasNode "PARAMETER" "e" fa `shouldBe` True
    hasNode "REFERENCE" "e" fa `shouldBe` True
    paramNode <- requireNode "PARAMETER" "e" fa
    let paramId = gnId paramNode
        refNodesList = findNodes "REFERENCE" "e" fa
    any (\ref -> hasEdge "READS_FROM" (gnId ref) paramId fa) refNodesList `shouldBe` True


importResolutionTests :: Spec
importResolutionTests = do

  -- Named import: import { foo } from './utils'
  it "propagates source metadata to named import binding" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":35,\"body\":["
          , "{\"type\":\"ImportDeclaration\",\"start\":0,\"end\":35,"
          , "\"specifiers\":["
          , "{\"type\":\"ImportSpecifier\",\"start\":9,\"end\":12,"
          , "\"local\":{\"type\":\"Identifier\",\"start\":9,\"end\":12,\"name\":\"foo\"},"
          , "\"imported\":{\"type\":\"Identifier\",\"start\":9,\"end\":12,\"name\":\"foo\"}}"
          , "],"
          , "\"source\":{\"type\":\"Literal\",\"start\":20,\"end\":29,\"value\":\"./utils\",\"raw\":\"'./utils'\"}}"
          , "]}"
          ]
    -- IMPORT_BINDING node should exist with correct metadata
    ibNode <- requireNode "IMPORT_BINDING" "foo" fa
    Map.lookup "source" (gnMetadata ibNode) `shouldBe` Just (MetaText "./utils")
    Map.lookup "importedName" (gnMetadata ibNode) `shouldBe` Just (MetaText "foo")
    -- Semantic ID should include source as parent
    gnId ibNode `shouldBe` "test.js->IMPORT_BINDING->foo[in:./utils]"

  -- Default import: import bar from './mod'
  it "propagates source metadata to default import binding" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":30,\"body\":["
          , "{\"type\":\"ImportDeclaration\",\"start\":0,\"end\":30,"
          , "\"specifiers\":["
          , "{\"type\":\"ImportDefaultSpecifier\",\"start\":7,\"end\":10,"
          , "\"local\":{\"type\":\"Identifier\",\"start\":7,\"end\":10,\"name\":\"bar\"}}"
          , "],"
          , "\"source\":{\"type\":\"Literal\",\"start\":18,\"end\":25,\"value\":\"./mod\",\"raw\":\"'./mod'\"}}"
          , "]}"
          ]
    ibNode <- requireNode "IMPORT_BINDING" "bar" fa
    Map.lookup "source" (gnMetadata ibNode) `shouldBe` Just (MetaText "./mod")
    Map.lookup "importedName" (gnMetadata ibNode) `shouldBe` Just (MetaText "default")
    gnId ibNode `shouldBe` "test.js->IMPORT_BINDING->bar[in:./mod]"

  -- IMPORT → CONTAINS → IMPORT_BINDING edge
  it "emits CONTAINS edge from IMPORT to IMPORT_BINDING" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":35,\"body\":["
          , "{\"type\":\"ImportDeclaration\",\"start\":0,\"end\":35,"
          , "\"specifiers\":["
          , "{\"type\":\"ImportSpecifier\",\"start\":9,\"end\":12,"
          , "\"local\":{\"type\":\"Identifier\",\"start\":9,\"end\":12,\"name\":\"foo\"},"
          , "\"imported\":{\"type\":\"Identifier\",\"start\":9,\"end\":12,\"name\":\"foo\"}}"
          , "],"
          , "\"source\":{\"type\":\"Literal\",\"start\":20,\"end\":29,\"value\":\"./utils\",\"raw\":\"'./utils'\"}}"
          , "]}"
          ]
    importNode <- requireNode "IMPORT" "./utils" fa
    ibNode <- requireNode "IMPORT_BINDING" "foo" fa
    hasEdge "CONTAINS" (gnId importNode) (gnId ibNode) fa `shouldBe` True

  -- Namespace import: import * as ns from './all'
  it "propagates source metadata to namespace import binding" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":30,\"body\":["
          , "{\"type\":\"ImportDeclaration\",\"start\":0,\"end\":30,"
          , "\"specifiers\":["
          , "{\"type\":\"ImportNamespaceSpecifier\",\"start\":7,\"end\":14,"
          , "\"local\":{\"type\":\"Identifier\",\"start\":12,\"end\":14,\"name\":\"ns\"}}"
          , "],"
          , "\"source\":{\"type\":\"Literal\",\"start\":22,\"end\":28,\"value\":\"./all\",\"raw\":\"'./all'\"}}"
          , "]}"
          ]
    ibNode <- requireNode "IMPORT_BINDING" "ns" fa
    Map.lookup "source" (gnMetadata ibNode) `shouldBe` Just (MetaText "./all")
    Map.lookup "importedName" (gnMetadata ibNode) `shouldBe` Just (MetaText "*")
    gnId ibNode `shouldBe` "test.js->IMPORT_BINDING->ns[in:./all]"


interfaceTests :: Spec
interfaceTests = do

  -- interface Foo { bar: string; baz: number; }
  it "creates INTERFACE node and PROPERTY_SIGNATURE children with HAS_PROPERTY edges" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":46,\"body\":["
          , "{\"type\":\"TSInterfaceDeclaration\",\"start\":0,\"end\":46,"
          , "\"id\":{\"type\":\"Identifier\",\"start\":10,\"end\":13,\"name\":\"Foo\"},"
          , "\"body\":{\"type\":\"TSInterfaceBody\",\"start\":14,\"end\":46,\"body\":["
          , "{\"type\":\"TSPropertySignature\",\"start\":16,\"end\":28,"
          , "\"key\":{\"type\":\"Identifier\",\"start\":16,\"end\":19,\"name\":\"bar\"},"
          , "\"computed\":false,"
          , "\"typeAnnotation\":{\"type\":\"TSTypeAnnotation\",\"start\":19,\"end\":27,"
          , "\"typeAnnotation\":{\"type\":\"TSStringKeyword\",\"start\":21,\"end\":27}}},"
          , "{\"type\":\"TSPropertySignature\",\"start\":29,\"end\":41,"
          , "\"key\":{\"type\":\"Identifier\",\"start\":29,\"end\":32,\"name\":\"baz\"},"
          , "\"computed\":false,"
          , "\"typeAnnotation\":{\"type\":\"TSTypeAnnotation\",\"start\":32,\"end\":40,"
          , "\"typeAnnotation\":{\"type\":\"TSNumberKeyword\",\"start\":34,\"end\":40}}}"
          , "]}}"
          , "]}"
          ]
    -- INTERFACE node exists
    hasNode "INTERFACE" "Foo" fa `shouldBe` True
    -- PROPERTY_SIGNATURE nodes exist
    hasNode "PROPERTY_SIGNATURE" "bar" fa `shouldBe` True
    hasNode "PROPERTY_SIGNATURE" "baz" fa `shouldBe` True
    -- Semantic IDs include interface name via withNamedParent
    barNode <- requireNode "PROPERTY_SIGNATURE" "bar" fa
    gnId barNode `shouldSatisfy` \nid -> "Foo" `Data.Text.isInfixOf` nid
    -- HAS_PROPERTY edges from INTERFACE to PROPERTY_SIGNATURE
    ifaceNode <- requireNode "INTERFACE" "Foo" fa
    let iid = gnId ifaceNode
    hasEdge "HAS_PROPERTY" iid (gnId barNode) fa `shouldBe` True
    bazNode <- requireNode "PROPERTY_SIGNATURE" "baz" fa
    hasEdge "HAS_PROPERTY" iid (gnId bazNode) fa `shouldBe` True

  -- interface Bar { greet(): void; }
  it "creates METHOD_SIGNATURE with HAS_PROPERTY edge from interface" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":35,\"body\":["
          , "{\"type\":\"TSInterfaceDeclaration\",\"start\":0,\"end\":35,"
          , "\"id\":{\"type\":\"Identifier\",\"start\":10,\"end\":13,\"name\":\"Bar\"},"
          , "\"body\":{\"type\":\"TSInterfaceBody\",\"start\":14,\"end\":35,\"body\":["
          , "{\"type\":\"TSMethodSignature\",\"start\":16,\"end\":33,"
          , "\"key\":{\"type\":\"Identifier\",\"start\":16,\"end\":21,\"name\":\"greet\"},"
          , "\"computed\":false,\"kind\":\"method\","
          , "\"params\":[],"
          , "\"returnType\":{\"type\":\"TSTypeAnnotation\",\"start\":23,\"end\":29,"
          , "\"typeAnnotation\":{\"type\":\"TSVoidKeyword\",\"start\":25,\"end\":29}}}"
          , "]}}"
          , "]}"
          ]
    hasNode "INTERFACE" "Bar" fa `shouldBe` True
    hasNode "METHOD_SIGNATURE" "greet" fa `shouldBe` True
    -- HAS_PROPERTY edge from interface to method signature
    ifaceNode <- requireNode "INTERFACE" "Bar" fa
    let iid = gnId ifaceNode
    methodNode <- requireNode "METHOD_SIGNATURE" "greet" fa
    hasEdge "HAS_PROPERTY" iid (gnId methodNode) fa `shouldBe` True


callArgCountTests :: Spec
callArgCountTests = do

  -- f() — 0-argument call should have argCount=0
  it "stores argCount=0 for zero-arg call" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":10,\"body\":["
          , "{\"type\":\"ExpressionStatement\",\"start\":0,\"end\":4,"
          , "\"expression\":{\"type\":\"CallExpression\",\"start\":0,\"end\":3,"
          , "\"callee\":{\"type\":\"Identifier\",\"start\":0,\"end\":1,\"name\":\"f\"},"
          , "\"arguments\":[]}}"
          , "]}"
          ]
    callNode <- requireNode "CALL" "f" fa
    Map.lookup "argCount" (gnMetadata callNode) `shouldBe` Just (MetaInt 0)

  -- f(1, 2) — 2-argument call should have argCount=2
  it "stores argCount=2 for two-arg call" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":10,\"body\":["
          , "{\"type\":\"ExpressionStatement\",\"start\":0,\"end\":7,"
          , "\"expression\":{\"type\":\"CallExpression\",\"start\":0,\"end\":6,"
          , "\"callee\":{\"type\":\"Identifier\",\"start\":0,\"end\":1,\"name\":\"f\"},"
          , "\"arguments\":["
          , "{\"type\":\"Literal\",\"start\":2,\"end\":3,\"value\":1,\"raw\":\"1\"},"
          , "{\"type\":\"Literal\",\"start\":4,\"end\":5,\"value\":2,\"raw\":\"2\"}"
          , "]}}"
          , "]}"
          ]
    callNode <- requireNode "CALL" "f" fa
    Map.lookup "argCount" (gnMetadata callNode) `shouldBe` Just (MetaInt 2)

  -- new Foo(x) — constructor call should have argCount=1 and kind="new"
  it "stores argCount and kind for new expression" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":12,\"body\":["
          , "{\"type\":\"ExpressionStatement\",\"start\":0,\"end\":11,"
          , "\"expression\":{\"type\":\"NewExpression\",\"start\":0,\"end\":10,"
          , "\"callee\":{\"type\":\"Identifier\",\"start\":4,\"end\":7,\"name\":\"Foo\"},"
          , "\"arguments\":["
          , "{\"type\":\"Identifier\",\"start\":8,\"end\":9,\"name\":\"x\"}"
          , "]}}"
          , "]}"
          ]
    callNode <- requireNode "CALL" "Foo" fa
    Map.lookup "argCount" (gnMetadata callNode) `shouldBe` Just (MetaInt 1)
    Map.lookup "kind" (gnMetadata callNode) `shouldBe` Just (MetaText "new")

  -- import('./mod') — dynamic import should have argCount=1
  it "stores argCount=1 for dynamic import" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":18,\"body\":["
          , "{\"type\":\"ExpressionStatement\",\"start\":0,\"end\":17,"
          , "\"expression\":{\"type\":\"ImportExpression\",\"start\":0,\"end\":16,"
          , "\"source\":{\"type\":\"Literal\",\"start\":7,\"end\":14,\"value\":\"./mod\",\"raw\":\"'./mod'\"}}}"
          , "]}"
          ]
    callNode <- requireNode "CALL" "import" fa
    Map.lookup "argCount" (gnMetadata callNode) `shouldBe` Just (MetaInt 1)
    Map.lookup "kind" (gnMetadata callNode) `shouldBe` Just (MetaText "dynamic_import")

  -- tag`${x}${y}` — tagged template with 2 expressions should have argCount=2
  it "stores argCount for tagged template expressions" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":20,\"body\":["
          , "{\"type\":\"ExpressionStatement\",\"start\":0,\"end\":19,"
          , "\"expression\":{\"type\":\"TaggedTemplateExpression\",\"start\":0,\"end\":18,"
          , "\"tag\":{\"type\":\"Identifier\",\"start\":0,\"end\":3,\"name\":\"tag\"},"
          , "\"quasi\":{\"type\":\"TemplateLiteral\",\"start\":3,\"end\":18,"
          , "\"quasis\":["
          , "{\"type\":\"TemplateElement\",\"start\":4,\"end\":4,\"value\":{\"raw\":\"\",\"cooked\":\"\"},\"tail\":false},"
          , "{\"type\":\"TemplateElement\",\"start\":8,\"end\":8,\"value\":{\"raw\":\"\",\"cooked\":\"\"},\"tail\":false},"
          , "{\"type\":\"TemplateElement\",\"start\":12,\"end\":12,\"value\":{\"raw\":\"\",\"cooked\":\"\"},\"tail\":true}"
          , "],"
          , "\"expressions\":["
          , "{\"type\":\"Identifier\",\"start\":6,\"end\":7,\"name\":\"x\"},"
          , "{\"type\":\"Identifier\",\"start\":10,\"end\":11,\"name\":\"y\"}"
          , "]}}}"
          , "]}"
          ]
    callNode <- requireNode "CALL" "tag" fa
    Map.lookup "argCount" (gnMetadata callNode) `shouldBe` Just (MetaInt 2)
    Map.lookup "kind" (gnMetadata callNode) `shouldBe` Just (MetaText "tagged_template")


-- ── Chained call receiver tests (RECEIVER_CALL edge) ─────────────────
chainedCallTests :: Spec
chainedCallTests = do

  -- a().b()  -- two-deep chain: outer CALL "<obj>.b" must have RECEIVER_CALL → inner CALL "a"
  it "emits RECEIVER_CALL from outer call to inner call in 2-deep chain" $ do
    -- AST for: a().b()
    -- Outer: CallExpression { callee: MemberExpression { object: CallExpression { callee: a }, property: b }, args: [] }
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":10,\"body\":["
          , "{\"type\":\"ExpressionStatement\",\"start\":0,\"end\":6,"
          , "\"expression\":{\"type\":\"CallExpression\",\"start\":0,\"end\":6,"
          , "\"callee\":{\"type\":\"MemberExpression\",\"start\":0,\"end\":5,"
          , "\"object\":{\"type\":\"CallExpression\",\"start\":0,\"end\":3,"
          , "\"callee\":{\"type\":\"Identifier\",\"start\":0,\"end\":1,\"name\":\"a\"},"
          , "\"arguments\":[]},"
          , "\"property\":{\"type\":\"Identifier\",\"start\":4,\"end\":5,\"name\":\"b\"},"
          , "\"computed\":false},"
          , "\"arguments\":[]}}"
          , "]}"
          ]
    -- Both CALL nodes exist
    let callNodes = filter (\n -> gnType n == "CALL") (faNodes fa)
    length callNodes `shouldBe` 2
    innerCall <- requireNode "CALL" "a" fa
    -- Outer call has name "<obj>.b" because object is a CallExpression (no Identifier name)
    let outerCalls = filter (\n -> gnType n == "CALL" && gnName n /= "a") callNodes
    length outerCalls `shouldBe` 1
    let outerCall = head outerCalls
    -- RECEIVER_CALL edge: outer CALL → inner CALL
    hasEdge "RECEIVER_CALL" (gnId outerCall) (gnId innerCall) fa `shouldBe` True

  -- a().b().c()  -- three-deep chain: TWO RECEIVER_CALL edges (c→b, b→a)
  it "emits two RECEIVER_CALL edges in 3-deep chain" $ do
    -- AST for: a().b().c()
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":12,\"body\":["
          , "{\"type\":\"ExpressionStatement\",\"start\":0,\"end\":10,"
          , "\"expression\":{\"type\":\"CallExpression\",\"start\":0,\"end\":10,"
          , "\"callee\":{\"type\":\"MemberExpression\",\"start\":0,\"end\":9,"
          , "\"object\":{\"type\":\"CallExpression\",\"start\":0,\"end\":7,"
          , "\"callee\":{\"type\":\"MemberExpression\",\"start\":0,\"end\":5,"
          , "\"object\":{\"type\":\"CallExpression\",\"start\":0,\"end\":3,"
          , "\"callee\":{\"type\":\"Identifier\",\"start\":0,\"end\":1,\"name\":\"a\"},"
          , "\"arguments\":[]},"
          , "\"property\":{\"type\":\"Identifier\",\"start\":4,\"end\":5,\"name\":\"b\"},"
          , "\"computed\":false},"
          , "\"arguments\":[]},"
          , "\"property\":{\"type\":\"Identifier\",\"start\":8,\"end\":9,\"name\":\"c\"},"
          , "\"computed\":false},"
          , "\"arguments\":[]}}"
          , "]}"
          ]
    -- Three CALL nodes total
    let callNodes = filter (\n -> gnType n == "CALL") (faNodes fa)
    length callNodes `shouldBe` 3
    -- Exactly two RECEIVER_CALL edges
    let receiverEdges = filter (\e -> geType e == "RECEIVER_CALL") (faEdges fa)
    length receiverEdges `shouldBe` 2

  -- a()  -- single call, no chain → NO RECEIVER_CALL edge
  it "does NOT emit RECEIVER_CALL for a non-chained call" $ do
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":5,\"body\":["
          , "{\"type\":\"ExpressionStatement\",\"start\":0,\"end\":4,"
          , "\"expression\":{\"type\":\"CallExpression\",\"start\":0,\"end\":3,"
          , "\"callee\":{\"type\":\"Identifier\",\"start\":0,\"end\":1,\"name\":\"a\"},"
          , "\"arguments\":[]}}"
          , "]}"
          ]
    let receiverEdges = filter (\e -> geType e == "RECEIVER_CALL") (faEdges fa)
    length receiverEdges `shouldBe` 0

  -- new Command('x').action(fn)  -- chain starting with NewExpression
  it "emits RECEIVER_CALL from outer call to inner NewExpression CALL" $ do
    -- AST for: new Command('x').action(fn)
    let fa = analyzeAST $ BL.concat
          [ "{\"type\":\"Program\",\"start\":0,\"end\":30,\"body\":["
          , "{\"type\":\"ExpressionStatement\",\"start\":0,\"end\":25,"
          , "\"expression\":{\"type\":\"CallExpression\",\"start\":0,\"end\":25,"
          , "\"callee\":{\"type\":\"MemberExpression\",\"start\":0,\"end\":21,"
          , "\"object\":{\"type\":\"NewExpression\",\"start\":0,\"end\":14,"
          , "\"callee\":{\"type\":\"Identifier\",\"start\":4,\"end\":11,\"name\":\"Command\"},"
          , "\"arguments\":["
          , "{\"type\":\"Literal\",\"start\":12,\"end\":13,\"value\":\"x\",\"raw\":\"'x'\"}"
          , "]},"
          , "\"property\":{\"type\":\"Identifier\",\"start\":15,\"end\":21,\"name\":\"action\"},"
          , "\"computed\":false},"
          , "\"arguments\":["
          , "{\"type\":\"Identifier\",\"start\":22,\"end\":24,\"name\":\"fn\"}"
          , "]}}"
          , "]}"
          ]
    innerCall <- requireNode "CALL" "Command" fa
    -- Outer CALL: name comes from getCallName, which for object=NewExpression returns "<obj>.action"
    let outerCalls = filter (\n -> gnType n == "CALL" && gnName n /= "Command") (faNodes fa)
    length outerCalls `shouldBe` 1
    let outerCall = head outerCalls
    hasEdge "RECEIVER_CALL" (gnId outerCall) (gnId innerCall) fa `shouldBe` True
