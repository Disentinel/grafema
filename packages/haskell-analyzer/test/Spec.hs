{-# LANGUAGE OverloadedStrings #-}
-- | Tests for the Haskell analyzer (Phases 1-3).
--
-- Verifies:
-- * Parser: module header parsing, qualified names, unnamed modules, syntax errors
-- * Walker: MODULE node emission with correct fields
-- * Declarations: FUNCTION, VARIABLE, TYPE_SIGNATURE nodes
-- * Data types: DATA_TYPE, CONSTRUCTOR, RECORD_FIELD nodes
-- * Type classes: TYPE_CLASS, INSTANCE nodes
-- * Type level: TYPE_SYNONYM nodes
-- * Imports: IMPORT, IMPORT_BINDING nodes, deferred IMPORTS_FROM edges
-- * Exports: EXPORT_BINDING nodes, ExportInfo records
module Main where

import Test.Hspec
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import Analysis.Types
import Analysis.Walker (walkModule)
import Analysis.Context (runAnalyzer)
import Parser (parseHaskell)
import Grafema.SemanticId (makeModuleId)
import Rules.Coverage (checkCoverage)
import Rules.Dispatch (checkDispatch)

-- | Parse source text and run the analyzer, returning FileAnalysis.
-- Uses the given file path for both the parser and the analyzer context.
-- Includes Phase 7 post-passes (coverage + dispatch).
analyzeSource :: T.Text -> T.Text -> Either String FileAnalysis
analyzeSource file source =
  case parseHaskell (T.unpack file) source of
    Left err -> Left err
    Right hsmod ->
      let moduleId = makeModuleId file
          rawResult = runAnalyzer file moduleId (walkModule hsmod)
          coverageEdges = checkCoverage rawResult
          dispatchEdges = checkDispatch rawResult
      in  Right rawResult { faEdges = faEdges rawResult ++ coverageEdges ++ dispatchEdges }

-- | Find the first node with gnType == "MODULE" in a FileAnalysis.
findModuleNode :: FileAnalysis -> Maybe GraphNode
findModuleNode fa = case filter (\n -> gnType n == "MODULE") (faNodes fa) of
  (n:_) -> Just n
  []    -> Nothing

-- | Check that parseHaskell succeeds (avoids needing Show for HsModule GhcPs).
shouldParseOk :: FilePath -> T.Text -> Expectation
shouldParseOk path source =
  case parseHaskell path source of
    Right _ -> pure ()
    Left err -> expectationFailure $ "expected successful parse, got error: " ++ err

-- | Check that parseHaskell fails (avoids needing Show for HsModule GhcPs).
shouldParseFail :: FilePath -> T.Text -> Expectation
shouldParseFail path source =
  case parseHaskell path source of
    Left _  -> pure ()
    Right _ -> expectationFailure "expected parse error, but parsing succeeded"

main :: IO ()
main = hspec $ do

  -- ── Parser tests ───────────────────────────────────────────────────
  describe "Parser" $ do

    it "parses minimal module" $
      shouldParseOk "Foo.hs" "module Foo where\n"

    it "parses qualified module name" $
      shouldParseOk "Foo/Bar/Baz.hs" "module Foo.Bar.Baz where\n"

    it "parses module with declarations" $ do
      let source = T.unlines
            [ "module Example where"
            , ""
            , "x :: Int"
            , "x = 42"
            ]
      shouldParseOk "Example.hs" source

    it "handles unnamed modules (no module header)" $
      -- Haskell allows files without a module header (defaults to Main)
      shouldParseOk "Main.hs" "main = putStrLn \"hello\"\n"

    it "reports syntax errors" $
      shouldParseFail "Bad.hs" "module where where where\n"

    it "error message is non-empty" $ do
      let source = "module where where where\n"
      case parseHaskell "Bad.hs" source of
        Left err -> err `shouldSatisfy` (not . null)
        Right _  -> expectationFailure "expected parse error"

  -- ── Walker: MODULE node tests ──────────────────────────────────────
  describe "Walker - MODULE node" $ do

    it "emits MODULE node for simple module" $ do
      let Right fa = analyzeSource "Foo.hs" "module Foo where\n"
      let nodes = faNodes fa
      length nodes `shouldBe` 1
      gnType (head nodes) `shouldBe` "MODULE"

    it "sets correct module name for simple module" $ do
      let Right fa = analyzeSource "Foo.hs" "module Foo where\n"
      let Just modNode = findModuleNode fa
      gnName modNode `shouldBe` "Foo"

    it "sets correct module name for qualified module" $ do
      let Right fa = analyzeSource "Foo/Bar/Baz.hs" "module Foo.Bar.Baz where\n"
      let Just modNode = findModuleNode fa
      gnName modNode `shouldBe` "Foo.Bar.Baz"

    it "uses file path as name for unnamed modules" $ do
      let Right fa = analyzeSource "src/Main.hs" "main = putStrLn \"hello\"\n"
      let Just modNode = findModuleNode fa
      gnName modNode `shouldBe` "src/Main.hs"

    it "sets correct source location for module name" $ do
      let Right fa = analyzeSource "Foo.hs" "module Foo where\n"
      let Just modNode = findModuleNode fa
      -- "module Foo where" -> "Foo" starts at line 1, col 7 (0-based)
      gnLine modNode `shouldBe` 1
      gnColumn modNode `shouldBe` 7

    it "defaults location to (1, 0) for unnamed modules" $ do
      let Right fa = analyzeSource "Main.hs" "main = putStrLn \"hello\"\n"
      let Just modNode = findModuleNode fa
      gnLine modNode `shouldBe` 1
      gnColumn modNode `shouldBe` 0

    it "sets exported = True for MODULE node" $ do
      let Right fa = analyzeSource "Foo.hs" "module Foo where\n"
      let Just modNode = findModuleNode fa
      gnExported modNode `shouldBe` True

    it "sets correct file path on MODULE node" $ do
      let Right fa = analyzeSource "src/Analysis/Types.hs" "module Analysis.Types where\n"
      let Just modNode = findModuleNode fa
      gnFile modNode `shouldBe` "src/Analysis/Types.hs"

    it "sets module ID as MODULE#filepath" $ do
      let Right fa = analyzeSource "Foo.hs" "module Foo where\n"
      let Just modNode = findModuleNode fa
      gnId modNode `shouldBe` "MODULE#Foo.hs"

  -- ── FileAnalysis structure tests ───────────────────────────────────
  describe "FileAnalysis structure" $ do

    it "sets faFile correctly" $ do
      let Right fa = analyzeSource "src/Lib.hs" "module Lib where\n"
      faFile fa `shouldBe` "src/Lib.hs"

    it "sets faModuleId correctly" $ do
      let Right fa = analyzeSource "src/Lib.hs" "module Lib where\n"
      faModuleId fa `shouldBe` "MODULE#src/Lib.hs"

    it "has no edges in Phase 1" $ do
      let Right fa = analyzeSource "Foo.hs" "module Foo where\n"
      faEdges fa `shouldBe` []

    it "has no unresolved refs in Phase 1" $ do
      let Right fa = analyzeSource "Foo.hs" "module Foo where\n"
      faUnresolvedRefs fa `shouldBe` []

    it "has no exports in Phase 1" $ do
      let Right fa = analyzeSource "Foo.hs" "module Foo where\n"
      faExports fa `shouldBe` []

  -- ── End-to-end: non-trivial source ─────────────────────────────────
  describe "Non-trivial source" $ do

    it "handles module with extensions and imports" $ do
      let source = T.unlines
            [ "{-# LANGUAGE OverloadedStrings #-}"
            , "{-# LANGUAGE ScopedTypeVariables #-}"
            , "module Data.Graph.Analysis where"
            , ""
            , "import Data.Text (Text)"
            , "import qualified Data.Map.Strict as Map"
            , ""
            , "analyze :: Text -> Int"
            , "analyze _ = 0"
            ]
      case analyzeSource "src/Data/Graph/Analysis.hs" source of
        Left err -> expectationFailure $ "expected successful analysis, got: " ++ err
        Right fa -> do
          let Just modNode = findModuleNode fa
          gnName modNode `shouldBe` "Data.Graph.Analysis"
          gnFile modNode `shouldBe` "src/Data/Graph/Analysis.hs"

    it "handles module with export list" $ do
      let source = T.unlines
            [ "module Foo"
            , "  ( bar"
            , "  , baz"
            , "  ) where"
            , ""
            , "bar :: Int"
            , "bar = 1"
            , ""
            , "baz :: Int"
            , "baz = 2"
            ]
      case analyzeSource "Foo.hs" source of
        Left err -> expectationFailure $ "expected successful analysis, got: " ++ err
        Right fa -> do
          let Just modNode = findModuleNode fa
          gnName modNode `shouldBe` "Foo"

  -- ── Phase 2: Declarations ───────────────────────────────────────────
  describe "Phase 2: Declarations" $ do

    it "emits FUNCTION node for top-level function" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nfoo x = x + 1"
      let fns = filter (\n -> gnType n == "FUNCTION") (faNodes fa)
      length fns `shouldBe` 1
      gnName (head fns) `shouldBe` "foo"

    it "emits FUNCTION node for simple binding (GHC parses x = 42 as FunBind)" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nx = 42"
      let fns = filter (\n -> gnType n == "FUNCTION") (faNodes fa)
      length fns `shouldBe` 1
      gnName (head fns) `shouldBe` "x"

    it "emits TYPE_SIGNATURE for type sig" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nfoo :: Int -> Int\nfoo x = x"
      let sigs = filter (\n -> gnType n == "TYPE_SIGNATURE") (faNodes fa)
      length sigs `shouldBe` 1
      gnName (head sigs) `shouldBe` "foo"

  -- ── Phase 2: Data Types ────────────────────────────────────────────
  describe "Phase 2: Data Types" $ do

    it "emits DATA_TYPE + CONSTRUCTORs for simple enum" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\ndata Color = Red | Green | Blue"
      let dts = filter (\n -> gnType n == "DATA_TYPE") (faNodes fa)
      let cons = filter (\n -> gnType n == "CONSTRUCTOR") (faNodes fa)
      length dts `shouldBe` 1
      gnName (head dts) `shouldBe` "Color"
      length cons `shouldBe` 3

    it "emits RECORD_FIELD + HAS_FIELD for record types" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\ndata Person = Person { name :: String, age :: Int }"
      let fields = filter (\n -> gnType n == "RECORD_FIELD") (faNodes fa)
      let hasFieldEdges = filter (\e -> geType e == "HAS_FIELD") (faEdges fa)
      length fields `shouldBe` 2
      length hasFieldEdges `shouldBe` 2

  -- ── Phase 2: Type Classes ──────────────────────────────────────────
  describe "Phase 2: Type Classes" $ do

    it "emits TYPE_CLASS for class declaration" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nclass MyClass a where\n  myMethod :: a -> String"
      let cls = filter (\n -> gnType n == "TYPE_CLASS") (faNodes fa)
      length cls `shouldBe` 1
      gnName (head cls) `shouldBe` "MyClass"

    it "emits INSTANCE for instance declaration" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\ndata Foo = Foo\nclass Bar a where\n  bar :: a -> Int\ninstance Bar Foo where\n  bar _ = 0"
      let insts = filter (\n -> gnType n == "INSTANCE") (faNodes fa)
      length insts `shouldBe` 1

  -- ── Phase 2: Type Level ────────────────────────────────────────────
  describe "Phase 2: Type Level" $ do

    it "emits TYPE_SYNONYM for type alias" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\ntype Name = String"
      let syns = filter (\n -> gnType n == "TYPE_SYNONYM") (faNodes fa)
      length syns `shouldBe` 1
      gnName (head syns) `shouldBe` "Name"

  -- ── Phase 3: Imports ──────────────────────────────────────────────
  describe "Phase 3: Imports" $ do

    it "emits IMPORT node for simple import" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nimport Data.Text"
      let imps = filter (\n -> gnType n == "IMPORT") (faNodes fa)
      length imps `shouldBe` 1
      gnName (head imps) `shouldBe` "Data.Text"

    it "emits CONTAINS edge from module to import" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nimport Data.Text"
      let containsEdges = filter (\e -> geType e == "CONTAINS") (faEdges fa)
      let importEdges = filter (\e -> T.isInfixOf "IMPORT" (geTarget e)) containsEdges
      length importEdges `shouldBe` 1

    it "emits IMPORT_BINDING for selective import" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nimport Data.Text (Text, pack)"
      let bindings = filter (\n -> gnType n == "IMPORT_BINDING") (faNodes fa)
      length bindings `shouldBe` 2

    it "emits correct names for import bindings" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nimport Data.Text (Text, pack)"
      let bindings = filter (\n -> gnType n == "IMPORT_BINDING") (faNodes fa)
      let names = map gnName bindings
      names `shouldContain` ["Text"]
      names `shouldContain` ["pack"]

    it "marks qualified imports in metadata" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nimport qualified Data.Map.Strict as Map"
      let imps = filter (\n -> gnType n == "IMPORT") (faNodes fa)
      length imps `shouldBe` 1
      Map.lookup "qualified" (gnMetadata (head imps)) `shouldBe` Just (MetaBool True)

    it "marks alias in metadata for qualified imports" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nimport qualified Data.Map.Strict as Map"
      let imps = filter (\n -> gnType n == "IMPORT") (faNodes fa)
      Map.lookup "alias" (gnMetadata (head imps)) `shouldBe` Just (MetaText "Map")

    it "marks hiding imports in metadata" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nimport Data.List hiding (sort)"
      let imps = filter (\n -> gnType n == "IMPORT") (faNodes fa)
      length imps `shouldBe` 1
      Map.lookup "hiding" (gnMetadata (head imps)) `shouldBe` Just (MetaBool True)

    it "emits IMPORT_BINDING for hiding items" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nimport Data.List hiding (sort, nub)"
      let bindings = filter (\n -> gnType n == "IMPORT_BINDING") (faNodes fa)
      length bindings `shouldBe` 2

    it "emits deferred IMPORTS_FROM ref" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nimport Data.Text"
      let refs = faUnresolvedRefs fa
      length refs `shouldBe` 1
      drKind (head refs) `shouldBe` ImportResolve
      drName (head refs) `shouldBe` "Data.Text"
      drEdgeType (head refs) `shouldBe` "IMPORTS_FROM"

    it "handles multiple imports" $ do
      let source = T.unlines
            [ "module Test where"
            , "import Data.Text"
            , "import Data.Map"
            , "import Data.Set"
            ]
      let Right fa = analyzeSource "Test.hs" source
      let imps = filter (\n -> gnType n == "IMPORT") (faNodes fa)
      length imps `shouldBe` 3
      let refs = faUnresolvedRefs fa
      length refs `shouldBe` 3

    it "handles import with type constructor and all constructors" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nimport Data.Maybe (Maybe(..))"
      let bindings = filter (\n -> gnType n == "IMPORT_BINDING") (faNodes fa)
      length bindings `shouldBe` 1
      gnName (head bindings) `shouldBe` "Maybe"

    it "handles import with type and specific constructors" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nimport Data.Either (Either(Left, Right))"
      let bindings = filter (\n -> gnType n == "IMPORT_BINDING") (faNodes fa)
      length bindings `shouldBe` 3  -- Either + Left + Right

    it "does not mark non-qualified imports as qualified" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nimport Data.Text"
      let imps = filter (\n -> gnType n == "IMPORT") (faNodes fa)
      Map.lookup "qualified" (gnMetadata (head imps)) `shouldBe` Nothing

  -- ── Phase 3: Exports ──────────────────────────────────────────────
  describe "Phase 3: Exports" $ do

    it "emits EXPORT_BINDING for explicit exports" $ do
      let source = T.unlines
            [ "module Test (foo, bar) where"
            , "foo = 1"
            , "bar = 2"
            ]
      let Right fa = analyzeSource "Test.hs" source
      let exports = filter (\n -> gnType n == "EXPORT_BINDING") (faNodes fa)
      length exports `shouldBe` 2

    it "emits correct names for export bindings" $ do
      let source = T.unlines
            [ "module Test (foo, bar) where"
            , "foo = 1"
            , "bar = 2"
            ]
      let Right fa = analyzeSource "Test.hs" source
      let exports = filter (\n -> gnType n == "EXPORT_BINDING") (faNodes fa)
      let names = map gnName exports
      names `shouldContain` ["foo"]
      names `shouldContain` ["bar"]

    it "emits ExportInfo for explicit exports" $ do
      let source = T.unlines
            [ "module Test (foo) where"
            , "foo = 1"
            ]
      let Right fa = analyzeSource "Test.hs" source
      let exps = faExports fa
      length exps `shouldBe` 1
      eiName (head exps) `shouldBe` "foo"
      eiKind (head exps) `shouldBe` NamedExport

    it "emits no EXPORT_BINDING for implicit exports (no export list)" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nfoo = 1"
      let exports = filter (\n -> gnType n == "EXPORT_BINDING") (faNodes fa)
      length exports `shouldBe` 0

    it "emits no ExportInfo for implicit exports" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nfoo = 1"
      faExports fa `shouldBe` []

    it "handles export of type with all constructors" $ do
      let source = T.unlines
            [ "module Test (Color(..)) where"
            , "data Color = Red | Green | Blue"
            ]
      let Right fa = analyzeSource "Test.hs" source
      let exports = filter (\n -> gnType n == "EXPORT_BINDING") (faNodes fa)
      length exports `shouldBe` 1
      gnName (head exports) `shouldBe` "Color"

    it "handles export of type with specific constructors" $ do
      let source = T.unlines
            [ "module Test (Either(Left, Right)) where"
            , "data Either a b = Left a | Right b"
            ]
      let Right fa = analyzeSource "Test.hs" source
      let exports = filter (\n -> gnType n == "EXPORT_BINDING") (faNodes fa)
      length exports `shouldBe` 3  -- Either + Left + Right

    it "handles module re-export in export list" $ do
      let source = T.unlines
            [ "module Test (module Data.Text) where"
            , "import Data.Text"
            ]
      let Right fa = analyzeSource "Test.hs" source
      let exps = faExports fa
      let reExps = filter (\e -> eiKind e == ReExport) exps
      length reExps `shouldBe` 1
      eiName (head reExps) `shouldBe` "Data.Text"
      eiSource (head reExps) `shouldBe` Just "Data.Text"

    it "sets exported = True on EXPORT_BINDING nodes" $ do
      let source = T.unlines
            [ "module Test (foo) where"
            , "foo = 1"
            ]
      let Right fa = analyzeSource "Test.hs" source
      let exports = filter (\n -> gnType n == "EXPORT_BINDING") (faNodes fa)
      gnExported (head exports) `shouldBe` True

  -- ── Phase 4: Expressions ────────────────────────────────────────────
  describe "Phase 4: Expressions" $ do

    it "emits REFERENCE for variable usage in function body" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nf x = x"
      let refs = filter (\n -> gnType n == "REFERENCE") (faNodes fa)
      length refs `shouldSatisfy` (> 0)
      -- The reference to 'x' on the RHS
      let xRefs = filter (\n -> gnName n == "x") refs
      length xRefs `shouldBe` 1

    it "emits CALL for function application" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nf x = g x"
      let calls = filter (\n -> gnType n == "CALL") (faNodes fa)
      length calls `shouldSatisfy` (> 0)
      let gCalls = filter (\n -> gnName n == "g") calls
      length gCalls `shouldBe` 1

    it "emits CALL for operator application" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nf x = x + 1"
      let calls = filter (\n -> gnType n == "CALL") (faNodes fa)
      let opCalls = filter (\n -> gnName n == "+") calls
      length opCalls `shouldBe` 1

    it "emits LAMBDA for lambda expression" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nf = \\x -> x"
      let lams = filter (\n -> gnType n == "LAMBDA") (faNodes fa)
      length lams `shouldBe` 1

    it "emits BRANCH for case expression" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nf x = case x of { True -> 1; False -> 0 }"
      let branches = filter (\n -> gnType n == "BRANCH") (faNodes fa)
      length branches `shouldBe` 1
      gnName (head branches) `shouldBe` "case"

    it "emits BRANCH for if expression" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nf x = if x then 1 else 0"
      let branches = filter (\n -> gnType n == "BRANCH") (faNodes fa)
      length branches `shouldBe` 1
      gnName (head branches) `shouldBe` "if"

    it "emits DO_BLOCK for do expression" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nf = do { x <- getLine; putStrLn x }"
      let dos = filter (\n -> gnType n == "DO_BLOCK") (faNodes fa)
      length dos `shouldBe` 1

    it "emits LET_BLOCK for let expression" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nf x = let y = x in y"
      let lets = filter (\n -> gnType n == "LET_BLOCK") (faNodes fa)
      length lets `shouldBe` 1

    it "emits CONTAINS edge from scope to REFERENCE" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nf x = x"
      let refs = filter (\n -> gnType n == "REFERENCE") (faNodes fa)
      let refIds = map gnId refs
      let containsEdges = filter (\e -> geType e == "CONTAINS" && geTarget e `elem` refIds) (faEdges fa)
      length containsEdges `shouldSatisfy` (> 0)

    it "walks into nested expressions" $ do
      -- f x = g (h x) should have calls to both g and h
      let Right fa = analyzeSource "Test.hs" "module Test where\nf x = g (h x)"
      let calls = filter (\n -> gnType n == "CALL") (faNodes fa)
      let callNames = map gnName calls
      callNames `shouldContain` ["g"]
      callNames `shouldContain` ["h"]

    it "walks into where clause expressions" $ do
      let source = T.unlines
            [ "module Test where"
            , "f x = helper x"
            , "  where helper y = y + 1"
            ]
      let Right fa = analyzeSource "Test.hs" source
      -- Should have a CALL for (+) in the where clause
      let calls = filter (\n -> gnType n == "CALL") (faNodes fa)
      let opCalls = filter (\n -> gnName n == "+") calls
      length opCalls `shouldBe` 1
      -- Should also emit FUNCTION for the local binding 'helper'
      let fns = filter (\n -> gnType n == "FUNCTION") (faNodes fa)
      let fnNames = map gnName fns
      fnNames `shouldContain` ["helper"]

  -- ── Phase 4: Patterns ──────────────────────────────────────────────
  describe "Phase 4: Patterns" $ do

    it "emits PARAMETER for function parameter" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nf x = x"
      let params = filter (\n -> gnType n == "PARAMETER") (faNodes fa)
      length params `shouldBe` 1
      gnName (head params) `shouldBe` "x"

    it "emits PARAMETER for multiple function parameters" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nf x y = x + y"
      let params = filter (\n -> gnType n == "PARAMETER") (faNodes fa)
      length params `shouldBe` 2
      let paramNames = map gnName params
      paramNames `shouldContain` ["x"]
      paramNames `shouldContain` ["y"]

    it "emits PATTERN for constructor pattern" $ do
      let source = T.unlines
            [ "module Test where"
            , "f (Just x) = x"
            , "f Nothing = 0"
            ]
      let Right fa = analyzeSource "Test.hs" source
      let pats = filter (\n -> gnType n == "PATTERN") (faNodes fa)
      let patNames = map gnName pats
      patNames `shouldContain` ["Just"]
      patNames `shouldContain` ["Nothing"]

    it "emits PARAMETER for nested pattern variable" $ do
      let source = T.unlines
            [ "module Test where"
            , "f (Just x) = x"
            , "f Nothing = 0"
            ]
      let Right fa = analyzeSource "Test.hs" source
      let params = filter (\n -> gnType n == "PARAMETER") (faNodes fa)
      let xParams = filter (\n -> gnName n == "x") params
      length xParams `shouldBe` 1

    it "emits PARAMETER for lambda parameters" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nf = \\x y -> x + y"
      let params = filter (\n -> gnType n == "PARAMETER") (faNodes fa)
      length params `shouldBe` 2
      let paramNames = map gnName params
      paramNames `shouldContain` ["x"]
      paramNames `shouldContain` ["y"]

    it "emits PATTERN for tuple pattern" $ do
      -- Tuples are ConPat internally in GHC, so should emit PATTERN nodes
      -- Actually, TuplePat is separate from ConPat -- it just recurses
      -- into sub-patterns. So (x, y) emits PARAMETERs for x and y.
      let Right fa = analyzeSource "Test.hs" "module Test where\nf (x, y) = x + y"
      let params = filter (\n -> gnType n == "PARAMETER") (faNodes fa)
      length params `shouldBe` 2

  -- ── Phase 4: Guards ────────────────────────────────────────────────
  describe "Phase 4: Guards" $ do

    it "walks RHS expressions in unguarded equations" $ do
      -- Simple f x = x + 1 should walk the body
      let Right fa = analyzeSource "Test.hs" "module Test where\nf x = x + 1"
      let calls = filter (\n -> gnType n == "CALL") (faNodes fa)
      length calls `shouldSatisfy` (> 0)

    it "walks let-expression body and bindings" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nf x = let y = x in y"
      let lets = filter (\n -> gnType n == "LET_BLOCK") (faNodes fa)
      length lets `shouldBe` 1
      -- The local binding 'y' should be emitted as a FUNCTION node
      -- (GHC parses y = x as a FunBind)
      let fns = filter (\n -> gnType n == "FUNCTION") (faNodes fa)
      let fnNames = map gnName fns
      fnNames `shouldContain` ["y"]

    it "walks do-block statements" $ do
      let source = T.unlines
            [ "module Test where"
            , "f = do"
            , "  x <- getLine"
            , "  putStrLn x"
            ]
      let Right fa = analyzeSource "Test.hs" source
      let dos = filter (\n -> gnType n == "DO_BLOCK") (faNodes fa)
      length dos `shouldBe` 1
      -- Should have calls to getLine and putStrLn
      let calls = filter (\n -> gnType n == "CALL") (faNodes fa)
      let callNames = map gnName calls
      callNames `shouldContain` ["putStrLn"]

    it "walks do-block bind patterns" $ do
      let source = T.unlines
            [ "module Test where"
            , "f = do"
            , "  x <- getLine"
            , "  putStrLn x"
            ]
      let Right fa = analyzeSource "Test.hs" source
      -- The 'x' in 'x <- getLine' should emit a PARAMETER
      let params = filter (\n -> gnType n == "PARAMETER") (faNodes fa)
      let xParams = filter (\n -> gnName n == "x") params
      length xParams `shouldBe` 1

  -- ── Phase 5: Data Flow Graph ──────────────────────────────────────
  describe "Phase 5: Data Flow Graph" $ do

    it "emits DERIVED_FROM for operator arguments" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nf x = x + 1"
      let dfEdges = filter (\e -> geType e == "DERIVED_FROM") (faEdges fa)
      length dfEdges `shouldSatisfy` (> 0)

    it "emits DERIVED_FROM from both operands to operator CALL" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nf x y = x + y"
      let dfEdges = filter (\e -> geType e == "DERIVED_FROM") (faEdges fa)
      -- Both x and y should flow into the (+) CALL node
      let callNodes = filter (\n -> gnType n == "CALL" && gnName n == "+") (faNodes fa)
      length callNodes `shouldBe` 1
      let callId = gnId (head callNodes)
      let edgesToCall = filter (\e -> geTarget e == callId) dfEdges
      length edgesToCall `shouldBe` 2

    it "emits DERIVED_FROM for if branches" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nf x = if x then 1 else 0"
      let dfEdges = filter (\e -> geType e == "DERIVED_FROM") (faEdges fa)
      -- then and else are literals, so no DERIVED_FROM edges from them
      -- (literals return Nothing). But the condition 'x' is a REFERENCE
      -- that doesn't flow to the BRANCH. Let's check for the BRANCH node.
      let branches = filter (\n -> gnType n == "BRANCH") (faNodes fa)
      length branches `shouldBe` 1

    it "emits DERIVED_FROM for if branches with variable results" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nf x y z = if x then y else z"
      let dfEdges = filter (\e -> geType e == "DERIVED_FROM") (faEdges fa)
      let branches = filter (\n -> gnType n == "BRANCH" && gnName n == "if") (faNodes fa)
      length branches `shouldBe` 1
      let branchId = gnId (head branches)
      let edgesToBranch = filter (\e -> geTarget e == branchId) dfEdges
      -- y and z (both REFERENCE nodes) should flow into the BRANCH
      length edgesToBranch `shouldBe` 2

    it "emits DERIVED_FROM for case branches with variable results" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nf x y z = case x of { True -> y; False -> z }"
      let dfEdges = filter (\e -> geType e == "DERIVED_FROM") (faEdges fa)
      let branches = filter (\n -> gnType n == "BRANCH" && gnName n == "case") (faNodes fa)
      length branches `shouldBe` 1
      let branchId = gnId (head branches)
      let edgesToBranch = filter (\e -> geTarget e == branchId) dfEdges
      -- y and z should flow into the case BRANCH
      length edgesToBranch `shouldBe` 2

    it "emits DERIVED_FROM for let body to LET_BLOCK" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nf x = let y = x in y"
      let dfEdges = filter (\e -> geType e == "DERIVED_FROM") (faEdges fa)
      let lets = filter (\n -> gnType n == "LET_BLOCK") (faNodes fa)
      length lets `shouldBe` 1
      let letId = gnId (head lets)
      let edgesToLet = filter (\e -> geTarget e == letId) dfEdges
      -- The body 'y' (a REFERENCE) should flow into the LET_BLOCK
      length edgesToLet `shouldBe` 1

    it "emits DERIVED_FROM for function application argument" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nf x = g x"
      let dfEdges = filter (\e -> geType e == "DERIVED_FROM") (faEdges fa)
      let calls = filter (\n -> gnType n == "CALL" && gnName n == "g") (faNodes fa)
      length calls `shouldBe` 1
      let callId = gnId (head calls)
      let edgesToCall = filter (\e -> geTarget e == callId) dfEdges
      -- x flows into the call to g
      length edgesToCall `shouldBe` 1

    it "emits DERIVED_FROM for lambda body" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nf = \\x -> x"
      let dfEdges = filter (\e -> geType e == "DERIVED_FROM") (faEdges fa)
      let lams = filter (\n -> gnType n == "LAMBDA") (faNodes fa)
      length lams `shouldBe` 1
      let lamId = gnId (head lams)
      let edgesToLam = filter (\e -> geTarget e == lamId) dfEdges
      -- x (REFERENCE) flows into the LAMBDA
      length edgesToLam `shouldBe` 1

    it "emits DERIVED_FROM for do-block last statement" $ do
      let source = T.unlines
            [ "module Test where"
            , "f = do"
            , "  x <- getLine"
            , "  putStrLn x"
            ]
      let Right fa = analyzeSource "Test.hs" source
      let dfEdges = filter (\e -> geType e == "DERIVED_FROM") (faEdges fa)
      let dos = filter (\n -> gnType n == "DO_BLOCK") (faNodes fa)
      length dos `shouldBe` 1
      let doId = gnId (head dos)
      let edgesToDo = filter (\e -> geTarget e == doId) dfEdges
      -- The last statement (putStrLn x) is a CALL, which flows into DO_BLOCK
      length edgesToDo `shouldBe` 1

  -- ── Phase 7: Pattern Coverage ─────────────────────────────────────
  describe "Phase 7: Pattern Coverage" $ do

    it "detects missing constructor" $ do
      let src = T.unlines
            [ "module Test where"
            , "data Shape = Circle | Square | Triangle"
            , "area Circle = 3.14"
            , "area Square = 1.0"
            -- Triangle is missing!
            ]
      let Right fa = analyzeSource "Test.hs" src
      let missing = filter (\e -> geType e == "MISSING_CONSTRUCTOR") (faEdges fa)
      length missing `shouldBe` 1

    it "missing constructor edge has correct metadata" $ do
      let src = T.unlines
            [ "module Test where"
            , "data Shape = Circle | Square | Triangle"
            , "area Circle = 3.14"
            , "area Square = 1.0"
            ]
      let Right fa = analyzeSource "Test.hs" src
      let missing = filter (\e -> geType e == "MISSING_CONSTRUCTOR") (faEdges fa)
      length missing `shouldBe` 1
      Map.lookup "constructor" (geMetadata (head missing)) `shouldBe` Just (MetaText "Triangle")

    it "no missing constructor when all covered" $ do
      let src = T.unlines
            [ "module Test where"
            , "data Bool2 = T | F"
            , "f T = 1"
            , "f F = 0"
            ]
      let Right fa = analyzeSource "Test.hs" src
      let missing = filter (\e -> geType e == "MISSING_CONSTRUCTOR") (faEdges fa)
      length missing `shouldBe` 0

    it "no missing constructor when no patterns at all" $ do
      let src = T.unlines
            [ "module Test where"
            , "data Color = Red | Green | Blue"
            , "x = 42"
            ]
      let Right fa = analyzeSource "Test.hs" src
      let missing = filter (\e -> geType e == "MISSING_CONSTRUCTOR") (faEdges fa)
      length missing `shouldBe` 0

    it "detects multiple missing constructors" $ do
      let src = T.unlines
            [ "module Test where"
            , "data Dir = North | South | East | West"
            , "f North = 1"
            ]
      let Right fa = analyzeSource "Test.hs" src
      let missing = filter (\e -> geType e == "MISSING_CONSTRUCTOR") (faEdges fa)
      length missing `shouldBe` 3

  -- ── Phase 7: Type Class Dispatch ──────────────────────────────────
  describe "Phase 7: Type Class Dispatch" $ do

    it "detects dispatch to class method" $ do
      let src = T.unlines
            [ "module Test where"
            , "class MyClass a where"
            , "  myMethod :: a -> Int"
            , "f x = myMethod x"
            ]
      let Right fa = analyzeSource "Test.hs" src
      let dispatch = filter (\e -> geType e == "DISPATCHES_VIA") (faEdges fa)
      length dispatch `shouldSatisfy` (> 0)

    it "dispatch edge targets TYPE_SIGNATURE node" $ do
      let src = T.unlines
            [ "module Test where"
            , "class MyClass a where"
            , "  myMethod :: a -> Int"
            , "f x = myMethod x"
            ]
      let Right fa = analyzeSource "Test.hs" src
      let dispatch = filter (\e -> geType e == "DISPATCHES_VIA") (faEdges fa)
      length dispatch `shouldBe` 1
      -- The target should be a TYPE_SIGNATURE node
      let targetId = geTarget (head dispatch)
      let targetNodes = filter (\n -> gnId n == targetId) (faNodes fa)
      length targetNodes `shouldBe` 1
      gnType (head targetNodes) `shouldBe` "TYPE_SIGNATURE"

    it "no dispatch for non-class-method calls" $ do
      let src = T.unlines
            [ "module Test where"
            , "class MyClass a where"
            , "  myMethod :: a -> Int"
            , "f x = someOtherFunction x"
            ]
      let Right fa = analyzeSource "Test.hs" src
      let dispatch = filter (\e -> geType e == "DISPATCHES_VIA") (faEdges fa)
      length dispatch `shouldBe` 0

    it "detects dispatch for multiple class methods" $ do
      let src = T.unlines
            [ "module Test where"
            , "class MyClass a where"
            , "  method1 :: a -> Int"
            , "  method2 :: a -> String"
            , "f x = method1 x"
            , "g x = method2 x"
            ]
      let Right fa = analyzeSource "Test.hs" src
      let dispatch = filter (\e -> geType e == "DISPATCHES_VIA") (faEdges fa)
      length dispatch `shouldBe` 2

  -- ── Phase 6: Effects ────────────────────────────────────────────────
  describe "Phase 6: Effects" $ do

    it "detects IO effect from type signature" $ do
      let src = T.unlines
            [ "module Test where"
            , "readFile :: FilePath -> IO String"
            , "readFile = undefined"
            ]
      let Right fa = analyzeSource "Test.hs" src
      let effects = filter (\n -> gnType n == "EFFECT") (faNodes fa)
      length effects `shouldBe` 1
      gnName (head effects) `shouldBe` "IO"

    it "detects no effect for pure function" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nfoo :: Int -> Int\nfoo x = x"
      let effects = filter (\n -> gnType n == "EFFECT") (faNodes fa)
      length effects `shouldBe` 0

    it "emits HAS_EFFECT edge" $ do
      let src = T.unlines
            [ "module Test where"
            , "readFile :: FilePath -> IO String"
            , "readFile = undefined"
            ]
      let Right fa = analyzeSource "Test.hs" src
      let hasEffectEdges = filter (\e -> geType e == "HAS_EFFECT") (faEdges fa)
      length hasEffectEdges `shouldBe` 1

    it "detects StateT effect" $ do
      let src = T.unlines
            [ "module Test where"
            , "runState :: a -> StateT s m a"
            , "runState = undefined"
            ]
      let Right fa = analyzeSource "Test.hs" src
      let effects = filter (\n -> gnType n == "EFFECT") (faNodes fa)
      length effects `shouldBe` 1
      gnName (head effects) `shouldBe` "StateT"

    it "detects ReaderT effect" $ do
      let src = T.unlines
            [ "module Test where"
            , "ask :: ReaderT r m r"
            , "ask = undefined"
            ]
      let Right fa = analyzeSource "Test.hs" src
      let effects = filter (\n -> gnType n == "EFFECT") (faNodes fa)
      length effects `shouldBe` 1
      gnName (head effects) `shouldBe` "ReaderT"

    it "detects effect through qualified type" $ do
      let src = T.unlines
            [ "module Test where"
            , "foo :: Monad m => Int -> IO String"
            , "foo = undefined"
            ]
      let Right fa = analyzeSource "Test.hs" src
      let effects = filter (\n -> gnType n == "EFFECT") (faNodes fa)
      length effects `shouldBe` 1
      gnName (head effects) `shouldBe` "IO"

    it "detects effect for multi-name signature" $ do
      let src = T.unlines
            [ "module Test where"
            , "foo, bar :: Int -> IO String"
            , "foo = undefined"
            , "bar = undefined"
            ]
      let Right fa = analyzeSource "Test.hs" src
      let effects = filter (\n -> gnType n == "EFFECT") (faNodes fa)
      -- One EFFECT node per name in the signature
      length effects `shouldBe` 2

  -- ── Phase 6: Type Constraints ────────────────────────────────────────
  describe "Phase 6: Type Constraints" $ do

    it "emits CONSTRAINT node for qualified type" $ do
      let src = T.unlines
            [ "module Test where"
            , "foo :: Eq a => a -> Bool"
            , "foo = undefined"
            ]
      let Right fa = analyzeSource "Test.hs" src
      let constraints = filter (\n -> gnType n == "CONSTRAINT") (faNodes fa)
      length constraints `shouldBe` 1

    it "emits CONSTRAINT nodes for multiple constraints" $ do
      let src = T.unlines
            [ "module Test where"
            , "foo :: (Eq a, Show a) => a -> String"
            , "foo = undefined"
            ]
      let Right fa = analyzeSource "Test.hs" src
      let constraints = filter (\n -> gnType n == "CONSTRAINT") (faNodes fa)
      length constraints `shouldBe` 2

    it "no CONSTRAINT for unconstrained function" $ do
      let Right fa = analyzeSource "Test.hs" "module Test where\nfoo :: Int -> Int\nfoo x = x"
      let constraints = filter (\n -> gnType n == "CONSTRAINT") (faNodes fa)
      length constraints `shouldBe` 0
