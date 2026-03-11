module Rules.ControlFlow (walkStmt) where

import GoAST (GoStmt)
import Analysis.Context (Analyzer)

walkStmt :: GoStmt -> Analyzer ()
