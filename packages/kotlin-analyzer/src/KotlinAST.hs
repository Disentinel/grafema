{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE StrictData #-}
-- | Kotlin AST types with FromJSON instances dispatching on "type" field.
--
-- The AST is produced by the Kotlin parser and received as JSON from
-- the orchestrator. Each declaration node has a "type" discriminator
-- field and a "span" field for source location.
module KotlinAST
  ( KotlinFile(..)
  , KotlinImport(..)
  , KotlinDecl(..)
  , KotlinMember(..)
  , KotlinStmt(..)
  , KotlinExpr(..)
  , KotlinType(..)
  , KotlinAnnotation(..)
  , KotlinParam(..)
  , KotlinVariable(..)
  , KotlinTypeParam(..)
  , KotlinWhenEntry(..)
  , KotlinCatchClause(..)
  , KotlinPrimaryConstructor(..)
  , KotlinPropertyAccessor(..)
  , Span(..)
  , Pos(..)
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import Data.Aeson (FromJSON(..), Value(..), withObject, (.:), (.:?), (.!=))
import qualified Data.Aeson.KeyMap as KM
import Data.Aeson.Types (Parser)

-- Position & Span

data Pos = Pos
  { posLine :: !Int
  , posCol  :: !Int
  } deriving (Show, Eq)

data Span = Span
  { spanStart :: !Pos
  , spanEnd   :: !Pos
  } deriving (Show, Eq)

-- Top-level file

data KotlinFile = KotlinFile
  { kfPackage      :: !(Maybe Text)
  , kfImports      :: ![KotlinImport]
  , kfDeclarations :: ![KotlinDecl]
  } deriving (Show, Eq)

data KotlinImport = KotlinImport
  { kiName     :: !Text
  , kiAlias    :: !(Maybe Text)
  , kiAsterisk :: !Bool
  , kiSpan     :: !Span
  } deriving (Show, Eq)

-- Declarations (top-level or nested)

data KotlinDecl
  = ClassDecl
      { kdName             :: !Text
      , kdClassKind        :: !Text         -- "class", "data", "sealed", "enum", "inner", "value", "annotation"
      , kdModifiers        :: ![Text]
      , kdTypeParams       :: ![KotlinTypeParam]
      , kdPrimaryConstructor :: !(Maybe KotlinPrimaryConstructor)
      , kdSuperTypes       :: ![KotlinType]
        -- ^ Decoded from the "superTypes" key — the live kotlin-parser never
        -- emits that key for classes (it emits "extends"/"implements",
        -- KotlinAstSerializer.kt:99-123), so this list is empty on real
        -- parser output; kept for the deferred-ref path and old fixtures.
      , kdExtendsNames     :: ![Text]
        -- ^ Supertype names from the parser's "extends" entries
        -- (KtSuperTypeCallEntry — the constructor-call '()' suffix marks the
        -- class supertype). Scope-qualified when the parser provides "scope".
      , kdImplementsNames  :: ![Text]
        -- ^ Supertype names from the parser's "implements" entries (bare
        -- KtSuperTypeEntry / delegated KtDelegatedSuperTypeEntry — interfaces,
        -- plus the no-primary-constructor class supertype ambiguity; see
        -- Rules.Declarations.inheritanceMeta).
      , kdMembers          :: ![KotlinMember]
      , kdAnnotations      :: ![KotlinAnnotation]
      , kdSpan             :: !Span
      }
  | ObjectDecl
      { kdName            :: !Text
      , kdModifiers       :: ![Text]
      , kdSuperTypes      :: ![KotlinType]
      , kdExtendsNames    :: ![Text]
        -- ^ Constructor-call entries of the parser's mixed "supertypes" array
        -- (KotlinAstSerializer.kt:148-171).
      , kdImplementsNames :: ![Text]
        -- ^ Bare/delegated entries of the same array.
      , kdMembers         :: ![KotlinMember]
      , kdAnnotations     :: ![KotlinAnnotation]
      , kdSpan            :: !Span
      }
  | FunDecl
      { kdName         :: !Text
      , kdModifiers    :: ![Text]
      , kdTypeParams   :: ![KotlinTypeParam]
      , kdReceiverType :: !(Maybe KotlinType)
      , kdParams       :: ![KotlinParam]
      , kdReturnType   :: !(Maybe KotlinType)
      , kdBody         :: !(Maybe KotlinStmt)
      , kdAnnotations  :: ![KotlinAnnotation]
      , kdSpan         :: !Span
      }
  | PropertyDecl
      { kdName        :: !Text
      , kdModifiers   :: ![Text]
      , kdIsVal       :: !Bool
      , kdPropertyType :: !(Maybe KotlinType)
      , kdInitializer :: !(Maybe KotlinExpr)
      , kdGetter      :: !(Maybe KotlinPropertyAccessor)
      , kdSetter      :: !(Maybe KotlinPropertyAccessor)
      , kdDelegated   :: !Bool
      , kdAnnotations :: ![KotlinAnnotation]
      , kdSpan        :: !Span
      }
  | TypeAliasDecl
      { kdName        :: !Text
      , kdModifiers   :: ![Text]
      , kdTypeParams  :: ![KotlinTypeParam]
      , kdAliasedType :: !KotlinType
      , kdAnnotations :: ![KotlinAnnotation]
      , kdSpan        :: !Span
      }
  | DeclUnknown
      { kdSpan :: !Span
      }
  deriving (Show, Eq)

data KotlinPrimaryConstructor = KotlinPrimaryConstructor
  { kpcModifiers   :: ![Text]
  , kpcParams      :: ![KotlinParam]
  , kpcAnnotations :: ![KotlinAnnotation]
  , kpcSpan        :: !Span
  } deriving (Show, Eq)

data KotlinPropertyAccessor = KotlinPropertyAccessor
  { kpaKind       :: !Text    -- "get" or "set"
  , kpaModifiers  :: ![Text]
  , kpaBody       :: !(Maybe KotlinStmt)
  , kpaSpan       :: !Span
  } deriving (Show, Eq)

-- Members (inside class/object bodies)

data KotlinMember
  = FunMember
      { kmName         :: !Text
      , kmModifiers    :: ![Text]
      , kmTypeParams   :: ![KotlinTypeParam]
      , kmReceiverType :: !(Maybe KotlinType)
      , kmParams       :: ![KotlinParam]
      , kmReturnType   :: !(Maybe KotlinType)
      , kmBody         :: !(Maybe KotlinStmt)
      , kmAnnotations  :: ![KotlinAnnotation]
      , kmSpan         :: !Span
      }
  | PropertyMember
      { kmpName        :: !Text
      , kmpModifiers   :: ![Text]
      , kmpIsVal       :: !Bool
      , kmpPropertyType :: !(Maybe KotlinType)
      , kmpInitializer :: !(Maybe KotlinExpr)
      , kmpGetter      :: !(Maybe KotlinPropertyAccessor)
      , kmpSetter      :: !(Maybe KotlinPropertyAccessor)
      , kmpDelegated   :: !Bool
      , kmpAnnotations :: ![KotlinAnnotation]
      , kmpSpan        :: !Span
      }
  | SecondaryConstructor
      { kmcModifiers   :: ![Text]
      , kmcParams      :: ![KotlinParam]
      , kmcDelegation  :: !(Maybe Text)    -- "this" or "super"
      , kmcDelegationArgs :: ![KotlinExpr]
      , kmcBody        :: !(Maybe KotlinStmt)
      , kmcAnnotations :: ![KotlinAnnotation]
      , kmcSpan        :: !Span
      }
  | InitBlock
      { kmiBody :: !KotlinStmt
      , kmiSpan :: !Span
      }
  | CompanionObjectMember
      { kmcoName       :: !(Maybe Text)
      , kmcoSuperTypes :: ![KotlinType]
      , kmcoMembers    :: ![KotlinMember]
      , kmcoAnnotations :: ![KotlinAnnotation]
      , kmcoSpan       :: !Span
      }
  | NestedClassMember
      { kmnDecl :: !KotlinDecl
      , kmnSpan :: !Span
      }
  | EnumEntryMember
      { kmeeName       :: !Text
      , kmeeArgs       :: ![KotlinExpr]
      , kmeeMembers    :: ![KotlinMember]
      , kmeeAnnotations :: ![KotlinAnnotation]
      , kmeeSpan       :: !Span
      }
  | MemberUnknown
      { kmuSpan :: !Span
      }
  deriving (Show, Eq)

-- Type parameters

data KotlinTypeParam = KotlinTypeParam
  { ktpName     :: !Text
  , ktpVariance :: !(Maybe Text)  -- "in", "out", or Nothing
  , ktpBounds   :: ![KotlinType]
  , ktpReified  :: !Bool
  , ktpSpan     :: !Span
  } deriving (Show, Eq)

-- Parameters

data KotlinParam = KotlinParam
  { kpName        :: !Text
  , kpType        :: !KotlinType
  , kpIsVal       :: !Bool        -- val in primary constructor
  , kpIsVar       :: !Bool        -- var in primary constructor
  , kpDefault     :: !(Maybe KotlinExpr)
  , kpIsVararg    :: !Bool
  , kpAnnotations :: ![KotlinAnnotation]
  , kpSpan        :: !Span
  } deriving (Show, Eq)

data KotlinVariable = KotlinVariable
  { kvName :: !Text
  , kvType :: !(Maybe KotlinType)
  , kvInit :: !(Maybe KotlinExpr)
  , kvSpan :: !Span
  } deriving (Show, Eq)

-- Statements

data KotlinStmt
  = ExprStmt      { ksExpr :: !KotlinExpr, ksSpan :: !Span }
  | BlockStmt     { ksStmts :: ![KotlinStmt], ksSpan :: !Span }
  | ReturnStmt    { ksReturnExpr :: !(Maybe KotlinExpr), ksLabel :: !(Maybe Text), ksSpan :: !Span }
  | ThrowStmt     { ksThrowExpr :: !KotlinExpr, ksSpan :: !Span }
  | IfStmt        { ksCondition :: !KotlinExpr, ksThen :: !KotlinStmt
                  , ksElse :: !(Maybe KotlinStmt), ksSpan :: !Span }
  | WhenStmt      { ksWhenSubject :: !(Maybe KotlinExpr)
                  , ksWhenEntries :: ![KotlinWhenEntry], ksSpan :: !Span }
  | WhileStmt     { ksWhileCond :: !KotlinExpr, ksWhileBody :: !KotlinStmt
                  , ksSpan :: !Span }
  | DoWhileStmt   { ksDoCond :: !KotlinExpr, ksDoBody :: !KotlinStmt
                  , ksSpan :: !Span }
  | ForStmt       { ksForVar :: !KotlinVariable
                  , ksForIter :: !KotlinExpr
                  , ksForBody :: !KotlinStmt, ksSpan :: !Span }
  | TryStmt       { ksTryBlock :: !KotlinStmt
                  , ksCatches :: ![KotlinCatchClause]
                  , ksFinally :: !(Maybe KotlinStmt), ksSpan :: !Span }
  | BreakStmt     { ksBreakLabel :: !(Maybe Text), ksSpan :: !Span }
  | ContinueStmt  { ksContinueLabel :: !(Maybe Text), ksSpan :: !Span }
  | VarDeclStmt   { ksVarIsVal :: !Bool
                  , ksVarDecls :: ![KotlinVariable], ksSpan :: !Span }
  | EmptyStmt     { ksSpan :: !Span }
  | StmtUnknown   { ksSpan :: !Span }
  deriving (Show, Eq)

data KotlinWhenEntry = KotlinWhenEntry
  { kweConditions :: ![KotlinExpr]
  , kweBody       :: !KotlinStmt
  , kweIsElse     :: !Bool
  , kweSpan       :: !Span
  } deriving (Show, Eq)

data KotlinCatchClause = KotlinCatchClause
  { kccParamName :: !Text
  , kccParamType :: !KotlinType
  , kccBody      :: !KotlinStmt
  , kccSpan      :: !Span
  } deriving (Show, Eq)

-- Expressions

data KotlinExpr
  = CallExpr
      { keCallName  :: !Text
      , keCallScope :: !(Maybe KotlinExpr)
      , keCallArgs  :: ![KotlinExpr]
      , keCallTypeArgs :: ![KotlinType]
      , keSpan      :: !Span
      }
  | SafeCallExpr
      { keSafeScope :: !KotlinExpr
      , keSafeName  :: !Text
      , keSafeArgs  :: ![KotlinExpr]
      , keSpan      :: !Span
      }
  | ObjectCreationExpr
      { keOcClassType :: !KotlinType
      , keOcArgs      :: ![KotlinExpr]
      , keOcTypeArgs  :: ![KotlinType]
      , keSpan        :: !Span
      }
  | PropertyAccessExpr
      { kePaScope :: !KotlinExpr
      , kePaName  :: !Text
      , keSpan    :: !Span
      }
  | NameExpr
      { keNeName :: !Text
      , keSpan   :: !Span
      }
  | AssignExpr
      { keAsTarget :: !KotlinExpr
      , keAsOp     :: !Text
      , keAsValue  :: !KotlinExpr
      , keSpan     :: !Span
      }
  | BinaryExpr
      { keBiLeft  :: !KotlinExpr
      , keBiOp    :: !Text
      , keBiRight :: !KotlinExpr
      , keSpan    :: !Span
      }
  | UnaryExpr
      { keUnOp     :: !Text
      , keUnPrefix :: !Bool
      , keUnExpr   :: !KotlinExpr
      , keSpan     :: !Span
      }
  | WhenExpr
      { keWeSubject :: !(Maybe KotlinExpr)
      , keWeEntries :: ![KotlinWhenEntry]
      , keSpan      :: !Span
      }
  | IfExpr
      { keIfCond :: !KotlinExpr
      , keIfThen :: !KotlinExpr
      , keIfElse :: !(Maybe KotlinExpr)
      , keSpan   :: !Span
      }
  | ElvisExpr
      { keElLeft  :: !KotlinExpr
      , keElRight :: !KotlinExpr
      , keSpan    :: !Span
      }
  | NotNullAssertExpr
      { keNnExpr :: !KotlinExpr
      , keSpan   :: !Span
      }
  | IsExpr
      { keIsExpr    :: !KotlinExpr
      , keIsType    :: !KotlinType
      , keIsNegated :: !Bool
      , keSpan      :: !Span
      }
  | AsExpr
      { keAsExpr    :: !KotlinExpr
      , keAsCastType :: !KotlinType
      , keAsSafe    :: !Bool
      , keSpan      :: !Span
      }
  | LambdaExpr
      { keLmParams :: ![KotlinParam]
      , keLmBody   :: !KotlinStmt
      , keSpan     :: !Span
      }
  | StringTemplateExpr
      { keStParts :: ![KotlinExpr]
      , keSpan    :: !Span
      }
  | StringLiteralPart
      { keSlValue :: !Text
      , keSpan    :: !Span
      }
  | StringExprPart
      { keSeExpr :: !KotlinExpr
      , keSpan   :: !Span
      }
  | RangeExpr
      { keRgLeft  :: !KotlinExpr
      , keRgRight :: !KotlinExpr
      , keRgOp    :: !Text       -- ".." or "..<" or "downTo" or "until"
      , keSpan    :: !Span
      }
  | DestructuringDecl
      { keDdEntries :: ![KotlinVariable]
      , keDdInit    :: !KotlinExpr
      , keSpan      :: !Span
      }
  | ThisExpr
      { keThisLabel :: !(Maybe Text)
      , keSpan      :: !Span
      }
  | SuperExpr
      { keSuperLabel :: !(Maybe Text)
      , keSuperType  :: !(Maybe KotlinType)
      , keSpan       :: !Span
      }
  | LiteralExpr
      { keLitType  :: !Text
      , keLitValue :: !Text
      , keSpan     :: !Span
      }
  | EnclosedExpr
      { keEnInner :: !KotlinExpr
      , keSpan    :: !Span
      }
  | ExprUnknown
      { keSpan :: !Span
      }
  deriving (Show, Eq)

-- Types

data KotlinType
  = SimpleType
      { ktName     :: !Text
      , ktTypeArgs :: ![KotlinType]
      , ktNullable :: !Bool
      , ktSpan     :: !Span
      }
  | FunctionType
      { ktFtReceiver  :: !(Maybe KotlinType)
      , ktFtParams    :: ![KotlinType]
      , ktFtReturn    :: !KotlinType
      , ktFtNullable  :: !Bool
      , ktFtSuspend   :: !Bool
      , ktSpan        :: !Span
      }
  | NullableType
      { ktInner    :: !KotlinType
      , ktSpan     :: !Span
      }
  | StarProjection
      { ktSpan :: !Span
      }
  | TypeUnknown
      { ktSpan :: !Span
      }
  deriving (Show, Eq)

-- Annotations

data KotlinAnnotation
  = MarkerAnnotation
      { kaMarkerName :: !Text
      , kaUseSite    :: !(Maybe Text)
      , kaSpan       :: !Span
      }
  | NormalAnnotation
      { kaNormalName    :: !Text
      , kaNormalArgs    :: ![KotlinExpr]
      , kaUseSite       :: !(Maybe Text)
      , kaSpan          :: !Span
      }
  | AnnotationUnknown
      { kaUnkName :: !Text
      , kaSpan    :: !Span
      }
  deriving (Show, Eq)

-- FromJSON instances

instance FromJSON Pos where
  parseJSON = withObject "Pos" $ \v -> Pos
    <$> v .: "line"
    <*> v .: "col"

instance FromJSON Span where
  parseJSON = withObject "Span" $ \v -> Span
    <$> v .: "start"
    <*> v .: "end"

instance FromJSON KotlinFile where
  parseJSON = withObject "KotlinFile" $ \v -> KotlinFile
    <$> v .:? "package"
    <*> v .:? "imports" .!= []
    <*> v .:? "declarations" .!= []

instance FromJSON KotlinImport where
  parseJSON = withObject "KotlinImport" $ \v -> KotlinImport
    <$> v .:  "name"
    <*> v .:? "alias"
    <*> v .:? "asterisk" .!= False
    <*> v .:  "span"

instance FromJSON KotlinPrimaryConstructor where
  parseJSON = withObject "KotlinPrimaryConstructor" $ \v -> KotlinPrimaryConstructor
    <$> v .:? "modifiers" .!= []
    <*> v .:? "params" .!= []
    <*> v .:? "annotations" .!= []
    <*> v .:  "span"

instance FromJSON KotlinPropertyAccessor where
  parseJSON = withObject "KotlinPropertyAccessor" $ \v -> KotlinPropertyAccessor
    <$> v .:  "kind"
    <*> v .:? "modifiers" .!= []
    <*> v .:? "body"
    <*> v .:  "span"

instance FromJSON KotlinTypeParam where
  parseJSON = withObject "KotlinTypeParam" $ \v -> KotlinTypeParam
    <$> v .:  "name"
    <*> v .:? "variance"
    <*> v .:? "bounds" .!= []
    <*> v .:? "reified" .!= False
    <*> v .:  "span"

instance FromJSON KotlinDecl where
  parseJSON = withObject "KotlinDecl" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "ClassDecl" -> do
        -- The live parser splits the supertype list into "extends"
        -- (constructor-call entries) and "implements" (bare/delegated);
        -- see parseSuperTypeEntry.
        extEntries  <- v .:? "extends"    .!= []
        implEntries <- v .:? "implements" .!= []
        ClassDecl
          <$> v .:  "name"
          <*> v .:? "kind" .!= "class"
          <*> v .:? "modifiers" .!= []
          <*> v .:? "typeParameters" .!= []
          <*> v .:? "primaryConstructor"
          <*> v .:? "superTypes" .!= []
          <*> pure (superTypeEntryNames extEntries)
          <*> pure (superTypeEntryNames implEntries)
          <*> v .:? "members" .!= []
          <*> v .:? "annotations" .!= []
          <*> v .:  "span"
      "ObjectDecl" -> do
        -- The live parser emits ONE mixed "supertypes" array for objects;
        -- constructor-call entries (wrapped, with "args") are the class
        -- supertype, the rest are interfaces.
        entries <- v .:? "supertypes" .!= []
        let pairs = map parseSuperTypeEntry entries
        ObjectDecl
          <$> v .:  "name"
          <*> v .:? "modifiers" .!= []
          <*> v .:? "superTypes" .!= []
          <*> pure [ n | (True,  n) <- pairs, not (T.null n) ]
          <*> pure [ n | (False, n) <- pairs, not (T.null n) ]
          <*> v .:? "members" .!= []
          <*> v .:? "annotations" .!= []
          <*> v .:  "span"
      "FunDecl" -> FunDecl
        <$> v .:  "name"
        <*> v .:? "modifiers" .!= []
        <*> v .:? "typeParameters" .!= []
        <*> v .:? "receiverType"
        <*> v .:? "params" .!= []
        <*> v .:? "returnType"
        <*> v .:? "body"
        <*> v .:? "annotations" .!= []
        <*> v .:  "span"
      "PropertyDecl" -> PropertyDecl
        <$> v .:  "name"
        <*> v .:? "modifiers" .!= []
        <*> v .:? "isVal" .!= True
        <*> v .:? "propertyType"
        <*> v .:? "initializer"
        <*> v .:? "getter"
        <*> v .:? "setter"
        <*> v .:? "delegated" .!= False
        <*> v .:? "annotations" .!= []
        <*> v .:  "span"
      "TypeAlias" -> TypeAliasDecl
        <$> v .:  "name"
        <*> v .:? "modifiers" .!= []
        <*> v .:? "typeParameters" .!= []
        <*> v .:  "aliasedType"
        <*> v .:? "annotations" .!= []
        <*> v .:  "span"
      _ -> DeclUnknown
        <$> v .: "span"

-- Supertype-list entry decoding (the live kotlin-parser vocabulary).
--
-- serializeClass (KotlinAstSerializer.kt:99-123) emits
--   "extends"    = [{type: <typeref>, args, span}]            (KtSuperTypeCallEntry)
--   "implements" = [<typeref> | {type: <typeref>, delegate, span}]
--                                  (KtSuperTypeEntry / KtDelegatedSuperTypeEntry)
-- and serializeObject (:148-171) one mixed "supertypes" array of the same two
-- shapes. The typeref itself is {"type":"ClassType","name":N,"scope":Q?,...}.
-- Both helpers are total: malformed entries yield "" and are dropped upstream.

-- | One supertype-list entry → (isConstructorCall, supertype name).
-- A wrapped entry holds the typeref under "type" (an Object, vs the String
-- discriminator of a direct typeref); "args" marks the constructor-call form.
parseSuperTypeEntry :: Value -> (Bool, Text)
parseSuperTypeEntry (Object v) =
  case KM.lookup "type" v of
    Just inner@(Object _) -> (KM.member "args" v, superTypeRefName inner)
    _                     -> (False, superTypeRefName (Object v))
parseSuperTypeEntry _ = (False, "")

-- | All non-empty names of a supertype-entry list (classification dropped —
-- the ClassDecl keys are pre-classified by the parser).
superTypeEntryNames :: [Value] -> [Text]
superTypeEntryNames = filter (not . T.null) . map (snd . parseSuperTypeEntry)

-- | The name of a supertype reference, scope-qualified when the parser
-- provides "scope" ("java.util" + "AbstractList" → "java.util.AbstractList").
-- Type arguments are NOT part of the name (generics stripped). Accepts the
-- live parser tag "ClassType" and the analyzer-internal/test tag "SimpleType";
-- nullable wrappers unwrap; anything else (function types, star projections,
-- unknowns) yields "".
superTypeRefName :: Value -> Text
superTypeRefName (Object v) =
  case KM.lookup "type" v of
    Just (String "ClassType")  -> qualifiedName
    Just (String "SimpleType") -> qualifiedName
    Just (String "NullableType") ->
      case KM.lookup "inner" v of
        Just inner -> superTypeRefName inner
        Nothing    -> ""
    _ -> ""
  where
    qualifiedName =
      let n = case KM.lookup "name" v of
                Just (String t) -> t
                _               -> ""
          mScope = case KM.lookup "scope" v of
                     Just (String s) -> Just s
                     _               -> Nothing
      in if T.null n then "" else maybe n (\s -> s <> "." <> n) mScope
superTypeRefName _ = ""

instance FromJSON KotlinMember where
  parseJSON = withObject "KotlinMember" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "FunDecl" -> FunMember
        <$> v .:  "name"
        <*> v .:? "modifiers" .!= []
        <*> v .:? "typeParameters" .!= []
        <*> v .:? "receiverType"
        <*> v .:? "params" .!= []
        <*> v .:? "returnType"
        <*> v .:? "body"
        <*> v .:? "annotations" .!= []
        <*> v .:  "span"
      "PropertyDecl" -> PropertyMember
        <$> v .:  "name"
        <*> v .:? "modifiers" .!= []
        <*> v .:? "isVal" .!= True
        <*> v .:? "propertyType"
        <*> v .:? "initializer"
        <*> v .:? "getter"
        <*> v .:? "setter"
        <*> v .:? "delegated" .!= False
        <*> v .:? "annotations" .!= []
        <*> v .:  "span"
      "SecondaryConstructor" -> SecondaryConstructor
        <$> v .:? "modifiers" .!= []
        <*> v .:? "params" .!= []
        <*> v .:? "delegation"
        <*> v .:? "delegationArgs" .!= []
        <*> v .:? "body"
        <*> v .:? "annotations" .!= []
        <*> v .:  "span"
      "InitBlock" -> InitBlock
        <$> v .:  "body"
        <*> v .:  "span"
      "CompanionObject" -> CompanionObjectMember
        <$> v .:? "name"
        <*> v .:? "superTypes" .!= []
        <*> v .:? "members" .!= []
        <*> v .:? "annotations" .!= []
        <*> v .:  "span"
      "NestedClass" -> NestedClassMember
        <$> v .:  "decl"
        <*> v .:  "span"
      "EnumEntry" -> EnumEntryMember
        <$> v .:  "name"
        <*> v .:? "args" .!= []
        <*> v .:? "members" .!= []
        <*> v .:? "annotations" .!= []
        <*> v .:  "span"
      _ -> MemberUnknown
        <$> v .: "span"

instance FromJSON KotlinParam where
  parseJSON = withObject "KotlinParam" $ \v -> KotlinParam
    <$> v .:  "name"
    <*> v .:  "paramType"
    <*> v .:? "isVal" .!= False
    <*> v .:? "isVar" .!= False
    <*> v .:? "default"
    <*> v .:? "isVararg" .!= False
    <*> v .:? "annotations" .!= []
    <*> v .:  "span"

instance FromJSON KotlinVariable where
  parseJSON = withObject "KotlinVariable" $ \v -> KotlinVariable
    <$> v .:  "name"
    <*> v .:? "varType"
    <*> v .:? "init"
    <*> v .:  "span"

instance FromJSON KotlinStmt where
  parseJSON = withObject "KotlinStmt" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "ExprStmt" -> ExprStmt
        <$> v .: "expr"
        <*> v .: "span"
      "BlockStmt" -> BlockStmt
        <$> v .:? "stmts" .!= []
        <*> v .:  "span"
      "ReturnStmt" -> ReturnStmt
        <$> v .:? "expr"
        <*> v .:? "label"
        <*> v .:  "span"
      "ThrowStmt" -> ThrowStmt
        <$> v .: "expr"
        <*> v .: "span"
      "IfStmt" -> IfStmt
        <$> v .:  "condition"
        <*> v .:  "then"
        <*> v .:? "else"
        <*> v .:  "span"
      "WhenStmt" -> WhenStmt
        <$> v .:? "subject"
        <*> v .:? "entries" .!= []
        <*> v .:  "span"
      "WhileStmt" -> WhileStmt
        <$> v .: "condition"
        <*> v .: "body"
        <*> v .: "span"
      "DoWhileStmt" -> DoWhileStmt
        <$> v .: "condition"
        <*> v .: "body"
        <*> v .: "span"
      "ForStmt" -> ForStmt
        <$> v .: "variable"
        <*> v .: "iterable"
        <*> v .: "body"
        <*> v .: "span"
      "TryStmt" -> TryStmt
        <$> v .:  "tryBlock"
        <*> v .:? "catches" .!= []
        <*> v .:? "finally"
        <*> v .:  "span"
      "BreakStmt" -> BreakStmt
        <$> v .:? "label"
        <*> v .:  "span"
      "ContinueStmt" -> ContinueStmt
        <$> v .:? "label"
        <*> v .:  "span"
      "VarDeclStmt" -> VarDeclStmt
        <$> v .:? "isVal" .!= True
        <*> v .:? "variables" .!= []
        <*> v .:  "span"
      "EmptyStmt" -> EmptyStmt
        <$> v .: "span"
      _ -> StmtUnknown
        <$> v .: "span"

instance FromJSON KotlinWhenEntry where
  parseJSON = withObject "KotlinWhenEntry" $ \v -> KotlinWhenEntry
    <$> v .:? "conditions" .!= []
    <*> v .:  "body"
    <*> v .:? "isElse" .!= False
    <*> v .:  "span"

instance FromJSON KotlinCatchClause where
  parseJSON = withObject "KotlinCatchClause" $ \v -> KotlinCatchClause
    <$> v .: "paramName"
    <*> v .: "paramType"
    <*> v .: "body"
    <*> v .: "span"

instance FromJSON KotlinExpr where
  parseJSON = withObject "KotlinExpr" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "CallExpr" -> CallExpr
        <$> v .:  "name"
        <*> v .:? "scope"
        <*> v .:? "args" .!= []
        <*> v .:? "typeArgs" .!= []
        <*> v .:  "span"
      "SafeCallExpr" -> SafeCallExpr
        <$> v .: "scope"
        <*> v .: "name"
        <*> v .:? "args" .!= []
        <*> v .: "span"
      "ObjectCreationExpr" -> ObjectCreationExpr
        <$> v .:  "classType"
        <*> v .:? "args" .!= []
        <*> v .:? "typeArgs" .!= []
        <*> v .:  "span"
      "PropertyAccessExpr" -> PropertyAccessExpr
        <$> v .: "scope"
        <*> v .: "name"
        <*> v .: "span"
      "NameExpr" -> NameExpr
        <$> v .: "name"
        <*> v .: "span"
      "AssignExpr" -> AssignExpr
        <$> v .:  "target"
        <*> v .:? "operator" .!= "="
        <*> v .:  "value"
        <*> v .:  "span"
      "BinaryExpr" -> BinaryExpr
        <$> v .: "left"
        <*> v .: "operator"
        <*> v .: "right"
        <*> v .: "span"
      "UnaryExpr" -> UnaryExpr
        <$> v .:  "operator"
        <*> v .:? "prefix" .!= True
        <*> v .:  "expr"
        <*> v .:  "span"
      "WhenExpr" -> WhenExpr
        <$> v .:? "subject"
        <*> v .:? "entries" .!= []
        <*> v .:  "span"
      "IfExpr" -> IfExpr
        <$> v .: "condition"
        <*> v .: "then"
        <*> v .:? "else"
        <*> v .:  "span"
      "ElvisExpr" -> ElvisExpr
        <$> v .: "left"
        <*> v .: "right"
        <*> v .: "span"
      "NotNullAssertExpr" -> NotNullAssertExpr
        <$> v .: "expr"
        <*> v .: "span"
      "IsExpr" -> IsExpr
        <$> v .:  "expr"
        <*> v .:  "checkType"
        <*> v .:? "negated" .!= False
        <*> v .:  "span"
      "AsExpr" -> AsExpr
        <$> v .:  "expr"
        <*> v .:  "castType"
        <*> v .:? "safe" .!= False
        <*> v .:  "span"
      "LambdaExpr" -> LambdaExpr
        <$> v .:? "params" .!= []
        <*> v .:  "body"
        <*> v .:  "span"
      "StringTemplateExpr" -> StringTemplateExpr
        <$> v .:? "parts" .!= []
        <*> v .:  "span"
      "StringLiteralPart" -> StringLiteralPart
        <$> v .: "value"
        <*> v .: "span"
      "StringExprPart" -> StringExprPart
        <$> v .: "expr"
        <*> v .: "span"
      "RangeExpr" -> RangeExpr
        <$> v .:  "left"
        <*> v .:  "right"
        <*> v .:? "operator" .!= ".."
        <*> v .:  "span"
      "DestructuringDecl" -> DestructuringDecl
        <$> v .:? "entries" .!= []
        <*> v .:  "init"
        <*> v .:  "span"
      "ThisExpr" -> ThisExpr
        <$> v .:? "label"
        <*> v .:  "span"
      "SuperExpr" -> SuperExpr
        <$> v .:? "label"
        <*> v .:? "superType"
        <*> v .:  "span"
      "LiteralExpr" -> LiteralExpr
        <$> v .: "literalType"
        <*> v .: "value"
        <*> v .: "span"
      "EnclosedExpr" -> EnclosedExpr
        <$> v .: "inner"
        <*> v .: "span"
      _ -> ExprUnknown
        <$> v .: "span"

instance FromJSON KotlinType where
  parseJSON = withObject "KotlinType" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "SimpleType" -> SimpleType
        <$> v .:  "name"
        <*> v .:? "typeArgs" .!= []
        <*> v .:? "nullable" .!= False
        <*> v .:  "span"
      "FunctionType" -> FunctionType
        <$> v .:? "receiver"
        <*> v .:? "paramTypes" .!= []
        <*> v .:  "returnType"
        <*> v .:? "nullable" .!= False
        <*> v .:? "suspend" .!= False
        <*> v .:  "span"
      "NullableType" -> NullableType
        <$> v .: "inner"
        <*> v .: "span"
      "StarProjection" -> StarProjection
        <$> v .: "span"
      _ -> TypeUnknown
        <$> v .: "span"

instance FromJSON KotlinAnnotation where
  parseJSON = withObject "KotlinAnnotation" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "MarkerAnnotation" -> MarkerAnnotation
        <$> v .:  "name"
        <*> v .:? "useSite"
        <*> v .:  "span"
      "NormalAnnotation" -> NormalAnnotation
        <$> v .:  "name"
        <*> v .:? "args" .!= []
        <*> v .:? "useSite"
        <*> v .:  "span"
      _ -> AnnotationUnknown
        <$> v .:? "name" .!= "<unknown>"
        <*> v .:  "span"
