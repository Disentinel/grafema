{-# LANGUAGE OverloadedStrings #-}
-- | Concurrency rule for Swift: actor isolation tracking.
--
-- Tracks @MainActor, @Sendable, Task spawns, and isolation boundaries.
-- Phase 2: syntactic tracking of concurrency annotations.
module Rules.Concurrency
  ( isMainActorAnnotated
  , isSendableAnnotated
  ) where

import SwiftAST (SwiftAttribute(..))

-- | Check if a list of attributes contains @MainActor.
isMainActorAnnotated :: [SwiftAttribute] -> Bool
isMainActorAnnotated = any (\a -> saName a == "MainActor")

-- | Check if a list of attributes contains @Sendable.
isSendableAnnotated :: [SwiftAttribute] -> Bool
isSendableAnnotated = any (\a -> saName a == "Sendable")
