{-# LANGUAGE OverloadedStrings #-}
-- | AST walker that traverses the C/C++ parse tree and emits graph nodes.
--
-- Emits a MODULE node for the file, then delegates to rule modules:
--   * Rules.Imports       — IMPORT nodes (#include, using)
--   * Rules.Declarations  — FUNCTION, VARIABLE, CONSTANT, PARAMETER nodes
--   * Rules.DataTypes     — CLASS, STRUCT, UNION, ENUM nodes
--   * Rules.Expressions   — CALL, REFERENCE, LITERAL, PROPERTY_ACCESS nodes
--   * Rules.Statements    — BRANCH, LOOP, CASE nodes
--   * Rules.Templates     — TEMPLATE nodes
--   * Rules.Namespaces    — NAMESPACE nodes
--   * Rules.Lambdas       — LAMBDA nodes
--   * Rules.ErrorFlow     — TRY_BLOCK, CATCH_BLOCK nodes
--   * Rules.Memory        — memory allocation metadata
--   * Rules.Operators     — operator overload metadata
--   * Rules.Preprocessor  — MACRO nodes
--   * Rules.Attributes    — ATTRIBUTE nodes
--   * Rules.TypeLevel     — TYPEDEF nodes
--   * Rules.Exports       — ExportInfo for header declarations
module Analysis.Walker
  ( walkFile
  ) where

import qualified Data.Text as T
import Data.Text (Text)
import qualified Data.Map.Strict as Map

import CppAST (CppFile(..), CppNode(..))
import Analysis.Context
    ( Analyzer
    , emitNode
    , askFile
    , askModuleId
    )
import Analysis.Types (GraphNode(..), MetaValue(..))
import Rules.Declarations (walkDeclaration)
import Rules.DataTypes (walkDataType)
import Rules.Expressions (walkExpr)
import Rules.Statements (walkStmt)
import Rules.Imports (walkImport)
import Rules.Exports (walkExports)
import Rules.Templates (walkTemplate)
import Rules.Namespaces (walkNamespace)
import Rules.Lambdas (walkLambda)
import Rules.ErrorFlow (walkErrorFlow)
import Rules.Preprocessor (walkPreprocessor)
import Rules.Attributes (walkAttribute)
import Rules.TypeLevel (walkTypeLevel)

-- | Walk a parsed C/C++ file AST, emitting graph nodes.
walkFile :: CppFile -> Analyzer ()
walkFile cppFile = do
  file     <- askFile
  moduleId <- askModuleId

  let modName  = extractModuleName file
      language = cfLanguage cppFile

  -- Emit MODULE node
  emitNode GraphNode
    { gnId        = moduleId
    , gnType      = "MODULE"
    , gnName      = modName
    , gnFile      = file
    , gnLine      = 1
    , gnColumn    = 0
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported  = True
    , gnMetadata  = Map.fromList
        [ ("language", MetaText language)
        , ("isHeader", MetaBool (isHeaderFile file))
        ]
    }

  -- Walk all top-level children
  mapM_ walkTopLevel (cfChildren cppFile)

  -- Walk exports (header file declarations)
  mapM_ walkExports (cfChildren cppFile)

-- | Dispatch a top-level AST node to the appropriate rule module.
walkTopLevel :: CppNode -> Analyzer ()
walkTopLevel node = case nodeKind node of
  -- Declarations
  "FunctionDecl"     -> walkDeclaration node
  "VarDecl"          -> walkDeclaration node
  "ParamDecl"        -> walkDeclaration node
  "MethodDecl"       -> walkDeclaration node
  "ConstructorDecl"  -> walkDeclaration node
  "DestructorDecl"   -> walkDeclaration node
  "ConversionDecl"   -> walkDeclaration node

  -- Data types
  "ClassDecl"        -> walkDataType node
  "StructDecl"       -> walkDataType node
  "UnionDecl"        -> walkDataType node
  "EnumDecl"         -> walkDataType node
  "EnumConstantDecl" -> walkDataType node
  "FieldDecl"        -> walkDataType node
  "BaseSpecifier"    -> walkDataType node

  -- Imports
  "IncludeDirective" -> walkImport node
  "UsingDirective"   -> walkImport node
  "UsingDeclaration" -> walkImport node

  -- Namespaces
  "Namespace"        -> walkNamespace node

  -- Templates
  "ClassTemplate"                -> walkTemplate node
  "FunctionTemplate"             -> walkTemplate node
  "ClassTemplatePartialSpec"     -> walkTemplate node
  "TemplateTypeParam"            -> walkTemplate node
  "TemplateNonTypeParam"         -> walkTemplate node
  "TemplateTemplateParam"        -> walkTemplate node

  -- Preprocessor
  "MacroDefinition"  -> walkPreprocessor node
  "MacroExpansion"   -> walkPreprocessor node

  -- Type-level
  "TypedefDecl"      -> walkTypeLevel node
  "TypeAliasDecl"    -> walkTypeLevel node

  -- Attributes
  "Attribute"        -> walkAttribute node

  -- Statements (at top level in C)
  "CompoundStmt"     -> walkStmt node
  "IfStmt"           -> walkStmt node
  "ForStmt"          -> walkStmt node
  "WhileStmt"        -> walkStmt node
  "DoStmt"           -> walkStmt node
  "SwitchStmt"       -> walkStmt node
  "ReturnStmt"       -> walkStmt node
  "DeclStmt"         -> walkStmt node

  -- Expressions (at top level)
  "CallExpr"         -> walkExpr node
  "MemberRefExpr"    -> walkExpr node
  "DeclRefExpr"      -> walkExpr node
  "BinaryOperator"   -> walkExpr node
  "LambdaExpr"       -> walkLambda node

  -- Error flow
  "TryStmt"          -> walkErrorFlow node
  "CatchStmt"        -> walkErrorFlow node
  "ThrowExpr"        -> walkErrorFlow node

  -- Access specifier labels in class bodies are handled by DataTypes
  "AccessSpecifier"  -> pure ()

  -- Unknown: try walking children
  _ -> mapM_ walkTopLevel (nodeChildren node)

-- | Extract module name from file path.
-- "src/main.cpp" -> "main"
-- "include/header.h" -> "header"
extractModuleName :: Text -> Text
extractModuleName path =
  let segments = T.splitOn "/" path
      fileName = if null segments then path else last segments
      baseName
        | T.isSuffixOf ".cpp" fileName = T.dropEnd 4 fileName
        | T.isSuffixOf ".cc" fileName  = T.dropEnd 3 fileName
        | T.isSuffixOf ".cxx" fileName = T.dropEnd 4 fileName
        | T.isSuffixOf ".c" fileName   = T.dropEnd 2 fileName
        | T.isSuffixOf ".hpp" fileName = T.dropEnd 4 fileName
        | T.isSuffixOf ".hxx" fileName = T.dropEnd 4 fileName
        | T.isSuffixOf ".h" fileName   = T.dropEnd 2 fileName
        | otherwise                    = fileName
  in baseName

-- | Check if a file is a header file.
isHeaderFile :: Text -> Bool
isHeaderFile path =
  T.isSuffixOf ".h" path
  || T.isSuffixOf ".hpp" path
  || T.isSuffixOf ".hxx" path
  || T.isSuffixOf ".hh" path
