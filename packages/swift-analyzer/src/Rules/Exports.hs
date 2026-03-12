{-# LANGUAGE OverloadedStrings #-}
-- | Exports rule for Swift.
--
-- Key difference from Kotlin: internal by default in Swift.
-- Items with `public` or `open` visibility are considered exported.
-- `internal`, `fileprivate`, and `private` items are not exported.
--
-- Stub for Phase 1 -- will emit ExportInfo for public/open items
-- in Phase 2.
module Rules.Exports (walkDeclExports) where

import SwiftAST (SwiftDecl)
import Analysis.Context (Analyzer)

-- | Walk exports for a declaration (Phase 2).
walkDeclExports :: SwiftDecl -> Analyzer ()
walkDeclExports _ = return ()
