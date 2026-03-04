module Rules.Patterns where

import RustAST (RustMatchArm)
import Analysis.Context (Analyzer)

walkMatchArms :: [RustMatchArm] -> Analyzer ()
