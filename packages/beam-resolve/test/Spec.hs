{-# LANGUAGE OverloadedStrings #-}
module Main where

import Test.Hspec
import qualified Data.Map.Strict as Map
import qualified Data.Text as T

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..))
import qualified BeamImportResolution
import qualified BeamLocalRefs
import qualified BeamBehaviourResolution
import qualified BeamProtocolResolution

-- | Helper to create a minimal GraphNode.
mkNode :: T.Text -> T.Text -> T.Text -> T.Text -> GraphNode
mkNode nid ntype name file = GraphNode
  { gnId        = nid
  , gnType      = ntype
  , gnName      = name
  , gnFile      = file
  , gnLine      = 1
  , gnColumn    = 0
  , gnEndLine   = 0
  , gnEndColumn = 0
  , gnExported  = False
  , gnMetadata  = Map.empty
  }

-- | Extract edges from plugin commands.
extractEdges :: [PluginCommand] -> [GraphEdge]
extractEdges = concatMap go
  where
    go (EmitEdge e) = [e]
    go _            = []

-- | Check if any edge points to a given target.
hasEdgeToTarget :: T.Text -> [PluginCommand] -> Bool
hasEdgeToTarget targetId cmds =
  any (\e -> geTarget e == targetId) (extractEdges cmds)

-- | Check if any edge has a metadata key with given value.
hasEdgeMeta :: T.Text -> MetaValue -> [PluginCommand] -> Bool
hasEdgeMeta key val cmds =
  any (\e -> Map.lookup key (geMetadata e) == Just val) (extractEdges cmds)

