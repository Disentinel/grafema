{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE StrictData #-}
-- | Java AST types with FromJSON instances dispatching on "type" field.
-- Follows the same pattern as RustAST.hs for the rust-analyzer.
--
-- The AST is produced by the Java parser (JavaParser-based) and received
-- as JSON from the orchestrator. Each node has a "type" discriminator
-- field and a "span" field for source location.
module JavaAST
  ( JavaFile(..)
  , JavaImport(..)
  , JavaTypeDecl(..)
  , JavaMember(..)
  , JavaStmt(..)
  , JavaExpr(..)
  , JavaType(..)
  , JavaAnnotation(..)
  , JavaParam(..)
  , JavaVariable(..)
  , JavaTypeParam(..)
  , JavaSwitchEntry(..)
  , JavaCatchClause(..)
  , Span(..)
  , Pos(..)
  ) where

import Data.Text (Text)
import Data.Aeson (FromJSON(..), Value, withObject, (.:), (.:?), (.!=))
import Data.Aeson.Types (Parser)

-- ── Position & Span (same as RustAST) ────────────────────────────────

data Pos = Pos
  { posLine :: !Int
  , posCol  :: !Int
  } deriving (Show, Eq)

data Span = Span
  { spanStart :: !Pos
  , spanEnd   :: !Pos
  } deriving (Show, Eq)

-- ── Top-level file ───────────────────────────────────────────────────

data JavaFile = JavaFile
  { jfPackage :: !(Maybe Text)
  , jfImports :: ![JavaImport]
  , jfTypes   :: ![JavaTypeDecl]
  } deriving (Show, Eq)

data JavaImport = JavaImport
  { jiName     :: !Text
  , jiStatic   :: !Bool
  , jiAsterisk :: !Bool
  , jiSpan     :: !Span
  } deriving (Show, Eq)

-- ── Type declarations ────────────────────────────────────────────────

data JavaTypeDecl
  = ClassDecl
      { jtdName        :: !Text
      , jtdModifiers   :: ![Text]
      , jtdTypeParams  :: ![JavaTypeParam]
      , jtdExtends     :: !(Maybe JavaType)
      , jtdImplements  :: ![JavaType]
      , jtdMembers     :: ![JavaMember]
      , jtdAnnotations :: ![JavaAnnotation]
      , jtdSpan        :: !Span
      }
  | InterfaceDecl
      { jtdName        :: !Text
      , jtdModifiers   :: ![Text]
      , jtdTypeParams  :: ![JavaTypeParam]
      , jtdExtends'    :: ![JavaType]       -- interfaces can extend multiple
      , jtdMembers     :: ![JavaMember]
      , jtdAnnotations :: ![JavaAnnotation]
      , jtdSpan        :: !Span
      }
  | EnumDecl
      { jtdName        :: !Text
      , jtdModifiers   :: ![Text]
      , jtdImplements  :: ![JavaType]
      , jtdConstants   :: ![JavaMember]     -- EnumConstant members
      , jtdMembers     :: ![JavaMember]
      , jtdAnnotations :: ![JavaAnnotation]
      , jtdSpan        :: !Span
      }
  | RecordDecl
      { jtdName        :: !Text
      , jtdModifiers   :: ![Text]
      , jtdTypeParams  :: ![JavaTypeParam]
      , jtdImplements  :: ![JavaType]
      , jtdComponents  :: ![JavaParam]
      , jtdMembers     :: ![JavaMember]
      , jtdAnnotations :: ![JavaAnnotation]
      , jtdSpan        :: !Span
      }
  | AnnotationTypeDecl
      { jtdName        :: !Text
      , jtdModifiers   :: ![Text]
      , jtdMembers     :: ![JavaMember]
      , jtdSpan        :: !Span
      }
  deriving (Show, Eq)

data JavaTypeParam = JavaTypeParam
  { jtpName   :: !Text
  , jtpBounds :: ![JavaType]
  , jtpSpan   :: !Span
  } deriving (Show, Eq)

-- ── Members ──────────────────────────────────────────────────────────

data JavaMember
  = MethodMember
      { jmName        :: !Text
      , jmModifiers   :: ![Text]
      , jmTypeParams  :: ![JavaTypeParam]
      , jmReturnType  :: !JavaType
      , jmParams      :: ![JavaParam]
      , jmThrows      :: ![JavaType]
      , jmBody        :: !(Maybe JavaStmt)
      , jmAnnotations :: ![JavaAnnotation]
      , jmSpan        :: !Span
      }
  | ConstructorMember
      { jmcName        :: !Text
      , jmcModifiers   :: ![Text]
      , jmcTypeParams  :: ![JavaTypeParam]
      , jmcParams      :: ![JavaParam]
      , jmcThrows      :: ![JavaType]
      , jmcBody        :: !JavaStmt
      , jmcAnnotations :: ![JavaAnnotation]
      , jmcSpan        :: !Span
      }
  | CompactConstructorMember
      { jmccName        :: !Text
      , jmccModifiers   :: ![Text]
      , jmccBody        :: !JavaStmt
      , jmccAnnotations :: ![JavaAnnotation]
      , jmccSpan        :: !Span
      }
  | FieldMember
      { jmfModifiers   :: ![Text]
      , jmfFieldType   :: !JavaType
      , jmfVariables   :: ![JavaVariable]
      , jmfAnnotations :: ![JavaAnnotation]
      , jmfSpan        :: !Span
      }
  | EnumConstantMember
      { jmecName        :: !Text
      , jmecArgs        :: ![JavaExpr]
      , jmecClassBody   :: ![JavaMember]
      , jmecAnnotations :: ![JavaAnnotation]
      , jmecSpan        :: !Span
      }
  | InitializerMember
      { jmiIsStatic :: !Bool
      , jmiBody     :: !JavaStmt
      , jmiSpan     :: !Span
      }
  | AnnotationMemberDecl
      { jmaName         :: !Text
      , jmaReturnType   :: !JavaType
      , jmaDefaultValue :: !(Maybe JavaExpr)
      , jmaSpan         :: !Span
      }
  | NestedTypeMember
      { jmntTypeDecl :: !JavaTypeDecl
      , jmntSpan     :: !Span
      }
  | MemberUnknown
      { jmuSpan :: !Span
      }
  deriving (Show, Eq)

data JavaVariable = JavaVariable
  { jvName :: !Text
  , jvType :: !JavaType
  , jvInit :: !(Maybe JavaExpr)
  , jvSpan :: !Span
  } deriving (Show, Eq)

data JavaParam = JavaParam
  { jpName        :: !Text
  , jpType        :: !JavaType
  , jpIsFinal     :: !Bool
  , jpIsVarArgs   :: !Bool
  , jpAnnotations :: ![JavaAnnotation]
  , jpSpan        :: !Span
  } deriving (Show, Eq)

-- ── Statements ───────────────────────────────────────────────────────

data JavaStmt
  = ExprStmt      { jsExpr :: !JavaExpr, jsSpan :: !Span }
  | BlockStmt     { jsStmts :: ![JavaStmt], jsSpan :: !Span }
  | ReturnStmt    { jsReturnExpr :: !(Maybe JavaExpr), jsSpan :: !Span }
  | ThrowStmt     { jsThrowExpr :: !JavaExpr, jsSpan :: !Span }
  | IfStmt        { jsCondition :: !JavaExpr, jsThen :: !JavaStmt
                  , jsElse :: !(Maybe JavaStmt), jsSpan :: !Span }
  | SwitchStmt    { jsSelector :: !JavaExpr
                  , jsEntries :: ![JavaSwitchEntry], jsSpan :: !Span }
  | WhileStmt     { jsWhileCond :: !JavaExpr, jsWhileBody :: !JavaStmt
                  , jsSpan :: !Span }
  | DoStmt        { jsDoCond :: !JavaExpr, jsDoBody :: !JavaStmt
                  , jsSpan :: !Span }
  | ForStmt       { jsForInit :: ![JavaExpr]
                  , jsForCond :: !(Maybe JavaExpr)
                  , jsForUpdate :: ![JavaExpr]
                  , jsForBody :: !JavaStmt, jsSpan :: !Span }
  | ForEachStmt   { jsForEachVar :: !JavaVariable
                  , jsForEachIter :: !JavaExpr
                  , jsForEachBody :: !JavaStmt, jsSpan :: !Span }
  | TryStmt       { jsTryResources :: ![JavaExpr]
                  , jsTryBlock :: !JavaStmt
                  , jsCatches :: ![JavaCatchClause]
                  , jsFinally :: !(Maybe JavaStmt), jsSpan :: !Span }
  | BreakStmt     { jsLabel :: !(Maybe Text), jsSpan :: !Span }
  | ContinueStmt  { jsContinueLabel :: !(Maybe Text), jsSpan :: !Span }
  | YieldStmt     { jsYieldExpr :: !JavaExpr, jsSpan :: !Span }
  | SynchronizedStmt { jsSyncExpr :: !JavaExpr, jsSyncBody :: !JavaStmt
                     , jsSpan :: !Span }
  | LabeledStmt   { jsLabelName :: !Text, jsLabelStmt :: !JavaStmt
                   , jsSpan :: !Span }
  | AssertStmt    { jsAssertCheck :: !JavaExpr
                  , jsAssertMsg :: !(Maybe JavaExpr), jsSpan :: !Span }
  | LocalClassStmt  { jsClassDecl :: !JavaTypeDecl, jsSpan :: !Span }
  | LocalRecordStmt { jsRecordDecl :: !JavaTypeDecl, jsSpan :: !Span }
  | ExplicitCtorInvStmt { jsCtorIsThis :: !Bool
                        , jsCtorArgs :: ![JavaExpr]
                        , jsCtorExpr :: !(Maybe JavaExpr)
                        , jsSpan :: !Span }
  | EmptyStmt     { jsSpan :: !Span }
  | VarDeclStmt   { jsVarModifiers :: ![Text]
                  , jsVarDecls :: ![JavaVariable], jsSpan :: !Span }
  | StmtUnknown   { jsSpan :: !Span }
  deriving (Show, Eq)

data JavaSwitchEntry = JavaSwitchEntry
  { jseLabels    :: ![JavaExpr]
  , jseStmts     :: ![JavaStmt]
  , jseIsDefault :: !Bool
  , jseSpan      :: !Span
  } deriving (Show, Eq)

data JavaCatchClause = JavaCatchClause
  { jccParam :: !JavaParam
  , jccBody  :: !JavaStmt
  , jccSpan  :: !Span
  } deriving (Show, Eq)

-- ── Expressions ──────────────────────────────────────────────────────

data JavaExpr
  = MethodCallExpr
      { jeMcName     :: !Text
      , jeMcScope    :: !(Maybe JavaExpr)
      , jeMcArgs     :: ![JavaExpr]
      , jeMcTypeArgs :: ![JavaType]
      , jeSpan       :: !Span
      }
  | ObjectCreationExpr
      { jeOcClassType :: !JavaType
      , jeOcArgs      :: ![JavaExpr]
      , jeOcTypeArgs  :: ![JavaType]
      , jeOcAnonBody  :: !(Maybe [JavaMember])
      , jeSpan        :: !Span
      }
  | FieldAccessExpr
      { jeFaScope     :: !JavaExpr
      , jeFaFieldName :: !Text
      , jeSpan        :: !Span
      }
  | ArrayAccessExpr
      { jeAaArray :: !JavaExpr
      , jeAaIndex :: !JavaExpr
      , jeSpan    :: !Span
      }
  | NameExpr
      { jeNeName :: !Text
      , jeSpan   :: !Span
      }
  | AssignExpr
      { jeAsTarget :: !JavaExpr
      , jeAsOp     :: !Text
      , jeAsValue  :: !JavaExpr
      , jeSpan     :: !Span
      }
  | BinaryExpr
      { jeBiLeft  :: !JavaExpr
      , jeBiOp    :: !Text
      , jeBiRight :: !JavaExpr
      , jeSpan    :: !Span
      }
  | UnaryExpr
      { jeUnOp     :: !Text
      , jeUnPrefix :: !Bool
      , jeUnExpr   :: !JavaExpr
      , jeSpan     :: !Span
      }
  | ConditionalExpr
      { jeCondCond :: !JavaExpr
      , jeCondThen :: !JavaExpr
      , jeCondElse :: !JavaExpr
      , jeSpan     :: !Span
      }
  | CastExpr
      { jeCastType :: !JavaType
      , jeCastExpr :: !JavaExpr
      , jeSpan     :: !Span
      }
  | InstanceOfExpr
      { jeIoExpr    :: !JavaExpr
      , jeIoType    :: !JavaType
      , jeIoPattern :: !(Maybe JavaExpr)
      , jeSpan      :: !Span
      }
  | LambdaExpr
      { jeLmParams   :: ![JavaParam]
      , jeLmBody     :: !JavaExpr
      , jeLmBodyKind :: !Text
      , jeSpan       :: !Span
      }
  | LambdaBlockExpr
      { jeLbParams :: ![JavaParam]
      , jeLbBlock  :: !JavaStmt
      , jeSpan     :: !Span
      }
  | MethodRefExpr
      { jeMrScope :: !JavaExpr
      , jeMrId    :: !Text
      , jeSpan    :: !Span
      }
  | ThisExpr
      { jeThisQualifier :: !(Maybe Text)
      , jeSpan          :: !Span
      }
  | SuperExpr
      { jeSuperQualifier :: !(Maybe Text)
      , jeSpan           :: !Span
      }
  | ArrayCreationExpr
      { jeAcElemType   :: !JavaType
      , jeAcDimensions :: ![Maybe JavaExpr]
      , jeAcInit       :: !(Maybe JavaExpr)
      , jeSpan         :: !Span
      }
  | ArrayInitExpr
      { jeAiValues :: ![JavaExpr]
      , jeSpan     :: !Span
      }
  | ClassExpr
      { jeClType :: !JavaType
      , jeSpan   :: !Span
      }
  | EnclosedExpr
      { jeEnInner :: !JavaExpr
      , jeSpan    :: !Span
      }
  | TextBlockExpr
      { jeTbValue :: !Text
      , jeSpan    :: !Span
      }
  | SwitchExpr
      { jeSwSelector :: !JavaExpr
      , jeSwEntries  :: ![JavaSwitchEntry]
      , jeSpan       :: !Span
      }
  | LiteralExpr
      { jeLitType  :: !Text
      , jeLitValue :: !Text
      , jeSpan     :: !Span
      }
  | PatternExpr
      { jePtName :: !Text
      , jePtType :: !JavaType
      , jeSpan   :: !Span
      }
  | VarDeclExpr
      { jeVdMods :: ![Text]
      , jeVdVars :: ![JavaVariable]
      , jeSpan   :: !Span
      }
  | ExprUnknown
      { jeSpan :: !Span
      }
  deriving (Show, Eq)

-- ── Types ────────────────────────────────────────────────────────────

data JavaType
  = ClassType
      { jtClName     :: !Text
      , jtClScope    :: !(Maybe Text)
      , jtClTypeArgs :: ![JavaType]
      , jtSpan       :: !Span
      }
  | PrimitiveType
      { jtPrimName :: !Text
      , jtSpan     :: !Span
      }
  | ArrayType
      { jtArrComponent :: !JavaType
      , jtSpan         :: !Span
      }
  | VoidType
      { jtSpan :: !Span
      }
  | WildcardType
      { jtWcExtends :: !(Maybe JavaType)
      , jtWcSuper   :: !(Maybe JavaType)
      , jtSpan      :: !Span
      }
  | UnionType
      { jtUnTypes :: ![JavaType]
      , jtSpan    :: !Span
      }
  | IntersectionType
      { jtInTypes :: ![JavaType]
      , jtSpan    :: !Span
      }
  | VarType
      { jtSpan :: !Span
      }
  | TypeUnknown
      { jtSpan :: !Span
      }
  deriving (Show, Eq)

-- ── Annotations ──────────────────────────────────────────────────────

data JavaAnnotation
  = MarkerAnnotation
      { jaMarkerName :: !Text
      , jaSpan       :: !Span
      }
  | NormalAnnotation
      { jaNormalName    :: !Text
      , jaNormalMembers :: ![(Text, JavaExpr)]
      , jaSpan          :: !Span
      }
  | SingleMemberAnnotation
      { jaSingleName  :: !Text
      , jaSingleValue :: !JavaExpr
      , jaSpan        :: !Span
      }
  | AnnotationUnknown
      { jaUnkName :: !Text
      , jaSpan    :: !Span
      }
  deriving (Show, Eq)

-- ── FromJSON instances ───────────────────────────────────────────────

instance FromJSON Pos where
  parseJSON = withObject "Pos" $ \v -> Pos
    <$> v .: "line"
    <*> v .: "col"

instance FromJSON Span where
  parseJSON = withObject "Span" $ \v -> Span
    <$> v .: "start"
    <*> v .: "end"

instance FromJSON JavaFile where
  parseJSON = withObject "JavaFile" $ \v -> JavaFile
    <$> v .:? "package"
    <*> v .:? "imports" .!= []
    <*> v .:? "types" .!= []

instance FromJSON JavaImport where
  parseJSON = withObject "JavaImport" $ \v -> JavaImport
    <$> v .:  "name"
    <*> v .:? "static" .!= False
    <*> v .:? "asterisk" .!= False
    <*> v .:  "span"

instance FromJSON JavaTypeParam where
  parseJSON = withObject "JavaTypeParam" $ \v -> JavaTypeParam
    <$> v .:  "name"
    <*> v .:? "bounds" .!= []
    <*> v .:  "span"

instance FromJSON JavaTypeDecl where
  parseJSON = withObject "JavaTypeDecl" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "ClassDecl" -> ClassDecl
        <$> v .:  "name"
        <*> v .:? "modifiers" .!= []
        <*> v .:? "typeParameters" .!= []
        <*> v .:? "extends"
        <*> v .:? "implements" .!= []
        <*> v .:? "members" .!= []
        <*> v .:? "annotations" .!= []
        <*> v .:  "span"
      "InterfaceDecl" -> InterfaceDecl
        <$> v .:  "name"
        <*> v .:? "modifiers" .!= []
        <*> v .:? "typeParameters" .!= []
        <*> v .:? "extends" .!= []
        <*> v .:? "members" .!= []
        <*> v .:? "annotations" .!= []
        <*> v .:  "span"
      "EnumDecl" -> EnumDecl
        <$> v .:  "name"
        <*> v .:? "modifiers" .!= []
        <*> v .:? "implements" .!= []
        <*> v .:? "constants" .!= []
        <*> v .:? "members" .!= []
        <*> v .:? "annotations" .!= []
        <*> v .:  "span"
      "RecordDecl" -> RecordDecl
        <$> v .:  "name"
        <*> v .:? "modifiers" .!= []
        <*> v .:? "typeParameters" .!= []
        <*> v .:? "implements" .!= []
        <*> v .:? "components" .!= []
        <*> v .:? "members" .!= []
        <*> v .:? "annotations" .!= []
        <*> v .:  "span"
      "AnnotationDecl" -> AnnotationTypeDecl
        <$> v .:  "name"
        <*> v .:? "modifiers" .!= []
        <*> v .:? "members" .!= []
        <*> v .:  "span"
      _ -> ClassDecl
        <$> v .:  "name"
        <*> v .:? "modifiers" .!= []
        <*> v .:? "typeParameters" .!= []
        <*> v .:? "extends"
        <*> v .:? "implements" .!= []
        <*> v .:? "members" .!= []
        <*> v .:? "annotations" .!= []
        <*> v .:  "span"

instance FromJSON JavaMember where
  parseJSON = withObject "JavaMember" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "MethodDecl" -> MethodMember
        <$> v .:  "name"
        <*> v .:? "modifiers" .!= []
        <*> v .:? "typeParameters" .!= []
        <*> v .:  "returnType"
        <*> v .:? "params" .!= []
        <*> v .:? "throws" .!= []
        <*> v .:? "body"
        <*> v .:? "annotations" .!= []
        <*> v .:  "span"
      "ConstructorDecl" -> ConstructorMember
        <$> v .:  "name"
        <*> v .:? "modifiers" .!= []
        <*> v .:? "typeParameters" .!= []
        <*> v .:? "params" .!= []
        <*> v .:? "throws" .!= []
        <*> v .:  "body"
        <*> v .:? "annotations" .!= []
        <*> v .:  "span"
      "CompactConstructorDecl" -> CompactConstructorMember
        <$> v .:  "name"
        <*> v .:? "modifiers" .!= []
        <*> v .:  "body"
        <*> v .:? "annotations" .!= []
        <*> v .:  "span"
      "FieldDecl" -> FieldMember
        <$> v .:? "modifiers" .!= []
        <*> v .:  "fieldType"
        <*> v .:? "variables" .!= []
        <*> v .:? "annotations" .!= []
        <*> v .:  "span"
      "EnumConstant" -> EnumConstantMember
        <$> v .:  "name"
        <*> v .:? "args" .!= []
        <*> v .:? "classBody" .!= []
        <*> v .:? "annotations" .!= []
        <*> v .:  "span"
      "InitializerDecl" -> InitializerMember
        <$> v .:? "isStatic" .!= False
        <*> v .:  "body"
        <*> v .:  "span"
      "AnnotationMember" -> AnnotationMemberDecl
        <$> v .:  "name"
        <*> v .:  "returnType"
        <*> v .:? "defaultValue"
        <*> v .:  "span"
      "NestedTypeMember" -> NestedTypeMember
        <$> v .:  "typeDecl"
        <*> v .:  "span"
      _ -> MemberUnknown
        <$> v .: "span"

instance FromJSON JavaVariable where
  parseJSON = withObject "JavaVariable" $ \v -> JavaVariable
    <$> v .:  "name"
    <*> v .:  "varType"
    <*> v .:? "init"
    <*> v .:  "span"

instance FromJSON JavaParam where
  parseJSON = withObject "JavaParam" $ \v -> JavaParam
    <$> v .:  "name"
    <*> v .:  "paramType"
    <*> v .:? "isFinal" .!= False
    <*> v .:? "isVarArgs" .!= False
    <*> v .:? "annotations" .!= []
    <*> v .:  "span"

instance FromJSON JavaStmt where
  parseJSON = withObject "JavaStmt" $ \v -> do
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
        <*> v .:  "span"
      "ThrowStmt" -> ThrowStmt
        <$> v .: "expr"
        <*> v .: "span"
      "IfStmt" -> IfStmt
        <$> v .:  "condition"
        <*> v .:  "then"
        <*> v .:? "else"
        <*> v .:  "span"
      "SwitchStmt" -> SwitchStmt
        <$> v .: "selector"
        <*> v .:? "entries" .!= []
        <*> v .:  "span"
      "WhileStmt" -> WhileStmt
        <$> v .: "condition"
        <*> v .: "body"
        <*> v .: "span"
      "DoStmt" -> DoStmt
        <$> v .: "condition"
        <*> v .: "body"
        <*> v .: "span"
      "ForStmt" -> ForStmt
        <$> v .:? "init" .!= []
        <*> v .:? "condition"
        <*> v .:? "update" .!= []
        <*> v .:  "body"
        <*> v .:  "span"
      "ForEachStmt" -> ForEachStmt
        <$> v .: "variable"
        <*> v .: "iterable"
        <*> v .: "body"
        <*> v .: "span"
      "TryStmt" -> TryStmt
        <$> v .:? "resources" .!= []
        <*> v .:  "tryBlock"
        <*> v .:? "catches" .!= []
        <*> v .:? "finally"
        <*> v .:  "span"
      "BreakStmt" -> BreakStmt
        <$> v .:? "label"
        <*> v .:  "span"
      "ContinueStmt" -> ContinueStmt
        <$> v .:? "label"
        <*> v .:  "span"
      "YieldStmt" -> YieldStmt
        <$> v .: "expr"
        <*> v .: "span"
      "SynchronizedStmt" -> SynchronizedStmt
        <$> v .: "expr"
        <*> v .: "body"
        <*> v .: "span"
      "LabeledStmt" -> LabeledStmt
        <$> v .: "label"
        <*> v .: "stmt"
        <*> v .: "span"
      "AssertStmt" -> AssertStmt
        <$> v .: "check"
        <*> v .:? "message"
        <*> v .:  "span"
      "LocalClassStmt" -> LocalClassStmt
        <$> v .: "classDecl"
        <*> v .: "span"
      "LocalRecordStmt" -> LocalRecordStmt
        <$> v .: "recordDecl"
        <*> v .: "span"
      "ExplicitConstructorInvocationStmt" -> ExplicitCtorInvStmt
        <$> v .:? "isThis" .!= False
        <*> v .:? "args" .!= []
        <*> v .:? "expr"
        <*> v .:  "span"
      "EmptyStmt" -> EmptyStmt
        <$> v .: "span"
      "VariableDeclarationExpr" -> VarDeclStmt
        <$> v .:? "modifiers" .!= []
        <*> v .:? "variables" .!= []
        <*> v .:  "span"
      _ -> StmtUnknown
        <$> v .: "span"

instance FromJSON JavaSwitchEntry where
  parseJSON = withObject "JavaSwitchEntry" $ \v -> JavaSwitchEntry
    <$> v .:? "labels" .!= []
    <*> v .:? "stmts" .!= []
    <*> v .:? "isDefault" .!= False
    <*> v .:  "span"

instance FromJSON JavaCatchClause where
  parseJSON = withObject "JavaCatchClause" $ \v -> JavaCatchClause
    <$> v .: "param"
    <*> v .: "body"
    <*> v .: "span"

instance FromJSON JavaExpr where
  parseJSON = withObject "JavaExpr" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "MethodCallExpr" -> MethodCallExpr
        <$> v .:  "name"
        <*> v .:? "scope"
        <*> v .:? "args" .!= []
        <*> v .:? "typeArgs" .!= []
        <*> v .:  "span"
      "ObjectCreationExpr" -> ObjectCreationExpr
        <$> v .:  "classType"
        <*> v .:? "args" .!= []
        <*> v .:? "typeArgs" .!= []
        <*> v .:? "anonymousClassBody"
        <*> v .:  "span"
      "FieldAccessExpr" -> FieldAccessExpr
        <$> v .: "scope"
        <*> v .: "name"
        <*> v .: "span"
      "ArrayAccessExpr" -> ArrayAccessExpr
        <$> v .: "name"
        <*> v .: "index"
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
      "ConditionalExpr" -> ConditionalExpr
        <$> v .: "condition"
        <*> v .: "then"
        <*> v .: "else"
        <*> v .: "span"
      "CastExpr" -> CastExpr
        <$> v .: "castType"
        <*> v .: "expr"
        <*> v .: "span"
      "InstanceOfExpr" -> InstanceOfExpr
        <$> v .:  "expr"
        <*> v .:  "checkType"
        <*> v .:? "pattern"
        <*> v .:  "span"
      "LambdaExpr" -> do
        bodyKind <- v .:? "bodyKind" .!= ("block" :: Text)
        case bodyKind of
          "expression" -> LambdaExpr
            <$> v .:? "params" .!= []
            <*> v .:  "body"
            <*> pure "expression"
            <*> v .:  "span"
          _ -> LambdaBlockExpr
            <$> v .:? "params" .!= []
            <*> v .:  "body"
            <*> v .:  "span"
      "MethodRefExpr" -> MethodRefExpr
        <$> v .: "scope"
        <*> v .: "identifier"
        <*> v .: "span"
      "ThisExpr" -> ThisExpr
        <$> v .:? "qualifier"
        <*> v .:  "span"
      "SuperExpr" -> SuperExpr
        <$> v .:? "qualifier"
        <*> v .:  "span"
      "ArrayCreationExpr" -> ArrayCreationExpr
        <$> v .:  "elementType"
        <*> v .:? "levels" .!= []
        <*> v .:? "initializer"
        <*> v .:  "span"
      "ArrayInitExpr" -> ArrayInitExpr
        <$> v .:? "values" .!= []
        <*> v .:  "span"
      "ClassExpr" -> ClassExpr
        <$> v .: "classType"
        <*> v .: "span"
      "EnclosedExpr" -> EnclosedExpr
        <$> v .: "inner"
        <*> v .: "span"
      "TextBlockExpr" -> TextBlockExpr
        <$> v .: "value"
        <*> v .: "span"
      "SwitchExpr" -> SwitchExpr
        <$> v .:  "selector"
        <*> v .:? "entries" .!= []
        <*> v .:  "span"
      "LiteralExpr" -> LiteralExpr
        <$> v .: "literalType"
        <*> v .: "value"
        <*> v .: "span"
      "PatternExpr" -> PatternExpr
        <$> v .: "name"
        <*> v .: "patType"
        <*> v .: "span"
      "VariableDeclarationExpr" -> VarDeclExpr
        <$> v .:? "modifiers" .!= []
        <*> v .:? "variables" .!= []
        <*> v .:  "span"
      _ -> ExprUnknown
        <$> v .: "span"

instance FromJSON JavaType where
  parseJSON = withObject "JavaType" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "ClassType" -> ClassType
        <$> v .:  "name"
        <*> v .:? "scope"
        <*> v .:? "typeArgs" .!= []
        <*> v .:  "span"
      "PrimitiveType" -> PrimitiveType
        <$> v .: "name"
        <*> v .: "span"
      "ArrayType" -> ArrayType
        <$> v .: "componentType"
        <*> v .: "span"
      "VoidType" -> VoidType
        <$> v .: "span"
      "WildcardType" -> WildcardType
        <$> v .:? "extends"
        <*> v .:? "super"
        <*> v .:  "span"
      "UnionType" -> UnionType
        <$> v .:? "types" .!= []
        <*> v .:  "span"
      "IntersectionType" -> IntersectionType
        <$> v .:? "types" .!= []
        <*> v .:  "span"
      "VarType" -> VarType
        <$> v .: "span"
      "TypeParam" -> ClassType
        <$> v .:  "name"
        <*> pure Nothing
        <*> pure []
        <*> v .:  "span"
      _ -> TypeUnknown
        <$> v .: "span"

instance FromJSON JavaAnnotation where
  parseJSON = withObject "JavaAnnotation" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "MarkerAnnotation" -> MarkerAnnotation
        <$> v .: "name"
        <*> v .: "span"
      "NormalAnnotation" -> do
        name <- v .: "name"
        members <- v .:? "members" .!= ([] :: [Value])
        sp <- v .: "span"
        pairs <- mapM parseMemberPair members
        pure $ NormalAnnotation name pairs sp
      "SingleMemberAnnotation" -> SingleMemberAnnotation
        <$> v .: "name"
        <*> v .: "value"
        <*> v .: "span"
      _ -> AnnotationUnknown
        <$> v .:? "name" .!= "<unknown>"
        <*> v .:  "span"

-- | Parse a member-value pair from a NormalAnnotation.
parseMemberPair :: Value -> Parser (Text, JavaExpr)
parseMemberPair = withObject "MemberValuePair" $ \v -> do
  k <- v .: "key"
  val <- v .: "value"
  pure (k, val)
