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

-- -- Test helpers ----------------------------------------------------------

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

-- -- Tests ----------------------------------------------------------------

main :: IO ()
main = hspec $ do

  -- -- ImportResolution ----------------------------------------------------

  describe "ImportResolution" $ do

    it "resolves 'from foo import bar' via name index" $ do
      let moduleNode = mkNode
            "utils.py->MODULE->utils.py" "MODULE" "utils.py" "mypackage/utils.py"
          funcNode = mkNode
            "utils.py->FUNCTION->helper" "FUNCTION" "helper" "mypackage/utils.py"
          bindingNode = mkNodeMeta
            "main.py->IMPORT_BINDING->helper[h:x]" "IMPORT_BINDING" "helper" "main.py"
            [ ("source_module", MetaText "mypackage.utils")
            , ("imported_name", MetaText "helper")
            ]
          nodes = [moduleNode, funcNode, bindingNode]
      cmds <- ImportResolution.resolveAll nodes
      let imports = findEdgesOfType "IMPORTS_FROM" cmds
      length imports `shouldBe` 1
      geTarget (head imports) `shouldBe` "utils.py->FUNCTION->helper"

    it "resolves 'from foo import bar' as submodule import" $ do
      let parentModule = mkNode
            "pkg/__init__.py->MODULE->pkg/__init__.py" "MODULE" "pkg/__init__.py" "pkg/__init__.py"
          childModule = mkNode
            "pkg/sub.py->MODULE->pkg/sub.py" "MODULE" "pkg/sub.py" "pkg/sub.py"
          bindingNode = mkNodeMeta
            "main.py->IMPORT_BINDING->sub[h:x]" "IMPORT_BINDING" "sub" "main.py"
            [("source_module", MetaText "pkg")]
          nodes = [parentModule, childModule, bindingNode]
      cmds <- ImportResolution.resolveAll nodes
      let imports = findEdgesOfType "IMPORTS_FROM" cmds
      length imports `shouldBe` 1
      geTarget (head imports) `shouldBe` "pkg/sub.py->MODULE->pkg/sub.py"

    it "resolves 'import foo' as module import" $ do
      let moduleNode = mkNode
            "mypackage/__init__.py->MODULE->mypackage/__init__.py" "MODULE" "mypackage/__init__.py" "mypackage/__init__.py"
          bindingNode = mkNode
            "main.py->IMPORT_BINDING->mypackage[h:x]" "IMPORT_BINDING" "mypackage" "main.py"
          nodes = [moduleNode, bindingNode]
      cmds <- ImportResolution.resolveAll nodes
      let imports = findEdgesOfType "IMPORTS_FROM" cmds
      length imports `shouldBe` 1

    it "produces no edges for unresolvable import" $ do
      let bindingNode = mkNodeMeta
            "main.py->IMPORT_BINDING->Unknown[h:x]" "IMPORT_BINDING" "Unknown" "main.py"
            [("source_module", MetaText "nonexistent.module")]
          nodes = [bindingNode]
      cmds <- ImportResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

  -- -- TypeResolution ------------------------------------------------------

  describe "TypeResolution" $ do

    it "resolves return_annotation to TYPE_OF edge" $ do
      let fn = mkNodeMeta
            "f1.py->FUNCTION->get_user[in:Service,h:x]" "FUNCTION" "get_user" "f1.py"
            [("return_annotation", MetaText "User")]
          cls = mkNode
            "f2.py->CLASS->User" "CLASS" "User" "f2.py"
          nodes = [fn, cls]
      cmds <- TypeResolution.resolveAll nodes
      let typeOf = findEdgesOfType "TYPE_OF" cmds
      length typeOf `shouldBe` 1
      geSource (head typeOf) `shouldBe` "f1.py->FUNCTION->get_user[in:Service,h:x]"
      geTarget (head typeOf) `shouldBe` "f2.py->CLASS->User"

    it "resolves VARIABLE annotation to TYPE_OF edge" $ do
      let var = mkNodeMeta
            "f1.py->VARIABLE->users[in:Service,h:x]" "VARIABLE" "users" "f1.py"
            [("annotation", MetaText "UserList")]
          cls = mkNode
            "f2.py->CLASS->UserList" "CLASS" "UserList" "f2.py"
          nodes = [var, cls]
      cmds <- TypeResolution.resolveAll nodes
      let typeOf = findEdgesOfType "TYPE_OF" cmds
      length typeOf `shouldBe` 1

    it "resolves PARAMETER annotation to TYPE_OF edge" $ do
      let param = mkNodeMeta
            "f1.py->PARAMETER->user[in:process,h:x]" "PARAMETER" "user" "f1.py"
            [("annotation", MetaText "User")]
          cls = mkNode
            "f2.py->CLASS->User" "CLASS" "User" "f2.py"
          nodes = [param, cls]
      cmds <- TypeResolution.resolveAll nodes
      let typeOf = findEdgesOfType "TYPE_OF" cmds
      length typeOf `shouldBe` 1

    it "resolves EXTENDS from bases metadata" $ do
      let child = mkNodeMeta
            "f1.py->CLASS->Admin" "CLASS" "Admin" "f1.py"
            [("bases", MetaText "User")]
          parent = mkNode
            "f2.py->CLASS->User" "CLASS" "User" "f2.py"
          nodes = [child, parent]
      cmds <- TypeResolution.resolveAll nodes
      let extends = findEdgesOfType "EXTENDS" cmds
      length extends `shouldBe` 1
      geSource (head extends) `shouldBe` "f1.py->CLASS->Admin"
      geTarget (head extends) `shouldBe` "f2.py->CLASS->User"

    it "resolves multiple base classes" $ do
      let child = mkNodeMeta
            "f1.py->CLASS->Admin" "CLASS" "Admin" "f1.py"
            [("bases", MetaText "User,Auditable")]
          parent1 = mkNode
            "f2.py->CLASS->User" "CLASS" "User" "f2.py"
          parent2 = mkNode
            "f3.py->CLASS->Auditable" "CLASS" "Auditable" "f3.py"
          nodes = [child, parent1, parent2]
      cmds <- TypeResolution.resolveAll nodes
      countEdgeType "EXTENDS" cmds `shouldBe` 2

    it "skips built-in type annotations" $ do
      let fn = mkNodeMeta
            "f1.py->FUNCTION->get_name[h:x]" "FUNCTION" "get_name" "f1.py"
            [("return_annotation", MetaText "str")]
          nodes = [fn]
      cmds <- TypeResolution.resolveAll nodes
      countEdgeType "TYPE_OF" cmds `shouldBe` 0

    it "strips generic wrapper for type lookup" $ do
      let fn = mkNodeMeta
            "f1.py->FUNCTION->get_users[h:x]" "FUNCTION" "get_users" "f1.py"
            [("return_annotation", MetaText "Optional[User]")]
          cls = mkNode
            "f2.py->CLASS->Optional" "CLASS" "Optional" "f2.py"
          nodes = [fn, cls]
      cmds <- TypeResolution.resolveAll nodes
      -- Should resolve to Optional (the wrapper), since that's what stripGeneric extracts
      countEdgeType "TYPE_OF" cmds `shouldBe` 1

  -- -- CallResolution ------------------------------------------------------

  describe "CallResolution" $ do

    it "resolves same-file function call" $ do
      let call = mkNode
            "f1.py->CALL->helper[h:x]" "CALL" "helper" "f1.py"
          func = mkNode
            "f1.py->FUNCTION->helper[h:y]" "FUNCTION" "helper" "f1.py"
          nodes = [call, func]
      cmds <- CallResolution.resolveAll nodes
      countEdgeType "CALLS" cmds `shouldBe` 1

    it "resolves method call via method index" $ do
      let call = mkNodeMeta
            "f1.py->CALL->save[h:x]" "CALL" "save" "f1.py"
            [("receiver", MetaText "user")]
          method = mkNodeMeta
            "f2.py->FUNCTION->save[in:User,h:y]" "FUNCTION" "save" "f2.py"
            [("kind", MetaText "method")]
          nodes = [call, method]
      cmds <- CallResolution.resolveAll nodes
      countEdgeType "CALLS" cmds `shouldBe` 1

    it "resolves cross-file function call" $ do
      let call = mkNode
            "f1.py->CALL->process[h:x]" "CALL" "process" "f1.py"
          func = mkNode
            "f2.py->FUNCTION->process[h:y]" "FUNCTION" "process" "f2.py"
          nodes = [call, func]
      cmds <- CallResolution.resolveAll nodes
      countEdgeType "CALLS" cmds `shouldBe` 1

    it "does not resolve call with no matching function" $ do
      let call = mkNode
            "f1.py->CALL->unknown_func[h:x]" "CALL" "unknown_func" "f1.py"
          nodes = [call]
      cmds <- CallResolution.resolveAll nodes
      edgesOf cmds `shouldBe` []

    it "prefers same-file function over cross-file" $ do
      let call = mkNode
            "f1.py->CALL->helper[h:x]" "CALL" "helper" "f1.py"
          localFunc = mkNode
            "f1.py->FUNCTION->helper[h:y]" "FUNCTION" "helper" "f1.py"
          remoteFunc = mkNode
            "f2.py->FUNCTION->helper[h:z]" "FUNCTION" "helper" "f2.py"
          nodes = [call, localFunc, remoteFunc]
      cmds <- CallResolution.resolveAll nodes
      let edges = findEdgesOfType "CALLS" cmds
      length edges `shouldBe` 1
      geTarget (head edges) `shouldBe` "f1.py->FUNCTION->helper[h:y]"

  -- -- Edge integrity ------------------------------------------------------

  describe "Edge integrity" $ do

    it "never produces edges with empty source or target" $ do
      let cls = mkNodeMeta
            "f1.py->CLASS->Foo" "CLASS" "Foo" "f1.py"
            [("bases", MetaText "Bar")]
          nodes = [cls]
      cmds <- TypeResolution.resolveAll nodes
      let badEdges = [ e | EmitEdge e <- cmds
                         , geSource e == "" || geTarget e == "" ]
      badEdges `shouldBe` []
