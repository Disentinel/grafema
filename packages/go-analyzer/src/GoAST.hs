{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE StrictData #-}
-- | Go AST types with FromJSON instances dispatching on "type" field.
-- Follows the same pattern as JavaAST.hs for the java-analyzer.
--
-- The AST is produced by the Go parser (go-parser binary) and received
-- as JSON from the orchestrator. Each node has a "type" discriminator
-- field and a "span" field for source location.
module GoAST
  ( GoFile(..)
  , GoImport(..)
  , GoDecl(..)
  , GoFieldDef(..)
  , GoMethodSig(..)
  , GoStmt(..)
  , GoExpr(..)
  , GoType(..)
  , GoParam(..)
  , GoTypeParam(..)
  , GoCaseClause(..)
  , GoCommClause(..)
  , GoReceiver(..)
  , GoVarSpec(..)
  , Span(..)
  , Pos(..)
  ) where

import Data.Text (Text)
import Data.Aeson (FromJSON(..), withObject, (.:), (.:?), (.!=))
import Data.Aeson.Types (Parser)

-- ── Position & Span (same as JavaAST) ──────────────────────────────

data Pos = Pos
  { posLine :: !Int
  , posCol  :: !Int
  } deriving (Show, Eq)

data Span = Span
  { spanStart :: !Pos
  , spanEnd   :: !Pos
  } deriving (Show, Eq)

-- ── Top-level file ─────────────────────────────────────────────────

data GoFile = GoFile
  { gfPackage :: !Text
  , gfImports :: ![GoImport]
  , gfDecls   :: ![GoDecl]
  } deriving (Show, Eq)

-- ── Imports ────────────────────────────────────────────────────────

data GoImport = GoImport
  { giName  :: !Text           -- ^ import name (local name or package name)
  , giPath  :: !Text           -- ^ import path (e.g., "fmt")
  , giAlias :: !(Maybe Text)   -- ^ explicit alias or Nothing
  , giBlank :: !Bool           -- ^ blank import (_ "pkg")
  , giDot   :: !Bool           -- ^ dot import (. "pkg")
  , giSpan  :: !Span
  } deriving (Show, Eq)

-- ── Receiver ───────────────────────────────────────────────────────

data GoReceiver = GoReceiver
  { grName     :: !(Maybe Text)  -- ^ receiver name (can be blank)
  , grTypeName :: !Text          -- ^ type name
  , grPointer  :: !Bool          -- ^ pointer receiver?
  } deriving (Show, Eq)

-- ── Field definitions ──────────────────────────────────────────────

data GoFieldDef = GoFieldDef
  { gfdName      :: !Text
  , gfdFieldType :: !GoType
  , gfdTag       :: !(Maybe Text)
  , gfdEmbedded  :: !Bool
  , gfdSpan      :: !Span
  } deriving (Show, Eq)

-- ── Method signatures (in interfaces) ──────────────────────────────

data GoMethodSig = GoMethodSig
  { gmsName    :: !Text
  , gmsParams  :: ![GoParam]
  , gmsResults :: ![GoParam]
  , gmsSpan    :: !Span
  } deriving (Show, Eq)

-- ── Parameters ─────────────────────────────────────────────────────

data GoParam = GoParam
  { gpName      :: !(Maybe Text)  -- ^ can be unnamed in results
  , gpParamType :: !GoType
  , gpVariadic  :: !Bool
  , gpSpan      :: !Span
  } deriving (Show, Eq)

-- ── Type parameters (generics) ─────────────────────────────────────

data GoTypeParam = GoTypeParam
  { gtpName       :: !Text
  , gtpConstraint :: !(Maybe GoType)
  , gtpSpan       :: !Span
  } deriving (Show, Eq)

-- ── Var/Const specs ────────────────────────────────────────────────

data GoVarSpec = GoVarSpec
  { gvsNames  :: ![Text]
  , gvsType   :: !(Maybe GoType)
  , gvsValues :: ![GoExpr]
  , gvsSpan   :: !Span
  } deriving (Show, Eq)

-- ── Case/Comm clauses ──────────────────────────────────────────────

data GoCaseClause = GoCaseClause
  { gccList :: ![GoExpr]
  , gccBody :: ![GoStmt]
  , gccSpan :: !Span
  } deriving (Show, Eq)

data GoCommClause = GoCommClause
  { gcmComm :: !(Maybe GoStmt)
  , gcmBody :: ![GoStmt]
  , gcmSpan :: !Span
  } deriving (Show, Eq)

-- ── Top-level declarations ─────────────────────────────────────────

data GoDecl
  = FuncDecl
      { gdName       :: !Text
      , gdRecv       :: !(Maybe GoReceiver)
      , gdTypeParams :: ![GoTypeParam]
      , gdParams     :: ![GoParam]
      , gdResults    :: ![GoParam]
      , gdBody       :: !(Maybe GoStmt)   -- ^ BlockStmt or Nothing for extern funcs
      , gdSpan       :: !Span
      }
  | StructTypeDecl
      { gdName       :: !Text
      , gdFields     :: ![GoFieldDef]
      , gdTypeParams :: ![GoTypeParam]
      , gdSpan       :: !Span
      }
  | InterfaceTypeDecl
      { gdName       :: !Text
      , gdMethods    :: ![GoMethodSig]
      , gdEmbeds     :: ![GoType]         -- ^ embedded interfaces
      , gdTypeParams :: ![GoTypeParam]
      , gdSpan       :: !Span
      }
  | VarDecl
      { gdVarSpecs :: ![GoVarSpec]
      , gdSpan     :: !Span
      }
  | ConstDecl
      { gdConstSpecs :: ![GoVarSpec]
      , gdSpan       :: !Span
      }
  | TypeAliasDecl
      { gdName     :: !Text
      , gdAliasOf  :: !GoType
      , gdSpan     :: !Span
      }
  deriving (Show, Eq)

-- ── Statements ─────────────────────────────────────────────────────

data GoStmt
  = BlockStmt      { gsStmts :: ![GoStmt], gsSpan :: !Span }
  | ReturnStmt     { gsResults :: ![GoExpr], gsSpan :: !Span }
  | IfStmt         { gsInit :: !(Maybe GoStmt), gsCond :: !GoExpr
                   , gsBody :: !GoStmt, gsElse :: !(Maybe GoStmt)
                   , gsSpan :: !Span }
  | ForStmt        { gsForInit :: !(Maybe GoStmt), gsForCond :: !(Maybe GoExpr)
                   , gsForPost :: !(Maybe GoStmt), gsForBody :: !GoStmt
                   , gsSpan :: !Span }
  | RangeStmt      { gsRangeKey :: !(Maybe GoExpr), gsRangeValue :: !(Maybe GoExpr)
                   , gsRangeX :: !GoExpr, gsRangeBody :: !GoStmt
                   , gsSpan :: !Span }
  | SwitchStmt     { gsSwitchInit :: !(Maybe GoStmt), gsSwitchTag :: !(Maybe GoExpr)
                   , gsSwitchBody :: !GoStmt, gsSpan :: !Span }
  | TypeSwitchStmt { gsTsInit :: !(Maybe GoStmt), gsTsAssign :: !GoStmt
                   , gsTsBody :: !GoStmt, gsSpan :: !Span }
  | SelectStmt     { gsSelectBody :: !GoStmt, gsSpan :: !Span }
  | CaseClauseStmt { gsCaseList :: ![GoExpr], gsCaseBody :: ![GoStmt]
                   , gsSpan :: !Span }
  | CommClauseStmt { gsCommComm :: !(Maybe GoStmt), gsCommBody :: ![GoStmt]
                   , gsSpan :: !Span }
  | GoStmtNode     { gsGoCall :: !GoExpr, gsSpan :: !Span }
  | DeferStmtNode  { gsDeferCall :: !GoExpr, gsSpan :: !Span }
  | SendStmtNode   { gsSendChan :: !GoExpr, gsSendValue :: !GoExpr
                   , gsSpan :: !Span }
  | AssignStmtNode { gsAssignLhs :: ![GoExpr], gsAssignRhs :: ![GoExpr]
                   , gsAssignTok :: !Text, gsSpan :: !Span }
  | ExprStmtNode   { gsExprX :: !GoExpr, gsSpan :: !Span }
  | DeclStmtNode   { gsDeclDecl :: !GoDecl, gsSpan :: !Span }
  | IncDecStmtNode { gsIncDecX :: !GoExpr, gsIncDecTok :: !Text
                   , gsSpan :: !Span }
  | BranchStmtNode { gsBranchTok :: !Text, gsBranchLabel :: !(Maybe Text)
                   , gsSpan :: !Span }
  | LabeledStmtNode { gsLabelName :: !Text, gsLabelStmt :: !GoStmt
                    , gsSpan :: !Span }
  | EmptyStmtNode  { gsSpan :: !Span }
  | StmtUnknown    { gsSpan :: !Span }
  deriving (Show, Eq)

-- ── Expressions ────────────────────────────────────────────────────

data GoExpr
  = CallExprNode    { geCallFun :: !GoExpr, geCallArgs :: ![GoExpr]
                    , geCallEllipsis :: !Bool, geSpan :: !Span }
  | SelectorExprNode { geSelectorX :: !GoExpr, geSelectorSel :: !Text
                     , geSpan :: !Span }
  | IdentNode       { geIdentName :: !Text, geSpan :: !Span }
  | BasicLitNode    { geLitKind :: !Text, geLitValue :: !Text
                    , geSpan :: !Span }
  | CompositeLitNode { geCompType :: !(Maybe GoType), geCompElts :: ![GoExpr]
                     , geSpan :: !Span }
  | UnaryExprNode   { geUnaryOp :: !Text, geUnaryX :: !GoExpr
                    , geSpan :: !Span }
  | BinaryExprNode  { geBinOp :: !Text, geBinX :: !GoExpr, geBinY :: !GoExpr
                    , geSpan :: !Span }
  | KeyValueExprNode { geKvKey :: !GoExpr, geKvValue :: !GoExpr
                     , geSpan :: !Span }
  | ParenExprNode   { geParenX :: !GoExpr, geSpan :: !Span }
  | TypeAssertNode  { geTaX :: !GoExpr, geTaType :: !(Maybe GoType)
                    , geSpan :: !Span }
  | SliceExprNode   { geSliceX :: !GoExpr, geSliceLow :: !(Maybe GoExpr)
                    , geSliceHigh :: !(Maybe GoExpr), geSliceMax :: !(Maybe GoExpr)
                    , geSpan :: !Span }
  | FuncLitNode     { geFuncType :: !GoType, geFuncBody :: !GoStmt
                    , geSpan :: !Span }
  | IndexExprNode   { geIndexX :: !GoExpr, geIndexIdx :: !GoExpr
                    , geSpan :: !Span }
  | IndexListExprNode { geIdxListX :: !GoExpr, geIdxListIndices :: ![GoExpr]
                      , geSpan :: !Span }
  | StarExprNode    { geStarX :: !GoExpr, geSpan :: !Span }
  | ExprUnknown     { geSpan :: !Span }
  deriving (Show, Eq)

-- ── Types ──────────────────────────────────────────────────────────

data GoType
  = IdentType       { gtIdent :: !Text, gtSpan :: !Span }
  | SelectorType    { gtSelX :: !GoExpr, gtSelSel :: !Text
                    , gtSpan :: !Span }
  | StarType        { gtStarX :: !GoType, gtSpan :: !Span }
  | ArrayTypeNode   { gtArrElt :: !GoType, gtArrLen :: !(Maybe GoExpr)
                    , gtSpan :: !Span }
  | MapTypeNode     { gtMapKey :: !GoType, gtMapValue :: !GoType
                    , gtSpan :: !Span }
  | ChanTypeNode    { gtChanDir :: !Text, gtChanValue :: !GoType
                    , gtSpan :: !Span }
  | FuncTypeNode    { gtFuncParams :: ![GoParam], gtFuncResults :: ![GoParam]
                    , gtSpan :: !Span }
  | InterfaceTypeNode { gtIfaceMethods :: ![GoMethodSig]
                      , gtSpan :: !Span }
  | StructTypeNode  { gtStructFields :: ![GoFieldDef]
                    , gtSpan :: !Span }
  | EllipsisType    { gtEllipsisElt :: !GoType, gtSpan :: !Span }
  | TypeUnknown     { gtSpan :: !Span }
  deriving (Show, Eq)

-- ── FromJSON instances ─────────────────────────────────────────────

instance FromJSON Pos where
  parseJSON = withObject "Pos" $ \v -> Pos
    <$> v .: "line"
    <*> v .: "col"

instance FromJSON Span where
  parseJSON = withObject "Span" $ \v -> Span
    <$> v .: "start"
    <*> v .: "end"

instance FromJSON GoFile where
  parseJSON = withObject "GoFile" $ \v -> GoFile
    <$> v .:  "package"
    <*> v .:? "imports" .!= []
    <*> v .:? "decls" .!= []

instance FromJSON GoImport where
  parseJSON = withObject "GoImport" $ \v -> GoImport
    <$> v .:  "name"
    <*> v .:  "path"
    <*> v .:? "alias"
    <*> v .:? "blank" .!= False
    <*> v .:? "dot" .!= False
    <*> v .:  "span"

instance FromJSON GoReceiver where
  parseJSON = withObject "GoReceiver" $ \v -> GoReceiver
    <$> v .:? "name"
    <*> v .:  "typeName"
    <*> v .:? "pointer" .!= False

instance FromJSON GoFieldDef where
  parseJSON = withObject "GoFieldDef" $ \v -> GoFieldDef
    <$> v .:  "name"
    <*> v .:  "fieldType"
    <*> v .:? "tag"
    <*> v .:? "embedded" .!= False
    <*> v .:  "span"

instance FromJSON GoMethodSig where
  parseJSON = withObject "GoMethodSig" $ \v -> GoMethodSig
    <$> v .:  "name"
    <*> v .:? "params" .!= []
    <*> v .:? "results" .!= []
    <*> v .:  "span"

instance FromJSON GoParam where
  parseJSON = withObject "GoParam" $ \v -> GoParam
    <$> v .:? "name"
    <*> v .:  "paramType"
    <*> v .:? "variadic" .!= False
    <*> v .:  "span"

instance FromJSON GoTypeParam where
  parseJSON = withObject "GoTypeParam" $ \v -> GoTypeParam
    <$> v .:  "name"
    <*> v .:? "constraint"
    <*> v .:  "span"

instance FromJSON GoVarSpec where
  parseJSON = withObject "GoVarSpec" $ \v -> GoVarSpec
    <$> v .:? "names" .!= []
    <*> v .:? "varType"
    <*> v .:? "values" .!= []
    <*> v .:  "span"

instance FromJSON GoCaseClause where
  parseJSON = withObject "GoCaseClause" $ \v -> GoCaseClause
    <$> v .:? "list" .!= []
    <*> v .:? "body" .!= []
    <*> v .:  "span"

instance FromJSON GoCommClause where
  parseJSON = withObject "GoCommClause" $ \v -> GoCommClause
    <$> v .:? "comm"
    <*> v .:? "body" .!= []
    <*> v .:  "span"

instance FromJSON GoDecl where
  parseJSON = withObject "GoDecl" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "FuncDecl" -> FuncDecl
        <$> v .:  "name"
        <*> v .:? "recv"
        <*> v .:? "typeParams" .!= []
        <*> v .:? "params" .!= []
        <*> v .:? "results" .!= []
        <*> v .:? "body"
        <*> v .:  "span"
      "StructTypeDecl" -> StructTypeDecl
        <$> v .:  "name"
        <*> v .:? "fields" .!= []
        <*> v .:? "typeParams" .!= []
        <*> v .:  "span"
      "InterfaceTypeDecl" -> InterfaceTypeDecl
        <$> v .:  "name"
        <*> v .:? "methods" .!= []
        <*> v .:? "embeds" .!= []
        <*> v .:? "typeParams" .!= []
        <*> v .:  "span"
      "VarDecl" -> VarDecl
        <$> v .:? "specs" .!= []
        <*> v .:  "span"
      "ConstDecl" -> ConstDecl
        <$> v .:? "specs" .!= []
        <*> v .:  "span"
      "TypeAliasDecl" -> TypeAliasDecl
        <$> v .:  "name"
        <*> v .:  "aliasOf"
        <*> v .:  "span"
      _ -> FuncDecl
        <$> v .:  "name"
        <*> v .:? "recv"
        <*> v .:? "typeParams" .!= []
        <*> v .:? "params" .!= []
        <*> v .:? "results" .!= []
        <*> v .:? "body"
        <*> v .:  "span"

instance FromJSON GoStmt where
  parseJSON = withObject "GoStmt" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "BlockStmt" -> BlockStmt
        <$> v .:? "stmts" .!= []
        <*> v .:  "span"
      "ReturnStmt" -> ReturnStmt
        <$> v .:? "results" .!= []
        <*> v .:  "span"
      "IfStmt" -> IfStmt
        <$> v .:? "init"
        <*> v .:  "cond"
        <*> v .:  "body"
        <*> v .:? "else"
        <*> v .:  "span"
      "ForStmt" -> ForStmt
        <$> v .:? "init"
        <*> v .:? "cond"
        <*> v .:? "post"
        <*> v .:  "body"
        <*> v .:  "span"
      "RangeStmt" -> RangeStmt
        <$> v .:? "key"
        <*> v .:? "value"
        <*> v .:  "x"
        <*> v .:  "body"
        <*> v .:  "span"
      "SwitchStmt" -> SwitchStmt
        <$> v .:? "init"
        <*> v .:? "tag"
        <*> v .:  "body"
        <*> v .:  "span"
      "TypeSwitchStmt" -> TypeSwitchStmt
        <$> v .:? "init"
        <*> v .:  "assign"
        <*> v .:  "body"
        <*> v .:  "span"
      "SelectStmt" -> SelectStmt
        <$> v .:  "body"
        <*> v .:  "span"
      "CaseClause" -> CaseClauseStmt
        <$> v .:? "list" .!= []
        <*> v .:? "body" .!= []
        <*> v .:  "span"
      "CommClause" -> CommClauseStmt
        <$> v .:? "comm"
        <*> v .:? "body" .!= []
        <*> v .:  "span"
      "GoStmt" -> GoStmtNode
        <$> v .:  "call"
        <*> v .:  "span"
      "DeferStmt" -> DeferStmtNode
        <$> v .:  "call"
        <*> v .:  "span"
      "SendStmt" -> SendStmtNode
        <$> v .:  "chan"
        <*> v .:  "value"
        <*> v .:  "span"
      "AssignStmt" -> AssignStmtNode
        <$> v .:? "lhs" .!= []
        <*> v .:? "rhs" .!= []
        <*> v .:? "tok" .!= "="
        <*> v .:  "span"
      "ExprStmt" -> ExprStmtNode
        <$> v .:  "x"
        <*> v .:  "span"
      "DeclStmt" -> DeclStmtNode
        <$> v .:  "decl"
        <*> v .:  "span"
      "IncDecStmt" -> IncDecStmtNode
        <$> v .:  "x"
        <*> v .:  "tok"
        <*> v .:  "span"
      "BranchStmt" -> BranchStmtNode
        <$> v .:  "tok"
        <*> v .:? "label"
        <*> v .:  "span"
      "LabeledStmt" -> LabeledStmtNode
        <$> v .:  "label"
        <*> v .:  "stmt"
        <*> v .:  "span"
      "EmptyStmt" -> EmptyStmtNode
        <$> v .: "span"
      _ -> StmtUnknown
        <$> v .: "span"

instance FromJSON GoExpr where
  parseJSON = withObject "GoExpr" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "CallExpr" -> CallExprNode
        <$> v .:  "fun"
        <*> v .:? "args" .!= []
        <*> v .:? "ellipsis" .!= False
        <*> v .:  "span"
      "SelectorExpr" -> SelectorExprNode
        <$> v .:  "x"
        <*> v .:  "sel"
        <*> v .:  "span"
      "Ident" -> IdentNode
        <$> v .:  "name"
        <*> v .:  "span"
      "BasicLit" -> BasicLitNode
        <$> v .:  "kind"
        <*> v .:  "value"
        <*> v .:  "span"
      "CompositeLit" -> CompositeLitNode
        <$> v .:? "litType"
        <*> v .:? "elts" .!= []
        <*> v .:  "span"
      "UnaryExpr" -> UnaryExprNode
        <$> v .:  "op"
        <*> v .:  "x"
        <*> v .:  "span"
      "BinaryExpr" -> BinaryExprNode
        <$> v .:  "op"
        <*> v .:  "x"
        <*> v .:  "y"
        <*> v .:  "span"
      "KeyValueExpr" -> KeyValueExprNode
        <$> v .:  "key"
        <*> v .:  "value"
        <*> v .:  "span"
      "ParenExpr" -> ParenExprNode
        <$> v .:  "x"
        <*> v .:  "span"
      "TypeAssertExpr" -> TypeAssertNode
        <$> v .:  "x"
        <*> v .:? "assertType"
        <*> v .:  "span"
      "SliceExpr" -> SliceExprNode
        <$> v .:  "x"
        <*> v .:? "low"
        <*> v .:? "high"
        <*> v .:? "max"
        <*> v .:  "span"
      "FuncLit" -> FuncLitNode
        <$> v .:  "funcType"
        <*> v .:  "body"
        <*> v .:  "span"
      "IndexExpr" -> IndexExprNode
        <$> v .:  "x"
        <*> v .:  "index"
        <*> v .:  "span"
      "IndexListExpr" -> IndexListExprNode
        <$> v .:  "x"
        <*> v .:? "indices" .!= []
        <*> v .:  "span"
      "StarExpr" -> StarExprNode
        <$> v .:  "x"
        <*> v .:  "span"
      _ -> ExprUnknown
        <$> v .: "span"

instance FromJSON GoType where
  parseJSON = withObject "GoType" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "Ident" -> IdentType
        <$> v .:  "name"
        <*> v .:  "span"
      "SelectorExpr" -> SelectorType
        <$> v .:  "x"
        <*> v .:  "sel"
        <*> v .:  "span"
      "StarExpr" -> StarType
        <$> v .:  "x"
        <*> v .:  "span"
      "ArrayType" -> ArrayTypeNode
        <$> v .:  "elt"
        <*> v .:? "len"
        <*> v .:  "span"
      "MapType" -> MapTypeNode
        <$> v .:  "key"
        <*> v .:  "value"
        <*> v .:  "span"
      "ChanType" -> ChanTypeNode
        <$> v .:? "dir" .!= "both"
        <*> v .:  "value"
        <*> v .:  "span"
      "FuncType" -> FuncTypeNode
        <$> v .:? "params" .!= []
        <*> v .:? "results" .!= []
        <*> v .:  "span"
      "InterfaceType" -> InterfaceTypeNode
        <$> v .:? "methods" .!= []
        <*> v .:  "span"
      "StructType" -> StructTypeNode
        <$> v .:? "fields" .!= []
        <*> v .:  "span"
      "Ellipsis" -> EllipsisType
        <$> v .:  "elt"
        <*> v .:  "span"
      _ -> TypeUnknown
        <$> v .: "span"
