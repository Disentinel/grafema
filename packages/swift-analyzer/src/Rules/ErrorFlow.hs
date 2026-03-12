{-# LANGUAGE OverloadedStrings #-}
-- | Error flow rule for Swift.
--
-- Stub for Phase 1 -- will handle throw/try/catch error propagation
-- in Phase 2.
module Rules.ErrorFlow (walkErrorFlowStmt) where

import SwiftAST (SwiftStmt)
import Analysis.Context (Analyzer)

-- | Walk a statement for error flow analysis (Phase 2).
walkErrorFlowStmt :: SwiftStmt -> Analyzer ()
walkErrorFlowStmt _ = return ()
