{-# LANGUAGE OverloadedStrings #-}
module Main where

import Test.Hspec
import qualified Data.Map.Strict as Map
import qualified Data.Text as T

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..))
import qualified BeamImportResolution
import qualified BeamLocalRefs

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
