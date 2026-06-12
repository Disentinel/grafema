{-# LANGUAGE OverloadedStrings #-}
-- | Tests for the remaining Rust resolve step.
--
-- Wave 6 (resolve→derive migration): the RustImportResolution,
-- RustCallResolution and RustTraitResolution modules were replaced by the
-- rust_imports / rust_calls / rust_trait_resolve derive stdlib packs and
-- DELETED — their tests went with them. What remains native (and tested here)
-- is RustCrossMethodCalls: its dyn-dispatch and receiver-typing arms that no
-- pack owns yet (the ctor and annotation/return-type arms are pack-owned by
-- rust_cross_methods_ctor / rust_receiver_typing, but the step is additive and
-- still serves the dyn-dispatch + self-field arms).
module Main where

import Test.Hspec
import Data.Text (Text)
import qualified Data.Map.Strict as Map

import qualified RustCrossMethodCalls
import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..))

-- ── Helpers ─────────────────────────────────────────────────────────

-- | Extract edges from plugin commands, ignoring EmitNode commands.
extractEdges :: [PluginCommand] -> [GraphEdge]
extractEdges = concatMap go
  where
    go (EmitEdge e) = [e]
    go _            = []

main :: IO ()
main = hspec $ do

  -- ── RustCrossMethodCalls ─────────────────────────────────────────
  describe "RustCrossMethodCalls — cross-file method resolution" $ do

    let mkParamWithType :: Text -> Text -> Text -> Text -> GraphNode
        mkParamWithType name ty file nodeId = GraphNode
          { gnId        = nodeId
          , gnType      = "PARAMETER"
          , gnName      = name
          , gnFile      = file
          , gnLine      = 3
          , gnColumn    = 0
          , gnEndLine   = 3
          , gnEndColumn = 10
          , gnExported  = False
          , gnMetadata  = Map.fromList [("typeAnnotation", MetaText ty)]
          }

        -- Mirrors analyzer format: FUNCTION inside IMPL_BLOCK has semanticId
        --   {file}->FUNCTION->{name}[in:{file}->IMPL_BLOCK->{type}]
        -- extractByMarker "IMPL_BLOCK->" stops at `[`/`]`, so it extracts the
        -- type name cleanly.
        mkMethodNode :: Text -> Text -> Text -> GraphNode
        mkMethodNode name implType file =
          let implId = file <> "->IMPL_BLOCK->" <> implType
              sid    = file <> "->FUNCTION->" <> name <> "[in:" <> implId <> "]"
          in GraphNode
            { gnId        = sid
            , gnType      = "FUNCTION"
            , gnName      = name
            , gnFile      = file
            , gnLine      = 10
            , gnColumn    = 0
            , gnEndLine   = 15
            , gnEndColumn = 1
            , gnExported  = True
            , gnMetadata  = Map.fromList [("semanticId", MetaText sid)]
            }

        mkTraitMethodNode :: Text -> Text -> Text -> Text -> GraphNode
        mkTraitMethodNode name traitName implType file =
          let implId = file <> "->IMPL_BLOCK->" <> implType
              sid    = file <> "->FUNCTION->" <> name <> "[in:" <> implId <> "]"
          in GraphNode
            { gnId        = sid
            , gnType      = "FUNCTION"
            , gnName      = name
            , gnFile      = file
            , gnLine      = 10
            , gnColumn    = 0
            , gnEndLine   = 15
            , gnEndColumn = 1
            , gnExported  = True
            , gnMetadata  = Map.fromList
                [ ("semanticId", MetaText sid)
                , ("trait",      MetaText traitName)
                ]
            }

        mkMethodCallNode :: Text -> Text -> Text -> Text -> GraphNode
        mkMethodCallNode receiver methodName file nodeId = GraphNode
          { gnId        = nodeId
          , gnType      = "CALL"
          , gnName      = methodName
          , gnFile      = file
          , gnLine      = 20
          , gnColumn    = 4
          , gnEndLine   = 20
          , gnEndColumn = 30
          , gnExported  = False
          , gnMetadata  = Map.fromList
              [ ("method",   MetaBool True)
              , ("receiver", MetaText receiver)
              ]
          }

    it "resolves method call via PARAMETER typeAnnotation" $ do
      let nodes =
            [ mkParamWithType "x" "Foo" "src/main.rs" "src/main.rs->PARAMETER->x"
            , mkMethodNode "bar" "Foo" "src/lib.rs"
            , mkMethodCallNode "x" "bar" "src/main.rs"
                "src/main.rs->CALL->bar@20:4"
            ]
      cmds <- RustCrossMethodCalls.resolveAll nodes []
      let edges = extractEdges cmds
      length edges `shouldBe` 1
      case edges of
        [e] -> do
          geType   e `shouldBe` "CALLS"
          geSource e `shouldBe` "src/main.rs->CALL->bar@20:4"
          geTarget e `shouldBe` "src/lib.rs->FUNCTION->bar[in:src/lib.rs->IMPL_BLOCK->Foo]"
          Map.lookup "resolvedVia" (geMetadata e)
            `shouldBe` Just (MetaText "rust-cross-method")
        _ -> expectationFailure "Expected 1 CALLS edge"

    it "produces no edge when receiver type is unknown" $ do
      let nodes =
            [ mkMethodNode "bar" "Foo" "src/lib.rs"
            , mkMethodCallNode "x" "bar" "src/main.rs"
                "src/main.rs->CALL->bar@20:4"
            ]
      cmds <- RustCrossMethodCalls.resolveAll nodes []
      length (extractEdges cmds) `shouldBe` 0

    it "dyn-dispatch fans out to all trait implementers" $ do
      -- x: dyn Draw; x.draw()  -> fan out to every FUNCTION tagged trait=Draw
      let nodes =
            [ mkParamWithType "x" "dyn Draw" "src/main.rs"
                "src/main.rs->PARAMETER->x"
            , mkTraitMethodNode "draw" "Draw" "Circle" "src/shapes.rs"
            , mkTraitMethodNode "draw" "Draw" "Square" "src/squares.rs"
            , mkMethodCallNode "x" "draw" "src/main.rs"
                "src/main.rs->CALL->draw@20:4"
            ]
      cmds <- RustCrossMethodCalls.resolveAll nodes []
      let edges = extractEdges cmds
      length edges `shouldBe` 2
      let targets = map geTarget edges
      targets `shouldContain` ["src/shapes.rs->FUNCTION->draw[in:src/shapes.rs->IMPL_BLOCK->Circle]"]
      targets `shouldContain` ["src/squares.rs->FUNCTION->draw[in:src/squares.rs->IMPL_BLOCK->Square]"]
      mapM_ (\e ->
        Map.lookup "resolvedVia" (geMetadata e)
          `shouldBe` Just (MetaText "rust-dyn-dispatch")) edges
