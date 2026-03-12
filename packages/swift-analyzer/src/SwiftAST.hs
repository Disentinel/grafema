{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE StrictData #-}
module SwiftAST
  ( SwiftFile(..)
  , SwiftImport(..)
  , SwiftDecl(..)
  , SwiftExpr(..)
  , SwiftStmt(..)
  , SwiftType(..)
  , SwiftPattern(..)
  , SwiftParam(..)
  , SwiftGenericParam(..)
  , SwiftAttribute(..)
  , SwiftCondition(..)
  , SwiftCatchClause(..)
  , SwiftBinding(..)
  , SwiftAccessor(..)
  , SwiftSwitchCase(..)
  , SwiftCaseItem(..)
  , SwiftEnumCaseElement(..)
  , Span(..)
  , Pos(..)
  , getExprSpan
  ) where

import Data.Text (Text)
import Data.Aeson (FromJSON(..), withObject, (.:), (.:?), (.!=))
import Data.Aeson.Types (Parser, Object)

-- Position & Span

data Pos = Pos
  { posLine :: !Int
  , posCol  :: !Int
  } deriving (Show, Eq)

data Span = Span
  { spanStart :: !Pos
  , spanEnd   :: !Pos
  } deriving (Show, Eq)

instance FromJSON Pos where
  parseJSON = withObject "Pos" $ \v -> Pos
    <$> v .: "line"
    <*> v .: "column"

instance FromJSON Span where
  parseJSON = withObject "Span" $ \v -> Span
    <$> v .: "start"
    <*> v .: "end"

-- Top-level file

data SwiftFile = SwiftFile
  { sfFile         :: !(Maybe Text)
  , sfImports      :: ![SwiftImport]
  , sfDeclarations :: ![SwiftDecl]
  } deriving (Show, Eq)

instance FromJSON SwiftFile where
  parseJSON = withObject "SwiftFile" $ \v -> SwiftFile
    <$> v .:? "file"
    <*> v .:? "imports" .!= []
    <*> v .:? "declarations" .!= []

-- Imports

data SwiftImport = SwiftImport
  { siName       :: !Text
  , siImportKind :: !(Maybe Text)
  , siExported   :: !Bool
  , siSpan       :: !Span
  } deriving (Show, Eq)

instance FromJSON SwiftImport where
  parseJSON = withObject "SwiftImport" $ \v -> SwiftImport
    <$> v .: "name"
    <*> v .:? "importKind"
    <*> v .:? "exported" .!= False
    <*> v .: "span"

-- Generic parameter

data SwiftGenericParam = SwiftGenericParam
  { sgpName         :: !Text
  , sgpConstraint   :: !(Maybe SwiftType)
  , sgpIsParamPack  :: !Bool
  } deriving (Show, Eq)

instance FromJSON SwiftGenericParam where
  parseJSON = withObject "SwiftGenericParam" $ \v -> SwiftGenericParam
    <$> v .: "name"
    <*> v .:? "constraint"
    <*> v .:? "isParameterPack" .!= False

-- Attribute

data SwiftAttribute = SwiftAttribute
  { saName      :: !Text
  , saArguments :: !(Maybe Text)
  } deriving (Show, Eq)

instance FromJSON SwiftAttribute where
  parseJSON = withObject "SwiftAttribute" $ \v -> SwiftAttribute
    <$> v .: "name"
    <*> v .:? "arguments"

-- Function parameter

data SwiftParam = SwiftParam
  { spFirstName  :: !Text
  , spSecondName :: !(Maybe Text)
  , spType       :: !SwiftType
  , spDefaultVal :: !(Maybe SwiftExpr)
  , spIsVariadic :: !Bool
  , spSpan       :: !Span
  } deriving (Show, Eq)

instance FromJSON SwiftParam where
  parseJSON = withObject "SwiftParam" $ \v -> SwiftParam
    <$> v .:? "firstName" .!= "_"
    <*> v .:? "secondName"
    <*> v .: "type"
    <*> v .:? "defaultValue"
    <*> v .:? "isVariadic" .!= False
    <*> v .: "span"

-- Pattern binding (for VarDecl)

data SwiftBinding = SwiftBinding
  { sbPattern     :: !SwiftPattern
  , sbType        :: !(Maybe SwiftType)
  , sbInitializer :: !(Maybe SwiftExpr)
  , sbAccessors   :: ![SwiftAccessor]
  , sbSpan        :: !Span
  } deriving (Show, Eq)

instance FromJSON SwiftBinding where
  parseJSON = withObject "SwiftBinding" $ \v -> SwiftBinding
    <$> v .: "pattern"
    <*> v .:? "type"
    <*> v .:? "initializer"
    <*> v .:? "accessors" .!= []
    <*> v .: "span"

-- Accessor (get, set, willSet, didSet)

data SwiftAccessor = SwiftAccessor
  { sacKind    :: !Text    -- "get", "set", "willSet", "didSet"
  , sacBody    :: !(Maybe [SwiftStmt])
  , sacIsAsync :: !Bool
  , sacThrows  :: !Bool
  } deriving (Show, Eq)

instance FromJSON SwiftAccessor where
  parseJSON = withObject "SwiftAccessor" $ \v -> SwiftAccessor
    <$> v .: "kind"
    <*> v .:? "body"
    <*> v .:? "isAsync" .!= False
    <*> v .:? "throws"  .!= False

-- Enum case element

data SwiftEnumCaseElement = SwiftEnumCaseElement
  { seeName           :: !Text
  , seeRawValue       :: !(Maybe SwiftExpr)
  , seeAssociatedVals :: ![SwiftParam]
  , seeSpan           :: !Span
  } deriving (Show, Eq)

instance FromJSON SwiftEnumCaseElement where
  parseJSON = withObject "SwiftEnumCaseElement" $ \v -> SwiftEnumCaseElement
    <$> v .: "name"
    <*> v .:? "rawValue"
    <*> v .:? "associatedValues" .!= []
    <*> v .: "span"

-- Declarations

data SwiftDecl
  = StructDecl
      { sdName          :: !Text
      , sdModifiers     :: ![Text]
      , sdGenericParams :: ![SwiftGenericParam]
      , sdInheritedTypes :: ![SwiftType]
      , sdMembers       :: ![SwiftDecl]
      , sdAttributes    :: ![SwiftAttribute]
      , sdSpan          :: !Span
      }
  | ClassDecl
      { sdName          :: !Text
      , sdModifiers     :: ![Text]
      , sdGenericParams :: ![SwiftGenericParam]
      , sdInheritedTypes :: ![SwiftType]
      , sdMembers       :: ![SwiftDecl]
      , sdAttributes    :: ![SwiftAttribute]
      , sdSpan          :: !Span
      }
  | EnumDecl
      { sdName          :: !Text
      , sdModifiers     :: ![Text]
      , sdGenericParams :: ![SwiftGenericParam]
      , sdInheritedTypes :: ![SwiftType]
      , sdMembers       :: ![SwiftDecl]
      , sdAttributes    :: ![SwiftAttribute]
      , sdSpan          :: !Span
      }
  | ProtocolDecl
      { sdName          :: !Text
      , sdModifiers     :: ![Text]
      , sdInheritedTypes :: ![SwiftType]
      , sdMembers       :: ![SwiftDecl]
      , sdAttributes    :: ![SwiftAttribute]
      , sdSpan          :: !Span
      }
  | ExtensionDecl
      { sdExtendedType  :: !SwiftType
      , sdModifiers     :: ![Text]
      , sdInheritedTypes :: ![SwiftType]
      , sdMembers       :: ![SwiftDecl]
      , sdAttributes    :: ![SwiftAttribute]
      , sdSpan          :: !Span
      }
  | FuncDecl
      { sdName          :: !Text
      , sdModifiers     :: ![Text]
      , sdGenericParams :: ![SwiftGenericParam]
      , sdParams        :: ![SwiftParam]
      , sdReturnType    :: !(Maybe SwiftType)
      , sdBody          :: !(Maybe [SwiftStmt])
      , sdAttributes    :: ![SwiftAttribute]
      , sdIsAsync       :: !Bool
      , sdThrows        :: !Bool
      , sdSpan          :: !Span
      }
  | InitDecl
      { sdModifiers     :: ![Text]
      , sdParams        :: ![SwiftParam]
      , sdBody          :: !(Maybe [SwiftStmt])
      , sdAttributes    :: ![SwiftAttribute]
      , sdIsOptional    :: !Bool
      , sdIsAsync       :: !Bool
      , sdThrows        :: !Bool
      , sdSpan          :: !Span
      }
  | DeinitDecl
      { sdBody          :: !(Maybe [SwiftStmt])
      , sdAttributes    :: ![SwiftAttribute]
      , sdSpan          :: !Span
      }
  | VarDecl
      { sdModifiers       :: ![Text]
      , sdBindingSpecifier :: !Text     -- "let" or "var"
      , sdBindings        :: ![SwiftBinding]
      , sdAttributes      :: ![SwiftAttribute]
      , sdSpan            :: !Span
      }
  | SubscriptDecl
      { sdModifiers     :: ![Text]
      , sdParams        :: ![SwiftParam]
      , sdReturnType    :: !(Maybe SwiftType)
      , sdAccessors     :: ![SwiftAccessor]
      , sdGenericParams :: ![SwiftGenericParam]
      , sdAttributes    :: ![SwiftAttribute]
      , sdSpan          :: !Span
      }
  | TypeAliasDecl
      { sdName          :: !Text
      , sdModifiers     :: ![Text]
      , sdTargetType    :: !SwiftType
      , sdGenericParams :: ![SwiftGenericParam]
      , sdAttributes    :: ![SwiftAttribute]
      , sdSpan          :: !Span
      }
  | ActorDecl
      { sdName          :: !Text
      , sdModifiers     :: ![Text]
      , sdGenericParams :: ![SwiftGenericParam]
      , sdInheritedTypes :: ![SwiftType]
      , sdMembers       :: ![SwiftDecl]
      , sdAttributes    :: ![SwiftAttribute]
      , sdSpan          :: !Span
      }
  | EnumCaseDecl
      { sdElements      :: ![SwiftEnumCaseElement]
      , sdAttributes    :: ![SwiftAttribute]
      , sdSpan          :: !Span
      }
  | AssociatedTypeDecl
      { sdName          :: !Text
      , sdModifiers     :: ![Text]
      , sdInheritedTypes :: ![SwiftType]
      , sdDefaultType   :: !(Maybe SwiftType)
      , sdAttributes    :: ![SwiftAttribute]
      , sdSpan          :: !Span
      }
  | OperatorDecl
      { sdName          :: !Text
      , sdModifiers     :: ![Text]
      , sdSpan          :: !Span
      }
  | UnknownDecl
      { sdText          :: !Text
      , sdSpan          :: !Span
      }
  deriving (Show, Eq)

instance FromJSON SwiftDecl where
  parseJSON = withObject "SwiftDecl" $ \v -> do
    typ <- v .: "type" :: Parser Text
    case typ of
      "StructDecl" -> StructDecl
        <$> v .: "name" <*> v .:? "modifiers" .!= [] <*> v .:? "genericParams" .!= []
        <*> parseInherited v <*> v .:? "members" .!= [] <*> v .:? "attributes" .!= [] <*> v .: "span"
      "ClassDecl" -> ClassDecl
        <$> v .: "name" <*> v .:? "modifiers" .!= [] <*> v .:? "genericParams" .!= []
        <*> parseInherited v <*> v .:? "members" .!= [] <*> v .:? "attributes" .!= [] <*> v .: "span"
      "EnumDecl" -> EnumDecl
        <$> v .: "name" <*> v .:? "modifiers" .!= [] <*> v .:? "genericParams" .!= []
        <*> parseInherited v <*> v .:? "members" .!= [] <*> v .:? "attributes" .!= [] <*> v .: "span"
      "ProtocolDecl" -> ProtocolDecl
        <$> v .: "name" <*> v .:? "modifiers" .!= []
        <*> parseInherited v <*> v .:? "members" .!= [] <*> v .:? "attributes" .!= [] <*> v .: "span"
      "ExtensionDecl" -> ExtensionDecl
        <$> v .: "extendedType" <*> v .:? "modifiers" .!= []
        <*> parseInherited v <*> v .:? "members" .!= [] <*> v .:? "attributes" .!= [] <*> v .: "span"
      "FuncDecl" -> FuncDecl
        <$> v .: "name" <*> v .:? "modifiers" .!= [] <*> v .:? "genericParams" .!= []
        <*> v .:? "params" .!= [] <*> v .:? "returnType"
        <*> parseBody v <*> v .:? "attributes" .!= []
        <*> v .:? "isAsync" .!= False <*> v .:? "throws" .!= False <*> v .: "span"
      "InitDecl" -> InitDecl
        <$> v .:? "modifiers" .!= [] <*> v .:? "params" .!= []
        <*> parseBody v <*> v .:? "attributes" .!= []
        <*> v .:? "isOptional" .!= False
        <*> v .:? "isAsync" .!= False <*> v .:? "throws" .!= False <*> v .: "span"
      "DeinitDecl" -> DeinitDecl
        <$> parseBody v <*> v .:? "attributes" .!= [] <*> v .: "span"
      "VarDecl" -> VarDecl
        <$> v .:? "modifiers" .!= [] <*> v .: "bindingSpecifier"
        <*> v .:? "bindings" .!= [] <*> v .:? "attributes" .!= [] <*> v .: "span"
      "SubscriptDecl" -> SubscriptDecl
        <$> v .:? "modifiers" .!= [] <*> v .:? "params" .!= []
        <*> v .:? "returnType" <*> v .:? "accessors" .!= []
        <*> v .:? "genericParams" .!= [] <*> v .:? "attributes" .!= [] <*> v .: "span"
      "TypeAliasDecl" -> TypeAliasDecl
        <$> v .: "name" <*> v .:? "modifiers" .!= [] <*> v .: "targetType"
        <*> v .:? "genericParams" .!= [] <*> v .:? "attributes" .!= [] <*> v .: "span"
      "ActorDecl" -> ActorDecl
        <$> v .: "name" <*> v .:? "modifiers" .!= [] <*> v .:? "genericParams" .!= []
        <*> parseInherited v <*> v .:? "members" .!= [] <*> v .:? "attributes" .!= [] <*> v .: "span"
      "EnumCaseDecl" -> EnumCaseDecl
        <$> v .:? "elements" .!= [] <*> v .:? "attributes" .!= [] <*> v .: "span"
      "AssociatedTypeDecl" -> AssociatedTypeDecl
        <$> v .: "name" <*> v .:? "modifiers" .!= []
        <*> parseInherited v <*> v .:? "defaultType"
        <*> v .:? "attributes" .!= [] <*> v .: "span"
      "OperatorDecl" -> OperatorDecl
        <$> v .: "name" <*> v .:? "modifiers" .!= [] <*> v .: "span"
      _ -> UnknownDecl
        <$> v .:? "text" .!= "" <*> v .: "span"

-- Helper: parse inherited types from [{type: ...}]
parseInherited :: Object -> Parser [SwiftType]
parseInherited v = do
  items <- v .:? "inheritedTypes" .!= []
  mapM (\item -> withObject "inherited" (\o -> o .: "type") item) items

-- Helper: parse body from {statements: [...]}
parseBody :: Object -> Parser (Maybe [SwiftStmt])
parseBody v = do
  mbody <- v .:? "body"
  case mbody of
    Nothing -> return Nothing
    Just bodyObj -> withObject "body" (\o -> Just <$> o .:? "statements" .!= []) bodyObj

-- Expressions

data SwiftExpr
  = CallExpr
      { seCallee           :: !SwiftExpr
      , seArguments        :: ![(Maybe Text, SwiftExpr)]
      , seTrailingClosure  :: !(Maybe SwiftExpr)
      , seExprSpan         :: !Span
      }
  | MemberAccessExpr
      { seMember           :: !Text
      , seBase             :: !(Maybe SwiftExpr)
      , seExprSpan         :: !Span
      }
  | ClosureExpr
      { seCaptureList      :: ![(Maybe Text, SwiftExpr)]
      , seClosureParams    :: ![(Text, Maybe SwiftType)]
      , seClosureBody      :: ![SwiftStmt]
      , seExprSpan         :: !Span
      }
  | AwaitExpr   { seExpr :: !SwiftExpr, seExprSpan :: !Span }
  | TryExpr     { seExpr :: !SwiftExpr, seTryKind :: !Text, seExprSpan :: !Span }
  | ForceUnwrapExpr  { seExpr :: !SwiftExpr, seExprSpan :: !Span }
  | OptionalChainingExpr { seExpr :: !SwiftExpr, seExprSpan :: !Span }
  | InfixExpr   { seLeft :: !SwiftExpr, seOp :: !SwiftExpr, seRight :: !SwiftExpr, seExprSpan :: !Span }
  | PrefixExpr  { seOperator :: !Text, seExpr :: !SwiftExpr, seExprSpan :: !Span }
  | PostfixExpr { seOperator :: !Text, seExpr :: !SwiftExpr, seExprSpan :: !Span }
  | TernaryExpr { seCond :: !SwiftExpr, seThen :: !SwiftExpr, seElse :: !SwiftExpr, seExprSpan :: !Span }
  | AsExpr      { seExpr :: !SwiftExpr, seTargetType :: !SwiftType, seCastKind :: !Text, seExprSpan :: !Span }
  | IsExpr      { seExpr :: !SwiftExpr, seCheckedType :: !SwiftType, seExprSpan :: !Span }
  | TupleExpr   { seElements :: ![(Maybe Text, SwiftExpr)], seExprSpan :: !Span }
  | ArrayExpr   { seExprs :: ![SwiftExpr], seExprSpan :: !Span }
  | DictExpr    { sePairs :: ![(SwiftExpr, SwiftExpr)], seExprSpan :: !Span }
  | DeclRefExpr { seDeclName :: !Text, seExprSpan :: !Span }
  | StringLiteral { seStrValue :: !Text, seExprSpan :: !Span }
  | IntLiteral    { seIntValue :: !Text, seExprSpan :: !Span }
  | FloatLiteral  { seFloatValue :: !Text, seExprSpan :: !Span }
  | BoolLiteral   { seBoolVal :: !Bool, seExprSpan :: !Span }
  | NilLiteral    { seExprSpan :: !Span }
  | SuperExpr     { seExprSpan :: !Span }
  | KeyPathExpr   { seRoot :: !(Maybe SwiftType), seExprSpan :: !Span }
  | SubscriptCallExpr { seSubCallee :: !SwiftExpr, seSubArguments :: ![(Maybe Text, SwiftExpr)], seExprSpan :: !Span }
  | IfExpr { seIfConditions :: ![SwiftCondition], seIfBody :: ![SwiftStmt], seIfElseBody :: !(Maybe SwiftStmt), seExprSpan :: !Span }
  | SwitchExpr { seSwitchSubject :: !SwiftExpr, seSwitchCases :: ![SwiftSwitchCase], seExprSpan :: !Span }
  | UnknownExpr { seUnkText :: !Text, seExprSpan :: !Span }
  deriving (Show, Eq)

-- | Extract span from any expression variant.
getExprSpan :: SwiftExpr -> Span
getExprSpan = seExprSpan

instance FromJSON SwiftExpr where
  parseJSON = withObject "SwiftExpr" $ \v -> do
    typ <- v .: "type" :: Parser Text
    case typ of
      "CallExpr" -> CallExpr
        <$> v .: "callee"
        <*> parseArgs v
        <*> v .:? "trailingClosure"
        <*> v .: "span"
      "MemberAccessExpr" -> MemberAccessExpr
        <$> v .: "member" <*> v .:? "base" <*> v .: "span"
      "ClosureExpr" -> ClosureExpr
        <$> parseCaptureList v <*> parseClosureParams v
        <*> v .:? "body" .!= [] <*> v .: "span"
      "AwaitExpr" -> AwaitExpr <$> v .: "expression" <*> v .: "span"
      "TryExpr" -> TryExpr <$> v .: "expression" <*> v .:? "tryKind" .!= "standard" <*> v .: "span"
      "ForceUnwrapExpr" -> ForceUnwrapExpr <$> v .: "expression" <*> v .: "span"
      "OptionalChainingExpr" -> OptionalChainingExpr <$> v .: "expression" <*> v .: "span"
      "InfixExpr" -> InfixExpr <$> v .: "left" <*> v .: "operator" <*> v .: "right" <*> v .: "span"
      "PrefixExpr" -> PrefixExpr <$> v .: "operator" <*> v .: "expression" <*> v .: "span"
      "PostfixExpr" -> PostfixExpr <$> v .: "operator" <*> v .: "expression" <*> v .: "span"
      "TernaryExpr" -> TernaryExpr <$> v .: "condition" <*> v .: "thenExpr" <*> v .: "elseExpr" <*> v .: "span"
      "AsExpr" -> AsExpr <$> v .: "expression" <*> v .: "targetType" <*> v .:? "castKind" .!= "bridging" <*> v .: "span"
      "IsExpr" -> IsExpr <$> v .: "expression" <*> v .: "checkedType" <*> v .: "span"
      "TupleExpr" -> TupleExpr <$> parseLabeledExprs v "elements" <*> v .: "span"
      "ArrayExpr" -> ArrayExpr <$> v .:? "elements" .!= [] <*> v .: "span"
      "DictExpr" -> DictExpr <$> parseDictEntries v <*> v .: "span"
      "DeclRef" -> DeclRefExpr <$> v .: "name" <*> v .: "span"
      "StringLiteral" -> StringLiteral <$> v .:? "value" .!= "" <*> v .: "span"
      "IntLiteral" -> IntLiteral <$> v .:? "value" .!= "" <*> v .: "span"
      "FloatLiteral" -> FloatLiteral <$> v .:? "value" .!= "" <*> v .: "span"
      "BoolLiteral" -> BoolLiteral <$> v .:? "value" .!= False <*> v .: "span"
      "NilLiteral" -> NilLiteral <$> v .: "span"
      "SuperExpr" -> SuperExpr <$> v .: "span"
      "KeyPathExpr" -> KeyPathExpr <$> v .:? "root" <*> v .: "span"
      "SubscriptCallExpr" -> SubscriptCallExpr <$> v .: "callee" <*> parseArgs v <*> v .: "span"
      "IfExpr" -> IfExpr
        <$> v .:? "conditions" .!= [] <*> parseStmtBody v
        <*> v .:? "elseBody" <*> v .: "span"
      "SwitchExpr" -> SwitchExpr
        <$> v .: "subject" <*> v .:? "cases" .!= [] <*> v .: "span"
      _ -> UnknownExpr <$> v .:? "text" .!= typ <*> v .: "span"

-- Helpers for expression parsing
parseArgs :: Object -> Parser [(Maybe Text, SwiftExpr)]
parseArgs v = do
  args <- v .:? "arguments" .!= []
  mapM (\arg -> withObject "arg" (\o -> (,) <$> o .:? "label" <*> o .: "value") arg) args

parseCaptureList :: Object -> Parser [(Maybe Text, SwiftExpr)]
parseCaptureList v = do
  items <- v .:? "captureList" .!= []
  mapM (\item -> withObject "capture" (\o -> (,) <$> o .:? "specifier" <*> o .: "expression") item) items

parseClosureParams :: Object -> Parser [(Text, Maybe SwiftType)]
parseClosureParams v = do
  ps <- v .:? "params" .!= []
  mapM (\p -> withObject "closureParam" (\o -> (,) <$> o .: "name" <*> o .:? "type") p) ps

parseDictEntries :: Object -> Parser [(SwiftExpr, SwiftExpr)]
parseDictEntries v = do
  items <- v .:? "elements" .!= []
  mapM (\item -> withObject "dictEntry" (\o -> (,) <$> o .: "key" <*> o .: "value") item) items

parseLabeledExprs :: Object -> Text -> Parser [(Maybe Text, SwiftExpr)]
parseLabeledExprs v _key = do
  items <- v .:? "elements" .!= []
  mapM (\item -> withObject "labeledExpr" (\o -> (,) <$> o .:? "label" <*> o .: "value") item) items

-- Statements

data SwiftStmt
  = IfStmt
      { ssConditions :: ![SwiftCondition]
      , ssBody       :: ![SwiftStmt]
      , ssElseBody   :: !(Maybe SwiftStmt)
      , ssStmtSpan   :: !Span
      }
  | GuardStmt
      { ssConditions :: ![SwiftCondition]
      , ssBody       :: ![SwiftStmt]
      , ssStmtSpan   :: !Span
      }
  | ForInStmt
      { ssPattern    :: !SwiftPattern
      , ssSequence   :: !SwiftExpr
      , ssBody       :: ![SwiftStmt]
      , ssWhereExpr  :: !(Maybe SwiftExpr)
      , ssStmtSpan   :: !Span
      }
  | WhileStmt
      { ssConditions :: ![SwiftCondition]
      , ssBody       :: ![SwiftStmt]
      , ssStmtSpan   :: !Span
      }
  | RepeatWhileStmt
      { ssBody       :: ![SwiftStmt]
      , ssCondition  :: !SwiftExpr
      , ssStmtSpan   :: !Span
      }
  | SwitchStmt
      { ssSubject    :: !SwiftExpr
      , ssCases      :: ![SwiftSwitchCase]
      , ssStmtSpan   :: !Span
      }
  | DoStmt
      { ssBody         :: ![SwiftStmt]
      , ssCatchClauses :: ![SwiftCatchClause]
      , ssStmtSpan     :: !Span
      }
  | ReturnStmt { ssRetExpr :: !(Maybe SwiftExpr), ssStmtSpan :: !Span }
  | ThrowStmt  { ssThrowExpr :: !(Maybe SwiftExpr), ssStmtSpan :: !Span }
  | DeferStmt  { ssBody :: ![SwiftStmt], ssStmtSpan :: !Span }
  | BreakStmt  { ssLabel :: !(Maybe Text), ssStmtSpan :: !Span }
  | ContinueStmt { ssLabel :: !(Maybe Text), ssStmtSpan :: !Span }
  | FallthroughStmt { ssStmtSpan :: !Span }
  | ExprStmt   { ssExprVal :: !SwiftExpr, ssStmtSpan :: !Span }
  | DeclStmt   { ssDeclVal :: !SwiftDecl, ssStmtSpan :: !Span }
  | UnknownStmt { ssUnkText :: !Text, ssStmtSpan :: !Span }
  deriving (Show, Eq)

instance FromJSON SwiftStmt where
  parseJSON = withObject "SwiftStmt" $ \v -> do
    typ <- v .: "type" :: Parser Text
    case typ of
      "IfStmt" -> IfStmt
        <$> v .:? "conditions" .!= [] <*> parseStmtBody v
        <*> v .:? "elseBody" <*> v .: "span"
      "GuardStmt" -> GuardStmt
        <$> v .:? "conditions" .!= [] <*> parseStmtBody v <*> v .: "span"
      "ForInStmt" -> ForInStmt
        <$> v .: "pattern" <*> v .: "sequence" <*> parseStmtBody v
        <*> v .:? "whereClause" <*> v .: "span"
      "WhileStmt" -> WhileStmt
        <$> v .:? "conditions" .!= [] <*> parseStmtBody v <*> v .: "span"
      "RepeatWhileStmt" -> RepeatWhileStmt
        <$> parseStmtBody v <*> v .: "condition" <*> v .: "span"
      "SwitchStmt" -> SwitchStmt
        <$> v .: "subject" <*> v .:? "cases" .!= [] <*> v .: "span"
      "DoStmt" -> DoStmt
        <$> parseStmtBody v <*> parseCatchClauses v <*> v .: "span"
      "ReturnStmt" -> ReturnStmt <$> v .:? "expression" <*> v .: "span"
      "ThrowStmt" -> ThrowStmt <$> v .:? "expression" <*> v .: "span"
      "DeferStmt" -> DeferStmt <$> parseStmtBody v <*> v .: "span"
      "BreakStmt" -> BreakStmt <$> v .:? "label" <*> v .: "span"
      "ContinueStmt" -> ContinueStmt <$> v .:? "label" <*> v .: "span"
      "FallthroughStmt" -> FallthroughStmt <$> v .: "span"
      "DeclStmt" -> DeclStmt <$> v .: "declaration" <*> v .: "span"
      "ExprStmt" -> ExprStmt <$> v .: "expression" <*> v .: "span"
      _ -> do
        -- Try to parse as expression statement
        mExpr <- v .:? "expression"
        case (mExpr :: Maybe SwiftExpr) of
          Just expr -> ExprStmt expr <$> v .: "span"
          Nothing -> UnknownStmt typ <$> v .: "span"

-- Helper: parse statement body from {body: {statements: [...]}}
parseStmtBody :: Object -> Parser [SwiftStmt]
parseStmtBody v = do
  mbody <- v .:? "body"
  case mbody of
    Nothing -> return []
    Just bodyObj -> withObject "stmtBody" (\o -> o .:? "statements" .!= []) bodyObj

parseCatchClauses :: Object -> Parser [SwiftCatchClause]
parseCatchClauses v = v .:? "catchClauses" .!= []

-- Condition

data SwiftCondition
  = ExprCondition !SwiftExpr
  | OptionalBindingCondition !Text !SwiftPattern !(Maybe SwiftType) !(Maybe SwiftExpr)
  | MatchingPatternCondition !SwiftPattern !SwiftExpr
  | AvailabilityCondition !Text
  deriving (Show, Eq)

instance FromJSON SwiftCondition where
  parseJSON = withObject "SwiftCondition" $ \v -> do
    kind <- v .: "kind" :: Parser Text
    case kind of
      "expression" -> ExprCondition <$> v .: "expression"
      "optionalBinding" -> OptionalBindingCondition
        <$> v .: "bindingSpecifier" <*> v .: "pattern"
        <*> v .:? "type" <*> v .:? "initializer"
      "matchingPattern" -> MatchingPatternCondition
        <$> v .: "pattern" <*> v .: "expression"
      "availability" -> AvailabilityCondition <$> v .:? "text" .!= ""
      _ -> AvailabilityCondition <$> v .:? "text" .!= ""

-- Catch clause

data SwiftCatchClause = SwiftCatchClause
  { sccItems :: ![(Maybe SwiftPattern, Maybe SwiftExpr)]
  , sccBody  :: ![SwiftStmt]
  } deriving (Show, Eq)

instance FromJSON SwiftCatchClause where
  parseJSON = withObject "SwiftCatchClause" $ \v -> SwiftCatchClause
    <$> parseCatchItems v
    <*> parseStmtBody v

parseCatchItems :: Object -> Parser [(Maybe SwiftPattern, Maybe SwiftExpr)]
parseCatchItems v = do
  items <- v .:? "items" .!= []
  mapM (\item -> withObject "catchItem" (\o -> (,) <$> o .:? "pattern" <*> o .:? "whereClause") item) items

-- Switch case

data SwiftSwitchCase = SwiftSwitchCase
  { sscKind  :: !Text    -- "case" or "default"
  , sscItems :: ![SwiftCaseItem]
  , sscBody  :: ![SwiftStmt]
  } deriving (Show, Eq)

instance FromJSON SwiftSwitchCase where
  parseJSON = withObject "SwiftSwitchCase" $ \v -> SwiftSwitchCase
    <$> v .: "kind" <*> v .:? "items" .!= [] <*> v .:? "body" .!= []

data SwiftCaseItem = SwiftCaseItem
  { sciPattern     :: !SwiftPattern
  , sciWhereClause :: !(Maybe SwiftExpr)
  } deriving (Show, Eq)

instance FromJSON SwiftCaseItem where
  parseJSON = withObject "SwiftCaseItem" $ \v -> SwiftCaseItem
    <$> v .: "pattern" <*> v .:? "whereClause"

-- Patterns

data SwiftPattern
  = IdentifierPattern !Text
  | TuplePattern ![SwiftPattern]
  | WildcardPattern
  | ExpressionPattern !SwiftExpr
  | ValueBindingPattern !Text !SwiftPattern
  | IsTypePattern !SwiftType
  | UnknownPattern !Text
  deriving (Show, Eq)

instance FromJSON SwiftPattern where
  parseJSON = withObject "SwiftPattern" $ \v -> do
    kind <- v .: "kind" :: Parser Text
    case kind of
      "identifier" -> IdentifierPattern <$> v .: "name"
      "tuple" -> TuplePattern <$> v .:? "elements" .!= []
      "wildcard" -> pure WildcardPattern
      "expression" -> ExpressionPattern <$> v .: "expression"
      "valueBinding" -> ValueBindingPattern <$> v .: "bindingSpecifier" <*> v .: "pattern"
      "isType" -> IsTypePattern <$> v .: "type"
      _ -> UnknownPattern <$> v .:? "text" .!= kind

-- Types

data SwiftType
  = SimpleType !Text ![SwiftType]           -- name + generic args
  | OptionalType !SwiftType
  | ImplicitlyUnwrappedOptionalType !SwiftType
  | ArrayType !SwiftType
  | DictionaryType !SwiftType !SwiftType
  | FunctionType ![SwiftType] !SwiftType !Bool !Bool  -- params, return, async, throws
  | TupleType ![(Maybe Text, SwiftType)]
  | CompositionType ![SwiftType]
  | SomeType !SwiftType                     -- some T
  | AnyType !SwiftType                      -- any T
  | MetatypeType !SwiftType !Text
  | MemberType !SwiftType !Text
  | UnknownType !Text
  deriving (Show, Eq)

instance FromJSON SwiftType where
  parseJSON = withObject "SwiftType" $ \v -> do
    kind <- v .: "kind" :: Parser Text
    case kind of
      "simple" -> SimpleType <$> v .: "name" <*> v .:? "genericArgs" .!= []
      "optional" -> OptionalType <$> v .: "wrappedType"
      "implicitlyUnwrappedOptional" -> ImplicitlyUnwrappedOptionalType <$> v .: "wrappedType"
      "array" -> ArrayType <$> v .: "elementType"
      "dictionary" -> DictionaryType <$> v .: "keyType" <*> v .: "valueType"
      "function" -> FunctionType
        <$> v .:? "params" .!= [] <*> v .: "returnType"
        <*> v .:? "isAsync" .!= False <*> v .:? "throws" .!= False
      "tuple" -> TupleType <$> parseTupleElements v
      "composition" -> CompositionType <$> v .:? "types" .!= []
      "some" -> SomeType <$> v .: "constraint"
      "any" -> AnyType <$> v .: "constraint"
      "metatype" -> MetatypeType <$> v .: "baseType" <*> v .:? "metatypeSpecifier" .!= "Type"
      "member" -> MemberType <$> v .: "baseType" <*> v .: "name"
      _ -> UnknownType <$> v .:? "text" .!= kind

parseTupleElements :: Object -> Parser [(Maybe Text, SwiftType)]
parseTupleElements v = do
  items <- v .:? "elements" .!= []
  mapM (\item -> withObject "tupleElem" (\o -> (,) <$> o .:? "name" <*> o .: "type") item) items
