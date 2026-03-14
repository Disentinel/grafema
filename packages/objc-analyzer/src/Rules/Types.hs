{-# LANGUAGE OverloadedStrings #-}
-- | Type resolution rules for Obj-C analysis.
--
-- Provides helpers to extract type metadata from Obj-C AST children:
--   * extractSuperClass  - find ObjCSuperClassRef among children
--   * extractProtocols   - find ObjCProtocolRef names among children
--
-- These are used by Declarations.hs to set extends/implements metadata
-- on CLASS nodes at creation time.
module Rules.Types
  ( extractSuperClass
  , extractProtocols
  ) where

import Data.Text (Text)
import ObjcAST (ObjcDecl(..))

-- | Extract superclass name from children (ObjCSuperClassRef).
-- Scans children for the first ObjCSuperClassRef node and returns its name.
extractSuperClass :: [ObjcDecl] -> Maybe Text
extractSuperClass [] = Nothing
extractSuperClass (ObjCSuperClassRef name _ : _) = Just name
extractSuperClass (_ : rest) = extractSuperClass rest

-- | Extract protocol names from children (ObjCProtocolRef).
-- Scans children for all ObjCProtocolRef nodes and collects their names.
extractProtocols :: [ObjcDecl] -> [Text]
extractProtocols [] = []
extractProtocols (ObjCProtocolRef name _ : rest) = name : extractProtocols rest
extractProtocols (_ : rest) = extractProtocols rest
