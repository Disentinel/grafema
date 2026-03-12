{-# LANGUAGE OverloadedStrings #-}
-- | Annotations rule for Swift: ATTRIBUTE nodes + HAS_ATTRIBUTE edges.
--
-- Stub for Phase 1 -- will handle Swift attributes (@available, @objc,
-- @MainActor, etc.) in Phase 2.
module Rules.Annotations (walkDeclAnnotations) where

import SwiftAST (SwiftDecl)
import Analysis.Context (Analyzer)

-- | Walk annotations on a declaration (Phase 2).
walkDeclAnnotations :: SwiftDecl -> Analyzer ()
walkDeclAnnotations _ = return ()
