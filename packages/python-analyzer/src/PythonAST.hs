{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE StrictData #-}
-- | Python AST types with FromJSON instances dispatching on "type" field.
-- Follows the same pattern as JavaAST.hs for the java-analyzer.
--
-- The AST is produced by rustpython-parser serialized to JSON and received
-- from the orchestrator. Each node has a "type" discriminator field.
module PythonAST
  ( PythonModule(..)
  , PythonStmt(..)
  , PythonExpr(..)
  , PythonArguments(..)
  , PythonArg(..)
  , PythonAlias(..)
  , PythonKeyword(..)
  , PythonComprehension(..)
  , PythonExceptHandler(..)
  , PythonWithItem(..)
  , PythonMatchCase(..)
  , PythonPattern(..)
  , Span(..)
  , Pos(..)
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import Data.Aeson (FromJSON(..), Value(..), withObject, (.:), (.:?), (.!=))
import Data.Aeson.Types (Parser)
import qualified Data.Scientific as Sci
import qualified Data.Vector as V

-- | Coerce a JSON constant value to Text.
-- rustpython-parser emits: String, Bool, Number, Null, Array (for tuple constants).
parseConstantValue :: Value -> Parser Text
parseConstantValue (String s)   = pure s
parseConstantValue (Bool True)  = pure "True"
parseConstantValue (Bool False) = pure "False"
parseConstantValue Null         = pure "None"
parseConstantValue (Number n)   = pure $ T.pack $ case Sci.floatingOrInteger n of
  Left  d -> show (d :: Double)
  Right i -> show (i :: Integer)
parseConstantValue (Array _)    = pure "<tuple>"
parseConstantValue (Object _)   = pure "<object>"

-- ── Position & Span ────────────────────────────────────────────────

data Pos = Pos
  { posLine :: !Int
  , posCol  :: !Int
  } deriving (Show, Eq)

data Span = Span
  { spanStart :: !Pos
  , spanEnd   :: !Pos
  } deriving (Show, Eq)

-- ── Top-level module ───────────────────────────────────────────────

data PythonModule = PythonModule
  { pmBody :: ![PythonStmt]
  } deriving (Show, Eq)

-- ── Statements ─────────────────────────────────────────────────────

data PythonStmt
  = FunctionDef
      { psFdName          :: !Text
      , psFdArgs          :: !PythonArguments
      , psFdBody          :: ![PythonStmt]
      , psFdDecoratorList :: ![PythonExpr]
      , psFdReturns       :: !(Maybe PythonExpr)
      , psFdIsAsync       :: !Bool
      , psSpan            :: !Span
      }
  | ClassDef
      { psCdName          :: !Text
      , psCdBases         :: ![PythonExpr]
      , psCdKeywords      :: ![PythonKeyword]
      , psCdBody          :: ![PythonStmt]
      , psCdDecoratorList :: ![PythonExpr]
      , psSpan            :: !Span
      }
  | ReturnStmt
      { psRetValue :: !(Maybe PythonExpr)
      , psSpan     :: !Span
      }
  | DeleteStmt
      { psDelTargets :: ![PythonExpr]
      , psSpan       :: !Span
      }
  | AssignStmt
      { psAsTargets :: ![PythonExpr]
      , psAsValue   :: !PythonExpr
      , psSpan      :: !Span
      }
  | AugAssignStmt
      { psAaTarget :: !PythonExpr
      , psAaOp     :: !Text
      , psAaValue  :: !PythonExpr
      , psSpan     :: !Span
      }
  | AnnAssignStmt
      { psAnTarget     :: !PythonExpr
      , psAnAnnotation :: !PythonExpr
      , psAnValue      :: !(Maybe PythonExpr)
      , psAnSimple     :: !Bool
      , psSpan         :: !Span
      }
  | ForStmt
      { psForTarget  :: !PythonExpr
      , psForIter    :: !PythonExpr
      , psForBody    :: ![PythonStmt]
      , psForOrElse  :: ![PythonStmt]
      , psForIsAsync :: !Bool
      , psSpan       :: !Span
      }
  | WhileStmt
      { psWhTest   :: !PythonExpr
      , psWhBody   :: ![PythonStmt]
      , psWhOrElse :: ![PythonStmt]
      , psSpan     :: !Span
      }
  | IfStmt
      { psIfTest   :: !PythonExpr
      , psIfBody   :: ![PythonStmt]
      , psIfOrElse :: ![PythonStmt]
      , psSpan     :: !Span
      }
  | WithStmt
      { psWithItems   :: ![PythonWithItem]
      , psWithBody    :: ![PythonStmt]
      , psWithIsAsync :: !Bool
      , psSpan        :: !Span
      }
  | MatchStmt
      { psMaSubject :: !PythonExpr
      , psMaCases   :: ![PythonMatchCase]
      , psSpan      :: !Span
      }
  | RaiseStmt
      { psRaExc   :: !(Maybe PythonExpr)
      , psRaCause :: !(Maybe PythonExpr)
      , psSpan    :: !Span
      }
  | TryStmt
      { psTrBody      :: ![PythonStmt]
      , psTrHandlers  :: ![PythonExceptHandler]
      , psTrOrElse    :: ![PythonStmt]
      , psTrFinalBody :: ![PythonStmt]
      , psSpan        :: !Span
      }
  | AssertStmt
      { psAssTest :: !PythonExpr
      , psAssMsg  :: !(Maybe PythonExpr)
      , psSpan    :: !Span
      }
  | ImportStmt
      { psImpNames :: ![PythonAlias]
      , psSpan     :: !Span
      }
  | ImportFromStmt
      { psIfModule :: !(Maybe Text)
      , psIfNames  :: ![PythonAlias]
      , psIfLevel  :: !Int
      , psSpan     :: !Span
      }
  | GlobalStmt
      { psGlNames :: ![Text]
      , psSpan    :: !Span
      }
  | NonlocalStmt
      { psNlNames :: ![Text]
      , psSpan    :: !Span
      }
  | ExprStmt
      { psExValue :: !PythonExpr
      , psSpan    :: !Span
      }
  | PassStmt   { psSpan :: !Span }
  | BreakStmt  { psSpan :: !Span }
  | ContinueStmt { psSpan :: !Span }
  | StmtUnknown  { psSpan :: !Span }
  deriving (Show, Eq)

-- ── Expressions ────────────────────────────────────────────────────

data PythonExpr
  = BoolOpExpr
      { peBoolOp     :: !Text
      , peBoolValues :: ![PythonExpr]
      , peSpan       :: !Span
      }
  | NamedExpr
      { peNeTarget :: !PythonExpr
      , peNeValue  :: !PythonExpr
      , peSpan     :: !Span
      }
  | BinOpExpr
      { peBiLeft  :: !PythonExpr
      , peBiOp    :: !Text
      , peBiRight :: !PythonExpr
      , peSpan    :: !Span
      }
  | UnaryOpExpr
      { peUnOp      :: !Text
      , peUnOperand :: !PythonExpr
      , peSpan      :: !Span
      }
  | LambdaExpr
      { peLmArgs :: !PythonArguments
      , peLmBody :: !PythonExpr
      , peSpan   :: !Span
      }
  | IfExpr
      { peIfTest   :: !PythonExpr
      , peIfBody   :: !PythonExpr
      , peIfOrElse :: !PythonExpr
      , peSpan     :: !Span
      }
  | DictExpr
      { peDiKeys   :: ![Maybe PythonExpr]
      , peDiValues :: ![PythonExpr]
      , peSpan     :: !Span
      }
  | SetExpr
      { peSetElts :: ![PythonExpr]
      , peSpan    :: !Span
      }
  | ListCompExpr
      { peLcElt        :: !PythonExpr
      , peLcGenerators :: ![PythonComprehension]
      , peSpan         :: !Span
      }
  | SetCompExpr
      { peScElt        :: !PythonExpr
      , peScGenerators :: ![PythonComprehension]
      , peSpan         :: !Span
      }
  | DictCompExpr
      { peDcKey        :: !PythonExpr
      , peDcValue      :: !PythonExpr
      , peDcGenerators :: ![PythonComprehension]
      , peSpan         :: !Span
      }
  | GeneratorExpr
      { peGeElt        :: !PythonExpr
      , peGeGenerators :: ![PythonComprehension]
      , peSpan         :: !Span
      }
  | AwaitExpr
      { peAwValue :: !PythonExpr
      , peSpan    :: !Span
      }
  | YieldExpr
      { peYiValue :: !(Maybe PythonExpr)
      , peSpan    :: !Span
      }
  | YieldFromExpr
      { peYfValue :: !PythonExpr
      , peSpan    :: !Span
      }
  | CompareExpr
      { peCmLeft        :: !PythonExpr
      , peCmOps         :: ![Text]
      , peCmComparators :: ![PythonExpr]
      , peSpan          :: !Span
      }
  | CallExpr
      { peClFunc     :: !PythonExpr
      , peClArgs     :: ![PythonExpr]
      , peClKeywords :: ![PythonKeyword]
      , peSpan       :: !Span
      }
  | FormattedValueExpr
      { peFvValue      :: !PythonExpr
      , peFvConversion :: !Int
      , peFvFormatSpec :: !(Maybe PythonExpr)
      , peSpan         :: !Span
      }
  | JoinedStrExpr
      { peJsValues :: ![PythonExpr]
      , peSpan     :: !Span
      }
  | ConstantExpr
      { peCoValue :: !Text
      , peCoKind  :: !(Maybe Text)
      , peSpan    :: !Span
      }
  | AttributeExpr
      { peAtValue :: !PythonExpr
      , peAtAttr  :: !Text
      , peSpan    :: !Span
      }
  | SubscriptExpr
      { peSubValue :: !PythonExpr
      , peSubSlice :: !PythonExpr
      , peSpan     :: !Span
      }
  | StarredExpr
      { peStValue :: !PythonExpr
      , peSpan    :: !Span
      }
  | NameExpr
      { peNmId :: !Text
      , peSpan :: !Span
      }
  | ListExpr
      { peLiElts :: ![PythonExpr]
      , peSpan   :: !Span
      }
  | TupleExpr
      { peTuElts :: ![PythonExpr]
      , peSpan   :: !Span
      }
  | SliceExpr
      { peSlLower :: !(Maybe PythonExpr)
      , peSlUpper :: !(Maybe PythonExpr)
      , peSlStep  :: !(Maybe PythonExpr)
      , peSpan    :: !Span
      }
  | ExprUnknown
      { peSpan :: !Span
      }
  deriving (Show, Eq)

-- ── Supporting types ───────────────────────────────────────────────

data PythonArguments = PythonArguments
  { paPosonlyargs :: ![PythonArg]
  , paArgs        :: ![PythonArg]
  , paVararg      :: !(Maybe PythonArg)
  , paKwonlyargs  :: ![PythonArg]
  , paKwDefaults  :: ![Maybe PythonExpr]
  , paKwarg       :: !(Maybe PythonArg)
  , paDefaults    :: ![PythonExpr]
  } deriving (Show, Eq)

data PythonArg = PythonArg
  { pargName       :: !Text
  , pargAnnotation :: !(Maybe PythonExpr)
  , pargSpan       :: !Span
  } deriving (Show, Eq)

data PythonAlias = PythonAlias
  { palName   :: !Text
  , palAsname :: !(Maybe Text)
  , palSpan   :: !Span
  } deriving (Show, Eq)

data PythonKeyword = PythonKeyword
  { pkArg   :: !(Maybe Text)
  , pkValue :: !PythonExpr
  , pkSpan  :: !Span
  } deriving (Show, Eq)

data PythonComprehension = PythonComprehension
  { pcTarget  :: !PythonExpr
  , pcIter    :: !PythonExpr
  , pcIfs     :: ![PythonExpr]
  , pcIsAsync :: !Bool
  } deriving (Show, Eq)

data PythonExceptHandler = PythonExceptHandler
  { pehType :: !(Maybe PythonExpr)
  , pehName :: !(Maybe Text)
  , pehBody :: ![PythonStmt]
  , pehSpan :: !Span
  } deriving (Show, Eq)

data PythonWithItem = PythonWithItem
  { pwiContextExpr  :: !PythonExpr
  , pwiOptionalVars :: !(Maybe PythonExpr)
  } deriving (Show, Eq)

data PythonMatchCase = PythonMatchCase
  { pmcPattern :: !PythonPattern
  , pmcGuard   :: !(Maybe PythonExpr)
  , pmcBody    :: ![PythonStmt]
  } deriving (Show, Eq)

data PythonPattern
  = MatchValue     { mpValue :: !PythonExpr }
  | MatchSingleton { mpValue :: !PythonExpr }
  | MatchSequence  { mpPatterns :: ![PythonPattern] }
  | MatchMapping
      { mpKeys     :: ![PythonExpr]
      , mpPatterns :: ![PythonPattern]
      , mpRest     :: !(Maybe Text)
      }
  | MatchClass
      { mpCls        :: !PythonExpr
      , mpPatterns   :: ![PythonPattern]
      , mpKwdAttrs   :: ![Text]
      , mpKwdPatterns :: ![PythonPattern]
      }
  | MatchStar     { mpName :: !(Maybe Text) }
  | MatchAs
      { mpPattern :: !(Maybe PythonPattern)
      , mpAsName  :: !(Maybe Text)
      }
  | MatchOr       { mpAlternatives :: ![PythonPattern] }
  | PatternUnknown
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

defaultSpan :: Span
defaultSpan = Span (Pos 0 0) (Pos 0 0)

defaultArgs :: PythonArguments
defaultArgs = PythonArguments [] [] Nothing [] [] Nothing []

instance FromJSON PythonModule where
  parseJSON = withObject "PythonModule" $ \v -> PythonModule
    <$> v .:? "body" .!= []

instance FromJSON PythonStmt where
  parseJSON = withObject "PythonStmt" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "FunctionDef" -> FunctionDef
        <$> v .:  "name"
        <*> v .:? "args" .!= defaultArgs
        <*> v .:? "body" .!= []
        <*> v .:? "decorator_list" .!= []
        <*> v .:? "returns"
        <*> v .:? "is_async" .!= False
        <*> v .:? "span" .!= defaultSpan
      "AsyncFunctionDef" -> FunctionDef
        <$> v .:  "name"
        <*> v .:? "args" .!= defaultArgs
        <*> v .:? "body" .!= []
        <*> v .:? "decorator_list" .!= []
        <*> v .:? "returns"
        <*> pure True
        <*> v .:? "span" .!= defaultSpan
      "ClassDef" -> ClassDef
        <$> v .:  "name"
        <*> v .:? "bases" .!= []
        <*> v .:? "keywords" .!= []
        <*> v .:? "body" .!= []
        <*> v .:? "decorator_list" .!= []
        <*> v .:? "span" .!= defaultSpan
      "Return" -> ReturnStmt
        <$> v .:? "value"
        <*> v .:? "span" .!= defaultSpan
      "Delete" -> DeleteStmt
        <$> v .:? "targets" .!= []
        <*> v .:? "span" .!= defaultSpan
      "Assign" -> AssignStmt
        <$> v .:? "targets" .!= []
        <*> v .:  "value"
        <*> v .:? "span" .!= defaultSpan
      "AugAssign" -> AugAssignStmt
        <$> v .:  "target"
        <*> v .:? "op" .!= "unknown"
        <*> v .:  "value"
        <*> v .:? "span" .!= defaultSpan
      "AnnAssign" -> AnnAssignStmt
        <$> v .:  "target"
        <*> v .:  "annotation"
        <*> v .:? "value"
        <*> v .:? "simple" .!= True
        <*> v .:? "span" .!= defaultSpan
      "For" -> ForStmt
        <$> v .:  "target"
        <*> v .:  "iter"
        <*> v .:? "body" .!= []
        <*> v .:? "orelse" .!= []
        <*> v .:? "is_async" .!= False
        <*> v .:? "span" .!= defaultSpan
      "AsyncFor" -> ForStmt
        <$> v .:  "target"
        <*> v .:  "iter"
        <*> v .:? "body" .!= []
        <*> v .:? "orelse" .!= []
        <*> pure True
        <*> v .:? "span" .!= defaultSpan
      "While" -> WhileStmt
        <$> v .:  "test"
        <*> v .:? "body" .!= []
        <*> v .:? "orelse" .!= []
        <*> v .:? "span" .!= defaultSpan
      "If" -> IfStmt
        <$> v .:  "test"
        <*> v .:? "body" .!= []
        <*> v .:? "orelse" .!= []
        <*> v .:? "span" .!= defaultSpan
      "With" -> WithStmt
        <$> v .:? "items" .!= []
        <*> v .:? "body" .!= []
        <*> v .:? "is_async" .!= False
        <*> v .:? "span" .!= defaultSpan
      "AsyncWith" -> WithStmt
        <$> v .:? "items" .!= []
        <*> v .:? "body" .!= []
        <*> pure True
        <*> v .:? "span" .!= defaultSpan
      "Match" -> MatchStmt
        <$> v .:  "subject"
        <*> v .:? "cases" .!= []
        <*> v .:? "span" .!= defaultSpan
      "Raise" -> RaiseStmt
        <$> v .:? "exc"
        <*> v .:? "cause"
        <*> v .:? "span" .!= defaultSpan
      "Try" -> TryStmt
        <$> v .:? "body" .!= []
        <*> v .:? "handlers" .!= []
        <*> v .:? "orelse" .!= []
        <*> v .:? "finalbody" .!= []
        <*> v .:? "span" .!= defaultSpan
      "TryStar" -> TryStmt
        <$> v .:? "body" .!= []
        <*> v .:? "handlers" .!= []
        <*> v .:? "orelse" .!= []
        <*> v .:? "finalbody" .!= []
        <*> v .:? "span" .!= defaultSpan
      "Assert" -> AssertStmt
        <$> v .:  "test"
        <*> v .:? "msg"
        <*> v .:? "span" .!= defaultSpan
      "Import" -> ImportStmt
        <$> v .:? "names" .!= []
        <*> v .:? "span" .!= defaultSpan
      "ImportFrom" -> ImportFromStmt
        <$> v .:? "module"
        <*> v .:? "names" .!= []
        <*> v .:? "level" .!= 0
        <*> v .:? "span" .!= defaultSpan
      "Global" -> GlobalStmt
        <$> v .:? "names" .!= []
        <*> v .:? "span" .!= defaultSpan
      "Nonlocal" -> NonlocalStmt
        <$> v .:? "names" .!= []
        <*> v .:? "span" .!= defaultSpan
      "Expr" -> ExprStmt
        <$> v .:  "value"
        <*> v .:? "span" .!= defaultSpan
      "Pass" -> PassStmt
        <$> v .:? "span" .!= defaultSpan
      "Break" -> BreakStmt
        <$> v .:? "span" .!= defaultSpan
      "Continue" -> ContinueStmt
        <$> v .:? "span" .!= defaultSpan
      _ -> StmtUnknown
        <$> v .:? "span" .!= defaultSpan

instance FromJSON PythonExpr where
  parseJSON = withObject "PythonExpr" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "BoolOp" -> BoolOpExpr
        <$> v .:? "op" .!= "unknown"
        <*> v .:? "values" .!= []
        <*> v .:? "span" .!= defaultSpan
      "NamedExpr" -> NamedExpr
        <$> v .:  "target"
        <*> v .:  "value"
        <*> v .:? "span" .!= defaultSpan
      "BinOp" -> BinOpExpr
        <$> v .:  "left"
        <*> v .:? "op" .!= "unknown"
        <*> v .:  "right"
        <*> v .:? "span" .!= defaultSpan
      "UnaryOp" -> UnaryOpExpr
        <$> v .:? "op" .!= "unknown"
        <*> v .:  "operand"
        <*> v .:? "span" .!= defaultSpan
      "Lambda" -> LambdaExpr
        <$> v .:? "args" .!= defaultArgs
        <*> v .:  "body"
        <*> v .:? "span" .!= defaultSpan
      "IfExp" -> IfExpr
        <$> v .:  "test"
        <*> v .:  "body"
        <*> v .:  "orelse"
        <*> v .:? "span" .!= defaultSpan
      "Dict" -> DictExpr
        <$> v .:? "keys" .!= []
        <*> v .:? "values" .!= []
        <*> v .:? "span" .!= defaultSpan
      "Set" -> SetExpr
        <$> v .:? "elts" .!= []
        <*> v .:? "span" .!= defaultSpan
      "ListComp" -> ListCompExpr
        <$> v .:  "elt"
        <*> v .:? "generators" .!= []
        <*> v .:? "span" .!= defaultSpan
      "SetComp" -> SetCompExpr
        <$> v .:  "elt"
        <*> v .:? "generators" .!= []
        <*> v .:? "span" .!= defaultSpan
      "DictComp" -> DictCompExpr
        <$> v .:  "key"
        <*> v .:  "value"
        <*> v .:? "generators" .!= []
        <*> v .:? "span" .!= defaultSpan
      "GeneratorExp" -> GeneratorExpr
        <$> v .:  "elt"
        <*> v .:? "generators" .!= []
        <*> v .:? "span" .!= defaultSpan
      "Await" -> AwaitExpr
        <$> v .:  "value"
        <*> v .:? "span" .!= defaultSpan
      "Yield" -> YieldExpr
        <$> v .:? "value"
        <*> v .:? "span" .!= defaultSpan
      "YieldFrom" -> YieldFromExpr
        <$> v .:  "value"
        <*> v .:? "span" .!= defaultSpan
      "Compare" -> CompareExpr
        <$> v .:  "left"
        <*> v .:? "ops" .!= []
        <*> v .:? "comparators" .!= []
        <*> v .:? "span" .!= defaultSpan
      "Call" -> CallExpr
        <$> v .:  "func"
        <*> v .:? "args" .!= []
        <*> v .:? "keywords" .!= []
        <*> v .:? "span" .!= defaultSpan
      "FormattedValue" -> FormattedValueExpr
        <$> v .:  "value"
        <*> v .:? "conversion" .!= (-1)
        <*> v .:? "format_spec"
        <*> v .:? "span" .!= defaultSpan
      "JoinedStr" -> JoinedStrExpr
        <$> v .:? "values" .!= []
        <*> v .:? "span" .!= defaultSpan
      "Constant" -> ConstantExpr
        <$> (v .:? "value" .!= Null >>= parseConstantValue)
        <*> v .:? "kind"
        <*> v .:? "span" .!= defaultSpan
      "Attribute" -> AttributeExpr
        <$> v .:  "value"
        <*> v .:  "attr"
        <*> v .:? "span" .!= defaultSpan
      "Subscript" -> SubscriptExpr
        <$> v .:  "value"
        <*> v .:  "slice"
        <*> v .:? "span" .!= defaultSpan
      "Starred" -> StarredExpr
        <$> v .:  "value"
        <*> v .:? "span" .!= defaultSpan
      "Name" -> NameExpr
        <$> v .:  "id"
        <*> v .:? "span" .!= defaultSpan
      "List" -> ListExpr
        <$> v .:? "elts" .!= []
        <*> v .:? "span" .!= defaultSpan
      "Tuple" -> TupleExpr
        <$> v .:? "elts" .!= []
        <*> v .:? "span" .!= defaultSpan
      "Slice" -> SliceExpr
        <$> v .:? "lower"
        <*> v .:? "upper"
        <*> v .:? "step"
        <*> v .:? "span" .!= defaultSpan
      _ -> ExprUnknown
        <$> v .:? "span" .!= defaultSpan

-- | Helper: unwrap ArgWithDefault → PythonArg.
-- Rust serializes as: {"type": "ArgWithDefault", "arg": {"type": "Arg", ...}, "default": ...}
parseArgWithDefault :: Value -> Parser PythonArg
parseArgWithDefault = withObject "ArgWithDefault" $ \v -> do
  argObj <- v .: "arg"
  parseJSON argObj

-- | Helper: parse a list of ArgWithDefault, extracting the inner PythonArg from each.
parseArgWithDefaults :: Value -> Parser [PythonArg]
parseArgWithDefaults (Array arr) = mapM parseArgWithDefault (V.toList arr)
parseArgWithDefaults _ = pure []

instance FromJSON PythonArguments where
  parseJSON = withObject "PythonArguments" $ \v -> PythonArguments
    <$> (v .:? "posonlyargs" .!= (Array mempty) >>= parseArgWithDefaults)
    <*> (v .:? "args" .!= (Array mempty) >>= parseArgWithDefaults)
    <*> v .:? "vararg"
    <*> (v .:? "kwonlyargs" .!= (Array mempty) >>= parseArgWithDefaults)
    <*> v .:? "kw_defaults" .!= []
    <*> v .:? "kwarg"
    <*> v .:? "defaults" .!= []

instance FromJSON PythonArg where
  parseJSON = withObject "PythonArg" $ \v -> PythonArg
    <$> v .:  "arg"
    <*> v .:? "annotation"
    <*> v .:? "span" .!= defaultSpan

instance FromJSON PythonAlias where
  parseJSON = withObject "PythonAlias" $ \v -> PythonAlias
    <$> v .:  "name"
    <*> v .:? "asname"
    <*> v .:? "span" .!= defaultSpan

instance FromJSON PythonKeyword where
  parseJSON = withObject "PythonKeyword" $ \v -> PythonKeyword
    <$> v .:? "arg"
    <*> v .:  "value"
    <*> v .:? "span" .!= defaultSpan

instance FromJSON PythonComprehension where
  parseJSON = withObject "PythonComprehension" $ \v -> PythonComprehension
    <$> v .:  "target"
    <*> v .:  "iter"
    <*> v .:? "ifs" .!= []
    <*> v .:? "is_async" .!= False

instance FromJSON PythonExceptHandler where
  parseJSON = withObject "PythonExceptHandler" $ \v -> PythonExceptHandler
    <$> v .:? "exc_type"
    <*> v .:? "name"
    <*> v .:? "body" .!= []
    <*> v .:? "span" .!= defaultSpan

instance FromJSON PythonWithItem where
  parseJSON = withObject "PythonWithItem" $ \v -> PythonWithItem
    <$> v .:  "context_expr"
    <*> v .:? "optional_vars"

instance FromJSON PythonMatchCase where
  parseJSON = withObject "PythonMatchCase" $ \v -> PythonMatchCase
    <$> v .:  "pattern"
    <*> v .:? "guard"
    <*> v .:? "body" .!= []

instance FromJSON PythonPattern where
  parseJSON = withObject "PythonPattern" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "MatchValue" -> MatchValue
        <$> v .: "value"
      "MatchSingleton" -> MatchSingleton
        <$> v .: "value"
      "MatchSequence" -> MatchSequence
        <$> v .:? "patterns" .!= []
      "MatchMapping" -> MatchMapping
        <$> v .:? "keys" .!= []
        <*> v .:? "patterns" .!= []
        <*> v .:? "rest"
      "MatchClass" -> MatchClass
        <$> v .:  "cls"
        <*> v .:? "patterns" .!= []
        <*> v .:? "kwd_attrs" .!= []
        <*> v .:? "kwd_patterns" .!= []
      "MatchStar" -> MatchStar
        <$> v .:? "name"
      "MatchAs" -> MatchAs
        <$> v .:? "pattern"
        <*> v .:? "name"
      "MatchOr" -> MatchOr
        <$> v .:? "patterns" .!= []
      _ -> pure PatternUnknown
