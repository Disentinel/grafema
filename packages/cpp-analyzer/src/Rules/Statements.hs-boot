module Rules.Statements (walkStmt, walkChild) where

import CppAST (CppNode)
import Analysis.Context (Analyzer)

walkStmt :: CppNode -> Analyzer ()
walkChild :: CppNode -> Analyzer ()
