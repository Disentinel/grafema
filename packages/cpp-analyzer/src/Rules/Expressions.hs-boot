module Rules.Expressions (walkExpr) where

import CppAST (CppNode)
import Analysis.Context (Analyzer)

walkExpr :: CppNode -> Analyzer ()
