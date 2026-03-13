{-# LANGUAGE OverloadedStrings #-}
module Main where

import Test.Hspec
import qualified Data.Map.Strict as Map
import qualified Data.Text as T

import Grafema.Types (GraphNode(..), MetaValue(..))
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
