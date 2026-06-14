{-# LANGUAGE OverloadedStrings #-}
-- | Analyzer tests focused on lexical SCOPE / HAS_SCOPE emission and the
-- CONTAINS re-sourcing that comes with it (W23: python scope-walk parity
-- with js-analyzer/src/Analysis/Scope.hs).
--
-- These are the first real unit tests for python-analyzer: the suite was a
-- single "pending" placeholder before. They pin the structural-graph
-- guarantees the resolvers rely on (node IDs + [in:..] payload byte-stable;
-- SCOPE/HAS_SCOPE additive; CONTAINS re-sourced onto :scope).
module Main (main) where

import Test.Hspec
import Data.Text (Text)
import qualified Data.Map.Strict as Map

import PythonAST
import Analysis.Context (runAnalyzer)
import Analysis.Walker (walkFile)
import Analysis.Types
  ( FileAnalysis(..), GraphNode(..), GraphEdge(..) )

-- ── Fixture helpers ──────────────────────────────────────────────────

sp :: Span
sp = Span (Pos 1 0) (Pos 1 0)

noArgs :: PythonArguments
noArgs = PythonArguments [] [] Nothing [] [] Nothing []

fn :: Text -> [PythonStmt] -> PythonStmt
fn name body = FunctionDef name noArgs body [] Nothing False sp

cls :: Text -> [PythonStmt] -> PythonStmt
cls name body = ClassDef name [] [] body [] sp

modul :: [PythonStmt] -> PythonModule
modul = PythonModule

analyze :: PythonModule -> FileAnalysis
analyze = runAnalyzer "test.py" "test.py" . walkFile

edgesOf :: Text -> FileAnalysis -> [(Text, Text)]
edgesOf ty fa = [ (geSource e, geTarget e) | e <- faEdges fa, geType e == ty ]

nodeIdsOfType :: Text -> FileAnalysis -> [Text]
nodeIdsOfType ty fa = [ gnId n | n <- faNodes fa, gnType n == ty ]

-- ── Spec ─────────────────────────────────────────────────────────────

main :: IO ()
main = hspec $ do
  describe "lexical SCOPE emission (mirror of js Scope.hs)" $ do

    it "emits a SCOPE node id = ownerId<>\":scope\" for a top-level function" $ do
      let fa = analyze (modul [fn "foo" []])
          fnId = "test.py->FUNCTION->foo"
      nodeIdsOfType "SCOPE" fa `shouldContain` [fnId <> ":scope"]

    it "emits HAS_SCOPE from the owner FUNCTION to its body scope" $ do
      let fa = analyze (modul [fn "foo" []])
          fnId = "test.py->FUNCTION->foo"
      edgesOf "HAS_SCOPE" fa `shouldContain` [(fnId, fnId <> ":scope")]

    it "emits a SCOPE node + HAS_SCOPE for a class body" $ do
      let fa = analyze (modul [cls "C" []])
          clsId = "test.py->CLASS->C"
      nodeIdsOfType "SCOPE" fa `shouldContain` [clsId <> ":scope"]
      edgesOf "HAS_SCOPE" fa `shouldContain` [(clsId, clsId <> ":scope")]

  describe "CONTAINS re-sourcing onto the :scope node" $ do

    it "re-sources a method's CONTAINS from CLASS to CLASS:scope" $ do
      -- class C: def m(self): ...   ->  C -HAS_SCOPE-> C:scope -CONTAINS-> m
      let fa = analyze (modul [cls "C" [fn "m" []]])
          clsId = "test.py->CLASS->C"
          mId   = "test.py->FUNCTION->m[in:C]"
      edgesOf "CONTAINS" fa `shouldContain` [(clsId <> ":scope", mId)]
      edgesOf "CONTAINS" fa `shouldNotContain` [(clsId, mId)]

    it "keeps top-level binders MODULE-contained (no module :scope node)" $ do
      let fa = analyze (modul [fn "foo" []])
          modId = "test.py"
          fnId  = "test.py->FUNCTION->foo"
      edgesOf "CONTAINS" fa `shouldContain` [(modId, fnId)]
      nodeIdsOfType "SCOPE" fa `shouldNotContain` [modId <> ":scope"]

  describe "lexical chain links (module -> function -> nested)" $ do

    it "nests an inner def under the enclosing function's scope via re-sourced CONTAINS" $ do
      -- def outer(): def inner(): ...
      let fa = analyze (modul [fn "outer" [fn "inner" []]])
          outerId = "test.py->FUNCTION->outer"
          innerId = "test.py->FUNCTION->inner[in:outer]"
      edgesOf "CONTAINS" fa `shouldContain` [(outerId <> ":scope", innerId)]
      edgesOf "HAS_SCOPE" fa `shouldContain` [(innerId, innerId <> ":scope")]

  describe "ID stability (flat resolver must keep passing)" $ do

    it "leaves the method semantic-id [in:ClassName] payload byte-stable" $ do
      let fa = analyze (modul [cls "C" [fn "m" []]])
      nodeIdsOfType "FUNCTION" fa `shouldContain` ["test.py->FUNCTION->m[in:C]"]

    it "does not mutate the FUNCTION/CLASS owner node ids" $ do
      let fa = analyze (modul [cls "C" [fn "m" []], fn "foo" []])
      nodeIdsOfType "CLASS" fa `shouldContain` ["test.py->CLASS->C"]
      nodeIdsOfType "FUNCTION" fa `shouldContain` ["test.py->FUNCTION->foo"]

    it "SCOPE node carries a kind metadatum" $ do
      let fa = analyze (modul [fn "foo" []])
          scopeNodes = [ n | n <- faNodes fa, gnType n == "SCOPE" ]
      scopeNodes `shouldSatisfy` (not . null)
      all (Map.member "kind" . gnMetadata) scopeNodes `shouldBe` True
