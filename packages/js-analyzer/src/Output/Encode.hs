{-# LANGUAGE OverloadedStrings #-}
-- ToJSON instances live in Analysis.Types to avoid orphan warnings.
-- This module re-exports for backward compatibility.
module Output.Encode (module Analysis.Types) where

import Analysis.Types
