module Rules.Declarations (walkDeclaration, walkMember) where

import KotlinAST (KotlinDecl, KotlinMember)
import Analysis.Context (Analyzer)

walkDeclaration :: KotlinDecl -> Analyzer ()
walkMember :: KotlinMember -> Analyzer ()
