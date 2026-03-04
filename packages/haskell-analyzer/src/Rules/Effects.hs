{-# LANGUAGE OverloadedStrings #-}
-- | Phase 6 rule: monadic effect detection from type signatures.
--
-- Scans type signatures for monadic effect types (IO, ST, STM,
-- Reader, Writer, State, ReaderT, WriterT, StateT, ExceptT,
-- MaybeT, ContT, RWST) and emits EFFECT nodes with HAS_EFFECT edges.
--
-- Pure functions (no effect type in return position) are not annotated
-- with EFFECT nodes -- they are simply left without one.
--
-- Called from 'Rules.Declarations.walkTypeSig' after emitting the
-- TYPE_SIGNATURE node.
module Rules.Effects
  ( walkTypeSigForEffects  -- :: T.Text -> LHsSigWcType GhcPs -> Analyzer ()
  ) where

import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import GHC.Hs (GhcPs)
import GHC.Hs.Type
  ( LHsSigWcType
  , HsWildCardBndrs(..)
  , HsSigType(..)
  , HsType(..)
  )
import GHC.Types.SrcLoc (GenLocated(..), unLoc)
import GHC.Types.Name.Reader (rdrNameOcc)
import GHC.Types.Name.Occurrence (occNameString)

import Analysis.Context (Analyzer, emitNode, emitEdge, askFile)
import Analysis.Types (GraphNode(..), GraphEdge(..), MetaValue(..))

-- | Walk a type signature to detect monadic effects in the return type.
--
-- Given a function node ID and its type signature, extracts the return
-- type and checks if it is wrapped in a known monadic effect type.
-- If found, emits an EFFECT node and a HAS_EFFECT edge from the function.
--
-- @walkTypeSigForEffects funcNodeId sigType@ where @funcNodeId@ is the
-- semantic ID of the function and @sigType@ is its located signature.
walkTypeSigForEffects :: T.Text -> LHsSigWcType GhcPs -> Analyzer ()
walkTypeSigForEffects funcNodeId (HsWC _ (L _ sigType)) = do
  let mbEffect = getReturnEffect (unLoc (sig_body sigType))
  case mbEffect of
    Just effectName -> do
      file <- askFile
      let effectNodeId = funcNodeId <> "->EFFECT->" <> effectName
      emitNode GraphNode
        { gnId        = effectNodeId
        , gnType      = "EFFECT"
        , gnName      = effectName
        , gnFile      = file
        , gnLine      = 0
        , gnColumn    = 0
        , gnEndLine   = 0
        , gnEndColumn = 0
        , gnExported  = False
        , gnMetadata  = Map.singleton "monad" (MetaText effectName)
        }
      emitEdge GraphEdge
        { geSource   = funcNodeId
        , geTarget   = effectNodeId
        , geType     = "HAS_EFFECT"
        , geMetadata = Map.empty
        }
    Nothing -> pure ()  -- pure function, no effect node

-- | Extract the effect type name from the return position of a type.
--
-- Traverses rightward through function arrows to find the return type,
-- then checks if the outermost type constructor is a known effect type.
--
-- Examples:
--   @Int -> IO String@       -> Just "IO"
--   @a -> StateT s m a@      -> Just "StateT"
--   @Int -> Int@             -> Nothing
--   @Monad m => m a -> m b@  -> Nothing (type variable, not a known effect)
getReturnEffect :: HsType GhcPs -> Maybe T.Text
getReturnEffect (HsFunTy _ _ _ retTy)   = getReturnEffect (unLoc retTy)
getReturnEffect (HsQualTy _ _ body)     = getReturnEffect (unLoc body)
getReturnEffect (HsForAllTy _ _ body)   = getReturnEffect (unLoc body)
getReturnEffect (HsParTy _ inner)       = getReturnEffect (unLoc inner)
getReturnEffect (HsAppTy _ funTy _)     = extractEffectName (unLoc funTy)
getReturnEffect (HsTyVar _ _ (L _ name)) =
  let n = T.pack (occNameString (rdrNameOcc name))
  in if n `elem` effectNames then Just n else Nothing
getReturnEffect _ = Nothing

-- | Extract the effect name from the head of a type application.
--
-- Unwraps nested 'HsAppTy' to find the leftmost type constructor,
-- then checks if it is a known effect name.
--
-- For @StateT s m a@, the AST is:
-- @HsAppTy (HsAppTy (HsAppTy (HsTyVar StateT) s) m) a@
-- This function traverses left to find @StateT@.
extractEffectName :: HsType GhcPs -> Maybe T.Text
extractEffectName (HsTyVar _ _ (L _ name)) =
  let n = T.pack (occNameString (rdrNameOcc name))
  in if n `elem` effectNames then Just n else Nothing
extractEffectName (HsAppTy _ (L _ f) _) = extractEffectName f
extractEffectName (HsParTy _ (L _ inner)) = extractEffectName inner
extractEffectName _ = Nothing

-- | Known monadic effect type names.
--
-- This covers the most common Haskell effect types from base, mtl,
-- and transformers. Additional effects can be added as needed.
effectNames :: [T.Text]
effectNames =
  [ "IO", "ST", "STM"
  , "Reader", "Writer", "State"
  , "ReaderT", "WriterT", "StateT"
  , "ExceptT", "MaybeT", "ContT", "RWST"
  ]
