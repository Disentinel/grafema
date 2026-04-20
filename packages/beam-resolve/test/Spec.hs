{-# LANGUAGE OverloadedStrings #-}
module Main where

import Test.Hspec
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import qualified Data.Text as T

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..))
import qualified BeamImportResolution
import qualified BeamLocalRefs
import qualified BeamBehaviourResolution
import qualified BeamProtocolResolution
import qualified BeamWrapperResolution
import qualified BeamMessageFindings
import qualified BeamMessageTypeResolution
import qualified BeamPubsubDelivery
import BeamShape

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

  describe "BeamWrapperResolution (REG-1098 W6)" $ do
    let -- Build a FUNCTION node carrying a `wraps` sub-object.
        mkWrapperFn :: T.Text -> T.Text -> T.Text -> T.Text
                    -> Map.Map T.Text MetaValue -> GraphNode
        mkWrapperFn nid file modName nameArity wraps =
          (mkNode nid "FUNCTION" nameArity file)
            { gnId = nid
            , gnMetadata = Map.fromList
                [ ("semanticId", MetaText (file <> "->FUNCTION->" <> nameArity <> "[in:" <> modName <> "]"))
                , ("wraps", MetaMap wraps)
                ]
            }

        mkPlainFn nid file modName nameArity =
          (mkNode nid "FUNCTION" nameArity file)
            { gnMetadata = Map.singleton "semanticId"
                (MetaText (file <> "->FUNCTION->" <> nameArity <> "[in:" <> modName <> "]"))
            }

        mkProcess nid file modName =
          (mkNode nid "PROCESS" modName file)
            { gnMetadata = Map.singleton "module" (MetaText modName) }

        mkModule nid file modName = mkNode nid "MODULE" modName file

        mkCall nid file name =
          (mkNode nid "CALL" name file)
            { gnMetadata = Map.empty }

        mkTopic nid file pubsub topic =
          (mkNode nid "PUBSUB_TOPIC" topic file)
            { gnMetadata = Map.fromList
                [ ("topic", MetaText topic)
                , ("pubsub", MetaText pubsub)
                ]
            }

        castWraps =
          Map.fromList
            [ ("kind", MetaText "cast")
            , ("target", MetaText "module_self")
            , ("target_hint", MetaNull)
            , ("topic", MetaNull)
            , ("message_shape", MetaList
                [ MetaText "tuple"
                , MetaList
                    [ MetaList [MetaText "atom", MetaText "emit"]
                    , MetaText "wildcard"
                    ]
                ])
            ]

    it "cast wrapper to __MODULE__ emits SENDS_TO to local PROCESS" $ do
      let nodes =
            [ mkModule "m:bus" "lib/event_bus.ex" "Ichi.EventBus"
            , mkWrapperFn "fn:emit" "lib/event_bus.ex" "Ichi.EventBus" "emit/1" castWraps
            , mkProcess "p:bus" "lib/event_bus.ex" "Ichi.EventBus"
            , mkModule "m:mamori" "lib/mamori.ex" "Mamori"
            , mkCall "c:1" "lib/mamori.ex" "Ichi.EventBus.emit"
            ]
      let cmds = BeamWrapperResolution.resolveAll nodes
          edges = extractEdges cmds
      length edges `shouldBe` 1
      let e = head edges
      geType e `shouldBe` "SENDS_TO"
      geSource e `shouldBe` "c:1"
      geTarget e `shouldBe` "p:bus"
      Map.member "message_shape" (geMetadata e) `shouldBe` True
      case Map.lookup "via" (geMetadata e) of
        Just (MetaText t) -> T.isInfixOf "GenServer.cast" t `shouldBe` True
        _ -> expectationFailure "expected via metadata"

    it "cast wrapper to literal module resolves via target_hint" $ do
      let literalWraps = Map.insert "target" (MetaText "literal")
                       $ Map.insert "target_hint" (MetaText "Elixir.Ichi.EventBus")
                       castWraps
          nodes =
            [ mkModule "m:bus" "lib/event_bus.ex" "Ichi.EventBus"
            , mkProcess "p:bus" "lib/event_bus.ex" "Ichi.EventBus"
            , mkModule "m:other" "lib/other.ex" "Other"
            , mkWrapperFn "fn:wrap" "lib/other.ex" "Other" "notify/1" literalWraps
            , mkModule "m:mamori" "lib/mamori.ex" "Mamori"
            , mkCall "c:1" "lib/mamori.ex" "Other.notify"
            ]
      let cmds = BeamWrapperResolution.resolveAll nodes
          edges = extractEdges cmds
      length edges `shouldBe` 1
      geTarget (head edges) `shouldBe` "p:bus"
      geType (head edges) `shouldBe` "SENDS_TO"

    it "variable target wrapper emits nothing" $ do
      let varWraps = Map.insert "target" (MetaText "var") castWraps
          nodes =
            [ mkModule "m:bus" "lib/bus.ex" "Bus"
            , mkWrapperFn "fn:emit" "lib/bus.ex" "Bus" "emit/1" varWraps
            , mkProcess "p:bus" "lib/bus.ex" "Bus"
            , mkModule "m:mamori" "lib/mamori.ex" "Mamori"
            , mkCall "c:1" "lib/mamori.ex" "Bus.emit"
            ]
      let cmds = BeamWrapperResolution.resolveAll nodes
      extractEdges cmds `shouldBe` []

    it "sub wrapper emits SUBSCRIBES_TO from caller MODULE to PUBSUB_TOPIC" $ do
      let subWraps = Map.fromList
            [ ("kind", MetaText "sub")
            , ("target", MetaText "module_self")
            , ("topic", MetaText "events")
            ]
          nodes =
            [ mkModule "m:bus" "lib/event_bus.ex" "Ichi.EventBus"
            , mkWrapperFn "fn:sub" "lib/event_bus.ex" "Ichi.EventBus" "subscribe/0" subWraps
            , mkTopic "t:events" "lib/pubsub.ex" "Ichi.PubSub" "events"
            , mkModule "m:mamori" "lib/mamori.ex" "Mamori"
            , mkCall "c:1" "lib/mamori.ex" "Ichi.EventBus.subscribe"
            ]
      let cmds = BeamWrapperResolution.resolveAll nodes
          edges = extractEdges cmds
      length edges `shouldBe` 1
      let e = head edges
      geType e `shouldBe` "SUBSCRIBES_TO"
      geSource e `shouldBe` "m:mamori"
      geTarget e `shouldBe` "t:events"

    it "broadcast wrapper emits BROADCASTS_TO with message_shape" $ do
      let bcWraps = Map.fromList
            [ ("kind", MetaText "broadcast")
            , ("target", MetaText "module_self")
            , ("topic", MetaText "events")
            , ("message_shape", MetaList [MetaText "number"])
            ]
          nodes =
            [ mkModule "m:bus" "lib/event_bus.ex" "Ichi.EventBus"
            , mkWrapperFn "fn:bc" "lib/event_bus.ex" "Ichi.EventBus" "broadcast_event/1" bcWraps
            , mkTopic "t:events" "lib/pubsub.ex" "Ichi.PubSub" "events"
            , mkModule "m:mamori" "lib/mamori.ex" "Mamori"
            , mkCall "c:1" "lib/mamori.ex" "Ichi.EventBus.broadcast_event"
            ]
      let cmds = BeamWrapperResolution.resolveAll nodes
          edges = extractEdges cmds
      length edges `shouldBe` 1
      let e = head edges
      geType e `shouldBe` "BROADCASTS_TO"
      geSource e `shouldBe` "c:1"
      geTarget e `shouldBe` "t:events"
      Map.lookup "message_shape" (geMetadata e) `shouldBe` Just (MetaList [MetaText "number"])

    it "fan-in: multiple callers each get their own SENDS_TO edge" $ do
      let nodes =
            [ mkModule "m:bus" "lib/event_bus.ex" "Ichi.EventBus"
            , mkWrapperFn "fn:emit" "lib/event_bus.ex" "Ichi.EventBus" "emit/1" castWraps
            , mkProcess "p:bus" "lib/event_bus.ex" "Ichi.EventBus"
            , mkModule "m:a" "lib/a.ex" "A"
            , mkModule "m:b" "lib/b.ex" "B"
            , mkModule "m:c" "lib/c.ex" "C"
            , mkCall "c:a" "lib/a.ex" "Ichi.EventBus.emit"
            , mkCall "c:b" "lib/b.ex" "Ichi.EventBus.emit"
            , mkCall "c:c" "lib/c.ex" "Ichi.EventBus.emit"
            ]
      let cmds = BeamWrapperResolution.resolveAll nodes
          edges = extractEdges cmds
      length edges `shouldBe` 3
      all ((== "SENDS_TO") . geType) edges `shouldBe` True
      all ((== "p:bus") . geTarget) edges `shouldBe` True

    it "plain FUNCTION (no wraps metadata) is ignored" $ do
      let nodes =
            [ mkModule "m:bus" "lib/event_bus.ex" "Ichi.EventBus"
            , mkPlainFn "fn:plain" "lib/event_bus.ex" "Ichi.EventBus" "helper/0"
            , mkProcess "p:bus" "lib/event_bus.ex" "Ichi.EventBus"
            , mkModule "m:mamori" "lib/mamori.ex" "Mamori"
            , mkCall "c:1" "lib/mamori.ex" "Ichi.EventBus.helper"
            ]
      let cmds = BeamWrapperResolution.resolveAll nodes
      extractEdges cmds `shouldBe` []

    it "sub wrapper synthesizes PUBSUB_TOPIC when missing from graph" $ do
      let subWraps = Map.fromList
            [ ("kind", MetaText "sub")
            , ("target", MetaText "module_self")
            , ("topic", MetaText "ghost_topic")
            ]
          nodes =
            [ mkModule "m:bus" "lib/event_bus.ex" "Ichi.EventBus"
            , mkWrapperFn "fn:sub" "lib/event_bus.ex" "Ichi.EventBus" "subscribe/0" subWraps
            , mkModule "m:mamori" "lib/mamori.ex" "Mamori"
            , mkCall "c:1" "lib/mamori.ex" "Ichi.EventBus.subscribe"
            ]
      let cmds = BeamWrapperResolution.resolveAll nodes
          edges = extractEdges cmds
          synths = [ n | EmitNode n <- cmds ]
      case (synths, edges) of
        ([synth], [edge]) -> do
          gnType synth `shouldBe` "PUBSUB_TOPIC"
          geType edge `shouldBe` "SUBSCRIBES_TO"
          geTarget edge `shouldBe` gnId synth
        _ -> expectationFailure "expected exactly one synth node and one edge"

  -- ===================================================================
  -- BeamShape + BeamMessageFindings (REG-1098 W9)
  -- ===================================================================
  describe "BeamShape (REG-1098 W9)" $ do
    it "parses atom shape" $
      parseShape (MetaList [MetaText "atom", MetaText "pay"]) `shouldBe` SAtom "pay"

    it "parses tuple shape" $
      parseShape (MetaList [MetaText "tuple",
                            MetaList [ MetaList [MetaText "atom", MetaText "pay"]
                                     , MetaList [MetaText "wildcard"]
                                     ]])
        `shouldBe` STuple [SAtom "pay", SAny]

    it "parses map shape" $
      parseShape (MetaList [MetaText "map",
                            MetaList [ MetaList [MetaText "type",
                                                 MetaList [MetaText "str", MetaText "x"]] ]])
        `shouldBe` SMap [("type", SStr "x")]

    it "SAny unifies with everything" $ do
      unify SAny (SAtom "x") `shouldBe` True
      unify (SStr "a") SAny  `shouldBe` True
      unify SAny (STuple [SNumber]) `shouldBe` True

    it "atoms unify iff equal" $ do
      unify (SAtom "pay") (SAtom "pay")    `shouldBe` True
      unify (SAtom "pay") (SAtom "refund") `shouldBe` False

    it "kami Mamori regression: :queue does NOT unify with \"queue\"" $
      -- This is the exact bug from Ichi.Mamori:83/90. Atom-keyed clauses
      -- and string-keyed clauses must NOT be treated as compatible.
      unify (SMap [("source", SAtom "queue")])
            (SMap [("source", SStr  "queue")])
        `shouldBe` False

    it "tuple with SAny unifies with tuple with concrete map" $
      unify (STuple [SAtom "event", SAny])
            (STuple [SAtom "event", SMap [("type", SStr "X")]])
        `shouldBe` True

    it "compatMap with disjoint keys is True" $
      compatMap [("a", SAtom "x")] [("b", SStr "y")] `shouldBe` True

    it "tuple length mismatch fails" $
      unify (STuple [SAtom "a"]) (STuple [SAtom "a", SAny]) `shouldBe` False

  describe "BeamMessageFindings (REG-1098 W9)" $ do
    let mkMod fid file name =
          (mkNode fid "MODULE" name file) { gnId = fid }

        mkMsgType nid name file line patternShape catchall bodyCalls =
          GraphNode
            { gnId        = nid
            , gnType      = "MESSAGE_TYPE"
            , gnName      = name
            , gnFile      = file
            , gnLine      = line
            , gnColumn    = 0
            , gnEndLine   = 0
            , gnEndColumn = 0
            , gnExported  = False
            , gnMetadata  = Map.fromList
                [ ("pattern_shape", patternShape)
                , ("catchall", MetaBool catchall)
                , ("handler_line", MetaInt line)
                , ("body_total_calls", MetaInt bodyCalls)
                ]
            }

        mkProc pid file name =
          (mkNode pid "PROCESS" name file) { gnId = pid }

        mkTopic9 tid file pubsub topic =
          GraphNode
            { gnId        = tid
            , gnType      = "PUBSUB_TOPIC"
            , gnName      = topic
            , gnFile      = file
            , gnLine      = 1
            , gnColumn    = 0
            , gnEndLine   = 0
            , gnEndColumn = 0
            , gnExported  = False
            , gnMetadata  = Map.fromList
                [ ("pubsub", MetaText pubsub)
                , ("topic",  MetaText topic)
                ]
            }

        -- shape helpers
        atomS a      = MetaList [MetaText "atom", MetaText a]
        strS  s      = MetaList [MetaText "str",  MetaText s]
        wild         = MetaList [MetaText "wildcard"]
        tupleS xs    = MetaList [MetaText "tuple", MetaList xs]
        mapS kvs     = MetaList [MetaText "map", MetaList [ MetaList [MetaText k, v] | (k,v) <- kvs ]]

        -- non-trivial tagged tuple: {:pay, :usd} — concrete, not catch-rest
        nonTrivial = tupleS [atomS "pay", atomS "usd"]

        -- filter helpers
        issueNodes cmds = [ n | EmitNode n <- cmds, gnType n == "ISSUE" ]
        findingsOfKind k cmds =
          [ n | n <- issueNodes cmds
              , Map.lookup "finding_kind" (gnMetadata n) == Just (MetaText k) ]
        containsEdges cmds = [ e | EmitEdge e <- cmds, geType e == "CONTAINS" ]

    it "silent_handler: non-trivial tagged cast with empty body is flagged" $ do
      let nodes =
            [ mkMod "m:acct" "lib/acct.ex" "Acct"
            , mkMsgType "mt:1" "cast" "lib/acct.ex" 10 nonTrivial False 0
            ]
          cmds = BeamMessageFindings.runFindings nodes []
      length (findingsOfKind "silent_handler" cmds) `shouldBe` 1

    it "silent_handler NOT emitted for bare-atom :tick pattern" $ do
      let nodes =
            [ mkMod "m:acct" "lib/acct.ex" "Acct"
            , mkMsgType "mt:1" "info" "lib/acct.ex" 10 (atomS "tick") False 0
            ]
          cmds = BeamMessageFindings.runFindings nodes []
      findingsOfKind "silent_handler" cmds `shouldBe` []

    it "silent_handler NOT emitted for handle_call" $ do
      let nodes =
            [ mkMod "m:acct" "lib/acct.ex" "Acct"
            , mkMsgType "mt:1" "call" "lib/acct.ex" 10 nonTrivial False 0
            ]
          cmds = BeamMessageFindings.runFindings nodes []
      findingsOfKind "silent_handler" cmds `shouldBe` []

    it "silent_handler NOT emitted when body has calls" $ do
      let nodes =
            [ mkMod "m:acct" "lib/acct.ex" "Acct"
            , mkMsgType "mt:1" "cast" "lib/acct.ex" 10 nonTrivial False 3
            ]
          cmds = BeamMessageFindings.runFindings nodes []
      findingsOfKind "silent_handler" cmds `shouldBe` []

    it "catchall_sink: empty handle_info(_, state) flagged" $ do
      let nodes =
            [ mkMod "m:acct" "lib/acct.ex" "Acct"
            , mkMsgType "mt:1" "info" "lib/acct.ex" 20 wild True 0
            ]
          cmds = BeamMessageFindings.runFindings nodes []
      length (findingsOfKind "catchall_sink" cmds) `shouldBe` 1

    it "catchall_sink NOT emitted when catchall has body effects" $ do
      let nodes =
            [ mkMod "m:acct" "lib/acct.ex" "Acct"
            , mkMsgType "mt:1" "info" "lib/acct.ex" 20 wild True 2
            ]
          cmds = BeamMessageFindings.runFindings nodes []
      findingsOfKind "catchall_sink" cmds `shouldBe` []

    it "unreachable_handler: handler with no matching sender flagged" $ do
      let proc = mkProc "p:acct" "lib/acct.ex" "Acct"
          -- Two handlers: {:pay, _} and {:refund, _}
          h1 = mkMsgType "mt:1" "cast" "lib/acct.ex" 10
                 (tupleS [atomS "pay", wild]) False 3
          h2 = mkMsgType "mt:2" "cast" "lib/acct.ex" 20
                 (tupleS [atomS "refund", wild]) False 3
          -- One send, shape = {:pay, ...}; only h1 can match.
          sendEdge = GraphEdge
            { geSource = "c:1"
            , geTarget = "p:acct"
            , geType   = "SENDS_TO"
            , geMetadata = Map.fromList
                [ ("via", MetaText "GenServer.cast")
                , ("message_shape", tupleS [atomS "pay", wild])
                ]
            }
          nodes = [ mkMod "m:acct" "lib/acct.ex" "Acct", proc, h1, h2 ]
          cmds  = BeamMessageFindings.runFindings nodes [sendEdge]
          ur    = findingsOfKind "unreachable_handler" cmds
      length ur `shouldBe` 1
      gnLine (head ur) `shouldBe` 20

    it "unreachable_handler NOT emitted when module has no static senders at all" $ do
      let nodes =
            [ mkMod "m:acct" "lib/acct.ex" "Acct"
            , mkProc "p:acct" "lib/acct.ex" "Acct"
            , mkMsgType "mt:1" "cast" "lib/acct.ex" 10
                (tupleS [atomS "pay", wild]) False 3
            ]
          cmds = BeamMessageFindings.runFindings nodes []
      findingsOfKind "unreachable_handler" cmds `shouldBe` []

    it "orphan_send: send of shape no handler receives is flagged" $ do
      let proc = mkProc "p:acct" "lib/acct.ex" "Acct"
          -- handler only accepts {:pay, _}, but we send {:refund, _}
          h = mkMsgType "mt:1" "cast" "lib/acct.ex" 10
                (tupleS [atomS "pay", wild]) False 3
          sendEdge = GraphEdge
            { geSource = "lib/caller.ex->CALL->x"
            , geTarget = "p:acct"
            , geType   = "SENDS_TO"
            , geMetadata = Map.fromList
                [ ("via", MetaText "GenServer.cast")
                , ("message_shape", tupleS [atomS "refund", wild])
                ]
            }
          nodes = [ mkMod "m:acct" "lib/acct.ex" "Acct"
                  , mkMod "m:cal"  "lib/caller.ex" "Caller"
                  , proc, h ]
          cmds = BeamMessageFindings.runFindings nodes [sendEdge]
      length (findingsOfKind "orphan_send" cmds) `shouldBe` 1

    it "topic_mismatch: broadcasts with no subscribers flagged" $ do
      let topic = mkTopic9 "t:1" "lib/pubsub.ex" "MyPubSub" "events"
          bcast = GraphEdge
            { geSource = "c:1", geTarget = "t:1"
            , geType = "BROADCASTS_TO"
            , geMetadata = Map.empty
            }
          nodes = [ mkMod "m:ps" "lib/pubsub.ex" "PS", topic ]
          cmds = BeamMessageFindings.runFindings nodes [bcast]
          tm = findingsOfKind "topic_mismatch" cmds
      length tm `shouldBe` 1
      let ctx = case Map.lookup "context" (gnMetadata (head tm)) of
            Just (MetaMap m) -> m
            _ -> Map.empty
      Map.lookup "direction" ctx `shouldBe` Just (MetaText "broadcasts_only")

    it "topic_mismatch: subscribers with no broadcasters flagged" $ do
      let topic = mkTopic9 "t:1" "lib/pubsub.ex" "MyPubSub" "events"
          sub = GraphEdge
            { geSource = "m:sub", geTarget = "t:1"
            , geType = "SUBSCRIBES_TO"
            , geMetadata = Map.empty
            }
          nodes = [ mkMod "m:ps" "lib/pubsub.ex" "PS", topic ]
          cmds = BeamMessageFindings.runFindings nodes [sub]
      length (findingsOfKind "topic_mismatch" cmds) `shouldBe` 1

    it "topic_mismatch NOT emitted when both subs and broadcasts present" $ do
      let topic = mkTopic9 "t:1" "lib/pubsub.ex" "MyPubSub" "events"
          bcast = GraphEdge { geSource = "c:1", geTarget = "t:1"
                            , geType = "BROADCASTS_TO", geMetadata = Map.empty }
          sub   = GraphEdge { geSource = "m:sub", geTarget = "t:1"
                            , geType = "SUBSCRIBES_TO", geMetadata = Map.empty }
          nodes = [ mkMod "m:ps" "lib/pubsub.ex" "PS", topic ]
          cmds = BeamMessageFindings.runFindings nodes [bcast, sub]
      findingsOfKind "topic_mismatch" cmds `shouldBe` []

    it "heterogeneous_key_type: MAMORI regression — :atom vs \"str\" on same key" $ do
      -- Handler A: %{type: :enqueued}
      -- Handler B: %{type: "task_completed"}
      -- Both in the same module. The Mamori bug: only one set ever fires.
      let patA = mapS [("type", atomS "enqueued")]
          patB = mapS [("type", strS  "task_completed")]
          nodes =
            [ mkMod "m:mam" "lib/mamori.ex" "Ichi.Mamori"
            , mkMsgType "mt:a" "info" "lib/mamori.ex" 83 patA False 2
            , mkMsgType "mt:b" "info" "lib/mamori.ex" 90 patB False 2
            ]
          cmds = BeamMessageFindings.runFindings nodes []
          hk = findingsOfKind "heterogeneous_key_type" cmds
      length hk `shouldBe` 1
      let f = head hk
          md = gnMetadata f
          ctx = case Map.lookup "context" md of
            Just (MetaMap m) -> m
            _ -> Map.empty
      Map.lookup "key" ctx `shouldBe` Just (MetaText "type")
      Map.lookup "module" ctx `shouldBe` Just (MetaText "Ichi.Mamori")
      case Map.lookup "kinds" ctx of
        Just (MetaList ks) -> ks `shouldBe` [MetaText "atom", MetaText "str"]
        _ -> expectationFailure "expected kinds list"

    it "heterogeneous_key_type NOT triggered when all clauses use same kind" $ do
      let nodes =
            [ mkMod "m:mam" "lib/mamori.ex" "Ichi.Mamori"
            , mkMsgType "mt:a" "info" "lib/mamori.ex" 83
                (mapS [("type", strS "a")]) False 2
            , mkMsgType "mt:b" "info" "lib/mamori.ex" 90
                (mapS [("type", strS "b")]) False 2
            ]
          cmds = BeamMessageFindings.runFindings nodes []
      findingsOfKind "heterogeneous_key_type" cmds `shouldBe` []

    it "every ISSUE gets exactly one CONTAINS edge from its MODULE" $ do
      let nodes =
            [ mkMod "m:acct" "lib/acct.ex" "Acct"
            , mkMsgType "mt:1" "cast" "lib/acct.ex" 10 nonTrivial False 0
            , mkMsgType "mt:2" "info" "lib/acct.ex" 20 wild True 0
            ]
          cmds = BeamMessageFindings.runFindings nodes []
          issues = issueNodes cmds
          edges  = containsEdges cmds
      length issues `shouldBe` 2
      length edges  `shouldBe` 2
      all ((== "m:acct") . geSource) edges `shouldBe` True
      Set.fromList (map geTarget edges) `shouldBe` Set.fromList (map gnId issues)

  describe "BeamMessageTypeResolution (SENDS_MESSAGE / SELF_SCHEDULE)" $ do
    -- Test helpers —————————————————————————————————————————————————
    let mkSendCall nid file via base isSelf mTargetHint mShape =
          (mkNode nid "CALL" base file)
            { gnMetadata = Map.fromList $
                [ ("sender_via",     MetaText via)
                , ("sender_base",    MetaText base)
                , ("target_is_self", MetaBool isSelf)
                , ("message_shape",  mShape)
                ] ++ maybe [] (\h -> [("target_hint", MetaText h)]) mTargetHint
            }

        mkMsgType nid handler file clauseShape =
          (mkNode nid "MESSAGE_TYPE" handler file)
            { gnMetadata = Map.fromList
                [ ("handler_type",  MetaText handler)
                , ("pattern_shape", clauseShape)
                ]
            }

        mkProcess nid moduleName file =
          (mkNode nid "PROCESS" moduleName file)
            { gnMetadata = Map.fromList [("starter", MetaText "GenServer.start_link")] }

        atomShape a  = MetaList [MetaText "atom", MetaText a]
        tupleShape xs = MetaList [MetaText "tuple", MetaList xs]
        wildShape    = MetaList [MetaText "wildcard"]

        edgeTypes cmds = [ geType e | EmitEdge e <- cmds ]
        edgeTargets cmds = [ geTarget e | EmitEdge e <- cmds ]

    it "emits SELF_SCHEDULE for Process.send_after(self(), atom, _)" $ do
      let nodes =
            [ mkProcess "p:1" "Naikan" "lib/naikan.ex"
            , mkMsgType "mt:reflect" "info" "lib/naikan.ex" (atomShape "reflect")
            , mkSendCall "c:1" "lib/naikan.ex" "info" "Process.send_after"
                True Nothing (atomShape "reflect")
            ]
          cmds = BeamMessageTypeResolution.resolveAll nodes
      edgeTypes cmds `shouldBe` ["SELF_SCHEDULE"]
      edgeTargets cmds `shouldBe` ["mt:reflect"]

    it "emits SENDS_MESSAGE for GenServer.call targeting self" $ do
      let nodes =
            [ mkProcess "p:1" "KV" "lib/kv.ex"
            , mkMsgType "mt:get" "call" "lib/kv.ex"
                (tupleShape [atomShape "get", wildShape])
            , mkSendCall "c:1" "lib/kv.ex" "call" "GenServer.call"
                True Nothing (tupleShape [atomShape "get", wildShape])
            ]
          cmds = BeamMessageTypeResolution.resolveAll nodes
      edgeTypes cmds `shouldBe` ["SENDS_MESSAGE"]
      edgeTargets cmds `shouldBe` ["mt:get"]

    it "resolves cross-file target via target_hint" $ do
      let nodes =
            -- target process lives in a different file
            [ mkProcess "p:1" "KV.Server" "lib/kv_server.ex"
            , mkMsgType "mt:put" "cast" "lib/kv_server.ex"
                (tupleShape [atomShape "put", wildShape])
            -- send-site lives in caller.ex and points at KV.Server
            , mkSendCall "c:1" "lib/caller.ex" "cast" "GenServer.cast"
                False (Just "KV.Server") (tupleShape [atomShape "put", wildShape])
            ]
          cmds = BeamMessageTypeResolution.resolveAll nodes
      edgeTypes cmds `shouldBe` ["SENDS_MESSAGE"]
      edgeTargets cmds `shouldBe` ["mt:put"]

    it "filters candidates by handler_type (cast send does not hit a call handler)" $ do
      let nodes =
            [ mkProcess "p:1" "KV" "lib/kv.ex"
            , mkMsgType "mt:call" "call" "lib/kv.ex" (atomShape "ping")
            , mkSendCall "c:1" "lib/kv.ex" "cast" "GenServer.cast"
                True Nothing (atomShape "ping")
            ]
          cmds = BeamMessageTypeResolution.resolveAll nodes
      cmds `shouldBe` []

    it "filters candidates by shape unification" $ do
      let nodes =
            [ mkProcess "p:1" "KV" "lib/kv.ex"
            , mkMsgType "mt:tick"  "info" "lib/kv.ex" (atomShape "tick")
            , mkMsgType "mt:other" "info" "lib/kv.ex" (atomShape "other")
            , mkSendCall "c:1" "lib/kv.ex" "info" "send"
                True Nothing (atomShape "tick")
            ]
          cmds = BeamMessageTypeResolution.resolveAll nodes
      edgeTargets cmds `shouldBe` ["mt:tick"]

    it "emits one edge per matching clause when multiple handlers unify" $ do
      let nodes =
            [ mkProcess "p:1" "KV" "lib/kv.ex"
            -- Two handle_info clauses: one specific atom, one wildcard — both match :tick
            , mkMsgType "mt:tick" "info" "lib/kv.ex" (atomShape "tick")
            , mkMsgType "mt:_"    "info" "lib/kv.ex" wildShape
            , mkSendCall "c:1" "lib/kv.ex" "info" "send"
                True Nothing (atomShape "tick")
            ]
          cmds = BeamMessageTypeResolution.resolveAll nodes
      Set.fromList (edgeTargets cmds) `shouldBe` Set.fromList ["mt:tick", "mt:_"]

    it "emits nothing when target is dynamic (no hint, not self)" $ do
      let nodes =
            [ mkProcess "p:1" "KV" "lib/kv.ex"
            , mkMsgType "mt:tick" "info" "lib/kv.ex" (atomShape "tick")
            , mkSendCall "c:1" "lib/caller.ex" "info" "send"
                False Nothing (atomShape "tick")
            ]
          cmds = BeamMessageTypeResolution.resolveAll nodes
      cmds `shouldBe` []

    it "emits nothing when the CALL has no message_shape metadata" $ do
      -- e.g. `send(pid, some_var)` — analyzer records sender_via but no shape.
      -- mkSendCall requires a shape, so build the node manually:
      let rawCall = (mkNode "c:1" "CALL" "send" "lib/kv.ex")
            { gnMetadata = Map.fromList
                [ ("sender_via",     MetaText "info")
                , ("sender_base",    MetaText "send")
                , ("target_is_self", MetaBool True)
                ]
            }
          nodes =
            [ mkProcess "p:1" "KV" "lib/kv.ex"
            , mkMsgType "mt:tick" "info" "lib/kv.ex" (atomShape "tick")
            , rawCall
            ]
          cmds = BeamMessageTypeResolution.resolveAll nodes
      cmds `shouldBe` []

    it "cross-process Process.send_after stays SENDS_MESSAGE (not SELF_SCHEDULE)" $ do
      let nodes =
            [ mkProcess "p:1" "Other" "lib/other.ex"
            , mkMsgType "mt:tick" "info" "lib/other.ex" (atomShape "tick")
            , mkSendCall "c:1" "lib/caller.ex" "info" "Process.send_after"
                False (Just "Other") (atomShape "tick")
            ]
          cmds = BeamMessageTypeResolution.resolveAll nodes
      edgeTypes cmds `shouldBe` ["SENDS_MESSAGE"]

  describe "BeamPubsubDelivery (PUBLISHES edges)" $ do
    -- Test helpers ------------------------------------------------
    let mkBroadcast nid file topic server shape =
          (mkNode nid "CALL" "Phoenix.PubSub.broadcast" file)
            { gnMetadata = Map.fromList
                [ ("pubsub_op",     MetaText "broadcast")
                , ("pubsub_topic",  MetaText topic)
                , ("pubsub_server", MetaText server)
                , ("message_shape", shape)
                ]
            }

        mkSubscribe nid file topic server =
          (mkNode nid "CALL" "Phoenix.PubSub.subscribe" file)
            { gnMetadata = Map.fromList
                [ ("pubsub_op",     MetaText "subscribe")
                , ("pubsub_topic",  MetaText topic)
                , ("pubsub_server", MetaText server)
                ]
            }

        mkInfoHandler nid file clauseShape =
          (mkNode nid "MESSAGE_TYPE" "info" file)
            { gnMetadata = Map.fromList
                [ ("handler_type",  MetaText "info")
                , ("pattern_shape", clauseShape)
                ]
            }

        atomShape a  = MetaList [MetaText "atom", MetaText a]
        tupleShape xs = MetaList [MetaText "tuple", MetaList xs]
        wildShape    = MetaList [MetaText "wildcard"]

        publishesEdges cmds = [ e | EmitEdge e <- cmds, geType e == "PUBLISHES" ]

    it "emits PUBLISHES from broadcast to subscriber handle_info clause on shape match" $ do
      let nodes =
            [ mkSubscribe "sub:1" "lib/sub.ex" "events" "Ichi.PubSub"
            , mkInfoHandler "mt:1" "lib/sub.ex"
                (tupleShape [atomShape "user_added", wildShape])
            , mkBroadcast "bc:1" "lib/pub.ex" "events" "Ichi.PubSub"
                (tupleShape [atomShape "user_added", wildShape])
            ]
          edges = publishesEdges (BeamPubsubDelivery.resolveAll nodes)
      map geSource edges `shouldBe` ["bc:1"]
      map geTarget edges `shouldBe` ["mt:1"]

    it "does NOT emit when topic differs" $ do
      let nodes =
            [ mkSubscribe "sub:1" "lib/sub.ex" "other" "Ichi.PubSub"
            , mkInfoHandler "mt:1" "lib/sub.ex" (atomShape "foo")
            , mkBroadcast "bc:1" "lib/pub.ex" "events" "Ichi.PubSub"
                (atomShape "foo")
            ]
      publishesEdges (BeamPubsubDelivery.resolveAll nodes) `shouldBe` []

    it "does NOT emit when PubSub server differs" $ do
      let nodes =
            [ mkSubscribe "sub:1" "lib/sub.ex" "events" "A.PubSub"
            , mkInfoHandler "mt:1" "lib/sub.ex" (atomShape "foo")
            , mkBroadcast "bc:1" "lib/pub.ex" "events" "B.PubSub"
                (atomShape "foo")
            ]
      publishesEdges (BeamPubsubDelivery.resolveAll nodes) `shouldBe` []

    it "does NOT emit when handler shape does not unify" $ do
      let nodes =
            [ mkSubscribe "sub:1" "lib/sub.ex" "events" "Ichi.PubSub"
            , mkInfoHandler "mt:1" "lib/sub.ex" (atomShape "other")
            , mkBroadcast "bc:1" "lib/pub.ex" "events" "Ichi.PubSub"
                (atomShape "foo")
            ]
      publishesEdges (BeamPubsubDelivery.resolveAll nodes) `shouldBe` []

    it "fans out to multiple subscribers on the same topic" $ do
      let nodes =
            [ mkSubscribe "sub:1" "lib/a.ex" "events" "Ichi.PubSub"
            , mkInfoHandler "mt:a" "lib/a.ex" (atomShape "ping")
            , mkSubscribe "sub:2" "lib/b.ex" "events" "Ichi.PubSub"
            , mkInfoHandler "mt:b" "lib/b.ex" (atomShape "ping")
            , mkBroadcast "bc:1" "lib/pub.ex" "events" "Ichi.PubSub"
                (atomShape "ping")
            ]
          edges = publishesEdges (BeamPubsubDelivery.resolveAll nodes)
      Set.fromList (map geTarget edges) `shouldBe` Set.fromList ["mt:a", "mt:b"]

    it "filters subscriber's own non-info handlers (no hit on handle_call)" $ do
      let nodes =
            [ mkSubscribe "sub:1" "lib/sub.ex" "events" "Ichi.PubSub"
            -- A handle_call in the subscriber module should not receive PUBLISHES
            -- even if its shape matches — PubSub delivers as handle_info only.
            , (mkInfoHandler "mt:call" "lib/sub.ex" (atomShape "ping"))
                { gnMetadata = Map.fromList
                    [ ("handler_type",  MetaText "call")
                    , ("pattern_shape", atomShape "ping")
                    ]
                }
            , mkBroadcast "bc:1" "lib/pub.ex" "events" "Ichi.PubSub"
                (atomShape "ping")
            ]
      publishesEdges (BeamPubsubDelivery.resolveAll nodes) `shouldBe` []

    it "carries topic + server provenance on the edge metadata" $ do
      let nodes =
            [ mkSubscribe "sub:1" "lib/sub.ex" "events" "Ichi.PubSub"
            , mkInfoHandler "mt:1" "lib/sub.ex" (atomShape "foo")
            , mkBroadcast "bc:1" "lib/pub.ex" "events" "Ichi.PubSub"
                (atomShape "foo")
            ]
          [edge] = publishesEdges (BeamPubsubDelivery.resolveAll nodes)
      Map.lookup "topic"  (geMetadata edge) `shouldBe` Just (MetaText "events")
      Map.lookup "server" (geMetadata edge) `shouldBe` Just (MetaText "Ichi.PubSub")
      Map.lookup "resolvedVia" (geMetadata edge)
        `shouldBe` Just (MetaText "beam-pubsub-delivery")
