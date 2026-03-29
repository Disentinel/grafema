module Rules.DataTypes (walkDataType) where

import CppAST (CppNode)
import Analysis.Context (Analyzer)

walkDataType :: CppNode -> Analyzer ()
