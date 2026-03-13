{-# LANGUAGE OverloadedStrings #-}
-- | Property wrappers rule for Swift.
--
-- Detects property wrapper attributes (@State, @Published, @Binding, etc.)
-- and provides metadata for VARIABLE nodes.
module Rules.PropertyWrappers
  ( findPropertyWrapper
  , knownPropertyWrappers
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import SwiftAST (SwiftAttribute(..))

-- | Known SwiftUI/Combine property wrappers.
knownPropertyWrappers :: [Text]
knownPropertyWrappers =
  [ "State", "Binding", "ObservedObject", "StateObject", "EnvironmentObject"
  , "Environment", "Published", "AppStorage", "SceneStorage", "FocusState"
  , "GestureState", "FetchRequest", "NSApplicationDelegateAdaptor"
  , "UIApplicationDelegateAdaptor"
  ]

-- | Find the first property wrapper attribute on a declaration.
-- Returns the wrapper name (e.g., "State", "Published") or Nothing.
findPropertyWrapper :: [SwiftAttribute] -> Maybe Text
findPropertyWrapper [] = Nothing
findPropertyWrapper (attr:rest)
  | isPropertyWrapperLike (saName attr) = Just (saName attr)
  | otherwise = findPropertyWrapper rest

-- | Heuristic: an attribute is a property wrapper if it's a known wrapper
-- or starts with an uppercase letter (custom property wrappers).
-- Excludes known non-wrapper attributes.
isPropertyWrapperLike :: Text -> Bool
isPropertyWrapperLike name
  | name `elem` knownPropertyWrappers = True
  | name `elem` nonWrapperAttributes  = False
  | T.null name = False
  | otherwise = False  -- conservative: only match known wrappers
  where
    nonWrapperAttributes :: [Text]
    nonWrapperAttributes =
      [ "objc", "MainActor", "Sendable", "available", "discardableResult"
      , "inlinable", "frozen", "propertyWrapper", "resultBuilder"
      , "dynamicMemberLookup", "dynamicCallable", "IBAction", "IBOutlet"
      ]