main :: IO ()
main = hspec $ do
  describe "BeamImportResolution" $ do
    it "resolves import to module" $ do
      let nodes =
            [ mkNode "lib/app.ex->MODULE->MyApp" "MODULE" "MyApp" "lib/app.ex"
            , mkNode "lib/server.ex->MODULE->MyApp.Server" "MODULE" "MyApp.Server" "lib/server.ex"
            , mkNode "lib/app.ex->IMPORT->MyApp.Server[in:MyApp]" "IMPORT" "MyApp.Server" "lib/app.ex"
            ]
      cmds <- BeamImportResolution.resolveAll nodes
      length cmds `shouldBe` 1

    it "skips unresolvable imports" $ do
      let nodes =
            [ mkNode "lib/app.ex->MODULE->MyApp" "MODULE" "MyApp" "lib/app.ex"
            , mkNode "lib/app.ex->IMPORT->External.Lib[in:MyApp]" "IMPORT" "External.Lib" "lib/app.ex"
            ]
      cmds <- BeamImportResolution.resolveAll nodes
      length cmds `shouldBe` 0

  describe "BeamLocalRefs" $ do
    it "resolves local call to function" $ do
      let nodes =
            [ mkNode "lib/app.ex->FUNCTION->helper/1[in:MyApp]" "FUNCTION" "helper/1" "lib/app.ex"
            , mkNode "lib/app.ex->CALL->helper[in:main/0,h:5:4]" "CALL" "helper" "lib/app.ex"
            ]
      let cmds = BeamLocalRefs.resolveAll nodes
      length cmds `shouldBe` 1

    it "creates virtual node for builtins" $ do
      let nodes =
            [ mkNode "lib/app.ex->CALL->inspect[in:main/0,h:5:4]" "CALL" "inspect" "lib/app.ex"
            ]
      let cmds = BeamLocalRefs.resolveAll nodes
      -- Should create both edge + virtual node
      length cmds `shouldBe` 2

    describe "cross-file qualified call resolution" $ do
      it "resolves qualified call with exact module name" $ do
        -- Accounts module with list_users function, call from another file
        let nodes =
              [ mkNode "lib/accounts.ex->MODULE->Accounts" "MODULE" "Accounts" "lib/accounts.ex"
              , mkNode "lib/accounts.ex->FUNCTION->list_users/0[in:Accounts]" "FUNCTION" "list_users/0" "lib/accounts.ex"
              , mkNode "lib/web.ex->MODULE->Web" "MODULE" "Web" "lib/web.ex"
              , mkNode "lib/web.ex->CALL->Accounts.list_users[in:index/2,h:10:4]" "CALL" "Accounts.list_users" "lib/web.ex"
              ]
        let cmds = BeamLocalRefs.resolveAll nodes
        length cmds `shouldBe` 1
        hasEdgeToTarget "lib/accounts.ex->FUNCTION->list_users/0[in:Accounts]" cmds `shouldBe` True
        hasEdgeMeta "crossFile" (MetaBool True) cmds `shouldBe` True

      it "resolves qualified call with suffix alias" $ do
        -- Full module name is MyApp.Accounts, but call uses short alias Accounts
        let nodes =
              [ mkNode "lib/accounts.ex->MODULE->MyApp.Accounts" "MODULE" "MyApp.Accounts" "lib/accounts.ex"
              , mkNode "lib/accounts.ex->FUNCTION->list_users/0[in:MyApp.Accounts]" "FUNCTION" "list_users/0" "lib/accounts.ex"
              , mkNode "lib/web.ex->MODULE->MyApp.Web" "MODULE" "MyApp.Web" "lib/web.ex"
              , mkNode "lib/web.ex->CALL->Accounts.list_users[in:index/2,h:10:4]" "CALL" "Accounts.list_users" "lib/web.ex"
              ]
        let cmds = BeamLocalRefs.resolveAll nodes
        length cmds `shouldBe` 1
        hasEdgeToTarget "lib/accounts.ex->FUNCTION->list_users/0[in:MyApp.Accounts]" cmds `shouldBe` True

      it "resolves qualified call with nested module alias" $ do
        -- Call uses MyApp.Accounts (full name), module is MyApp.Accounts
        let nodes =
              [ mkNode "lib/accounts.ex->MODULE->MyApp.Accounts" "MODULE" "MyApp.Accounts" "lib/accounts.ex"
              , mkNode "lib/accounts.ex->FUNCTION->get_user/1[in:MyApp.Accounts]" "FUNCTION" "get_user/1" "lib/accounts.ex"
              , mkNode "lib/web.ex->MODULE->MyApp.Web" "MODULE" "MyApp.Web" "lib/web.ex"
              , mkNode "lib/web.ex->CALL->MyApp.Accounts.get_user[in:show/2,h:15:4]" "CALL" "MyApp.Accounts.get_user" "lib/web.ex"
              ]
        let cmds = BeamLocalRefs.resolveAll nodes
        length cmds `shouldBe` 1
        hasEdgeToTarget "lib/accounts.ex->FUNCTION->get_user/1[in:MyApp.Accounts]" cmds `shouldBe` True

      it "does not resolve qualified call when module is unknown" $ do
        -- No MODULE node for External, so should not resolve
        let nodes =
              [ mkNode "lib/web.ex->MODULE->MyApp.Web" "MODULE" "MyApp.Web" "lib/web.ex"
              , mkNode "lib/web.ex->CALL->External.do_thing[in:index/2,h:10:4]" "CALL" "External.do_thing" "lib/web.ex"
              ]
        let cmds = BeamLocalRefs.resolveAll nodes
        length cmds `shouldBe` 0

      it "prefers local resolution over cross-file qualified" $ do
        -- Same-file function should win over cross-file qualified match
        let nodes =
              [ mkNode "lib/accounts.ex->MODULE->Accounts" "MODULE" "Accounts" "lib/accounts.ex"
              , mkNode "lib/accounts.ex->FUNCTION->helper/0[in:Accounts]" "FUNCTION" "helper/0" "lib/accounts.ex"
              , mkNode "lib/accounts.ex->CALL->helper[in:list_users/0,h:5:4]" "CALL" "helper" "lib/accounts.ex"
              ]
        let cmds = BeamLocalRefs.resolveAll nodes
        length cmds `shouldBe` 1
        -- Should resolve via local, not cross-file
        hasEdgeMeta "crossFile" (MetaBool True) cmds `shouldBe` False

    -- Production node shape: orchestrator ships hash-id as `gnId` and the
    -- human-readable semantic ID separately in metadata under "semanticId".
    -- Earlier tests use arrow-form strings as `gnId`; they don't exercise
    -- the production path. REG-1097.
    describe "production node shape (hash id + semanticId metadata)" $ do
      let mkProdNode hashId sid ntype name file meta = GraphNode
            { gnId        = hashId
            , gnType      = ntype
            , gnName      = name
            , gnFile      = file
            , gnLine      = 1
            , gnColumn    = 0
            , gnEndLine   = 0
            , gnEndColumn = 0
            , gnExported  = False
            , gnMetadata  = Map.insert "semanticId" (MetaText sid) meta
            }
          noMeta = Map.empty
          withArity n = Map.singleton "arity" (MetaInt n)

      it "resolves Ichi.EventBus.emit/3 from another file" $ do
        let nodes =
              [ mkProdNode "h:mod:eventbus"
                  "grafema://localhost/ichi/lib/ichi/event_bus.ex#MODULE-%3EIchi.EventBus"
                  "MODULE" "Ichi.EventBus" "lib/ichi/event_bus.ex" noMeta
              , mkProdNode "h:fn:emit3"
                  "grafema://localhost/ichi/lib/ichi/event_bus.ex#FUNCTION-%3Eemit/3%5Bin:Ichi.EventBus%5D"
                  "FUNCTION" "emit/3" "lib/ichi/event_bus.ex" noMeta
              , mkProdNode "h:mod:mamori"
                  "grafema://localhost/ichi/lib/ichi/mamori.ex#MODULE-%3EIchi.Mamori"
                  "MODULE" "Ichi.Mamori" "lib/ichi/mamori.ex" noMeta
              , mkProdNode "h:call:emit"
                  "grafema://localhost/ichi/lib/ichi/mamori.ex#CALL-%3EIchi.EventBus.emit%5Bin:handle_verdict/3,h:729:25%5D"
                  "CALL" "Ichi.EventBus.emit" "lib/ichi/mamori.ex" (withArity 3)
              ]
        let cmds = BeamLocalRefs.resolveAll nodes
        hasEdgeToTarget "h:fn:emit3" cmds `shouldBe` True
        hasEdgeMeta "crossFile" (MetaBool True) cmds `shouldBe` True

      it "disambiguates overloaded arities (foo/1 vs foo/2)" $ do
        let nodes =
              [ mkProdNode "h:mod:bus"
                  "grafema://localhost/p/lib/bus.ex#MODULE-%3EBus"
                  "MODULE" "Bus" "lib/bus.ex" noMeta
              , mkProdNode "h:fn:foo1"
                  "grafema://localhost/p/lib/bus.ex#FUNCTION-%3Efoo/1%5Bin:Bus%5D"
                  "FUNCTION" "foo/1" "lib/bus.ex" noMeta
              , mkProdNode "h:fn:foo2"
                  "grafema://localhost/p/lib/bus.ex#FUNCTION-%3Efoo/2%5Bin:Bus%5D"
                  "FUNCTION" "foo/2" "lib/bus.ex" noMeta
              , mkProdNode "h:mod:caller"
                  "grafema://localhost/p/lib/caller.ex#MODULE-%3ECaller"
                  "MODULE" "Caller" "lib/caller.ex" noMeta
              , mkProdNode "h:call:foo1"
                  "grafema://localhost/p/lib/caller.ex#CALL-%3EBus.foo%5Bin:run/0,h:10:4%5D"
                  "CALL" "Bus.foo" "lib/caller.ex" (withArity 1)
              , mkProdNode "h:call:foo2"
                  "grafema://localhost/p/lib/caller.ex#CALL-%3EBus.foo%5Bin:run/0,h:11:4%5D"
                  "CALL" "Bus.foo" "lib/caller.ex" (withArity 2)
              ]
        let cmds = BeamLocalRefs.resolveAll nodes
            edges = extractEdges cmds
        length edges `shouldBe` 2
        hasEdgeToTarget "h:fn:foo1" cmds `shouldBe` True
        hasEdgeToTarget "h:fn:foo2" cmds `shouldBe` True

      it "falls back to arity-agnostic resolution when CALL lacks arity metadata" $ do
        -- Some analyzer paths (pipe syntax, capture forms) may not emit arity.
        -- In that case we should still resolve to the target module/function,
        -- preferring a uniquely-named match.
        let nodes =
              [ mkProdNode "h:mod:bus"
                  "grafema://localhost/p/lib/bus.ex#MODULE-%3EBus"
                  "MODULE" "Bus" "lib/bus.ex" noMeta
              , mkProdNode "h:fn:only"
                  "grafema://localhost/p/lib/bus.ex#FUNCTION-%3Eonly_one/1%5Bin:Bus%5D"
                  "FUNCTION" "only_one/1" "lib/bus.ex" noMeta
              , mkProdNode "h:mod:caller"
                  "grafema://localhost/p/lib/caller.ex#MODULE-%3ECaller"
                  "MODULE" "Caller" "lib/caller.ex" noMeta
              , mkProdNode "h:call:only"
                  "grafema://localhost/p/lib/caller.ex#CALL-%3EBus.only_one%5Bin:run/0,h:10:4%5D"
                  "CALL" "Bus.only_one" "lib/caller.ex" noMeta
              ]
        let cmds = BeamLocalRefs.resolveAll nodes
        hasEdgeToTarget "h:fn:only" cmds `shouldBe` True

  describe "BeamBehaviourResolution" $ do
    -- Helper for production-shape MODULE/IMPORT nodes.
    let mkProdMod hashId sid name file = GraphNode
          { gnId = hashId
          , gnType = "MODULE"
          , gnName = name
          , gnFile = file
          , gnLine = 1, gnColumn = 0, gnEndLine = 0, gnEndColumn = 0
          , gnExported = False
          , gnMetadata = Map.singleton "semanticId" (MetaText sid)
          }
        mkProdImport hashId sid name file behaviour = GraphNode
          { gnId = hashId
          , gnType = "IMPORT"
          , gnName = name
          , gnFile = file
          , gnLine = 1, gnColumn = 0, gnEndLine = 0, gnEndColumn = 0
          , gnExported = False
          , gnMetadata = Map.fromList
              [ ("semanticId", MetaText sid)
              , ("kind", MetaText (if behaviour then "behaviour" else "alias"))
              ]
          }

    it "production node shape: emits IMPLEMENTS edge for @behaviour declarations" $ do
      -- A worker module declares @behaviour GenServer. The resolver should
      -- find both the worker MODULE and the GenServer MODULE in the graph
      -- (despite hash IDs that contain no `->` separator) and emit an
      -- IMPLEMENTS edge between them.
      let nodes =
            [ mkProdMod "h:mod:gs"
                "grafema://localhost/p/lib/gen_server.ex#MODULE-%3EGenServer"
                "GenServer" "lib/gen_server.ex"
            , mkProdMod "h:mod:worker"
                "grafema://localhost/p/lib/worker.ex#MODULE-%3EMyApp.Worker"
                "MyApp.Worker" "lib/worker.ex"
            , mkProdImport "h:imp:beh"
                "grafema://localhost/p/lib/worker.ex#IMPORT-%3EGenServer%5Bin:MyApp.Worker%5D"
                "GenServer" "lib/worker.ex" True
            ]
      let cmds = BeamBehaviourResolution.resolveAll nodes
          edges = extractEdges cmds
      length edges `shouldBe` 1
      geSource (head edges) `shouldBe` "h:mod:worker"
      geTarget (head edges) `shouldBe` "h:mod:gs"
      geType (head edges)   `shouldBe` "IMPLEMENTS"

    it "ignores plain alias imports" $ do
      -- alias / import / require don't carry behaviour semantics.
      let mkAliasImport hashId sid name file = GraphNode
            { gnId = hashId
            , gnType = "IMPORT"
            , gnName = name
            , gnFile = file
            , gnLine = 1, gnColumn = 0, gnEndLine = 0, gnEndColumn = 0
            , gnExported = False
            , gnMetadata = Map.fromList
                [ ("semanticId", MetaText sid)
                , ("kind",       MetaText "alias")
                ]
            }
      let nodes =
            [ mkProdMod "h:mod:other"
                "grafema://localhost/p/lib/other.ex#MODULE-%3EOther"
                "Other" "lib/other.ex"
            , mkProdMod "h:mod:user"
                "grafema://localhost/p/lib/user.ex#MODULE-%3EUser"
                "User" "lib/user.ex"
            , mkAliasImport "h:imp:alias"
                "grafema://localhost/p/lib/user.ex#IMPORT-%3EOther%5Bin:User%5D"
                "Other" "lib/user.ex"
            ]
      let cmds = BeamBehaviourResolution.resolveAll nodes
      length (extractEdges cmds) `shouldBe` 0

    it "treats `use Foo` as an implements relationship" $ do
      -- `use GenServer` is the canonical Elixir way to opt into the GenServer
      -- behaviour. Macro expansion injects `@behaviour GenServer`, but the
      -- analyzer doesn't expand macros — so we must accept `kind=use` too.
      let mkUseImport hashId sid name file = GraphNode
            { gnId = hashId
            , gnType = "IMPORT"
            , gnName = name
            , gnFile = file
            , gnLine = 1, gnColumn = 0, gnEndLine = 0, gnEndColumn = 0
            , gnExported = False
            , gnMetadata = Map.fromList
                [ ("semanticId", MetaText sid)
                , ("kind",       MetaText "use")
                ]
            }
      let nodes =
            [ mkProdMod "h:mod:gs"
                "grafema://localhost/p/lib/gen_server.ex#MODULE-%3EGenServer"
                "GenServer" "lib/gen_server.ex"
            , mkProdMod "h:mod:queue"
                "grafema://localhost/p/lib/queue.ex#MODULE-%3EQueue"
                "Queue" "lib/queue.ex"
            , mkUseImport "h:imp:use"
                "grafema://localhost/p/lib/queue.ex#IMPORT-%3EGenServer%5Bin:Queue%5D"
                "GenServer" "lib/queue.ex"
            ]
      let cmds = BeamBehaviourResolution.resolveAll nodes
          edges = extractEdges cmds
      length edges `shouldBe` 1
      geSource (head edges) `shouldBe` "h:mod:queue"
      geTarget (head edges) `shouldBe` "h:mod:gs"
      Map.lookup "via" (geMetadata (head edges)) `shouldBe` Just (MetaText "use")

    it "creates a deduplicated virtual MODULE for external behaviour targets" $ do
      -- When the implemented behaviour is stdlib/external (not in the
      -- analyzed project), the resolver creates a virtual MODULE node
      -- with the BEAM_GLOBAL::Module:: prefix and emits an IMPLEMENTS
      -- edge to it. Multiple implementers share one virtual node.
      let mkUseImport hashId name file = GraphNode
            { gnId = hashId
            , gnType = "IMPORT"
            , gnName = name
            , gnFile = file
            , gnLine = 1, gnColumn = 0, gnEndLine = 0, gnEndColumn = 0
            , gnExported = False
            , gnMetadata = Map.singleton "kind" (MetaText "use")
            }
      let nodes =
            [ mkProdMod "h:mod:a"
                "grafema://localhost/p/lib/a.ex#MODULE-%3EA" "A" "lib/a.ex"
            , mkProdMod "h:mod:b"
                "grafema://localhost/p/lib/b.ex#MODULE-%3EB" "B" "lib/b.ex"
            -- Note: no MODULE node for GenServer — it's stdlib.
            , mkUseImport "h:imp:a" "GenServer" "lib/a.ex"
            , mkUseImport "h:imp:b" "GenServer" "lib/b.ex"
            ]
      let cmds = BeamBehaviourResolution.resolveAll nodes
          virtualNodes = [ n | EmitNode n <- cmds, gnType n == "MODULE", gnName n == "GenServer" ]
          edges = extractEdges cmds
      length virtualNodes `shouldBe` 1  -- deduplicated
      length edges `shouldBe` 2          -- one IMPLEMENTS edge per implementer
      let vid = "BEAM_GLOBAL::Module::GenServer"
      all (\e -> geTarget e == vid) edges `shouldBe` True
      gnFile (head virtualNodes) `shouldBe` "<runtime/elixir>"

  describe "BeamProtocolResolution" $ do
    it "production node shape: emits IMPLEMENTS edge for defimpl modules" $ do
      -- A defimpl module has metadata.protocol = "Stringify". The resolver
      -- looks the protocol module up by name and emits an edge from the
      -- impl module to it. ID format is irrelevant — the resolver treats
      -- gnId as opaque (REG-1097 sanity guard).
      let mkProto hashId name file extraMeta = GraphNode
            { gnId = hashId
            , gnType = "MODULE"
            , gnName = name
            , gnFile = file
            , gnLine = 1, gnColumn = 0, gnEndLine = 0, gnEndColumn = 0
            , gnExported = False
            , gnMetadata = extraMeta
            }
      let nodes =
            [ mkProto "h:mod:proto"
                "Stringify" "lib/stringify.ex"
                (Map.singleton "kind" (MetaText "protocol"))
            , mkProto "h:mod:impl"
                "Stringify.MyApp.User" "lib/stringify_user.ex"
                (Map.fromList
                  [ ("kind", MetaText "protocol_impl")
                  , ("protocol", MetaText "Stringify")
                  , ("for_type", MetaText "MyApp.User")
                  ])
            ]
      let cmds = BeamProtocolResolution.resolveAll nodes
          edges = extractEdges cmds
      length edges `shouldBe` 1
      geSource (head edges) `shouldBe` "h:mod:impl"
      geTarget (head edges) `shouldBe` "h:mod:proto"
      geType (head edges)   `shouldBe` "IMPLEMENTS"
