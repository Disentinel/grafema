{-# LANGUAGE OverloadedStrings #-}
module Main where

import Test.Hspec
import qualified Data.Map.Strict as Map
import Data.Text (Text)

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..))
import qualified GoImportResolution
import qualified GoCallResolution
import qualified GoInterfaceSatisfaction
import qualified GoContextPropagation

-- | Create a minimal test node.
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
  , gnExported  = True
  , gnMetadata  = Map.empty
  }

-- | Create a node with metadata.
mkNodeMeta :: Text -> Text -> Text -> Text -> [(Text, MetaValue)] -> GraphNode
mkNodeMeta nid ntype name file meta = (mkNode nid ntype name file)
  { gnMetadata = Map.fromList meta }

-- | Extract edges from plugin commands.
edgesOf :: [PluginCommand] -> [GraphEdge]
edgesOf = concatMap go
  where go (EmitEdge e) = [e]
        go _            = []

-- | Count edges of a specific type.
countEdgeType :: Text -> [PluginCommand] -> Int
countEdgeType t = length . filter (\e -> geType e == t) . edgesOf

main :: IO ()
main = hspec $ do

  -- ── GoImportResolution ─────────────────────────────────────────────────

  describe "GoImportResolution" $ do

    it "same-module import resolves to MODULE in target directory" $ do
      let modNode = mkNode "mod:pkg/auth" "MODULE" "auth" "pkg/auth/auth.go"
          importNode = mkNodeMeta "imp:auth" "IMPORT" "github.com/user/project/pkg/auth" "cmd/main.go"
            [("path", MetaText "github.com/user/project/pkg/auth"), ("local_name", MetaText "auth")]
          result = GoImportResolution.resolveAll [modNode, importNode] "github.com/user/project"
      countEdgeType "IMPORTS_FROM" result `shouldBe` 1
      let [EmitEdge e] = result
      geSource e `shouldBe` "imp:auth"
      geTarget e `shouldBe` "mod:pkg/auth"

    it "standard library import produces no edges" $ do
      let importNode = mkNodeMeta "imp:fmt" "IMPORT" "fmt" "main.go"
            [("path", MetaText "fmt"), ("local_name", MetaText "fmt")]
      GoImportResolution.resolveAll [importNode] "github.com/user/project" `shouldBe` []

    it "third-party import produces no edges" $ do
      let importNode = mkNodeMeta "imp:logrus" "IMPORT" "github.com/sirupsen/logrus" "main.go"
            [("path", MetaText "github.com/sirupsen/logrus"), ("local_name", MetaText "logrus")]
      GoImportResolution.resolveAll [importNode] "github.com/user/project" `shouldBe` []

    it "multiple files in target package resolves to first MODULE" $ do
      let mod1 = mkNode "mod:pkg/a1" "MODULE" "pkg" "pkg/a.go"
          mod2 = mkNode "mod:pkg/a2" "MODULE" "pkg" "pkg/b.go"
          importNode = mkNodeMeta "imp:pkg" "IMPORT" "github.com/user/project/pkg" "main.go"
            [("path", MetaText "github.com/user/project/pkg"), ("local_name", MetaText "pkg")]
          result = GoImportResolution.resolveAll [mod1, mod2, importNode] "github.com/user/project"
      countEdgeType "IMPORTS_FROM" result `shouldBe` 1

    it "empty module path uses fallback directory matching" $ do
      let modNode = mkNode "mod:auth" "MODULE" "auth" "pkg/auth/auth.go"
          importNode = mkNodeMeta "imp:auth" "IMPORT" "example.com/pkg/auth" "main.go"
            [("path", MetaText "example.com/pkg/auth"), ("local_name", MetaText "auth")]
          result = GoImportResolution.resolveAll [modNode, importNode] ""
      countEdgeType "IMPORTS_FROM" result `shouldBe` 1

    it "blank/dot import still resolves" $ do
      let modNode = mkNode "mod:effects" "MODULE" "effects" "internal/effects/effects.go"
          importNode = mkNodeMeta "imp:effects" "IMPORT" "github.com/user/project/internal/effects" "main.go"
            [("path", MetaText "github.com/user/project/internal/effects"), ("local_name", MetaText "effects"), ("blank", MetaBool True)]
          result = GoImportResolution.resolveAll [modNode, importNode] "github.com/user/project"
      countEdgeType "IMPORTS_FROM" result `shouldBe` 1

  -- ── GoCallResolution ───────────────────────────────────────────────────

  describe "GoCallResolution" $ do

    it "package-qualified call resolves via import alias" $ do
      let modNode = mkNode "mod:pkg/utils" "MODULE" "utils" "pkg/utils/utils.go"
          funcNode = mkNodeMeta "fn:DoStuff" "FUNCTION" "DoStuff" "pkg/utils/utils.go"
            [("kind", MetaText "function")]
          importNode = mkNodeMeta "imp:utils" "IMPORT" "github.com/user/project/pkg/utils" "cmd/main.go"
            [("path", MetaText "github.com/user/project/pkg/utils"), ("local_name", MetaText "utils")]
          callNode = mkNodeMeta "call:utils.DoStuff" "CALL" "utils.DoStuff" "cmd/main.go"
            [("receiver", MetaText "utils")]
          nodes = [modNode, funcNode, importNode, callNode]
          result = GoCallResolution.resolveAll nodes "github.com/user/project"
      countEdgeType "CALLS" result `shouldBe` 1
      let [EmitEdge e] = result
      geSource e `shouldBe` "call:utils.DoStuff"
      geTarget e `shouldBe` "fn:DoStuff"

    it "same-package function call resolves" $ do
      let funcNode = mkNodeMeta "fn:helper" "FUNCTION" "helper" "pkg/main.go"
            [("kind", MetaText "function")]
          callNode = mkNode "call:helper" "CALL" "helper" "pkg/main.go"
          result = GoCallResolution.resolveAll [funcNode, callNode] "github.com/user/project"
      countEdgeType "CALLS" result `shouldBe` 1

    it "method call with known receiver type resolves" $ do
      let methodNode = mkNodeMeta "fn:Server.Start" "FUNCTION" "Start" "pkg/server.go"
            [("kind", MetaText "method"), ("receiver", MetaText "Server")]
          callNode = mkNodeMeta "call:s.Start" "CALL" "s.Start" "pkg/main.go"
            [("receiver", MetaText "Server")]
          result = GoCallResolution.resolveAll [methodNode, callNode] ""
      countEdgeType "CALLS" result `shouldBe` 1

    it "call with unknown receiver is skipped" $ do
      let callNode = mkNodeMeta "call:x.Unknown" "CALL" "x.Unknown" "main.go"
            [("receiver", MetaText "x")]
          result = GoCallResolution.resolveAll [callNode] ""
      result `shouldBe` []

    it "call to unexported function in another package is skipped" $ do
      let funcNode = mkNodeMeta "fn:helper" "FUNCTION" "helper" "pkg/internal.go"
            [("kind", MetaText "function")]
          callNode = mkNode "call:helper" "CALL" "helper" "cmd/main.go"
          result = GoCallResolution.resolveAll [funcNode, callNode] ""
      result `shouldBe` []

    it "closure call is skipped" $ do
      let closureNode = mkNodeMeta "fn:closure" "FUNCTION" "<closure>" "main.go"
            [("kind", MetaText "closure")]
          callNode = mkNode "call:closure" "CALL" "<closure>" "main.go"
          result = GoCallResolution.resolveAll [closureNode, callNode] ""
      result `shouldBe` []

  -- ── GoInterfaceSatisfaction ────────────────────────────────────────────

  describe "GoInterfaceSatisfaction" $ do

    it "struct with all interface methods emits IMPLEMENTS edge" $ do
      let ifaceNode = mkNode "iface:Reader" "INTERFACE" "Reader" "io.go"
          ifaceMethod = mkNodeMeta "fn:Reader.Read[in:Reader]" "FUNCTION" "Read" "io.go"
            [("kind", MetaText "interface_method")]
          structNode = mkNodeMeta "class:MyReader" "CLASS" "MyReader" "reader.go"
            [("kind", MetaText "struct")]
          structMethod = mkNodeMeta "fn:MyReader.Read" "FUNCTION" "Read" "reader.go"
            [("kind", MetaText "method"), ("receiver", MetaText "MyReader")]
          result = GoInterfaceSatisfaction.resolveAll [ifaceNode, ifaceMethod, structNode, structMethod]
      countEdgeType "IMPLEMENTS" result `shouldBe` 1
      let [EmitEdge e] = result
      geSource e `shouldBe` "class:MyReader"
      geTarget e `shouldBe` "iface:Reader"

    it "struct missing one method produces no edge" $ do
      let ifaceNode = mkNode "iface:ReadWriter" "INTERFACE" "ReadWriter" "io.go"
          ifaceM1 = mkNodeMeta "fn:ReadWriter.Read[in:ReadWriter]" "FUNCTION" "Read" "io.go"
            [("kind", MetaText "interface_method")]
          ifaceM2 = mkNodeMeta "fn:ReadWriter.Write[in:ReadWriter]" "FUNCTION" "Write" "io.go"
            [("kind", MetaText "interface_method")]
          structNode = mkNodeMeta "class:OnlyReader" "CLASS" "OnlyReader" "r.go"
            [("kind", MetaText "struct")]
          structMethod = mkNodeMeta "fn:OnlyReader.Read" "FUNCTION" "Read" "r.go"
            [("kind", MetaText "method"), ("receiver", MetaText "OnlyReader")]
          result = GoInterfaceSatisfaction.resolveAll [ifaceNode, ifaceM1, ifaceM2, structNode, structMethod]
      result `shouldBe` []

    it "empty interface produces no edges" $ do
      let ifaceNode = mkNode "iface:Empty" "INTERFACE" "Empty" "types.go"
          structNode = mkNodeMeta "class:Anything" "CLASS" "Anything" "impl.go"
            [("kind", MetaText "struct")]
          result = GoInterfaceSatisfaction.resolveAll [ifaceNode, structNode]
      result `shouldBe` []

    it "multiple structs implementing same interface produce separate edges" $ do
      let ifaceNode = mkNode "iface:Stringer" "INTERFACE" "Stringer" "fmt.go"
          ifaceMethod = mkNodeMeta "fn:Stringer.String[in:Stringer]" "FUNCTION" "String" "fmt.go"
            [("kind", MetaText "interface_method")]
          struct1 = mkNodeMeta "class:Person" "CLASS" "Person" "person.go"
            [("kind", MetaText "struct")]
          method1 = mkNodeMeta "fn:Person.String" "FUNCTION" "String" "person.go"
            [("kind", MetaText "method"), ("receiver", MetaText "Person")]
          struct2 = mkNodeMeta "class:Animal" "CLASS" "Animal" "animal.go"
            [("kind", MetaText "struct")]
          method2 = mkNodeMeta "fn:Animal.String" "FUNCTION" "String" "animal.go"
            [("kind", MetaText "method"), ("receiver", MetaText "Animal")]
          result = GoInterfaceSatisfaction.resolveAll [ifaceNode, ifaceMethod, struct1, method1, struct2, method2]
      countEdgeType "IMPLEMENTS" result `shouldBe` 2

    it "pointer receiver vs value receiver both match" $ do
      let ifaceNode = mkNode "iface:Writer" "INTERFACE" "Writer" "io.go"
          ifaceMethod = mkNodeMeta "fn:Writer.Write[in:Writer]" "FUNCTION" "Write" "io.go"
            [("kind", MetaText "interface_method")]
          structNode = mkNodeMeta "class:Buffer" "CLASS" "Buffer" "buf.go"
            [("kind", MetaText "struct")]
          ptrMethod = mkNodeMeta "fn:Buffer.Write" "FUNCTION" "Write" "buf.go"
            [("kind", MetaText "method"), ("receiver", MetaText "Buffer"), ("pointer_receiver", MetaBool True)]
          result = GoInterfaceSatisfaction.resolveAll [ifaceNode, ifaceMethod, structNode, ptrMethod]
      countEdgeType "IMPLEMENTS" result `shouldBe` 1

  -- ── GoContextPropagation ────────────────────────────────────────────────

  describe "GoContextPropagation" $ do

    it "context propagates through call chain" $ do
      -- Function A(ctx) calls function B(ctx) → PROPAGATES_CONTEXT edge A→B
      let funcA = mkNodeMeta "fn:A" "FUNCTION" "A" "pkg/handler.go"
            [("kind", MetaText "function"), ("accepts_context", MetaBool True)]
          funcB = mkNodeMeta "fn:B" "FUNCTION" "B" "pkg/service.go"
            [("kind", MetaText "function"), ("accepts_context", MetaBool True)]
          callNode = mkNodeMeta "pkg/handler.go->CALL->B[in:A]" "CALL" "B" "pkg/handler.go"
            []
          callEdges = [("pkg/handler.go->CALL->B[in:A]", "fn:B")]
          result = GoContextPropagation.resolveAll [funcA, funcB, callNode] callEdges
      countEdgeType "PROPAGATES_CONTEXT" result `shouldBe` 1
      let [EmitEdge e] = result
      geSource e `shouldBe` "fn:A"
      geTarget e `shouldBe` "fn:B"

    it "goroutine with context emits SPAWNS_WITH_CONTEXT" $ do
      -- go worker(ctx) where worker accepts context → SPAWNS_WITH_CONTEXT
      let funcMain = mkNodeMeta "fn:main" "FUNCTION" "main" "pkg/main.go"
            [("kind", MetaText "function"), ("accepts_context", MetaBool True)]
          funcWorker = mkNodeMeta "fn:worker" "FUNCTION" "worker" "pkg/main.go"
            [("kind", MetaText "function"), ("accepts_context", MetaBool True)]
          callNode = mkNodeMeta "pkg/main.go->CALL->worker[in:main]" "CALL" "worker" "pkg/main.go"
            [("goroutine", MetaBool True)]
          callEdges = [("pkg/main.go->CALL->worker[in:main]", "fn:worker")]
          result = GoContextPropagation.resolveAll [funcMain, funcWorker, callNode] callEdges
      countEdgeType "SPAWNS_WITH_CONTEXT" result `shouldBe` 1
      -- Also expect PROPAGATES_CONTEXT since caller also accepts context
      countEdgeType "PROPAGATES_CONTEXT" result `shouldBe` 1

    it "no context on target produces no propagation edges" $ do
      -- Function A(ctx) calls function C(x int) → no context edges
      let funcA = mkNodeMeta "fn:A" "FUNCTION" "A" "pkg/handler.go"
            [("kind", MetaText "function"), ("accepts_context", MetaBool True)]
          funcC = mkNodeMeta "fn:C" "FUNCTION" "C" "pkg/util.go"
            [("kind", MetaText "function")]
          callNode = mkNodeMeta "pkg/handler.go->CALL->C[in:A]" "CALL" "C" "pkg/handler.go"
            []
          callEdges = [("pkg/handler.go->CALL->C[in:A]", "fn:C")]
          result = GoContextPropagation.resolveAll [funcA, funcC, callNode] callEdges
      result `shouldBe` []

    it "deferred with context emits DEFERS_WITH_CONTEXT" $ do
      -- defer cleanup(ctx) where cleanup accepts context → DEFERS_WITH_CONTEXT
      let funcHandler = mkNodeMeta "fn:handler" "FUNCTION" "handler" "pkg/api.go"
            [("kind", MetaText "function"), ("accepts_context", MetaBool True)]
          funcCleanup = mkNodeMeta "fn:cleanup" "FUNCTION" "cleanup" "pkg/api.go"
            [("kind", MetaText "function"), ("accepts_context", MetaBool True)]
          callNode = mkNodeMeta "pkg/api.go->CALL->cleanup[in:handler]" "CALL" "cleanup" "pkg/api.go"
            [("deferred", MetaBool True)]
          callEdges = [("pkg/api.go->CALL->cleanup[in:handler]", "fn:cleanup")]
          result = GoContextPropagation.resolveAll [funcHandler, funcCleanup, callNode] callEdges
      countEdgeType "DEFERS_WITH_CONTEXT" result `shouldBe` 1
      -- Also expect PROPAGATES_CONTEXT since caller also accepts context
      countEdgeType "PROPAGATES_CONTEXT" result `shouldBe` 1

    it "possible context (aliased import) emits edges with unresolved=true" $ do
      -- Function with possible_context (aliased import: ctx.Context) calls
      -- another possible_context function → edges with unresolved metadata
      let funcA = mkNodeMeta "fn:A" "FUNCTION" "A" "pkg/handler.go"
            [("kind", MetaText "function"), ("possible_context", MetaBool True)]
          funcB = mkNodeMeta "fn:B" "FUNCTION" "B" "pkg/handler.go"
            [("kind", MetaText "function"), ("possible_context", MetaBool True)]
          callNode = mkNodeMeta "pkg/handler.go->CALL->B[in:A]" "CALL" "B" "pkg/handler.go"
            []
          callEdges = [("pkg/handler.go->CALL->B[in:A]", "fn:B")]
          result = GoContextPropagation.resolveAll [funcA, funcB, callNode] callEdges
      countEdgeType "PROPAGATES_CONTEXT" result `shouldBe` 1
      let [EmitEdge e] = result
      geSource e `shouldBe` "fn:A"
      geTarget e `shouldBe` "fn:B"
      Map.lookup "unresolved" (geMetadata e) `shouldBe` Just (MetaBool True)

    it "certain context target with possible context caller still emits edges" $ do
      -- Caller has possible_context, target has accepts_context (certain)
      -- → edge emitted without unresolved (target is certain)
      let funcA = mkNodeMeta "fn:A" "FUNCTION" "A" "pkg/handler.go"
            [("kind", MetaText "function"), ("possible_context", MetaBool True)]
          funcB = mkNodeMeta "fn:B" "FUNCTION" "B" "pkg/handler.go"
            [("kind", MetaText "function"), ("accepts_context", MetaBool True)]
          callNode = mkNodeMeta "pkg/handler.go->CALL->B[in:A]" "CALL" "B" "pkg/handler.go"
            []
          callEdges = [("pkg/handler.go->CALL->B[in:A]", "fn:B")]
          result = GoContextPropagation.resolveAll [funcA, funcB, callNode] callEdges
      countEdgeType "PROPAGATES_CONTEXT" result `shouldBe` 1
      let [EmitEdge e] = result
      -- Target is certain → no unresolved metadata
      Map.lookup "unresolved" (geMetadata e) `shouldBe` Nothing
