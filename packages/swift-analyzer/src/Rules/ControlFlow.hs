{-# LANGUAGE OverloadedStrings #-}
-- | Control flow rule for Swift: BRANCH and SCOPE nodes.
--
-- Stub for Phase 1 -- will handle if/guard/switch/for/while/do-catch
-- in Phase 2.
module Rules.ControlFlow (walkControlFlowStmt) where

import SwiftAST (SwiftStmt)
import Analysis.Context (Analyzer)

-- | Walk a statement for control flow analysis (Phase 2).
walkControlFlowStmt :: SwiftStmt -> Analyzer ()
walkControlFlowStmt _ = return ()
