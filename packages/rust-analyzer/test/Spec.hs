{-# LANGUAGE OverloadedStrings #-}
-- | Tests for the Rust analyzer (Phase 1 + Phase 3 + Phase 4 + Phase 5 + Phase 6 + Phase 7 + Phase 8 + Phase 9 + Phase 10 + Phase 11 + Phase 12 + Phase 13 + Phase 14 + Phase 15).
--
-- Verifies:
-- * RustAST FromJSON: empty file parsing
-- * Walker: MODULE node emission with correct fields
-- * FileAnalysis: file/moduleId set correctly, no edges/refs/exports
-- * Declarations: FUNCTION and VARIABLE nodes, CONTAINS edges
-- * DataTypes: STRUCT, ENUM, VARIANT nodes, CONTAINS/HAS_FIELD edges
-- * Traits: TRAIT, IMPL_BLOCK, TYPE_SIGNATURE, ASSOCIATED_TYPE nodes
-- * Imports: IMPORT, IMPORT_BINDING nodes, CONTAINS edges, IMPORTS_FROM deferred refs
-- * Exports: ExportInfo records for pub items, pub use re-exports
-- * Expressions: CALL, BRANCH, CLOSURE, REFERENCE nodes + CONTAINS edges
-- * Patterns: PARAMETER, PATTERN, MATCH_ARM nodes + HANDLES_VARIANT edges
-- * Ownership: BORROW, DEREF nodes + BORROWS, BORROWS_MUT edges
-- * ErrorFlow: ERROR_PROPAGATES edges + error_exit_count metadata
-- * Unsafe: UNSAFE_BLOCK nodes, CONTAINS_UNSAFE edges, WRAPS_UNSAFE edges
-- * Closures: CAPTURES, CAPTURES_MUT, CAPTURES_MOVE edges
-- * TypeLevel: TYPE_ALIAS, LIFETIME, TRAIT_BOUND nodes + CONTAINS, LIFETIME_OF edges
-- * Attributes: ATTRIBUTE nodes, DERIVES edges, HAS_ATTRIBUTE edges
module Main where

import Test.Hspec
import Data.Aeson (eitherDecode)
import qualified Data.ByteString.Lazy.Char8 as BLC
import qualified Data.Map.Strict as Map
import Data.List (find)
import Data.Text (Text)

import RustAST
import Analysis.Types
import Analysis.Context (runAnalyzer)
import Analysis.Walker (walkFile)
import Grafema.SemanticId (makeModuleId, semanticId)
import Rules.ErrorFlow (countErrorExits)

main :: IO ()
main = hspec $ do

  -- ── MODULE node tests ──────────────────────────────────────────────
  describe "MODULE node" $ do

    it "emits MODULE node for minimal file" $ do
      let file = "src/main.rs"
          moduleId = makeModuleId file
          rustFile = RustFile []
          result = runAnalyzer file moduleId (walkFile rustFile)
      length (faNodes result) `shouldBe` 1
      let node = head (faNodes result)
      gnType node `shouldBe` "MODULE"
      gnName node `shouldBe` "main"
      gnFile node `shouldBe` file
      gnExported node `shouldBe` True

    it "extracts module name from mod.rs" $ do
      let file = "src/foo/mod.rs"
          moduleId = makeModuleId file
          rustFile = RustFile []
          result = runAnalyzer file moduleId (walkFile rustFile)
          node = head (faNodes result)
      gnName node `shouldBe` "foo"

    it "extracts module name from nested path" $ do
      let file = "packages/orchestrator/src/config.rs"
          moduleId = makeModuleId file
          rustFile = RustFile []
          result = runAnalyzer file moduleId (walkFile rustFile)
          node = head (faNodes result)
      gnName node `shouldBe` "config"

    it "sets correct line and column for MODULE node" $ do
      let file = "src/lib.rs"
          moduleId = makeModuleId file
          rustFile = RustFile []
          result = runAnalyzer file moduleId (walkFile rustFile)
          node = head (faNodes result)
      gnLine node `shouldBe` 1
      gnColumn node `shouldBe` 0

    it "sets module ID as MODULE#filepath" $ do
      let file = "src/main.rs"
          moduleId = makeModuleId file
          rustFile = RustFile []
          result = runAnalyzer file moduleId (walkFile rustFile)
          node = head (faNodes result)
      gnId node `shouldBe` "MODULE#src/main.rs"

  -- ── RustAST FromJSON tests ─────────────────────────────────────────
  describe "RustAST FromJSON" $ do

    it "parses empty file" $ do
      let json = BLC.pack "{\"items\":[]}"
      case eitherDecode json of
        Left err -> expectationFailure err
        Right rf -> rfItems (rf :: RustFile) `shouldBe` []

    it "parses Pos from JSON" $ do
      let json = BLC.pack "{\"line\":10,\"col\":5}"
      case eitherDecode json of
        Left err -> expectationFailure err
        Right pos -> do
          posLine (pos :: Pos) `shouldBe` 10
          posCol pos `shouldBe` 5

    it "parses Span from JSON" $ do
      let json = BLC.pack "{\"start\":{\"line\":1,\"col\":0},\"end\":{\"line\":1,\"col\":10}}"
      case eitherDecode json of
        Left err -> expectationFailure err
        Right sp -> do
          posLine (spanStart (sp :: Span)) `shouldBe` 1
          posCol (spanEnd sp) `shouldBe` 10

    it "parses Vis from JSON" $ do
      case eitherDecode (BLC.pack "\"pub\"") of
        Left err -> expectationFailure err
        Right vis -> (vis :: Vis) `shouldBe` VisPub
      case eitherDecode (BLC.pack "\"pub(crate)\"") of
        Left err -> expectationFailure err
        Right vis -> (vis :: Vis) `shouldBe` VisPubCrate
      case eitherDecode (BLC.pack "\"\"") of
        Left err -> expectationFailure err
        Right vis -> (vis :: Vis) `shouldBe` VisPrivate

    it "parses ItemFn from JSON" $ do
      let json = BLC.pack $ concat
            [ "{\"type\":\"ItemFn\",\"ident\":\"main\",\"vis\":\"pub\""
            , ",\"sig\":{\"inputs\":[]}"
            , ",\"block\":{\"stmts\":[]}"
            , ",\"span\":{\"start\":{\"line\":1,\"col\":0},\"end\":{\"line\":3,\"col\":1}}}"
            ]
      case eitherDecode json of
        Left err -> expectationFailure err
        Right item -> case (item :: RustItem) of
          ItemFn ident vis _ _ _ _ -> do
            ident `shouldBe` "main"
            vis `shouldBe` VisPub
          _ -> expectationFailure "expected ItemFn"

    it "parses ItemStruct from JSON" $ do
      let json = BLC.pack $ concat
            [ "{\"type\":\"ItemStruct\",\"ident\":\"Foo\",\"vis\":\"\""
            , ",\"span\":{\"start\":{\"line\":1,\"col\":0},\"end\":{\"line\":1,\"col\":20}}}"
            ]
      case eitherDecode json of
        Left err -> expectationFailure err
        Right item -> case (item :: RustItem) of
          ItemStruct ident _ _ _ _ _ _ -> ident `shouldBe` "Foo"
          _ -> expectationFailure "expected ItemStruct"

    it "parses ItemEnum from JSON" $ do
      let json = BLC.pack $ concat
            [ "{\"type\":\"ItemEnum\",\"ident\":\"Color\",\"vis\":\"pub\""
            , ",\"variants\":[{\"ident\":\"Red\",\"fields\":[],\"span\":{\"start\":{\"line\":2,\"col\":2},\"end\":{\"line\":2,\"col\":5}}}]"
            , ",\"span\":{\"start\":{\"line\":1,\"col\":0},\"end\":{\"line\":3,\"col\":1}}}"
            ]
      case eitherDecode json of
        Left err -> expectationFailure err
        Right item -> case (item :: RustItem) of
          ItemEnum ident _ variants _ _ -> do
            ident `shouldBe` "Color"
            length variants `shouldBe` 1
            rvIdent (head variants) `shouldBe` "Red"
          _ -> expectationFailure "expected ItemEnum"

    it "parses ExprPath from JSON" $ do
      let json = BLC.pack "{\"type\":\"Path\",\"path\":\"foo\",\"span\":{\"start\":{\"line\":1,\"col\":0},\"end\":{\"line\":1,\"col\":3}}}"
      case eitherDecode json of
        Left err -> expectationFailure err
        Right expr -> case (expr :: RustExpr) of
          ExprPath p _ -> p `shouldBe` "foo"
          _ -> expectationFailure "expected ExprPath"

    it "parses ExprCall from JSON" $ do
      let json = BLC.pack $ concat
            [ "{\"type\":\"Call\""
            , ",\"func\":{\"type\":\"Path\",\"path\":\"println\",\"span\":{\"start\":{\"line\":1,\"col\":0},\"end\":{\"line\":1,\"col\":7}}}"
            , ",\"args\":[]"
            , ",\"span\":{\"start\":{\"line\":1,\"col\":0},\"end\":{\"line\":1,\"col\":10}}}"
            ]
      case eitherDecode json of
        Left err -> expectationFailure err
        Right expr -> case (expr :: RustExpr) of
          ExprCall _ args _ -> length args `shouldBe` 0
          _ -> expectationFailure "expected ExprCall"

    it "parses PatIdent from JSON" $ do
      let json = BLC.pack "{\"type\":\"Ident\",\"ident\":\"x\",\"span\":{\"start\":{\"line\":1,\"col\":0},\"end\":{\"line\":1,\"col\":1}}}"
      case eitherDecode json of
        Left err -> expectationFailure err
        Right pat -> case (pat :: RustPat) of
          PatIdent ident _ _ _ -> ident `shouldBe` "x"
          _ -> expectationFailure "expected PatIdent"

    it "parses TypePath from JSON" $ do
      let json = BLC.pack "{\"type\":\"Path\",\"path\":\"String\",\"span\":{\"start\":{\"line\":1,\"col\":0},\"end\":{\"line\":1,\"col\":6}}}"
      case eitherDecode json of
        Left err -> expectationFailure err
        Right ty -> case (ty :: RustType) of
          TypePath p _ _ -> p `shouldBe` "String"
          _ -> expectationFailure "expected TypePath"

    it "parses UseTree from JSON" $ do
      let json = BLC.pack "{\"type\":\"Path\",\"ident\":\"std\",\"tree\":{\"type\":\"Name\",\"ident\":\"io\"}}"
      case eitherDecode json of
        Left err -> expectationFailure err
        Right tree -> case (tree :: RustUseTree) of
          UsePath ident subtree -> do
            ident `shouldBe` "std"
            case subtree of
              UseName name -> name `shouldBe` "io"
              _ -> expectationFailure "expected UseName subtree"
          _ -> expectationFailure "expected UsePath"

    it "parses RustAttribute from JSON" $ do
      let json = BLC.pack "{\"style\":\"outer\",\"path\":\"derive\",\"tokens\":\"Debug, Clone\"}"
      case eitherDecode json of
        Left err -> expectationFailure err
        Right attr -> do
          raStyle (attr :: RustAttribute) `shouldBe` "outer"
          raPath attr `shouldBe` "derive"
          raTokens attr `shouldBe` "Debug, Clone"

    it "falls back to ItemUnknown for unknown item types" $ do
      let json = BLC.pack "{\"type\":\"ItemFuture\",\"span\":{\"start\":{\"line\":1,\"col\":0},\"end\":{\"line\":1,\"col\":5}}}"
      case eitherDecode json of
        Left err -> expectationFailure err
        Right item -> case (item :: RustItem) of
          ItemUnknown _ -> pure ()
          _ -> expectationFailure "expected ItemUnknown"

    it "falls back to ExprUnknown for unknown expr types" $ do
      let json = BLC.pack "{\"type\":\"Yield\",\"span\":{\"start\":{\"line\":1,\"col\":0},\"end\":{\"line\":1,\"col\":5}}}"
      case eitherDecode json of
        Left err -> expectationFailure err
        Right expr -> case (expr :: RustExpr) of
          ExprUnknown _ -> pure ()
          _ -> expectationFailure "expected ExprUnknown"

    it "falls back to PatUnknown for unknown pat types" $ do
      let json = BLC.pack "{\"type\":\"Rest\",\"span\":{\"start\":{\"line\":1,\"col\":0},\"end\":{\"line\":1,\"col\":2}}}"
      case eitherDecode json of
        Left err -> expectationFailure err
        Right pat -> case (pat :: RustPat) of
          PatUnknown _ -> pure ()
          _ -> expectationFailure "expected PatUnknown"

    it "falls back to TypeUnknown for unknown type types" $ do
      let json = BLC.pack "{\"type\":\"Infer\",\"span\":{\"start\":{\"line\":1,\"col\":0},\"end\":{\"line\":1,\"col\":1}}}"
      case eitherDecode json of
        Left err -> expectationFailure err
        Right ty -> case (ty :: RustType) of
          TypeUnknown _ -> pure ()
          _ -> expectationFailure "expected TypeUnknown"

  -- ── FileAnalysis structure tests ───────────────────────────────────
  describe "FileAnalysis structure" $ do

    it "sets faFile correctly" $ do
      let file = "src/lib.rs"
          moduleId = makeModuleId file
          result = runAnalyzer file moduleId (walkFile (RustFile []))
      faFile result `shouldBe` file

    it "sets faModuleId correctly" $ do
      let file = "src/lib.rs"
          moduleId = makeModuleId file
          result = runAnalyzer file moduleId (walkFile (RustFile []))
      faModuleId result `shouldBe` "MODULE#src/lib.rs"

    it "has no edges in Phase 1" $ do
      let file = "src/main.rs"
          moduleId = makeModuleId file
          result = runAnalyzer file moduleId (walkFile (RustFile []))
      faEdges result `shouldBe` []

    it "has no unresolved refs in Phase 1" $ do
      let file = "src/main.rs"
          moduleId = makeModuleId file
          result = runAnalyzer file moduleId (walkFile (RustFile []))
      faUnresolvedRefs result `shouldBe` []

    it "has no exports in Phase 1" $ do
      let file = "src/main.rs"
          moduleId = makeModuleId file
          result = runAnalyzer file moduleId (walkFile (RustFile []))
      faExports result `shouldBe` []

  -- ── FileAnalysis Monoid ────────────────────────────────────────────
  describe "FileAnalysis Monoid" $ do

    it "mempty is empty" $ do
      faNodes (mempty :: FileAnalysis) `shouldBe` []
      faEdges (mempty :: FileAnalysis) `shouldBe` []

    it "mappend concatenates nodes" $ do
      let a = mempty { faNodes = [GraphNode "a" "T" "n" "f" 1 0 0 0 False mempty] }
          b = mempty { faNodes = [GraphNode "b" "T" "m" "f" 2 0 0 0 False mempty] }
      length (faNodes (a <> b)) `shouldBe` 2

  -- ── Declarations tests (Phase 3) ──────────────────────────────────
  describe "Declarations" $ do

    -- Test helpers
    let mkSpan line col = Span (Pos line col) (Pos line (col + 1))
        mkEmptyBlock = RustBlock []
        mkFnSig = RustFnSig False False False [] Nothing
        file = "src/main.rs"
        moduleId = makeModuleId file

        -- Helper: run analysis on a file with given items
        analyze items = runAnalyzer file moduleId (walkFile (RustFile items))

        -- Helper: find node by type and name
        findNode ntype nname result =
          find (\n -> gnType n == ntype && gnName n == nname) (faNodes result)

        -- Helper: find edge by type and target
        findEdge etype etarget result =
          find (\e -> geType e == etype && geTarget e == etarget) (faEdges result)

        -- Helper: get metadata value
        getMeta key node = Map.lookup key (gnMetadata node)

    it "fn main() {} -> FUNCTION node with name=main, exported=False" $ do
      let item = ItemFn "main" VisPrivate mkFnSig mkEmptyBlock [] (mkSpan 1 0)
          result = analyze [item]
      case findNode "FUNCTION" "main" result of
        Nothing -> expectationFailure "expected FUNCTION node 'main'"
        Just node -> do
          gnName node `shouldBe` "main"
          gnExported node `shouldBe` False
          gnFile node `shouldBe` file

    it "pub fn process() {} -> FUNCTION with exported=True, visibility=pub" $ do
      let item = ItemFn "process" VisPub mkFnSig mkEmptyBlock [] (mkSpan 1 0)
          result = analyze [item]
      case findNode "FUNCTION" "process" result of
        Nothing -> expectationFailure "expected FUNCTION node 'process'"
        Just node -> do
          gnExported node `shouldBe` True
          getMeta "visibility" node `shouldBe` Just (MetaText "pub")

    it "async fn handle() {} -> FUNCTION with async=true" $ do
      let asyncSig = RustFnSig True False False [] Nothing
          item = ItemFn "handle" VisPrivate asyncSig mkEmptyBlock [] (mkSpan 1 0)
          result = analyze [item]
      case findNode "FUNCTION" "handle" result of
        Nothing -> expectationFailure "expected FUNCTION node 'handle'"
        Just node ->
          getMeta "async" node `shouldBe` Just (MetaBool True)

    it "unsafe fn danger() {} -> FUNCTION with unsafe=true" $ do
      let unsafeSig = RustFnSig False True False [] Nothing
          item = ItemFn "danger" VisPrivate unsafeSig mkEmptyBlock [] (mkSpan 1 0)
          result = analyze [item]
      case findNode "FUNCTION" "danger" result of
        Nothing -> expectationFailure "expected FUNCTION node 'danger'"
        Just node ->
          getMeta "unsafe" node `shouldBe` Just (MetaBool True)

    it "const fn compute() {} -> FUNCTION with const=true" $ do
      let constSig = RustFnSig False False True [] Nothing
          item = ItemFn "compute" VisPrivate constSig mkEmptyBlock [] (mkSpan 1 0)
          result = analyze [item]
      case findNode "FUNCTION" "compute" result of
        Nothing -> expectationFailure "expected FUNCTION node 'compute'"
        Just node ->
          getMeta "const" node `shouldBe` Just (MetaBool True)

    it "const MAX: i32 = 100; -> VARIABLE with kind=const" $ do
      let ty = TypePath "i32" [] (mkSpan 1 10)
          expr = ExprLit "100" (mkSpan 1 16)
          item = ItemConst "MAX" VisPrivate ty expr (mkSpan 1 0) []
          result = analyze [item]
      case findNode "VARIABLE" "MAX" result of
        Nothing -> expectationFailure "expected VARIABLE node 'MAX'"
        Just node -> do
          getMeta "kind" node `shouldBe` Just (MetaText "const")
          getMeta "mutable" node `shouldBe` Just (MetaBool False)

    it "static mut COUNTER: i32 = 0; -> VARIABLE with kind=static, mutable=true" $ do
      let ty = TypePath "i32" [] (mkSpan 1 18)
          expr = ExprLit "0" (mkSpan 1 24)
          item = ItemStatic "COUNTER" VisPrivate ty True expr (mkSpan 1 0) []
          result = analyze [item]
      case findNode "VARIABLE" "COUNTER" result of
        Nothing -> expectationFailure "expected VARIABLE node 'COUNTER'"
        Just node -> do
          getMeta "kind" node `shouldBe` Just (MetaText "static")
          getMeta "mutable" node `shouldBe` Just (MetaBool True)

    it "CONTAINS edge from MODULE to FUNCTION" $ do
      let item = ItemFn "main" VisPrivate mkFnSig mkEmptyBlock [] (mkSpan 1 0)
          result = analyze [item]
          fnId = semanticId file "FUNCTION" "main" Nothing Nothing
      case findEdge "CONTAINS" fnId result of
        Nothing -> expectationFailure "expected CONTAINS edge to FUNCTION"
        Just edge -> geSource edge `shouldBe` moduleId

    it "CONTAINS edge from MODULE to VARIABLE (const)" $ do
      let ty = TypePath "i32" [] (mkSpan 1 10)
          expr = ExprLit "100" (mkSpan 1 16)
          item = ItemConst "MAX" VisPrivate ty expr (mkSpan 1 0) []
          result = analyze [item]
          varId = semanticId file "VARIABLE" "MAX" Nothing Nothing
      case findEdge "CONTAINS" varId result of
        Nothing -> expectationFailure "expected CONTAINS edge to VARIABLE"
        Just edge -> geSource edge `shouldBe` moduleId

    it "semantic ID format: file->FUNCTION->main" $ do
      let item = ItemFn "main" VisPrivate mkFnSig mkEmptyBlock [] (mkSpan 1 0)
          result = analyze [item]
      case findNode "FUNCTION" "main" result of
        Nothing -> expectationFailure "expected FUNCTION node 'main'"
        Just node ->
          gnId node `shouldBe` "src/main.rs->FUNCTION->main"

    it "let x = 5; inside fn body -> VARIABLE with kind=let" $ do
      let letPat = PatIdent "x" False False (mkSpan 2 8)
          letInit = ExprLit "5" (mkSpan 2 12)
          letStmt = StmtLocal letPat (Just letInit) (mkSpan 2 4)
          block = RustBlock [letStmt]
          item = ItemFn "main" VisPrivate mkFnSig block [] (mkSpan 1 0)
          result = analyze [item]
      case findNode "VARIABLE" "x" result of
        Nothing -> expectationFailure "expected VARIABLE node 'x'"
        Just node -> do
          getMeta "kind" node `shouldBe` Just (MetaText "let")
          getMeta "mutable" node `shouldBe` Just (MetaBool False)

    it "let mut y = 10; -> VARIABLE with mutable=true" $ do
      let letPat = PatIdent "y" True False (mkSpan 2 8)
          letInit = ExprLit "10" (mkSpan 2 14)
          letStmt = StmtLocal letPat (Just letInit) (mkSpan 2 4)
          block = RustBlock [letStmt]
          item = ItemFn "main" VisPrivate mkFnSig block [] (mkSpan 1 0)
          result = analyze [item]
      case findNode "VARIABLE" "y" result of
        Nothing -> expectationFailure "expected VARIABLE node 'y'"
        Just node ->
          getMeta "mutable" node `shouldBe` Just (MetaBool True)

    it "nested fn in block -> FUNCTION with correct parent" $ do
      let innerFn = ItemFn "helper" VisPrivate mkFnSig mkEmptyBlock [] (mkSpan 3 4)
          innerStmt = StmtItem innerFn
          block = RustBlock [innerStmt]
          outerFn = ItemFn "main" VisPrivate mkFnSig block [] (mkSpan 1 0)
          result = analyze [outerFn]
      -- Should find both functions
      case findNode "FUNCTION" "main" result of
        Nothing -> expectationFailure "expected FUNCTION node 'main'"
        Just _ -> pure ()
      case findNode "FUNCTION" "helper" result of
        Nothing -> expectationFailure "expected FUNCTION node 'helper'"
        Just node ->
          -- Nested function has parent context in semantic ID
          gnId node `shouldBe` semanticId file "FUNCTION" "helper" (Just "main") Nothing

    it "multiple functions -> correct number of nodes" $ do
      let fn1 = ItemFn "foo" VisPrivate mkFnSig mkEmptyBlock [] (mkSpan 1 0)
          fn2 = ItemFn "bar" VisPrivate mkFnSig mkEmptyBlock [] (mkSpan 5 0)
          fn3 = ItemFn "baz" VisPrivate mkFnSig mkEmptyBlock [] (mkSpan 9 0)
          result = analyze [fn1, fn2, fn3]
          -- 1 MODULE + 3 FUNCTION nodes = 4 nodes total
          fnNodes = filter (\n -> gnType n == "FUNCTION") (faNodes result)
      length fnNodes `shouldBe` 3

    it "pub(crate) visibility -> correct metadata" $ do
      let item = ItemFn "internal" VisPubCrate mkFnSig mkEmptyBlock [] (mkSpan 1 0)
          result = analyze [item]
      case findNode "FUNCTION" "internal" result of
        Nothing -> expectationFailure "expected FUNCTION node 'internal'"
        Just node -> do
          getMeta "visibility" node `shouldBe` Just (MetaText "pub(crate)")
          -- pub(crate) counts as exported
          gnExported node `shouldBe` True

  -- ── DataTypes tests (Phase 4) ────────────────────────────────────────
  describe "DataTypes" $ do

    -- Test helpers (reuse from Declarations block)
    let mkSpan' line col = Span (Pos line col) (Pos line (col + 1))
        file' = "src/main.rs"
        moduleId' = makeModuleId file'

        -- Helper: run analysis on a file with given items
        analyze' items = runAnalyzer file' moduleId' (walkFile (RustFile items))

        -- Helper: find node by type and name
        findNode' ntype nname result =
          find (\n -> gnType n == ntype && gnName n == nname) (faNodes result)

        -- Helper: find edge by type and target
        findEdge' etype etarget result =
          find (\e -> geType e == etype && geTarget e == etarget) (faEdges result)

        -- Helper: get metadata value
        getMeta' key node = Map.lookup key (gnMetadata node)

        -- Helper: get edge metadata value
        getEdgeMeta key edge = Map.lookup key (geMetadata edge)

        -- Helpers: common types and fields
        mkType name = TypePath name [] (mkSpan' 1 10)
        mkNamedField name ty = RustField (Just name) (mkType ty) VisPrivate
        mkTupleField ty = RustField Nothing (mkType ty) VisPrivate

    -- 1. Named struct -> STRUCT node
    it "named struct -> STRUCT node with name, visibility=private" $ do
      let item = ItemStruct "Foo" VisPrivate
                   [mkNamedField "x" "i32", mkNamedField "y" "i32"]
                   [] (mkSpan' 1 0) False False
          result = analyze' [item]
      case findNode' "STRUCT" "Foo" result of
        Nothing -> expectationFailure "expected STRUCT node 'Foo'"
        Just node -> do
          gnName node `shouldBe` "Foo"
          getMeta' "visibility" node `shouldBe` Just (MetaText "private")
          gnExported node `shouldBe` False

    -- 2. pub struct -> exported
    it "pub struct -> STRUCT with exported=True, visibility=pub" $ do
      let item = ItemStruct "Bar" VisPub [] [] (mkSpan' 1 0) False False
          result = analyze' [item]
      case findNode' "STRUCT" "Bar" result of
        Nothing -> expectationFailure "expected STRUCT node 'Bar'"
        Just node -> do
          gnExported node `shouldBe` True
          getMeta' "visibility" node `shouldBe` Just (MetaText "pub")

    -- 3. Tuple struct
    it "tuple struct -> STRUCT with tuple=True" $ do
      let item = ItemStruct "Point" VisPrivate
                   [mkTupleField "f64", mkTupleField "f64"]
                   [] (mkSpan' 1 0) True False
          result = analyze' [item]
      case findNode' "STRUCT" "Point" result of
        Nothing -> expectationFailure "expected STRUCT node 'Point'"
        Just node ->
          getMeta' "tuple" node `shouldBe` Just (MetaBool True)

    -- 4. Unit struct
    it "unit struct -> STRUCT with unit=True" $ do
      let item = ItemStruct "Marker" VisPrivate [] [] (mkSpan' 1 0) False True
          result = analyze' [item]
      case findNode' "STRUCT" "Marker" result of
        Nothing -> expectationFailure "expected STRUCT node 'Marker'"
        Just node -> do
          getMeta' "unit" node `shouldBe` Just (MetaBool True)
          getMeta' "tuple" node `shouldBe` Just (MetaBool False)

    -- 5. Named struct fields -> HAS_FIELD edges
    it "named struct fields -> HAS_FIELD edges with field_name metadata" $ do
      let item = ItemStruct "Config" VisPrivate
                   [mkNamedField "host" "String", mkNamedField "port" "u16"]
                   [] (mkSpan' 1 0) False False
          result = analyze' [item]
          structId = semanticId file' "STRUCT" "Config" Nothing Nothing
          hasFieldEdges = filter (\e -> geType e == "HAS_FIELD" && geSource e == structId) (faEdges result)
      length hasFieldEdges `shouldBe` 2
      -- Check field names via metadata
      let fieldNames = map (\e -> getEdgeMeta "field_name" e) hasFieldEdges
      fieldNames `shouldBe` [Just (MetaText "host"), Just (MetaText "port")]
      -- Check field indices
      let fieldIndices = map (\e -> getEdgeMeta "field_index" e) hasFieldEdges
      fieldIndices `shouldBe` [Just (MetaInt 0), Just (MetaInt 1)]

    -- 6. Enum -> ENUM node
    it "enum -> ENUM node" $ do
      let item = ItemEnum "Color" VisPrivate [] [] (mkSpan' 1 0)
          result = analyze' [item]
      case findNode' "ENUM" "Color" result of
        Nothing -> expectationFailure "expected ENUM node 'Color'"
        Just node -> do
          gnName node `shouldBe` "Color"
          getMeta' "visibility" node `shouldBe` Just (MetaText "private")

    -- 7. Enum variants -> VARIANT nodes
    it "enum variants -> VARIANT nodes" $ do
      let variants =
            [ RustVariant "Red"   [] (mkSpan' 2 2)
            , RustVariant "Green" [] (mkSpan' 3 2)
            , RustVariant "Blue"  [] (mkSpan' 4 2)
            ]
          item = ItemEnum "Color" VisPrivate variants [] (mkSpan' 1 0)
          result = analyze' [item]
          variantNodes = filter (\n -> gnType n == "VARIANT") (faNodes result)
      length variantNodes `shouldBe` 3

    -- 8. Unit variant -> kind=unit
    it "unit variant -> VARIANT kind=unit" $ do
      let variants = [RustVariant "None" [] (mkSpan' 2 2)]
          item = ItemEnum "Option" VisPrivate variants [] (mkSpan' 1 0)
          result = analyze' [item]
      case findNode' "VARIANT" "None" result of
        Nothing -> expectationFailure "expected VARIANT node 'None'"
        Just node ->
          getMeta' "kind" node `shouldBe` Just (MetaText "unit")

    -- 9. Tuple variant -> kind=tuple
    it "tuple variant -> VARIANT kind=tuple" $ do
      let variants = [RustVariant "Some" [mkTupleField "i32"] (mkSpan' 2 2)]
          item = ItemEnum "Option" VisPrivate variants [] (mkSpan' 1 0)
          result = analyze' [item]
      case findNode' "VARIANT" "Some" result of
        Nothing -> expectationFailure "expected VARIANT node 'Some'"
        Just node ->
          getMeta' "kind" node `shouldBe` Just (MetaText "tuple")

    -- 10. Struct variant -> kind=struct
    it "struct variant -> VARIANT kind=struct" $ do
      let variants = [RustVariant "Move" [mkNamedField "x" "i32", mkNamedField "y" "i32"] (mkSpan' 2 2)]
          item = ItemEnum "Event" VisPrivate variants [] (mkSpan' 1 0)
          result = analyze' [item]
      case findNode' "VARIANT" "Move" result of
        Nothing -> expectationFailure "expected VARIANT node 'Move'"
        Just node ->
          getMeta' "kind" node `shouldBe` Just (MetaText "struct")

    -- 11. CONTAINS edges: module->struct, module->enum, enum->variant
    it "CONTAINS edges: module->struct, module->enum, enum->variant" $ do
      let structItem = ItemStruct "Foo" VisPrivate [] [] (mkSpan' 1 0) False True
          variants = [RustVariant "A" [] (mkSpan' 4 2)]
          enumItem = ItemEnum "Bar" VisPrivate variants [] (mkSpan' 3 0)
          result = analyze' [structItem, enumItem]
          structId  = semanticId file' "STRUCT" "Foo" Nothing Nothing
          enumId    = semanticId file' "ENUM" "Bar" Nothing Nothing
          variantId = semanticId file' "VARIANT" "A" Nothing (Just "Bar")
      -- module -> struct
      case findEdge' "CONTAINS" structId result of
        Nothing -> expectationFailure "expected CONTAINS edge to STRUCT"
        Just edge -> geSource edge `shouldBe` moduleId'
      -- module -> enum
      case findEdge' "CONTAINS" enumId result of
        Nothing -> expectationFailure "expected CONTAINS edge to ENUM"
        Just edge -> geSource edge `shouldBe` moduleId'
      -- enum -> variant
      case findEdge' "CONTAINS" variantId result of
        Nothing -> expectationFailure "expected CONTAINS edge to VARIANT"
        Just edge -> geSource edge `shouldBe` enumId

    -- 12. Semantic IDs
    it "semantic IDs: file->STRUCT->Foo, file->VARIANT->Red[h:Color]" $ do
      let structItem = ItemStruct "Foo" VisPrivate [] [] (mkSpan' 1 0) False True
          variants = [RustVariant "Red" [] (mkSpan' 4 2)]
          enumItem = ItemEnum "Color" VisPrivate variants [] (mkSpan' 3 0)
          result = analyze' [structItem, enumItem]
      case findNode' "STRUCT" "Foo" result of
        Nothing -> expectationFailure "expected STRUCT node 'Foo'"
        Just node ->
          gnId node `shouldBe` "src/main.rs->STRUCT->Foo"
      case findNode' "VARIANT" "Red" result of
        Nothing -> expectationFailure "expected VARIANT node 'Red'"
        Just node ->
          gnId node `shouldBe` "src/main.rs->VARIANT->Red[h:Color]"

  -- ── Traits tests (Phase 5) ──────────────────────────────────────────
  describe "Traits" $ do

    -- Test helpers
    let mkSpanT line col = Span (Pos line col) (Pos line (col + 1))
        mkEmptyBlockT = RustBlock []
        mkFnSigT = RustFnSig False False False [] Nothing
        fileT = "src/main.rs"
        moduleIdT = makeModuleId fileT

        -- Helper: run analysis on a file with given items
        analyzeT items = runAnalyzer fileT moduleIdT (walkFile (RustFile items))

        -- Helper: find node by type and name
        findNodeT ntype nname result =
          find (\n -> gnType n == ntype && gnName n == nname) (faNodes result)

        -- Helper: find edge by type and target
        findEdgeT etype etarget result =
          find (\e -> geType e == etype && geTarget e == etarget) (faEdges result)

        -- Helper: get metadata value
        getMetaT key node = Map.lookup key (gnMetadata node)

    -- 1. Simple trait -> TRAIT node
    it "simple trait -> TRAIT node" $ do
      let item = ItemTrait "Display" VisPrivate [] [] (mkSpanT 1 0) False
          result = analyzeT [item]
      case findNodeT "TRAIT" "Display" result of
        Nothing -> expectationFailure "expected TRAIT node 'Display'"
        Just node -> do
          gnName node `shouldBe` "Display"
          gnExported node `shouldBe` False

    -- 2. pub trait -> TRAIT with exported=True, visibility=pub
    it "pub trait -> TRAIT with exported=True, visibility=pub" $ do
      let item = ItemTrait "Display" VisPub [] [] (mkSpanT 1 0) False
          result = analyzeT [item]
      case findNodeT "TRAIT" "Display" result of
        Nothing -> expectationFailure "expected TRAIT node 'Display'"
        Just node -> do
          gnExported node `shouldBe` True
          getMetaT "visibility" node `shouldBe` Just (MetaText "pub")

    -- 3. unsafe trait -> TRAIT with unsafe=true
    it "unsafe trait -> TRAIT with unsafe=true" $ do
      let item = ItemTrait "Send" VisPrivate [] [] (mkSpanT 1 0) True
          result = analyzeT [item]
      case findNodeT "TRAIT" "Send" result of
        Nothing -> expectationFailure "expected TRAIT node 'Send'"
        Just node ->
          getMetaT "unsafe" node `shouldBe` Just (MetaBool True)

    -- 4. Trait with method signature -> TYPE_SIGNATURE node
    it "trait with method signature -> TYPE_SIGNATURE node" $ do
      let methodSig = ItemTraitMethod "to_string" mkFnSigT (mkSpanT 2 4) []
          item = ItemTrait "Display" VisPrivate [methodSig] [] (mkSpanT 1 0) False
          result = analyzeT [item]
      case findNodeT "TYPE_SIGNATURE" "to_string" result of
        Nothing -> expectationFailure "expected TYPE_SIGNATURE node 'to_string'"
        Just node -> do
          gnName node `shouldBe` "to_string"
          gnFile node `shouldBe` fileT

    -- 5. HAS_METHOD edge from trait to method signature
    it "HAS_METHOD edge from trait to method signature" $ do
      let methodSig = ItemTraitMethod "to_string" mkFnSigT (mkSpanT 2 4) []
          item = ItemTrait "Display" VisPrivate [methodSig] [] (mkSpanT 1 0) False
          result = analyzeT [item]
          traitId = semanticId fileT "TRAIT" "Display" Nothing Nothing
          typeSigId = semanticId fileT "TYPE_SIGNATURE" "to_string" (Just "Display") Nothing
      case findEdgeT "HAS_METHOD" typeSigId result of
        Nothing -> expectationFailure "expected HAS_METHOD edge to TYPE_SIGNATURE"
        Just edge -> geSource edge `shouldBe` traitId

    -- 6. Trait with associated type -> ASSOCIATED_TYPE node
    it "trait with associated type -> ASSOCIATED_TYPE node" $ do
      let assocType = ItemAssocType "Item" (mkSpanT 2 4) []
          item = ItemTrait "Iterator" VisPrivate [assocType] [] (mkSpanT 1 0) False
          result = analyzeT [item]
      case findNodeT "ASSOCIATED_TYPE" "Item" result of
        Nothing -> expectationFailure "expected ASSOCIATED_TYPE node 'Item'"
        Just node -> do
          gnName node `shouldBe` "Item"
          gnFile node `shouldBe` fileT

    -- 7. Inherent impl -> IMPL_BLOCK with target_type metadata
    it "inherent impl -> IMPL_BLOCK with target_type metadata" $ do
      let selfTy = TypePath "MyStruct" [] (mkSpanT 1 5)
          item = ItemImpl selfTy Nothing [] (mkSpanT 1 0) [] False
          result = analyzeT [item]
      case findNodeT "IMPL_BLOCK" "MyStruct" result of
        Nothing -> expectationFailure "expected IMPL_BLOCK node 'MyStruct'"
        Just node -> do
          getMetaT "target_type" node `shouldBe` Just (MetaText "MyStruct")
          -- Inherent impl should not have trait metadata
          getMetaT "trait" node `shouldBe` Nothing

    -- 8. Trait impl -> IMPL_BLOCK with trait metadata
    it "trait impl -> IMPL_BLOCK with trait metadata" $ do
      let selfTy = TypePath "MyStruct" [] (mkSpanT 1 5)
          item = ItemImpl selfTy (Just "Display") [] (mkSpanT 1 0) [] False
          result = analyzeT [item]
      case findNodeT "IMPL_BLOCK" "MyStruct" result of
        Nothing -> expectationFailure "expected IMPL_BLOCK node 'MyStruct'"
        Just node -> do
          getMetaT "target_type" node `shouldBe` Just (MetaText "MyStruct")
          getMetaT "trait" node `shouldBe` Just (MetaText "Display")

    -- 9. Trait impl -> deferred IMPLEMENTS ref
    it "trait impl -> deferred IMPLEMENTS ref" $ do
      let selfTy = TypePath "MyStruct" [] (mkSpanT 1 5)
          item = ItemImpl selfTy (Just "Display") [] (mkSpanT 1 0) [] False
          result = analyzeT [item]
      length (faUnresolvedRefs result) `shouldBe` 1
      let ref = head (faUnresolvedRefs result)
      drKind ref `shouldBe` ImplResolve
      drName ref `shouldBe` "Display"
      drEdgeType ref `shouldBe` "IMPLEMENTS"
      drReceiver ref `shouldBe` Just "MyStruct"

    -- 10. Methods in impl -> FUNCTION nodes (via walkDeclarations delegation)
    it "methods in impl -> FUNCTION nodes via walkDeclarations" $ do
      let selfTy = TypePath "MyStruct" [] (mkSpanT 1 5)
          method = ItemFn "new" VisPub mkFnSigT mkEmptyBlockT [] (mkSpanT 2 4)
          item = ItemImpl selfTy Nothing [method] (mkSpanT 1 0) [] False
          result = analyzeT [item]
      case findNodeT "FUNCTION" "new" result of
        Nothing -> expectationFailure "expected FUNCTION node 'new'"
        Just node -> gnName node `shouldBe` "new"

    -- 11. CONTAINS edges: module->trait, module->impl_block
    it "CONTAINS edges: module->trait, module->impl_block" $ do
      let traitItem = ItemTrait "Display" VisPrivate [] [] (mkSpanT 1 0) False
          selfTy = TypePath "MyStruct" [] (mkSpanT 5 5)
          implItem = ItemImpl selfTy Nothing [] (mkSpanT 5 0) [] False
          result = analyzeT [traitItem, implItem]
          traitId = semanticId fileT "TRAIT" "Display" Nothing Nothing
          implId  = semanticId fileT "IMPL_BLOCK" "MyStruct" Nothing Nothing
      -- module -> trait
      case findEdgeT "CONTAINS" traitId result of
        Nothing -> expectationFailure "expected CONTAINS edge to TRAIT"
        Just edge -> geSource edge `shouldBe` moduleIdT
      -- module -> impl_block
      case findEdgeT "CONTAINS" implId result of
        Nothing -> expectationFailure "expected CONTAINS edge to IMPL_BLOCK"
        Just edge -> geSource edge `shouldBe` moduleIdT

    -- 12. Semantic ID: file->TRAIT->Display
    it "semantic ID: file->TRAIT->Display" $ do
      let item = ItemTrait "Display" VisPrivate [] [] (mkSpanT 1 0) False
          result = analyzeT [item]
      case findNodeT "TRAIT" "Display" result of
        Nothing -> expectationFailure "expected TRAIT node 'Display'"
        Just node ->
          gnId node `shouldBe` "src/main.rs->TRAIT->Display"

    -- 13. Semantic ID: file->IMPL_BLOCK->MyStruct (inherent)
    it "semantic ID: file->IMPL_BLOCK->MyStruct (inherent)" $ do
      let selfTy = TypePath "MyStruct" [] (mkSpanT 1 5)
          item = ItemImpl selfTy Nothing [] (mkSpanT 1 0) [] False
          result = analyzeT [item]
      case findNodeT "IMPL_BLOCK" "MyStruct" result of
        Nothing -> expectationFailure "expected IMPL_BLOCK node 'MyStruct'"
        Just node ->
          gnId node `shouldBe` "src/main.rs->IMPL_BLOCK->MyStruct"

    -- 14. Semantic ID: file->IMPL_BLOCK->MyStruct[in:Display] (trait impl)
    it "semantic ID: file->IMPL_BLOCK->MyStruct[in:Display] (trait impl)" $ do
      let selfTy = TypePath "MyStruct" [] (mkSpanT 1 5)
          item = ItemImpl selfTy (Just "Display") [] (mkSpanT 1 0) [] False
          result = analyzeT [item]
      case findNodeT "IMPL_BLOCK" "MyStruct" result of
        Nothing -> expectationFailure "expected IMPL_BLOCK node 'MyStruct'"
        Just node ->
          gnId node `shouldBe` "src/main.rs->IMPL_BLOCK->MyStruct[in:Display]"

    -- 15. Default method in trait -> FUNCTION node
    it "default method in trait -> FUNCTION node" $ do
      let defaultMethod = ItemFn "default_impl" VisPrivate mkFnSigT mkEmptyBlockT [] (mkSpanT 2 4)
          item = ItemTrait "MyTrait" VisPrivate [defaultMethod] [] (mkSpanT 1 0) False
          result = analyzeT [item]
      case findNodeT "FUNCTION" "default_impl" result of
        Nothing -> expectationFailure "expected FUNCTION node 'default_impl'"
        Just node -> gnName node `shouldBe` "default_impl"

  -- ── Imports tests (Phase 6) ──────────────────────────────────────────
  describe "Imports" $ do

    -- Test helpers
    let mkSpanI line col = Span (Pos line col) (Pos line (col + 1))
        fileI = "src/main.rs"
        moduleIdI = makeModuleId fileI

        -- Helper: run analysis on a file with given items
        analyzeI items = runAnalyzer fileI moduleIdI (walkFile (RustFile items))

        -- Helper: find node by type and name
        findNodeI ntype nname result =
          find (\n -> gnType n == ntype && gnName n == nname) (faNodes result)

        -- Helper: find all nodes by type
        findNodesI ntype result =
          filter (\n -> gnType n == ntype) (faNodes result)

        -- Helper: find edge by type and target
        findEdgeI etype etarget result =
          find (\e -> geType e == etype && geTarget e == etarget) (faEdges result)

        -- Helper: get metadata value
        getMetaI key node = Map.lookup key (gnMetadata node)

    -- 1. use std::io; -> IMPORT node with path="std" + IMPORT_BINDING "io"
    it "use std::io; -> IMPORT node with path=std and IMPORT_BINDING io" $ do
      let tree = UsePath "std" (UseName "io")
          item = ItemUse tree VisPrivate (mkSpanI 1 0) []
          result = analyzeI [item]
      case findNodeI "IMPORT" "std" result of
        Nothing -> expectationFailure "expected IMPORT node 'std'"
        Just node -> do
          gnName node `shouldBe` "std"
          getMetaI "path" node `shouldBe` Just (MetaText "std")
          getMetaI "glob" node `shouldBe` Just (MetaBool False)
      case findNodeI "IMPORT_BINDING" "io" result of
        Nothing -> expectationFailure "expected IMPORT_BINDING node 'io'"
        Just node -> do
          getMetaI "imported_name" node `shouldBe` Just (MetaText "io")
          getMetaI "local_name" node `shouldBe` Just (MetaText "io")

    -- 2. use std::io::Read; -> IMPORT + IMPORT_BINDING with imported_name="Read"
    it "use std::io::Read; -> IMPORT + IMPORT_BINDING with imported_name=Read" $ do
      let tree = UsePath "std" (UsePath "io" (UseName "Read"))
          item = ItemUse tree VisPrivate (mkSpanI 1 0) []
          result = analyzeI [item]
      case findNodeI "IMPORT" "std::io" result of
        Nothing -> expectationFailure "expected IMPORT node 'std::io'"
        Just node ->
          getMetaI "path" node `shouldBe` Just (MetaText "std::io")
      case findNodeI "IMPORT_BINDING" "Read" result of
        Nothing -> expectationFailure "expected IMPORT_BINDING node 'Read'"
        Just node -> do
          getMetaI "imported_name" node `shouldBe` Just (MetaText "Read")
          getMetaI "local_name" node `shouldBe` Just (MetaText "Read")

    -- 3. use std::io::{Read, Write}; -> IMPORT + 2 IMPORT_BINDING nodes
    it "use std::io::{Read, Write}; -> 2 IMPORT_BINDING nodes" $ do
      let tree = UsePath "std" (UsePath "io" (UseGroup [UseName "Read", UseName "Write"]))
          item = ItemUse tree VisPrivate (mkSpanI 1 0) []
          result = analyzeI [item]
          bindingNodes = findNodesI "IMPORT_BINDING" result
      length bindingNodes `shouldBe` 2
      case findNodeI "IMPORT_BINDING" "Read" result of
        Nothing -> expectationFailure "expected IMPORT_BINDING node 'Read'"
        Just _ -> pure ()
      case findNodeI "IMPORT_BINDING" "Write" result of
        Nothing -> expectationFailure "expected IMPORT_BINDING node 'Write'"
        Just _ -> pure ()

    -- 4. use std::io::*; -> IMPORT with glob=True
    it "use std::io::*; -> IMPORT with glob=True" $ do
      let tree = UsePath "std" (UsePath "io" UseGlob)
          item = ItemUse tree VisPrivate (mkSpanI 1 0) []
          result = analyzeI [item]
      case findNodeI "IMPORT" "std::io::*" result of
        Nothing -> expectationFailure "expected IMPORT node 'std::io::*'"
        Just node -> do
          getMetaI "glob" node `shouldBe` Just (MetaBool True)
          getMetaI "path" node `shouldBe` Just (MetaText "std::io::*")

    -- 5. use std::io::Read as IoRead; -> IMPORT_BINDING with imported_name="Read", local_name="IoRead"
    it "use std::io::Read as IoRead; -> IMPORT_BINDING with rename" $ do
      let tree = UsePath "std" (UsePath "io" (UseRename "Read" "IoRead"))
          item = ItemUse tree VisPrivate (mkSpanI 1 0) []
          result = analyzeI [item]
      case findNodeI "IMPORT_BINDING" "IoRead" result of
        Nothing -> expectationFailure "expected IMPORT_BINDING node 'IoRead'"
        Just node -> do
          getMetaI "imported_name" node `shouldBe` Just (MetaText "Read")
          getMetaI "local_name" node `shouldBe` Just (MetaText "IoRead")

    -- 6. use crate::foo::Bar; -> IMPORT with path containing "crate"
    it "use crate::foo::Bar; -> IMPORT with path containing crate" $ do
      let tree = UsePath "crate" (UsePath "foo" (UseName "Bar"))
          item = ItemUse tree VisPrivate (mkSpanI 1 0) []
          result = analyzeI [item]
      case findNodeI "IMPORT" "crate::foo" result of
        Nothing -> expectationFailure "expected IMPORT node 'crate::foo'"
        Just node ->
          getMetaI "path" node `shouldBe` Just (MetaText "crate::foo")

    -- 7. use super::Bar; -> IMPORT with path containing "super"
    it "use super::Bar; -> IMPORT with path containing super" $ do
      let tree = UsePath "super" (UseName "Bar")
          item = ItemUse tree VisPrivate (mkSpanI 1 0) []
          result = analyzeI [item]
      case findNodeI "IMPORT" "super" result of
        Nothing -> expectationFailure "expected IMPORT node 'super'"
        Just node ->
          getMetaI "path" node `shouldBe` Just (MetaText "super")

    -- 8. CONTAINS edges: module->import, import->binding
    it "CONTAINS edges: module->import, import->binding" $ do
      let tree = UsePath "std" (UsePath "io" (UseName "Read"))
          item = ItemUse tree VisPrivate (mkSpanI 1 0) []
          result = analyzeI [item]
          importId = semanticId fileI "IMPORT" "std::io" Nothing Nothing
          bindingId = semanticId fileI "IMPORT_BINDING" "Read" Nothing (Just "std::io::Read")
      -- module -> import
      case findEdgeI "CONTAINS" importId result of
        Nothing -> expectationFailure "expected CONTAINS edge to IMPORT"
        Just edge -> geSource edge `shouldBe` moduleIdI
      -- import -> binding
      case findEdgeI "CONTAINS" bindingId result of
        Nothing -> expectationFailure "expected CONTAINS edge to IMPORT_BINDING"
        Just edge -> geSource edge `shouldBe` importId

    -- 9. IMPORTS_FROM deferred refs created for each binding
    it "IMPORTS_FROM deferred refs created for each binding" $ do
      let tree = UsePath "std" (UsePath "io" (UseGroup [UseName "Read", UseName "Write"]))
          item = ItemUse tree VisPrivate (mkSpanI 1 0) []
          result = analyzeI [item]
          importRefs = filter (\r -> drKind r == ImportResolve) (faUnresolvedRefs result)
      length importRefs `shouldBe` 2
      let refNames = map drName importRefs
      refNames `shouldBe` ["Read", "Write"]
      -- Each ref should have source path
      let refSources = map drSource importRefs
      refSources `shouldBe` [Just "std::io::Read", Just "std::io::Write"]

    -- 10. Semantic ID format: file->IMPORT->std::io
    it "semantic ID format: file->IMPORT->std::io" $ do
      let tree = UsePath "std" (UsePath "io" (UseName "Read"))
          item = ItemUse tree VisPrivate (mkSpanI 1 0) []
          result = analyzeI [item]
      case findNodeI "IMPORT" "std::io" result of
        Nothing -> expectationFailure "expected IMPORT node 'std::io'"
        Just node ->
          gnId node `shouldBe` "src/main.rs->IMPORT->std::io"

    -- 11. Semantic ID format: file->IMPORT_BINDING->Read[h:std::io::Read]
    it "semantic ID format: file->IMPORT_BINDING->Read[h:std::io::Read]" $ do
      let tree = UsePath "std" (UsePath "io" (UseName "Read"))
          item = ItemUse tree VisPrivate (mkSpanI 1 0) []
          result = analyzeI [item]
      case findNodeI "IMPORT_BINDING" "Read" result of
        Nothing -> expectationFailure "expected IMPORT_BINDING node 'Read'"
        Just node ->
          gnId node `shouldBe` semanticId fileI "IMPORT_BINDING" "Read" Nothing (Just "std::io::Read")

    -- 12. Nested use groups flattened correctly
    it "nested use groups flattened correctly" $ do
      let tree = UsePath "std" (UseGroup
            [ UsePath "io" (UseGroup [UseName "Read", UseName "Write"])
            , UsePath "fmt" (UseName "Display")
            ])
          item = ItemUse tree VisPrivate (mkSpanI 1 0) []
          result = analyzeI [item]
          bindingNodes = findNodesI "IMPORT_BINDING" result
      -- Should have 3 bindings: Read, Write, Display
      length bindingNodes `shouldBe` 3
      case findNodeI "IMPORT_BINDING" "Read" result of
        Nothing -> expectationFailure "expected IMPORT_BINDING node 'Read'"
        Just _ -> pure ()
      case findNodeI "IMPORT_BINDING" "Write" result of
        Nothing -> expectationFailure "expected IMPORT_BINDING node 'Write'"
        Just _ -> pure ()
      case findNodeI "IMPORT_BINDING" "Display" result of
        Nothing -> expectationFailure "expected IMPORT_BINDING node 'Display'"
        Just _ -> pure ()

    -- 13. pub use -> exported=True on IMPORT and IMPORT_BINDING
    it "pub use -> exported=True on IMPORT and IMPORT_BINDING" $ do
      let tree = UsePath "std" (UsePath "io" (UseName "Read"))
          item = ItemUse tree VisPub (mkSpanI 1 0) []
          result = analyzeI [item]
      case findNodeI "IMPORT" "std::io" result of
        Nothing -> expectationFailure "expected IMPORT node 'std::io'"
        Just node -> gnExported node `shouldBe` True
      case findNodeI "IMPORT_BINDING" "Read" result of
        Nothing -> expectationFailure "expected IMPORT_BINDING node 'Read'"
        Just node -> gnExported node `shouldBe` True

    -- 14. Glob import has no IMPORT_BINDING and no deferred refs
    it "glob import has no IMPORT_BINDING and no deferred refs" $ do
      let tree = UsePath "std" (UsePath "io" UseGlob)
          item = ItemUse tree VisPrivate (mkSpanI 1 0) []
          result = analyzeI [item]
          bindingNodes = findNodesI "IMPORT_BINDING" result
      length bindingNodes `shouldBe` 0
      -- No deferred refs for glob (can't resolve * to specific names)
      let importRefs = filter (\r -> drKind r == ImportResolve) (faUnresolvedRefs result)
      length importRefs `shouldBe` 0

  -- ── Exports tests (Phase 7) ──────────────────────────────────────────
  describe "Exports" $ do

    -- Test helpers
    let mkSpanE line col = Span (Pos line col) (Pos line (col + 1))
        mkEmptyBlockE = RustBlock []
        mkFnSigE = RustFnSig False False False [] Nothing
        mkDummyTypeE = TypePath "i32" [] (mkSpanE 1 10)
        mkDummyExprE = ExprLit "0" (mkSpanE 1 16)
        fileE = "src/lib.rs"
        moduleIdE = makeModuleId fileE

        -- Helper: run analysis on a file with given items
        analyzeE items = runAnalyzer fileE moduleIdE (walkFile (RustFile items))

        -- Helper: find export by name
        findExport ename result =
          find (\e -> eiName e == ename) (faExports result)

    -- 1. pub fn foo() -> ExportInfo with name="foo", kind=NamedExport
    it "pub fn foo() -> ExportInfo with name=foo, kind=NamedExport" $ do
      let item = ItemFn "foo" VisPub mkFnSigE mkEmptyBlockE [] (mkSpanE 1 0)
          result = analyzeE [item]
      case findExport "foo" result of
        Nothing -> expectationFailure "expected ExportInfo for 'foo'"
        Just ex -> do
          eiName ex `shouldBe` "foo"
          eiKind ex `shouldBe` NamedExport
          eiSource ex `shouldBe` Nothing
          eiNodeId ex `shouldBe` semanticId fileE "FUNCTION" "foo" Nothing Nothing

    -- 2. Private fn -> no ExportInfo
    it "private fn -> no ExportInfo" $ do
      let item = ItemFn "secret" VisPrivate mkFnSigE mkEmptyBlockE [] (mkSpanE 1 0)
          result = analyzeE [item]
      faExports result `shouldBe` []

    -- 3. pub struct Foo -> ExportInfo
    it "pub struct Foo -> ExportInfo with kind=NamedExport" $ do
      let item = ItemStruct "Foo" VisPub [] [] (mkSpanE 1 0) False False
          result = analyzeE [item]
      case findExport "Foo" result of
        Nothing -> expectationFailure "expected ExportInfo for 'Foo'"
        Just ex -> do
          eiKind ex `shouldBe` NamedExport
          eiNodeId ex `shouldBe` semanticId fileE "STRUCT" "Foo" Nothing Nothing

    -- 4. pub(crate) fn bar() -> ExportInfo (pub(crate) counts as exported)
    it "pub(crate) fn bar() -> ExportInfo" $ do
      let item = ItemFn "bar" VisPubCrate mkFnSigE mkEmptyBlockE [] (mkSpanE 1 0)
          result = analyzeE [item]
      case findExport "bar" result of
        Nothing -> expectationFailure "expected ExportInfo for 'bar'"
        Just ex -> do
          eiKind ex `shouldBe` NamedExport
          eiSource ex `shouldBe` Nothing

    -- 5. pub use crate::internal::Foo -> ExportInfo with kind=ReExport
    it "pub use crate::internal::Foo -> ReExport" $ do
      let tree = UsePath "crate" (UsePath "internal" (UseName "Foo"))
          item = ItemUse tree VisPub (mkSpanE 1 0) []
          result = analyzeE [item]
      case findExport "Foo" result of
        Nothing -> expectationFailure "expected ExportInfo for 'Foo'"
        Just ex -> do
          eiKind ex `shouldBe` ReExport
          eiSource ex `shouldBe` Just "crate::internal::Foo"

    -- 6. pub use crate::internal::* -> ExportInfo for glob re-export
    it "pub use crate::internal::* -> glob ReExport" $ do
      let tree = UsePath "crate" (UsePath "internal" UseGlob)
          item = ItemUse tree VisPub (mkSpanE 1 0) []
          result = analyzeE [item]
      case findExport "*" result of
        Nothing -> expectationFailure "expected ExportInfo for '*'"
        Just ex -> do
          eiKind ex `shouldBe` ReExport
          eiSource ex `shouldBe` Just "crate::internal::*"
          eiNodeId ex `shouldBe` ""

    -- 7. Multiple pub items -> correct number of ExportInfo entries
    it "multiple pub items -> correct number of ExportInfo entries" $ do
      let fn1 = ItemFn "alpha" VisPub mkFnSigE mkEmptyBlockE [] (mkSpanE 1 0)
          fn2 = ItemFn "beta" VisPub mkFnSigE mkEmptyBlockE [] (mkSpanE 2 0)
          fn3 = ItemFn "gamma" VisPrivate mkFnSigE mkEmptyBlockE [] (mkSpanE 3 0)
          result = analyzeE [fn1, fn2, fn3]
      length (faExports result) `shouldBe` 2

    -- 8. pub enum -> ExportInfo
    it "pub enum Color -> ExportInfo with kind=NamedExport" $ do
      let variant = RustVariant "Red" [] (mkSpanE 2 2)
          item = ItemEnum "Color" VisPub [variant] [] (mkSpanE 1 0)
          result = analyzeE [item]
      case findExport "Color" result of
        Nothing -> expectationFailure "expected ExportInfo for 'Color'"
        Just ex -> do
          eiKind ex `shouldBe` NamedExport
          eiNodeId ex `shouldBe` semanticId fileE "ENUM" "Color" Nothing Nothing

    -- 9. pub trait -> ExportInfo
    it "pub trait Display -> ExportInfo with kind=NamedExport" $ do
      let item = ItemTrait "Display" VisPub [] [] (mkSpanE 1 0) False
          result = analyzeE [item]
      case findExport "Display" result of
        Nothing -> expectationFailure "expected ExportInfo for 'Display'"
        Just ex -> do
          eiKind ex `shouldBe` NamedExport
          eiNodeId ex `shouldBe` semanticId fileE "TRAIT" "Display" Nothing Nothing

    -- 10. pub const -> ExportInfo
    it "pub const MAX -> ExportInfo with kind=NamedExport" $ do
      let item = ItemConst "MAX" VisPub mkDummyTypeE mkDummyExprE (mkSpanE 1 0) []
          result = analyzeE [item]
      case findExport "MAX" result of
        Nothing -> expectationFailure "expected ExportInfo for 'MAX'"
        Just ex -> do
          eiKind ex `shouldBe` NamedExport
          eiNodeId ex `shouldBe` semanticId fileE "VARIABLE" "MAX" Nothing Nothing

    -- 11. pub static -> ExportInfo
    it "pub static COUNTER -> ExportInfo with kind=NamedExport" $ do
      let item = ItemStatic "COUNTER" VisPub mkDummyTypeE False mkDummyExprE (mkSpanE 1 0) []
          result = analyzeE [item]
      case findExport "COUNTER" result of
        Nothing -> expectationFailure "expected ExportInfo for 'COUNTER'"
        Just ex -> do
          eiKind ex `shouldBe` NamedExport
          eiNodeId ex `shouldBe` semanticId fileE "VARIABLE" "COUNTER" Nothing Nothing

    -- 12. pub type -> ExportInfo
    it "pub type Alias -> ExportInfo with kind=NamedExport" $ do
      let item = ItemType "Alias" VisPub mkDummyTypeE (mkSpanE 1 0) []
          result = analyzeE [item]
      case findExport "Alias" result of
        Nothing -> expectationFailure "expected ExportInfo for 'Alias'"
        Just ex -> do
          eiKind ex `shouldBe` NamedExport
          eiNodeId ex `shouldBe` semanticId fileE "TYPE_ALIAS" "Alias" Nothing Nothing

    -- 13. private use -> no ExportInfo
    it "private use -> no ExportInfo" $ do
      let tree = UsePath "std" (UsePath "io" (UseName "Read"))
          item = ItemUse tree VisPrivate (mkSpanE 1 0) []
          result = analyzeE [item]
      faExports result `shouldBe` []

    -- 14. pub use with grouped items -> multiple ReExport entries
    it "pub use with grouped items -> multiple ReExport entries" $ do
      let tree = UsePath "crate" (UsePath "internal" (UseGroup [UseName "Foo", UseName "Bar"]))
          item = ItemUse tree VisPub (mkSpanE 1 0) []
          result = analyzeE [item]
          reexports = filter (\e -> eiKind e == ReExport) (faExports result)
      length reexports `shouldBe` 2
      case findExport "Foo" result of
        Nothing -> expectationFailure "expected ExportInfo for 'Foo'"
        Just ex -> eiSource ex `shouldBe` Just "crate::internal::Foo"
      case findExport "Bar" result of
        Nothing -> expectationFailure "expected ExportInfo for 'Bar'"
        Just ex -> eiSource ex `shouldBe` Just "crate::internal::Bar"

  -- ── Expressions tests (Phase 8) ────────────────────────────────────
  describe "Expressions" $ do

    -- Test helpers
    let mkSpanX line col = Span (Pos line col) (Pos line (col + 1))
        mkEmptyBlockX = RustBlock []
        mkFnSigX = RustFnSig False False False [] Nothing
        fileX = "src/main.rs"
        moduleIdX = makeModuleId fileX

        -- Helper: build a function with the given body statements
        mkFnWithBody :: Text -> [RustStmt] -> RustItem
        mkFnWithBody name stmts =
          ItemFn name VisPrivate mkFnSigX (RustBlock stmts) [] (mkSpanX 1 0)

        -- Helper: wrap an expression as a StmtSemi
        mkExprStmt :: RustExpr -> RustStmt
        mkExprStmt e = StmtSemi e

        -- Helper: run analysis on a file with given items
        analyzeX items = runAnalyzer fileX moduleIdX (walkFile (RustFile items))

        -- Helper: find all nodes by type
        findNodesX ntype result =
          filter (\n -> gnType n == ntype) (faNodes result)

        -- Helper: find node by type and name
        findNodeX ntype nname result =
          find (\n -> gnType n == ntype && gnName n == nname) (faNodes result)

        -- Helper: find edge by type and target
        findEdgeX etype etarget result =
          find (\e -> geType e == etype && geTarget e == etarget) (faEdges result)

        -- Helper: find all edges by type
        findEdgesX etype result =
          filter (\e -> geType e == etype) (faEdges result)

        -- Helper: get metadata value
        getMetaX key node = Map.lookup key (gnMetadata node)

    -- 1. Function call -> CALL node with name of function
    it "function call -> CALL node with function name" $ do
      let callExpr = ExprCall
            (ExprPath "println" (mkSpanX 2 0))
            []
            (mkSpanX 2 0)
          fn = mkFnWithBody "main" [mkExprStmt callExpr]
          result = analyzeX [fn]
      case findNodeX "CALL" "println" result of
        Nothing -> expectationFailure "expected CALL node 'println'"
        Just node -> do
          gnType node `shouldBe` "CALL"
          gnName node `shouldBe` "println"
          getMetaX "method" node `shouldBe` Just (MetaBool False)

    -- 2. Method call -> CALL with method=True metadata
    it "method call -> CALL with method=True" $ do
      let methodExpr = ExprMethodCall
            (ExprPath "vec" (mkSpanX 2 0))
            "push"
            [ExprLit "42" (mkSpanX 2 10)]
            (mkSpanX 2 0)
          fn = mkFnWithBody "main" [mkExprStmt methodExpr]
          result = analyzeX [fn]
      case findNodeX "CALL" "push" result of
        Nothing -> expectationFailure "expected CALL node 'push'"
        Just node -> do
          getMetaX "method" node `shouldBe` Just (MetaBool True)
          getMetaX "receiver" node `shouldBe` Just (MetaText "vec")

    -- 3. if/else -> BRANCH with kind=if
    it "if/else -> BRANCH with kind=if" $ do
      let ifExpr = ExprIf
            (ExprPath "cond" (mkSpanX 2 3))
            mkEmptyBlockX
            Nothing
            (mkSpanX 2 0)
          fn = mkFnWithBody "main" [mkExprStmt ifExpr]
          result = analyzeX [fn]
      case findNodeX "BRANCH" "if" result of
        Nothing -> expectationFailure "expected BRANCH node 'if'"
        Just node ->
          getMetaX "kind" node `shouldBe` Just (MetaText "if")

    -- 4. match -> BRANCH with kind=match
    it "match -> BRANCH with kind=match" $ do
      let arm = RustMatchArm
            (PatWild (mkSpanX 3 4))
            Nothing
            (ExprLit "0" (mkSpanX 3 9))
            (mkSpanX 3 4)
          matchExpr = ExprMatch
            (ExprPath "x" (mkSpanX 2 6))
            [arm]
            (mkSpanX 2 0)
          fn = mkFnWithBody "main" [mkExprStmt matchExpr]
          result = analyzeX [fn]
      case findNodeX "BRANCH" "match" result of
        Nothing -> expectationFailure "expected BRANCH node 'match'"
        Just node ->
          getMetaX "kind" node `shouldBe` Just (MetaText "match")

    -- 5. loop -> BRANCH with kind=loop
    it "loop -> BRANCH with kind=loop" $ do
      let loopExpr = ExprLoop
            mkEmptyBlockX
            Nothing
            (mkSpanX 2 0)
          fn = mkFnWithBody "main" [mkExprStmt loopExpr]
          result = analyzeX [fn]
      case findNodeX "BRANCH" "loop" result of
        Nothing -> expectationFailure "expected BRANCH node 'loop'"
        Just node ->
          getMetaX "kind" node `shouldBe` Just (MetaText "loop")

    -- 6. while -> BRANCH with kind=while
    it "while -> BRANCH with kind=while" $ do
      let whileExpr = ExprWhile
            (ExprPath "cond" (mkSpanX 2 6))
            mkEmptyBlockX
            Nothing
            (mkSpanX 2 0)
          fn = mkFnWithBody "main" [mkExprStmt whileExpr]
          result = analyzeX [fn]
      case findNodeX "BRANCH" "while" result of
        Nothing -> expectationFailure "expected BRANCH node 'while'"
        Just node ->
          getMetaX "kind" node `shouldBe` Just (MetaText "while")

    -- 7. for -> BRANCH with kind=for
    it "for -> BRANCH with kind=for" $ do
      let forExpr = ExprForLoop
            (PatIdent "i" False False (mkSpanX 2 4))
            (ExprPath "items" (mkSpanX 2 9))
            mkEmptyBlockX
            Nothing
            (mkSpanX 2 0)
          fn = mkFnWithBody "main" [mkExprStmt forExpr]
          result = analyzeX [fn]
      case findNodeX "BRANCH" "for" result of
        Nothing -> expectationFailure "expected BRANCH node 'for'"
        Just node ->
          getMetaX "kind" node `shouldBe` Just (MetaText "for")

    -- 8. closure -> CLOSURE node
    it "closure -> CLOSURE node" $ do
      let closureExpr = ExprClosure
            []
            Nothing
            (ExprLit "42" (mkSpanX 2 7))
            False
            (mkSpanX 2 0)
          fn = mkFnWithBody "main" [mkExprStmt closureExpr]
          result = analyzeX [fn]
      case findNodeX "CLOSURE" "<closure>" result of
        Nothing -> expectationFailure "expected CLOSURE node"
        Just node -> do
          gnType node `shouldBe` "CLOSURE"
          getMetaX "capture" node `shouldBe` Just (MetaBool False)

    -- 9. Variable reference -> REFERENCE node
    it "variable reference -> REFERENCE node" $ do
      let pathExpr = ExprPath "my_var" (mkSpanX 2 0)
          fn = mkFnWithBody "main" [mkExprStmt pathExpr]
          result = analyzeX [fn]
      case findNodeX "REFERENCE" "my_var" result of
        Nothing -> expectationFailure "expected REFERENCE node 'my_var'"
        Just node -> do
          gnType node `shouldBe` "REFERENCE"
          getMetaX "field" node `shouldBe` Just (MetaBool False)

    -- 10. Field access -> REFERENCE with field=True
    it "field access -> REFERENCE with field=True" $ do
      let fieldExpr = ExprField
            (ExprPath "self" (mkSpanX 2 0))
            "name"
            (mkSpanX 2 0)
          fn = mkFnWithBody "main" [mkExprStmt fieldExpr]
          result = analyzeX [fn]
      case findNodeX "REFERENCE" "name" result of
        Nothing -> expectationFailure "expected REFERENCE node 'name'"
        Just node -> do
          getMetaX "field" node `shouldBe` Just (MetaBool True)
          getMetaX "base" node `shouldBe` Just (MetaText "self")

    -- 11. ? operator -> CALL with name="?"
    it "? operator -> CALL with name=?" $ do
      let tryExpr = ExprTry
            (ExprPath "result" (mkSpanX 2 0))
            (mkSpanX 2 0)
          fn = mkFnWithBody "main" [mkExprStmt tryExpr]
          result = analyzeX [fn]
      case findNodeX "CALL" "?" result of
        Nothing -> expectationFailure "expected CALL node '?'"
        Just node -> do
          gnName node `shouldBe` "?"
          getMetaX "try" node `shouldBe` Just (MetaBool True)

    -- 12. CONTAINS edges for CALL nodes
    it "CONTAINS edges from enclosing function to CALL node" $ do
      let callExpr = ExprCall
            (ExprPath "foo" (mkSpanX 2 0))
            []
            (mkSpanX 2 0)
          fn = mkFnWithBody "main" [mkExprStmt callExpr]
          result = analyzeX [fn]
          fnId = semanticId fileX "FUNCTION" "main" Nothing Nothing
          callNodes = findNodesX "CALL" result
      length callNodes `shouldBe` 1
      let callId = gnId (head callNodes)
      case findEdgeX "CONTAINS" callId result of
        Nothing -> expectationFailure "expected CONTAINS edge to CALL"
        Just edge -> geSource edge `shouldBe` fnId

    -- 13. CONTAINS edges for BRANCH nodes
    it "CONTAINS edges from enclosing function to BRANCH node" $ do
      let ifExpr = ExprIf
            (ExprPath "cond" (mkSpanX 2 3))
            mkEmptyBlockX
            Nothing
            (mkSpanX 2 0)
          fn = mkFnWithBody "main" [mkExprStmt ifExpr]
          result = analyzeX [fn]
          fnId = semanticId fileX "FUNCTION" "main" Nothing Nothing
          branchNodes = findNodesX "BRANCH" result
      length branchNodes `shouldBe` 1
      let branchId = gnId (head branchNodes)
      case findEdgeX "CONTAINS" branchId result of
        Nothing -> expectationFailure "expected CONTAINS edge to BRANCH"
        Just edge -> geSource edge `shouldBe` fnId

    -- 14. Nested expressions produce correct nodes
    it "nested expressions: call inside if -> both CALL and BRANCH nodes" $ do
      let innerCall = ExprCall
            (ExprPath "do_thing" (mkSpanX 3 4))
            []
            (mkSpanX 3 4)
          ifExpr = ExprIf
            (ExprPath "cond" (mkSpanX 2 3))
            (RustBlock [StmtSemi innerCall])
            Nothing
            (mkSpanX 2 0)
          fn = mkFnWithBody "main" [mkExprStmt ifExpr]
          result = analyzeX [fn]
      length (findNodesX "BRANCH" result) `shouldBe` 1
      length (findNodesX "CALL" result) `shouldBe` 1
      case findNodeX "CALL" "do_thing" result of
        Nothing -> expectationFailure "expected CALL node 'do_thing'"
        Just _ -> pure ()

    -- 15. Multiple calls in function -> correct CALL count
    it "multiple calls in function -> correct CALL count" $ do
      let call1 = ExprCall (ExprPath "foo" (mkSpanX 2 0)) [] (mkSpanX 2 0)
          call2 = ExprCall (ExprPath "bar" (mkSpanX 3 0)) [] (mkSpanX 3 0)
          call3 = ExprCall (ExprPath "baz" (mkSpanX 4 0)) [] (mkSpanX 4 0)
          fn = mkFnWithBody "main"
            [mkExprStmt call1, mkExprStmt call2, mkExprStmt call3]
          result = analyzeX [fn]
      length (findNodesX "CALL" result) `shouldBe` 3

    -- 16. Closure with capture -> CLOSURE with capture=True metadata
    it "closure with capture -> CLOSURE with capture=True" $ do
      let closureExpr = ExprClosure
            []
            Nothing
            (ExprLit "42" (mkSpanX 2 10))
            True   -- move capture
            (mkSpanX 2 0)
          fn = mkFnWithBody "main" [mkExprStmt closureExpr]
          result = analyzeX [fn]
      case findNodeX "CLOSURE" "<closure>" result of
        Nothing -> expectationFailure "expected CLOSURE node"
        Just node ->
          getMetaX "capture" node `shouldBe` Just (MetaBool True)

    -- 17. ExprLit -> no node emitted
    it "ExprLit -> no extra node emitted" $ do
      let litExpr = ExprLit "42" (mkSpanX 2 0)
          fn = mkFnWithBody "main" [mkExprStmt litExpr]
          result = analyzeX [fn]
          -- Only MODULE + FUNCTION nodes, no expression nodes
          exprNodes = filter (\n -> gnType n `elem`
            ["CALL", "BRANCH", "CLOSURE", "REFERENCE"]) (faNodes result)
      length exprNodes `shouldBe` 0

    -- 18. ExprReturn -> walks inner expression
    it "ExprReturn -> walks inner expression producing REFERENCE" $ do
      let retExpr = ExprReturn (Just (ExprPath "result" (mkSpanX 2 7))) (mkSpanX 2 0)
          fn = mkFnWithBody "main" [mkExprStmt retExpr]
          result = analyzeX [fn]
      case findNodeX "REFERENCE" "result" result of
        Nothing -> expectationFailure "expected REFERENCE node 'result' from return"
        Just _ -> pure ()

    -- 19. ExprAssign -> walks both sides
    it "ExprAssign -> walks both sides producing REFERENCEs" $ do
      let assignExpr = ExprAssign
            (ExprPath "x" (mkSpanX 2 0))
            (ExprPath "y" (mkSpanX 2 4))
            (mkSpanX 2 0)
          fn = mkFnWithBody "main" [mkExprStmt assignExpr]
          result = analyzeX [fn]
      case findNodeX "REFERENCE" "x" result of
        Nothing -> expectationFailure "expected REFERENCE node 'x'"
        Just _ -> pure ()
      case findNodeX "REFERENCE" "y" result of
        Nothing -> expectationFailure "expected REFERENCE node 'y'"
        Just _ -> pure ()

    -- 20. Transparent expressions: binary walks children
    it "binary expression -> walks both operands" $ do
      let binExpr = ExprBinary
            (ExprPath "a" (mkSpanX 2 0))
            "+"
            (ExprPath "b" (mkSpanX 2 4))
            (mkSpanX 2 0)
          fn = mkFnWithBody "main" [mkExprStmt binExpr]
          result = analyzeX [fn]
          refNodes = findNodesX "REFERENCE" result
      length refNodes `shouldBe` 2
      case findNodeX "REFERENCE" "a" result of
        Nothing -> expectationFailure "expected REFERENCE node 'a'"
        Just _ -> pure ()
      case findNodeX "REFERENCE" "b" result of
        Nothing -> expectationFailure "expected REFERENCE node 'b'"
        Just _ -> pure ()

    -- Additional: let binding init expression is walked
    it "let binding with init expression -> walks init" $ do
      let letStmt = StmtLocal
            (PatIdent "x" False False (mkSpanX 2 8))
            (Just (ExprCall (ExprPath "compute" (mkSpanX 2 12)) [] (mkSpanX 2 12)))
            (mkSpanX 2 4)
          fn = mkFnWithBody "main" [letStmt]
          result = analyzeX [fn]
      case findNodeX "CALL" "compute" result of
        Nothing -> expectationFailure "expected CALL node 'compute' from let init"
        Just _ -> pure ()

    -- Additional: match arm bodies are walked
    it "match arm body expressions are walked" $ do
      let arm1 = RustMatchArm
            (PatWild (mkSpanX 3 4))
            Nothing
            (ExprCall (ExprPath "handle_a" (mkSpanX 3 9)) [] (mkSpanX 3 9))
            (mkSpanX 3 4)
          arm2 = RustMatchArm
            (PatWild (mkSpanX 4 4))
            Nothing
            (ExprCall (ExprPath "handle_b" (mkSpanX 4 9)) [] (mkSpanX 4 9))
            (mkSpanX 4 4)
          matchExpr = ExprMatch
            (ExprPath "x" (mkSpanX 2 6))
            [arm1, arm2]
            (mkSpanX 2 0)
          fn = mkFnWithBody "main" [mkExprStmt matchExpr]
          result = analyzeX [fn]
      case findNodeX "CALL" "handle_a" result of
        Nothing -> expectationFailure "expected CALL node 'handle_a'"
        Just _ -> pure ()
      case findNodeX "CALL" "handle_b" result of
        Nothing -> expectationFailure "expected CALL node 'handle_b'"
        Just _ -> pure ()

    -- Additional: CONTAINS edge count is correct for all emitted nodes
    it "all expression nodes have CONTAINS edges" $ do
      let callExpr = ExprCall (ExprPath "foo" (mkSpanX 2 0)) [] (mkSpanX 2 0)
          ifExpr = ExprIf (ExprPath "c" (mkSpanX 3 3)) mkEmptyBlockX Nothing (mkSpanX 3 0)
          fn = mkFnWithBody "main" [mkExprStmt callExpr, mkExprStmt ifExpr]
          result = analyzeX [fn]
          -- All CALL, BRANCH, REFERENCE nodes should have CONTAINS edges
          exprNodeIds = map gnId $ filter (\n -> gnType n `elem`
            ["CALL", "BRANCH", "REFERENCE"]) (faNodes result)
          containsEdges = findEdgesX "CONTAINS" result
          containsTargets = map geTarget containsEdges
      -- Each expression node should appear as a target in some CONTAINS edge
      mapM_ (\nid ->
        nid `elem` containsTargets `shouldBe` True
        ) exprNodeIds

    -- Additional: unary expression walks operand
    it "unary expression -> walks operand" $ do
      let unaryExpr = ExprUnary "!" (ExprPath "flag" (mkSpanX 2 1)) (mkSpanX 2 0)
          fn = mkFnWithBody "main" [mkExprStmt unaryExpr]
          result = analyzeX [fn]
      case findNodeX "REFERENCE" "flag" result of
        Nothing -> expectationFailure "expected REFERENCE node 'flag'"
        Just _ -> pure ()

    -- Additional: call with arguments walks args
    it "function call with args -> walks all arguments" $ do
      let callExpr = ExprCall
            (ExprPath "add" (mkSpanX 2 0))
            [ ExprPath "x" (mkSpanX 2 4)
            , ExprPath "y" (mkSpanX 2 7)
            ]
            (mkSpanX 2 0)
          fn = mkFnWithBody "main" [mkExprStmt callExpr]
          result = analyzeX [fn]
      -- Should have: CALL(add) + REFERENCE(add) from func position + REFERENCE(x) + REFERENCE(y)
      case findNodeX "CALL" "add" result of
        Nothing -> expectationFailure "expected CALL node 'add'"
        Just _ -> pure ()
      case findNodeX "REFERENCE" "x" result of
        Nothing -> expectationFailure "expected REFERENCE node 'x'"
        Just _ -> pure ()
      case findNodeX "REFERENCE" "y" result of
        Nothing -> expectationFailure "expected REFERENCE node 'y'"
        Just _ -> pure ()

  -- ── Patterns tests (Phase 9) ──────────────────────────────────────────
  describe "Patterns" $ do

    -- Test helpers
    let mkSpanP line col = Span (Pos line col) (Pos line (col + 1))
        fileP = "src/main.rs"
        moduleIdP = makeModuleId fileP

        -- Helper: build a function with the given signature and body
        mkFnWithSigBody :: Text -> RustFnSig -> [RustStmt] -> RustItem
        mkFnWithSigBody name sig stmts =
          ItemFn name VisPrivate sig (RustBlock stmts) [] (mkSpanP 1 0)

        -- Helper: build a function with default sig and body
        mkFnWithBodyP :: Text -> [RustStmt] -> RustItem
        mkFnWithBodyP name stmts =
          mkFnWithSigBody name (RustFnSig False False False [] Nothing) stmts

        -- Helper: wrap an expression as a StmtSemi
        mkExprStmtP :: RustExpr -> RustStmt
        mkExprStmtP e = StmtSemi e

        -- Helper: run analysis on a file with given items
        analyzeP items = runAnalyzer fileP moduleIdP (walkFile (RustFile items))

        -- Helper: find all nodes by type
        findNodesP ntype result =
          filter (\n -> gnType n == ntype) (faNodes result)

        -- Helper: find node by type and name
        findNodeP ntype nname result =
          find (\n -> gnType n == ntype && gnName n == nname) (faNodes result)

        -- Helper: find all edges by type
        findEdgesP etype result =
          filter (\e -> geType e == etype) (faEdges result)

        -- Helper: find edge by type and target
        findEdgeP etype etarget result =
          find (\e -> geType e == etype && geTarget e == etarget) (faEdges result)

        -- Helper: get metadata value
        getMetaP key node = Map.lookup key (gnMetadata node)

        -- Helper: get edge metadata value
        getEdgeMetaP key edge = Map.lookup key (geMetadata edge)

    -- 1. Function params -> PARAMETER nodes with correct index
    it "function params -> PARAMETER nodes with correct index" $ do
      let sig = RustFnSig False False False
                  [ FnArgTyped (PatIdent "x" False False (mkSpanP 1 10)) (TypePath "i32" [] (mkSpanP 1 13))
                  , FnArgTyped (PatIdent "y" False False (mkSpanP 1 20)) (TypePath "i32" [] (mkSpanP 1 23))
                  ] Nothing
          fn = mkFnWithSigBody "add" sig []
          result = analyzeP [fn]
          paramNodes = findNodesP "PARAMETER" result
      length paramNodes `shouldBe` 2
      case findNodeP "PARAMETER" "x" result of
        Nothing -> expectationFailure "expected PARAMETER node 'x'"
        Just node -> getMetaP "index" node `shouldBe` Just (MetaInt 0)
      case findNodeP "PARAMETER" "y" result of
        Nothing -> expectationFailure "expected PARAMETER node 'y'"
        Just node -> getMetaP "index" node `shouldBe` Just (MetaInt 1)

    -- 2. self param -> PARAMETER with name="self"
    it "self param -> PARAMETER with name=self" $ do
      let sig = RustFnSig False False False [FnArgSelf False] Nothing
          fn = mkFnWithSigBody "method" sig []
          result = analyzeP [fn]
      case findNodeP "PARAMETER" "self" result of
        Nothing -> expectationFailure "expected PARAMETER node 'self'"
        Just node -> do
          gnName node `shouldBe` "self"
          getMetaP "index" node `shouldBe` Just (MetaInt 0)
          getMetaP "mutable" node `shouldBe` Just (MetaBool False)

    -- 3. mut param -> PARAMETER with mutable=True
    it "mut param -> PARAMETER with mutable=True" $ do
      let sig = RustFnSig False False False
                  [ FnArgTyped (PatIdent "x" True False (mkSpanP 1 10)) (TypePath "i32" [] (mkSpanP 1 18))
                  ] Nothing
          fn = mkFnWithSigBody "process" sig []
          result = analyzeP [fn]
      case findNodeP "PARAMETER" "x" result of
        Nothing -> expectationFailure "expected PARAMETER node 'x'"
        Just node -> getMetaP "mutable" node `shouldBe` Just (MetaBool True)

    -- 4. ref param -> PARAMETER with by_ref=True
    it "ref param -> PARAMETER with by_ref=True" $ do
      let sig = RustFnSig False False False
                  [ FnArgTyped (PatIdent "x" False True (mkSpanP 1 10)) (TypePath "i32" [] (mkSpanP 1 18))
                  ] Nothing
          fn = mkFnWithSigBody "inspect" sig []
          result = analyzeP [fn]
      case findNodeP "PARAMETER" "x" result of
        Nothing -> expectationFailure "expected PARAMETER node 'x'"
        Just node -> getMetaP "by_ref" node `shouldBe` Just (MetaBool True)

    -- 5. Struct pattern -> PATTERN with constructor metadata
    it "struct pattern -> PATTERN with constructor metadata" $ do
      let structPat = PatStruct "Foo" [("x", PatIdent "x" False False (mkSpanP 3 14))] (mkSpanP 3 4)
          arm = RustMatchArm structPat Nothing (ExprLit "0" (mkSpanP 3 24)) (mkSpanP 3 4)
          matchExpr = ExprMatch
            (ExprPath "val" (mkSpanP 2 6))
            [arm]
            (mkSpanP 2 0)
          fn = mkFnWithBodyP "main" [mkExprStmtP matchExpr]
          result = analyzeP [fn]
      case findNodeP "PATTERN" "Foo" result of
        Nothing -> expectationFailure "expected PATTERN node 'Foo'"
        Just node -> getMetaP "constructor" node `shouldBe` Just (MetaText "Foo")

    -- 6. Tuple struct pattern -> PATTERN with constructor
    it "tuple struct pattern -> PATTERN with constructor" $ do
      let tsPat = PatTupleStruct "Some" [PatIdent "x" False False (mkSpanP 3 9)] (mkSpanP 3 4)
          arm = RustMatchArm tsPat Nothing (ExprLit "0" (mkSpanP 3 18)) (mkSpanP 3 4)
          matchExpr = ExprMatch
            (ExprPath "opt" (mkSpanP 2 6))
            [arm]
            (mkSpanP 2 0)
          fn = mkFnWithBodyP "main" [mkExprStmtP matchExpr]
          result = analyzeP [fn]
      case findNodeP "PATTERN" "Some" result of
        Nothing -> expectationFailure "expected PATTERN node 'Some'"
        Just node -> getMetaP "constructor" node `shouldBe` Just (MetaText "Some")

    -- 7. Path pattern -> PATTERN
    it "path pattern -> PATTERN" $ do
      let pathPat = PatPath "None" (mkSpanP 3 4)
          arm = RustMatchArm pathPat Nothing (ExprLit "0" (mkSpanP 3 12)) (mkSpanP 3 4)
          matchExpr = ExprMatch
            (ExprPath "opt" (mkSpanP 2 6))
            [arm]
            (mkSpanP 2 0)
          fn = mkFnWithBodyP "main" [mkExprStmtP matchExpr]
          result = analyzeP [fn]
      case findNodeP "PATTERN" "None" result of
        Nothing -> expectationFailure "expected PATTERN node 'None'"
        Just node -> getMetaP "constructor" node `shouldBe` Just (MetaText "None")

    -- 8. Wildcard -> no PATTERN node
    it "wildcard pattern -> no PATTERN node" $ do
      let wildPat = PatWild (mkSpanP 3 4)
          arm = RustMatchArm wildPat Nothing (ExprLit "0" (mkSpanP 3 9)) (mkSpanP 3 4)
          matchExpr = ExprMatch
            (ExprPath "x" (mkSpanP 2 6))
            [arm]
            (mkSpanP 2 0)
          fn = mkFnWithBodyP "main" [mkExprStmtP matchExpr]
          result = analyzeP [fn]
          patternNodes = findNodesP "PATTERN" result
      length patternNodes `shouldBe` 0

    -- 9. Match arm -> MATCH_ARM node with index
    it "match arm -> MATCH_ARM node with index" $ do
      let arm0 = RustMatchArm
                   (PatPath "None" (mkSpanP 3 4))
                   Nothing
                   (ExprLit "0" (mkSpanP 3 12))
                   (mkSpanP 3 4)
          arm1 = RustMatchArm
                   (PatWild (mkSpanP 4 4))
                   Nothing
                   (ExprLit "1" (mkSpanP 4 9))
                   (mkSpanP 4 4)
          matchExpr = ExprMatch
            (ExprPath "x" (mkSpanP 2 6))
            [arm0, arm1]
            (mkSpanP 2 0)
          fn = mkFnWithBodyP "main" [mkExprStmtP matchExpr]
          result = analyzeP [fn]
      case findNodeP "MATCH_ARM" "#0" result of
        Nothing -> expectationFailure "expected MATCH_ARM node '#0'"
        Just node -> getMetaP "index" node `shouldBe` Just (MetaInt 0)
      case findNodeP "MATCH_ARM" "#1" result of
        Nothing -> expectationFailure "expected MATCH_ARM node '#1'"
        Just node -> getMetaP "index" node `shouldBe` Just (MetaInt 1)

    -- 10. HANDLES_VARIANT edge from match arm
    it "HANDLES_VARIANT edge from match arm with variant name" $ do
      let arm = RustMatchArm
                  (PatPath "None" (mkSpanP 3 4))
                  Nothing
                  (ExprLit "0" (mkSpanP 3 12))
                  (mkSpanP 3 4)
          matchExpr = ExprMatch
            (ExprPath "x" (mkSpanP 2 6))
            [arm]
            (mkSpanP 2 0)
          fn = mkFnWithBodyP "main" [mkExprStmtP matchExpr]
          result = analyzeP [fn]
          hvEdges = findEdgesP "HANDLES_VARIANT" result
      length hvEdges `shouldBe` 1
      let hvEdge = head hvEdges
      getEdgeMetaP "variant" hvEdge `shouldBe` Just (MetaText "None")
      -- HANDLES_VARIANT is a self-edge on the MATCH_ARM node
      geSource hvEdge `shouldBe` geTarget hvEdge

    -- 11. Multiple match arms -> correct MATCH_ARM count
    it "multiple match arms -> correct MATCH_ARM count" $ do
      let arm0 = RustMatchArm
                   (PatPath "A" (mkSpanP 3 4))
                   Nothing
                   (ExprLit "0" (mkSpanP 3 9))
                   (mkSpanP 3 4)
          arm1 = RustMatchArm
                   (PatPath "B" (mkSpanP 4 4))
                   Nothing
                   (ExprLit "1" (mkSpanP 4 9))
                   (mkSpanP 4 4)
          arm2 = RustMatchArm
                   (PatWild (mkSpanP 5 4))
                   Nothing
                   (ExprLit "2" (mkSpanP 5 9))
                   (mkSpanP 5 4)
          matchExpr = ExprMatch
            (ExprPath "x" (mkSpanP 2 6))
            [arm0, arm1, arm2]
            (mkSpanP 2 0)
          fn = mkFnWithBodyP "main" [mkExprStmtP matchExpr]
          result = analyzeP [fn]
          matchArmNodes = findNodesP "MATCH_ARM" result
      length matchArmNodes `shouldBe` 3

    -- 12. CONTAINS edges for parameters
    it "CONTAINS edges from function to PARAMETER nodes" $ do
      let sig = RustFnSig False False False
                  [ FnArgTyped (PatIdent "x" False False (mkSpanP 1 10)) (TypePath "i32" [] (mkSpanP 1 13))
                  ] Nothing
          fn = mkFnWithSigBody "foo" sig []
          result = analyzeP [fn]
          fnId = semanticId fileP "FUNCTION" "foo" Nothing Nothing
          paramNodes = findNodesP "PARAMETER" result
      length paramNodes `shouldBe` 1
      let paramId = gnId (head paramNodes)
      case findEdgeP "CONTAINS" paramId result of
        Nothing -> expectationFailure "expected CONTAINS edge to PARAMETER"
        Just edge -> geSource edge `shouldBe` fnId

  -- ── Ownership tests ─────────────────────────────────────────────────
  describe "Ownership" $ do

    -- Test helpers
    let mkSpanO line col = Span (Pos line col) (Pos line (col + 1))
        fileO = "src/main.rs"
        moduleIdO = makeModuleId fileO

        -- Helper: build a function with default sig and body
        mkFnWithBodyO :: Text -> [RustStmt] -> RustItem
        mkFnWithBodyO name stmts =
          ItemFn name VisPrivate (RustFnSig False False False [] Nothing) (RustBlock stmts) [] (mkSpanO 1 0)

        -- Helper: wrap an expression as a StmtSemi
        mkExprStmtO :: RustExpr -> RustStmt
        mkExprStmtO e = StmtSemi e

        -- Helper: run analysis on a file with given items
        analyzeO items = runAnalyzer fileO moduleIdO (walkFile (RustFile items))

        -- Helper: find all nodes by type
        findNodesO ntype result =
          filter (\n -> gnType n == ntype) (faNodes result)

        -- Helper: find node by type and name
        findNodeO ntype nname result =
          find (\n -> gnType n == ntype && gnName n == nname) (faNodes result)

        -- Helper: find all edges by type
        findEdgesO etype result =
          filter (\e -> geType e == etype) (faEdges result)

        -- Helper: find edge by type and target
        _findEdgeO etype etarget result =
          find (\e -> geType e == etype && geTarget e == etarget) (faEdges result)

        -- Helper: get metadata value
        getMetaO key node = Map.lookup key (gnMetadata node)

        -- Helper: get edge metadata value
        getEdgeMetaO key edge = Map.lookup key (geMetadata edge)

    -- 1. &x -> BORROW node with mutable=False
    it "&x -> BORROW node with mutable=False" $ do
      let refExpr = ExprReference (ExprPath "x" (mkSpanO 2 5)) False (mkSpanO 2 4)
          fn = mkFnWithBodyO "main" [mkExprStmtO refExpr]
          result = analyzeO [fn]
      case findNodeO "BORROW" "x" result of
        Nothing -> expectationFailure "expected BORROW node 'x'"
        Just node -> do
          gnType node `shouldBe` "BORROW"
          gnName node `shouldBe` "x"
          getMetaO "mutable" node `shouldBe` Just (MetaBool False)

    -- 2. &mut x -> BORROW node with mutable=True
    it "&mut x -> BORROW node with mutable=True" $ do
      let refExpr = ExprReference (ExprPath "x" (mkSpanO 2 9)) True (mkSpanO 2 4)
          fn = mkFnWithBodyO "main" [mkExprStmtO refExpr]
          result = analyzeO [fn]
      case findNodeO "BORROW" "x" result of
        Nothing -> expectationFailure "expected BORROW node 'x'"
        Just node -> do
          gnType node `shouldBe` "BORROW"
          getMetaO "mutable" node `shouldBe` Just (MetaBool True)

    -- 3. &x -> BORROWS edge
    it "&x -> BORROWS edge with target metadata" $ do
      let refExpr = ExprReference (ExprPath "x" (mkSpanO 2 5)) False (mkSpanO 2 4)
          fn = mkFnWithBodyO "main" [mkExprStmtO refExpr]
          result = analyzeO [fn]
          borrowsEdges = findEdgesO "BORROWS" result
      length borrowsEdges `shouldBe` 1
      let edge = head borrowsEdges
      getEdgeMetaO "target" edge `shouldBe` Just (MetaText "x")
      -- BORROWS is a self-edge on the BORROW node
      geSource edge `shouldBe` geTarget edge

    -- 4. &mut x -> BORROWS_MUT edge
    it "&mut x -> BORROWS_MUT edge with target metadata" $ do
      let refExpr = ExprReference (ExprPath "x" (mkSpanO 2 9)) True (mkSpanO 2 4)
          fn = mkFnWithBodyO "main" [mkExprStmtO refExpr]
          result = analyzeO [fn]
          borrowsMutEdges = findEdgesO "BORROWS_MUT" result
      length borrowsMutEdges `shouldBe` 1
      let edge = head borrowsMutEdges
      getEdgeMetaO "target" edge `shouldBe` Just (MetaText "x")
      -- BORROWS_MUT is a self-edge on the BORROW node
      geSource edge `shouldBe` geTarget edge

    -- 5. *x -> DEREF node
    it "*x -> DEREF node" $ do
      let derefExpr = ExprUnary "*" (ExprPath "x" (mkSpanO 2 5)) (mkSpanO 2 4)
          fn = mkFnWithBodyO "main" [mkExprStmtO derefExpr]
          result = analyzeO [fn]
      case findNodeO "DEREF" "x" result of
        Nothing -> expectationFailure "expected DEREF node 'x'"
        Just node -> do
          gnType node `shouldBe` "DEREF"
          gnName node `shouldBe` "x"

    -- 6. CONTAINS edge for BORROW
    it "CONTAINS edge from scope to BORROW" $ do
      let refExpr = ExprReference (ExprPath "x" (mkSpanO 2 5)) False (mkSpanO 2 4)
          fn = mkFnWithBodyO "foo" [mkExprStmtO refExpr]
          result = analyzeO [fn]
          borrowNodes = findNodesO "BORROW" result
      length borrowNodes `shouldBe` 1
      let borrowId = gnId (head borrowNodes)
          containsEdges = filter (\e -> geType e == "CONTAINS" && geTarget e == borrowId) (faEdges result)
      length containsEdges `shouldBe` 1

    -- 7. CONTAINS edge for DEREF
    it "CONTAINS edge from scope to DEREF" $ do
      let derefExpr = ExprUnary "*" (ExprPath "x" (mkSpanO 2 5)) (mkSpanO 2 4)
          fn = mkFnWithBodyO "foo" [mkExprStmtO derefExpr]
          result = analyzeO [fn]
          derefNodes = findNodesO "DEREF" result
      length derefNodes `shouldBe` 1
      let derefId = gnId (head derefNodes)
          containsEdges = filter (\e -> geType e == "CONTAINS" && geTarget e == derefId) (faEdges result)
      length containsEdges `shouldBe` 1

    -- 8. Confidence metadata = "syntactic"
    it "confidence metadata = syntactic for BORROW and DEREF" $ do
      let refExpr = ExprReference (ExprPath "x" (mkSpanO 2 5)) False (mkSpanO 2 4)
          derefExpr = ExprUnary "*" (ExprPath "y" (mkSpanO 3 5)) (mkSpanO 3 4)
          fn = mkFnWithBodyO "main" [mkExprStmtO refExpr, mkExprStmtO derefExpr]
          result = analyzeO [fn]
      case findNodeO "BORROW" "x" result of
        Nothing -> expectationFailure "expected BORROW node 'x'"
        Just node -> getMetaO "confidence" node `shouldBe` Just (MetaText "syntactic")
      case findNodeO "DEREF" "y" result of
        Nothing -> expectationFailure "expected DEREF node 'y'"
        Just node -> getMetaO "confidence" node `shouldBe` Just (MetaText "syntactic")

    -- 9. Nested &mut &x -> 2 BORROW nodes
    it "nested &mut &x -> 2 BORROW nodes" $ do
      let innerRef = ExprReference (ExprPath "x" (mkSpanO 2 10)) False (mkSpanO 2 9)
          outerRef = ExprReference innerRef True (mkSpanO 2 4)
          fn = mkFnWithBodyO "main" [mkExprStmtO outerRef]
          result = analyzeO [fn]
          borrowNodes = findNodesO "BORROW" result
      length borrowNodes `shouldBe` 2

    -- 10. No ownership nodes for plain variable reference
    it "no ownership nodes for plain variable reference" $ do
      let plainRef = ExprPath "x" (mkSpanO 2 4)
          fn = mkFnWithBodyO "main" [mkExprStmtO plainRef]
          result = analyzeO [fn]
          borrowNodes = findNodesO "BORROW" result
          derefNodes = findNodesO "DEREF" result
      length borrowNodes `shouldBe` 0
      length derefNodes `shouldBe` 0

  -- ── ErrorFlow tests (Phase 11) ──────────────────────────────────────
  describe "ErrorFlow" $ do

    -- Test helpers
    let mkSpanEF line col = Span (Pos line col) (Pos line (col + 1))
        fileEF = "src/main.rs"
        moduleIdEF = makeModuleId fileEF
        mkFnSigEF = RustFnSig False False False [] Nothing

        -- Helper: build a function with default sig and body
        mkFnWithBodyEF :: Text -> [RustStmt] -> RustItem
        mkFnWithBodyEF name stmts =
          ItemFn name VisPrivate mkFnSigEF (RustBlock stmts) [] (mkSpanEF 1 0)

        -- Helper: wrap an expression as a StmtSemi
        mkExprStmtEF :: RustExpr -> RustStmt
        mkExprStmtEF e = StmtSemi e

        -- Helper: run analysis on a file with given items
        analyzeEF items = runAnalyzer fileEF moduleIdEF (walkFile (RustFile items))

        -- Helper: find all edges by type
        findEdgesEF etype result =
          filter (\e -> geType e == etype) (faEdges result)

        -- Helper: find node by type and name
        findNodeEF ntype nname result =
          find (\n -> gnType n == ntype && gnName n == nname) (faNodes result)

        -- Helper: get metadata value
        getMetaEF key node = Map.lookup key (gnMetadata node)

        -- Helper: get edge metadata value
        _getEdgeMetaEF key edge = Map.lookup key (geMetadata edge)

    -- 1. Single ? -> ERROR_PROPAGATES edge
    it "single ? -> ERROR_PROPAGATES edge" $ do
      let tryExpr = ExprTry (ExprPath "foo" (mkSpanEF 2 4)) (mkSpanEF 2 8)
          fn = mkFnWithBodyEF "main" [mkExprStmtEF tryExpr]
          result = analyzeEF [fn]
          errorEdges = findEdgesEF "ERROR_PROPAGATES" result
      length errorEdges `shouldBe` 1

    -- 2. Multiple ? -> multiple edges + error_exit_count metadata
    it "multiple ? -> multiple ERROR_PROPAGATES edges" $ do
      let try1 = ExprTry (ExprPath "foo" (mkSpanEF 2 4)) (mkSpanEF 2 8)
          try2 = ExprTry (ExprPath "bar" (mkSpanEF 3 4)) (mkSpanEF 3 8)
          fn = mkFnWithBodyEF "main" [mkExprStmtEF try1, mkExprStmtEF try2]
          result = analyzeEF [fn]
          errorEdges = findEdgesEF "ERROR_PROPAGATES" result
      length errorEdges `shouldBe` 2

    -- 3. ? in closure does NOT propagate to outer fn
    it "? in closure does NOT propagate to outer fn" $ do
      let closureBody = ExprTry (ExprPath "x" (mkSpanEF 3 8)) (mkSpanEF 3 12)
          closure = ExprClosure [] Nothing closureBody False (mkSpanEF 2 4)
          fn = mkFnWithBodyEF "main" [mkExprStmtEF closure]
          result = analyzeEF [fn]
          errorEdges = findEdgesEF "ERROR_PROPAGATES" result
      length errorEdges `shouldBe` 0

    -- 4. Function without ? -> no ERROR_PROPAGATES edges
    it "function without ? -> no ERROR_PROPAGATES edges" $ do
      let plainExpr = ExprPath "x" (mkSpanEF 2 4)
          fn = mkFnWithBodyEF "main" [mkExprStmtEF plainExpr]
          result = analyzeEF [fn]
          errorEdges = findEdgesEF "ERROR_PROPAGATES" result
      length errorEdges `shouldBe` 0

    -- 5. error_exit_count = 0 for function without ?
    it "error_exit_count = 0 for function without ?" $ do
      let plainExpr = ExprPath "x" (mkSpanEF 2 4)
          fn = mkFnWithBodyEF "main" [mkExprStmtEF plainExpr]
          result = analyzeEF [fn]
      case findNodeEF "FUNCTION" "main" result of
        Nothing -> expectationFailure "expected FUNCTION node 'main'"
        Just node -> getMetaEF "error_exit_count" node `shouldBe` Just (MetaInt 0)

    -- 6. error_exit_count = 2 for function with 2 ?
    it "error_exit_count = 2 for function with 2 ?" $ do
      let try1 = ExprTry (ExprPath "foo" (mkSpanEF 2 4)) (mkSpanEF 2 8)
          try2 = ExprTry (ExprPath "bar" (mkSpanEF 3 4)) (mkSpanEF 3 8)
          fn = mkFnWithBodyEF "main" [mkExprStmtEF try1, mkExprStmtEF try2]
          result = analyzeEF [fn]
      case findNodeEF "FUNCTION" "main" result of
        Nothing -> expectationFailure "expected FUNCTION node 'main'"
        Just node -> getMetaEF "error_exit_count" node `shouldBe` Just (MetaInt 2)

    -- 7. ERROR_PROPAGATES target is the enclosing function ID
    it "ERROR_PROPAGATES target is the enclosing function ID" $ do
      let tryExpr = ExprTry (ExprPath "foo" (mkSpanEF 2 4)) (mkSpanEF 2 8)
          fn = mkFnWithBodyEF "do_stuff" [mkExprStmtEF tryExpr]
          result = analyzeEF [fn]
          errorEdges = findEdgesEF "ERROR_PROPAGATES" result
          fnId = semanticId fileEF "FUNCTION" "do_stuff" Nothing Nothing
      length errorEdges `shouldBe` 1
      let edge = head errorEdges
      geTarget edge `shouldBe` fnId

    -- 8. Nested ? (e.g., foo()?.bar()?) -> 2 edges
    it "nested ? (foo()?.bar()?) -> 2 ERROR_PROPAGATES edges" $ do
      let innerCall = ExprCall (ExprPath "foo" (mkSpanEF 2 0)) [] (mkSpanEF 2 0)
          innerTry = ExprTry innerCall (mkSpanEF 2 5)
          methodCall = ExprMethodCall innerTry "bar" [] (mkSpanEF 2 6)
          outerTry = ExprTry methodCall (mkSpanEF 2 12)
          fn = mkFnWithBodyEF "main" [mkExprStmtEF outerTry]
          result = analyzeEF [fn]
          errorEdges = findEdgesEF "ERROR_PROPAGATES" result
      length errorEdges `shouldBe` 2

    -- 9. countErrorExits pure function: empty block
    it "countErrorExits: empty block -> 0" $ do
      countErrorExits (RustBlock []) `shouldBe` 0

    -- 10. countErrorExits: closure ? not counted
    it "countErrorExits: ? inside closure not counted" $ do
      let closureBody = ExprTry (ExprPath "x" (mkSpanEF 3 8)) (mkSpanEF 3 12)
          closure = ExprClosure [] Nothing closureBody False (mkSpanEF 2 4)
          block = RustBlock [StmtSemi closure]
      countErrorExits block `shouldBe` 0

  -- ── Unsafe tests (Phase 12) ──────────────────────────────────────────
  describe "Unsafe" $ do

    -- Test helpers
    let mkSpanU line col = Span (Pos line col) (Pos line (col + 1))
        fileU = "src/main.rs"
        moduleIdU = makeModuleId fileU
        mkFnSigU = RustFnSig False False False [] Nothing
        mkUnsafeFnSig = RustFnSig False True False [] Nothing

        -- Helper: build a function with default sig and body
        mkFnWithBodyU :: Text -> [RustStmt] -> RustItem
        mkFnWithBodyU name stmts =
          ItemFn name VisPrivate mkFnSigU (RustBlock stmts) [] (mkSpanU 1 0)

        -- Helper: build an unsafe function with body
        mkUnsafeFnWithBodyU :: Text -> [RustStmt] -> RustItem
        mkUnsafeFnWithBodyU name stmts =
          ItemFn name VisPrivate mkUnsafeFnSig (RustBlock stmts) [] (mkSpanU 1 0)

        -- Helper: wrap an expression as a StmtSemi
        mkExprStmtU :: RustExpr -> RustStmt
        mkExprStmtU e = StmtSemi e

        -- Helper: run analysis on a file with given items
        analyzeU items = runAnalyzer fileU moduleIdU (walkFile (RustFile items))

        -- Helper: find node by type and name
        findNodeU ntype nname result =
          find (\n -> gnType n == ntype && gnName n == nname) (faNodes result)

        -- Helper: find all nodes by type
        findNodesU ntype result =
          filter (\n -> gnType n == ntype) (faNodes result)

        -- Helper: find all edges by type
        findEdgesU etype result =
          filter (\e -> geType e == etype) (faEdges result)

    -- 1. unsafe { ... } -> UNSAFE_BLOCK node
    it "unsafe { ... } -> UNSAFE_BLOCK node" $ do
      let unsafeExpr = ExprUnsafe (RustBlock []) (mkSpanU 2 4)
          fn = mkFnWithBodyU "main" [mkExprStmtU unsafeExpr]
          result = analyzeU [fn]
      case findNodeU "UNSAFE_BLOCK" "unsafe" result of
        Nothing -> expectationFailure "expected UNSAFE_BLOCK node 'unsafe'"
        Just node -> do
          gnType node `shouldBe` "UNSAFE_BLOCK"
          gnName node `shouldBe` "unsafe"

    -- 2. CONTAINS_UNSAFE edge from safe fn to unsafe block
    it "CONTAINS_UNSAFE edge from safe fn to unsafe block" $ do
      let unsafeExpr = ExprUnsafe (RustBlock []) (mkSpanU 2 4)
          fn = mkFnWithBodyU "do_stuff" [mkExprStmtU unsafeExpr]
          result = analyzeU [fn]
          containsUnsafeEdges = findEdgesU "CONTAINS_UNSAFE" result
          fnId = semanticId fileU "FUNCTION" "do_stuff" Nothing Nothing
      length containsUnsafeEdges `shouldBe` 1
      let edge = head containsUnsafeEdges
      geSource edge `shouldBe` fnId

    -- 3. WRAPS_UNSAFE edge from safe fn to call inside unsafe block
    it "WRAPS_UNSAFE edge from safe fn to call inside unsafe block" $ do
      let callExpr = ExprCall (ExprPath "dangerous_fn" (mkSpanU 3 8)) [] (mkSpanU 3 8)
          unsafeExpr = ExprUnsafe (RustBlock [StmtSemi callExpr]) (mkSpanU 2 4)
          fn = mkFnWithBodyU "wrapper" [mkExprStmtU unsafeExpr]
          result = analyzeU [fn]
          wrapsUnsafeEdges = findEdgesU "WRAPS_UNSAFE" result
          fnId = semanticId fileU "FUNCTION" "wrapper" Nothing Nothing
      length wrapsUnsafeEdges `shouldBe` 1
      let edge = head wrapsUnsafeEdges
      geSource edge `shouldBe` fnId

    -- 4. unsafe fn does NOT get CONTAINS_UNSAFE edge (already unsafe context)
    it "unsafe fn does NOT get CONTAINS_UNSAFE edge" $ do
      let unsafeExpr = ExprUnsafe (RustBlock []) (mkSpanU 2 4)
          fn = mkUnsafeFnWithBodyU "danger" [mkExprStmtU unsafeExpr]
          result = analyzeU [fn]
          containsUnsafeEdges = findEdgesU "CONTAINS_UNSAFE" result
      length containsUnsafeEdges `shouldBe` 0

    -- 5. CONTAINS edge from scope to UNSAFE_BLOCK
    it "CONTAINS edge from scope to UNSAFE_BLOCK" $ do
      let unsafeExpr = ExprUnsafe (RustBlock []) (mkSpanU 2 4)
          fn = mkFnWithBodyU "foo" [mkExprStmtU unsafeExpr]
          result = analyzeU [fn]
          unsafeNodes = findNodesU "UNSAFE_BLOCK" result
      length unsafeNodes `shouldBe` 1
      let unsafeId = gnId (head unsafeNodes)
          containsEdges = filter (\e -> geType e == "CONTAINS" && geTarget e == unsafeId) (faEdges result)
      length containsEdges `shouldBe` 1

    -- 6. Multiple unsafe blocks -> correct count
    it "multiple unsafe blocks -> correct count of UNSAFE_BLOCK nodes" $ do
      let unsafe1 = ExprUnsafe (RustBlock []) (mkSpanU 2 4)
          unsafe2 = ExprUnsafe (RustBlock []) (mkSpanU 3 4)
          unsafe3 = ExprUnsafe (RustBlock []) (mkSpanU 4 4)
          fn = mkFnWithBodyU "multi" [mkExprStmtU unsafe1, mkExprStmtU unsafe2, mkExprStmtU unsafe3]
          result = analyzeU [fn]
          unsafeNodes = findNodesU "UNSAFE_BLOCK" result
      length unsafeNodes `shouldBe` 3

    -- 7. No unsafe blocks -> no UNSAFE_BLOCK nodes
    it "no unsafe blocks -> no UNSAFE_BLOCK nodes" $ do
      let plainExpr = ExprPath "x" (mkSpanU 2 4)
          fn = mkFnWithBodyU "safe_fn" [mkExprStmtU plainExpr]
          result = analyzeU [fn]
          unsafeNodes = findNodesU "UNSAFE_BLOCK" result
      length unsafeNodes `shouldBe` 0

    -- 8. Nested unsafe in safe fn -> both nodes
    it "nested unsafe blocks -> both UNSAFE_BLOCK nodes emitted" $ do
      let innerUnsafe = ExprUnsafe (RustBlock []) (mkSpanU 3 8)
          outerUnsafe = ExprUnsafe (RustBlock [StmtSemi innerUnsafe]) (mkSpanU 2 4)
          fn = mkFnWithBodyU "nested" [mkExprStmtU outerUnsafe]
          result = analyzeU [fn]
          unsafeNodes = findNodesU "UNSAFE_BLOCK" result
      length unsafeNodes `shouldBe` 2

  -- ── Closures (Phase 13) ──────────────────────────────────────────────
  describe "Closures" $ do

    -- Test helpers
    let mkSpanCL line col = Span (Pos line col) (Pos line (col + 1))
        fileCL = "src/main.rs"
        moduleIdCL = makeModuleId fileCL
        mkFnSigCL = RustFnSig False False False [] Nothing

        -- Helper: build a function with default sig and body
        mkFnWithBodyCL :: Text -> [RustStmt] -> RustItem
        mkFnWithBodyCL name stmts =
          ItemFn name VisPrivate mkFnSigCL (RustBlock stmts) [] (mkSpanCL 1 0)

        -- Helper: wrap an expression as a StmtSemi
        mkExprStmtCL :: RustExpr -> RustStmt
        mkExprStmtCL e = StmtSemi e

        -- Helper: run analysis on a file with given items
        analyzeCL items = runAnalyzer fileCL moduleIdCL (walkFile (RustFile items))

        -- Helper: find all edges by type
        findEdgesCL etype result =
          filter (\e -> geType e == etype) (faEdges result)

        -- Helper: find edges by type and variable metadata
        findCaptureEdge etype varName result =
          find (\e -> geType e == etype &&
                      Map.lookup "variable" (geMetadata e) == Just (MetaText varName))
               (faEdges result)

    -- 1. move || x -> CAPTURES_MOVE edge with variable="x"
    it "move || x -> CAPTURES_MOVE edge with variable=\"x\"" $ do
      let closureBody = ExprPath "x" (mkSpanCL 2 16)
          closure = ExprClosure [] Nothing closureBody True (mkSpanCL 2 4)
          fn = mkFnWithBodyCL "main" [mkExprStmtCL closure]
          result = analyzeCL [fn]
          capturesMoveEdges = findEdgesCL "CAPTURES_MOVE" result
      length capturesMoveEdges `shouldBe` 1
      case findCaptureEdge "CAPTURES_MOVE" "x" result of
        Nothing -> expectationFailure "expected CAPTURES_MOVE edge with variable=\"x\""
        Just edge -> do
          geType edge `shouldBe` "CAPTURES_MOVE"
          Map.lookup "variable" (geMetadata edge) `shouldBe` Just (MetaText "x")

    -- 2. || x (read) -> CAPTURES edge
    it "|| x (read) -> CAPTURES edge" $ do
      let closureBody = ExprPath "x" (mkSpanCL 2 10)
          closure = ExprClosure [] Nothing closureBody False (mkSpanCL 2 4)
          fn = mkFnWithBodyCL "main" [mkExprStmtCL closure]
          result = analyzeCL [fn]
          capturesEdges = findEdgesCL "CAPTURES" result
      length capturesEdges `shouldBe` 1
      case findCaptureEdge "CAPTURES" "x" result of
        Nothing -> expectationFailure "expected CAPTURES edge with variable=\"x\""
        Just edge ->
          Map.lookup "variable" (geMetadata edge) `shouldBe` Just (MetaText "x")

    -- 3. || { x = 1 } (mutate) -> CAPTURES_MUT edge
    it "|| { x = 1 } (mutate) -> CAPTURES_MUT edge" $ do
      let assignExpr = ExprAssign
                         (ExprPath "x" (mkSpanCL 2 12))
                         (ExprLit "1" (mkSpanCL 2 16))
                         (mkSpanCL 2 12)
          closureBody = ExprBlock [StmtSemi assignExpr] (mkSpanCL 2 8)
          closure = ExprClosure [] Nothing closureBody False (mkSpanCL 2 4)
          fn = mkFnWithBodyCL "main" [mkExprStmtCL closure]
          result = analyzeCL [fn]
      case findCaptureEdge "CAPTURES_MUT" "x" result of
        Nothing -> expectationFailure "expected CAPTURES_MUT edge with variable=\"x\""
        Just edge ->
          Map.lookup "variable" (geMetadata edge) `shouldBe` Just (MetaText "x")

    -- 4. Parameter is NOT a capture (declared in closure)
    it "parameter is NOT a capture" $ do
      let param = PatIdent "x" False False (mkSpanCL 2 5)
          closureBody = ExprPath "x" (mkSpanCL 2 10)
          closure = ExprClosure [param] Nothing closureBody False (mkSpanCL 2 4)
          fn = mkFnWithBodyCL "main" [mkExprStmtCL closure]
          result = analyzeCL [fn]
          capturesEdges = findEdgesCL "CAPTURES" result
          capturesMutEdges = findEdgesCL "CAPTURES_MUT" result
          capturesMoveEdges = findEdgesCL "CAPTURES_MOVE" result
      length capturesEdges `shouldBe` 0
      length capturesMutEdges `shouldBe` 0
      length capturesMoveEdges `shouldBe` 0

    -- 5. Local variable is NOT a capture (declared in closure body)
    it "local variable is NOT a capture" $ do
      let letStmt = StmtLocal
                      (PatIdent "y" False False (mkSpanCL 3 12))
                      (Just (ExprLit "42" (mkSpanCL 3 16)))
                      (mkSpanCL 3 8)
          useExpr = ExprPath "y" (mkSpanCL 4 8)
          closureBody = ExprBlock [letStmt, StmtExpr useExpr] (mkSpanCL 2 8)
          closure = ExprClosure [] Nothing closureBody False (mkSpanCL 2 4)
          fn = mkFnWithBodyCL "main" [mkExprStmtCL closure]
          result = analyzeCL [fn]
          -- y is declared locally, so no capture edge for it
      case findCaptureEdge "CAPTURES" "y" result of
        Nothing -> pure ()  -- expected: no capture for local variable
        Just _  -> expectationFailure "local variable 'y' should NOT be a capture"

    -- 6. Multiple captures -> correct count of edges
    it "multiple captures -> correct count of edges" $ do
      let ref1 = ExprPath "a" (mkSpanCL 2 10)
          ref2 = ExprPath "b" (mkSpanCL 2 14)
          ref3 = ExprPath "c" (mkSpanCL 2 18)
          closureBody = ExprTuple [ref1, ref2, ref3] (mkSpanCL 2 8)
          closure = ExprClosure [] Nothing closureBody False (mkSpanCL 2 4)
          fn = mkFnWithBodyCL "main" [mkExprStmtCL closure]
          result = analyzeCL [fn]
          capturesEdges = findEdgesCL "CAPTURES" result
      length capturesEdges `shouldBe` 3

  -- ── TypeLevel (Phase 14) ───────────────────────────────────────────────
  describe "TypeLevel" $ do

    -- Test helpers
    let mkSpanTL line col = Span (Pos line col) (Pos line (col + 1))
        fileTL = "src/main.rs"
        moduleIdTL = makeModuleId fileTL

        -- Helper: run analysis on a file with given items
        analyzeTL items = runAnalyzer fileTL moduleIdTL (walkFile (RustFile items))

        -- Helper: find all nodes by type
        findNodesTL ntype result =
          filter (\n -> gnType n == ntype) (faNodes result)

        -- Helper: find all edges by type
        findEdgesTL etype result =
          filter (\e -> geType e == etype) (faEdges result)

    -- 1. type Foo = Vec<i32> → TYPE_ALIAS node
    it "type alias emits TYPE_ALIAS node" $ do
      let typeAlias = ItemType "Foo" VisPrivate
                        (TypePath "Vec" [TypePath "i32" [] (mkSpanTL 1 15)] (mkSpanTL 1 11))
                        (mkSpanTL 1 0)
                        []
          result = analyzeTL [typeAlias]
          aliasNodes = findNodesTL "TYPE_ALIAS" result
      length aliasNodes `shouldBe` 1
      let node = head aliasNodes
      gnName node `shouldBe` "Foo"
      gnType node `shouldBe` "TYPE_ALIAS"

    -- 2. TYPE_ALIAS exported when pub
    it "TYPE_ALIAS exported when pub" $ do
      let typeAlias = ItemType "PubAlias" VisPub
                        (TypePath "i32" [] (mkSpanTL 1 20))
                        (mkSpanTL 1 0)
                        []
          result = analyzeTL [typeAlias]
          aliasNodes = findNodesTL "TYPE_ALIAS" result
      length aliasNodes `shouldBe` 1
      gnExported (head aliasNodes) `shouldBe` True

    -- 3. &'a T in fn sig → LIFETIME node with name 'a
    it "&'a T in fn sig emits LIFETIME node" $ do
      let fnSig = RustFnSig False False False
                    [ FnArgTyped
                        (PatIdent "x" False False (mkSpanTL 1 10))
                        (TypeReference (Just "'a") False
                          (TypePath "T" [] (mkSpanTL 1 20))
                          (mkSpanTL 1 14))
                    ]
                    Nothing
          fn = ItemFn "foo" VisPrivate fnSig (RustBlock []) [] (mkSpanTL 1 0)
          result = analyzeTL [fn]
          lifetimeNodes = findNodesTL "LIFETIME" result
      length lifetimeNodes `shouldBe` 1
      gnName (head lifetimeNodes) `shouldBe` "'a"

    -- 4. LIFETIME_OF edge for lifetime reference
    it "LIFETIME_OF edge emitted for lifetime" $ do
      let fnSig = RustFnSig False False False
                    [ FnArgTyped
                        (PatIdent "x" False False (mkSpanTL 1 10))
                        (TypeReference (Just "'b") False
                          (TypePath "T" [] (mkSpanTL 1 20))
                          (mkSpanTL 1 14))
                    ]
                    Nothing
          fn = ItemFn "foo" VisPrivate fnSig (RustBlock []) [] (mkSpanTL 1 0)
          result = analyzeTL [fn]
          lifetimeOfEdges = findEdgesTL "LIFETIME_OF" result
      length lifetimeOfEdges `shouldBe` 1
      -- LIFETIME_OF is a self-edge on the LIFETIME node
      let edge = head lifetimeOfEdges
      geSource edge `shouldBe` geTarget edge

    -- 5. impl Display + Debug → 2 TRAIT_BOUND nodes
    it "impl Trait with multiple bounds emits TRAIT_BOUND per bound" $ do
      let fnSig = RustFnSig False False False []
                    (Just (TypeImplTrait ["Display", "Debug"] (mkSpanTL 1 20)))
          fn = ItemFn "foo" VisPrivate fnSig (RustBlock []) [] (mkSpanTL 1 0)
          result = analyzeTL [fn]
          boundNodes = findNodesTL "TRAIT_BOUND" result
      length boundNodes `shouldBe` 2
      map gnName boundNodes `shouldBe` ["Display", "Debug"]

    -- 6. dyn Display → TRAIT_BOUND node
    it "dyn Trait emits TRAIT_BOUND node" $ do
      let fnSig = RustFnSig False False False
                    [ FnArgTyped
                        (PatIdent "x" False False (mkSpanTL 1 10))
                        (TypeReference Nothing False
                          (TypeTraitObject ["Display"] (mkSpanTL 1 18))
                          (mkSpanTL 1 14))
                    ]
                    Nothing
          fn = ItemFn "foo" VisPrivate fnSig (RustBlock []) [] (mkSpanTL 1 0)
          result = analyzeTL [fn]
          boundNodes = findNodesTL "TRAIT_BOUND" result
      length boundNodes `shouldBe` 1
      gnName (head boundNodes) `shouldBe` "Display"

    -- 7. CONTAINS edges for all type-level nodes
    it "CONTAINS edges emitted for type-level nodes" $ do
      let typeAlias = ItemType "Foo" VisPrivate
                        (TypePath "i32" [] (mkSpanTL 1 15))
                        (mkSpanTL 1 0)
                        []
          result = analyzeTL [typeAlias]
          containsEdges = findEdgesTL "CONTAINS" result
          aliasNodes = findNodesTL "TYPE_ALIAS" result
          aliasId = gnId (head aliasNodes)
          -- Find CONTAINS edge targeting the TYPE_ALIAS node
          aliasContains = filter (\e -> geTarget e == aliasId) containsEdges
      length aliasContains `shouldBe` 1
      geSource (head aliasContains) `shouldBe` moduleIdTL

    -- 8. No lifetimes → no LIFETIME nodes
    it "no lifetimes in type produces no LIFETIME nodes" $ do
      let fnSig = RustFnSig False False False
                    [ FnArgTyped
                        (PatIdent "x" False False (mkSpanTL 1 10))
                        (TypeReference Nothing False
                          (TypePath "i32" [] (mkSpanTL 1 18))
                          (mkSpanTL 1 14))
                    ]
                    Nothing
          fn = ItemFn "bar" VisPrivate fnSig (RustBlock []) [] (mkSpanTL 1 0)
          result = analyzeTL [fn]
          lifetimeNodes = findNodesTL "LIFETIME" result
      length lifetimeNodes `shouldBe` 0

    -- 9. TYPE_ALIAS semantic ID format
    it "TYPE_ALIAS semantic ID follows format file->TYPE_ALIAS->name" $ do
      let typeAlias = ItemType "MyType" VisPrivate
                        (TypePath "u32" [] (mkSpanTL 1 18))
                        (mkSpanTL 1 0)
                        []
          result = analyzeTL [typeAlias]
          aliasNodes = findNodesTL "TYPE_ALIAS" result
      length aliasNodes `shouldBe` 1
      gnId (head aliasNodes) `shouldBe` semanticId fileTL "TYPE_ALIAS" "MyType" Nothing Nothing

    -- 10. Multiple trait bounds → correct count
    it "multiple trait bounds in impl Trait produce correct count" $ do
      let fnSig = RustFnSig False False False []
                    (Just (TypeImplTrait ["Display", "Debug", "Clone"] (mkSpanTL 1 20)))
          fn = ItemFn "multi" VisPrivate fnSig (RustBlock []) [] (mkSpanTL 1 0)
          result = analyzeTL [fn]
          boundNodes = findNodesTL "TRAIT_BOUND" result
      length boundNodes `shouldBe` 3

  -- ── Attributes (Phase 15) ────────────────────────────────────────────────
  describe "Attributes" $ do

    -- Test helpers
    let mkSpanA line col = Span (Pos line col) (Pos line (col + 1))
        fileA = "src/main.rs"
        moduleIdA = makeModuleId fileA

        -- Helper: run analysis on a file with given items
        analyzeA items = runAnalyzer fileA moduleIdA (walkFile (RustFile items))

        -- Helper: find all nodes by type
        findNodesA ntype result =
          filter (\n -> gnType n == ntype) (faNodes result)

        -- Helper: find node by type and name
        findNodeA ntype nname result =
          find (\n -> gnType n == ntype && gnName n == nname) (faNodes result)

        -- Helper: find all edges by type
        findEdgesA etype result =
          filter (\e -> geType e == etype) (faEdges result)

        -- Helper: get metadata value
        getMetaA key node = Map.lookup key (gnMetadata node)

        -- Helper: make a simple derive attribute
        mkDeriveAttr traits = RustAttribute "outer" "derive" traits

        -- Helper: make a regular attribute
        mkAttr path tokens = RustAttribute "outer" path tokens

    -- 1. #[derive(Debug, Clone)] -> DERIVES edges per trait (2 edges)
    it "#[derive(Debug, Clone)] emits DERIVES edge per trait" $ do
      let attr = mkDeriveAttr "Debug, Clone"
          item = ItemStruct "Foo" VisPrivate [] [attr] (mkSpanA 1 0) False False
          result = analyzeA [item]
          derivesEdges = findEdgesA "DERIVES" result
      length derivesEdges `shouldBe` 2
      let traits = map (\e -> Map.lookup "trait" (geMetadata e)) derivesEdges
      traits `shouldBe` [Just (MetaText "Debug"), Just (MetaText "Clone")]

    -- 2. #[test] -> ATTRIBUTE node with kind=test
    it "#[test] emits ATTRIBUTE node with kind=test" $ do
      let attr = mkAttr "test" ""
          fn = ItemFn "my_test" VisPrivate
                 (RustFnSig False False False [] Nothing)
                 (RustBlock [])
                 [attr]
                 (mkSpanA 1 0)
          result = analyzeA [fn]
      case findNodeA "ATTRIBUTE" "test" result of
        Nothing -> expectationFailure "expected ATTRIBUTE node 'test'"
        Just node -> do
          gnType node `shouldBe` "ATTRIBUTE"
          gnName node `shouldBe` "test"
          getMetaA "kind" node `shouldBe` Just (MetaText "test")

    -- 3. #[cfg(test)] -> ATTRIBUTE node with kind=cfg
    it "#[cfg(test)] emits ATTRIBUTE node with kind=cfg" $ do
      let attr = mkAttr "cfg" "test"
          fn = ItemFn "test_fn" VisPrivate
                 (RustFnSig False False False [] Nothing)
                 (RustBlock [])
                 [attr]
                 (mkSpanA 1 0)
          result = analyzeA [fn]
      case findNodeA "ATTRIBUTE" "cfg" result of
        Nothing -> expectationFailure "expected ATTRIBUTE node 'cfg'"
        Just node -> do
          getMetaA "kind" node `shouldBe` Just (MetaText "cfg")
          getMetaA "tokens" node `shouldBe` Just (MetaText "test")

    -- 4. #[serde(rename = "foo")] -> ATTRIBUTE node with kind=other and tokens metadata
    it "#[serde(rename = \"foo\")] emits ATTRIBUTE with kind=other and tokens" $ do
      let attr = mkAttr "serde" "rename = \"foo\""
          item = ItemStruct "Bar" VisPrivate [] [attr] (mkSpanA 1 0) False False
          result = analyzeA [item]
      case findNodeA "ATTRIBUTE" "serde" result of
        Nothing -> expectationFailure "expected ATTRIBUTE node 'serde'"
        Just node -> do
          getMetaA "kind" node `shouldBe` Just (MetaText "other")
          getMetaA "tokens" node `shouldBe` Just (MetaText "rename = \"foo\"")

    -- 5. HAS_ATTRIBUTE edge from item to attribute
    it "HAS_ATTRIBUTE edge from item to attribute" $ do
      let attr = mkAttr "test" ""
          fn = ItemFn "my_fn" VisPrivate
                 (RustFnSig False False False [] Nothing)
                 (RustBlock [])
                 [attr]
                 (mkSpanA 1 0)
          result = analyzeA [fn]
          fnId = semanticId fileA "FUNCTION" "my_fn" Nothing Nothing
          hasAttrEdges = findEdgesA "HAS_ATTRIBUTE" result
      length hasAttrEdges `shouldBe` 1
      let edge = head hasAttrEdges
      geSource edge `shouldBe` fnId

    -- 6. CONTAINS edge for ATTRIBUTE node
    it "CONTAINS edge from scope to ATTRIBUTE node" $ do
      let attr = mkAttr "inline" ""
          fn = ItemFn "fast_fn" VisPrivate
                 (RustFnSig False False False [] Nothing)
                 (RustBlock [])
                 [attr]
                 (mkSpanA 1 0)
          result = analyzeA [fn]
          attrNodes = findNodesA "ATTRIBUTE" result
      length attrNodes `shouldBe` 1
      let attrId = gnId (head attrNodes)
          containsEdges = filter (\e -> geType e == "CONTAINS" && geTarget e == attrId) (faEdges result)
      length containsEdges `shouldBe` 1
      geSource (head containsEdges) `shouldBe` moduleIdA

    -- 7. No attributes -> no ATTRIBUTE nodes
    it "no attributes produces no ATTRIBUTE nodes" $ do
      let fn = ItemFn "plain" VisPrivate
                 (RustFnSig False False False [] Nothing)
                 (RustBlock [])
                 []
                 (mkSpanA 1 0)
          result = analyzeA [fn]
          attrNodes = findNodesA "ATTRIBUTE" result
          derivesEdges = findEdgesA "DERIVES" result
      length attrNodes `shouldBe` 0
      length derivesEdges `shouldBe` 0

    -- 8. Multiple derives -> correct count
    it "multiple derives produce correct count of DERIVES edges" $ do
      let attr = mkDeriveAttr "Debug, Clone, PartialEq, Eq"
          item = ItemStruct "Multi" VisPrivate [] [attr] (mkSpanA 1 0) False False
          result = analyzeA [item]
          derivesEdges = findEdgesA "DERIVES" result
      length derivesEdges `shouldBe` 4
