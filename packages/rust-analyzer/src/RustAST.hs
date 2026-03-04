{-# LANGUAGE LambdaCase #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE StrictData #-}
-- | Haskell types for the JSON AST that the orchestrator sends.
-- Each type has a FromJSON instance that dispatches on the "type" field.
-- The orchestrator serializes syn (Rust) AST nodes as JSON objects.
module RustAST
  ( RustFile(..)
  , RustItem(..)
  , RustExpr(..)
  , RustPat(..)
  , RustType(..)
  , RustStmt(..)
  , RustUseTree(..)
  , RustAttribute(..)
  , RustFnArg(..)
  , RustFnSig(..)
  , RustBlock(..)
  , RustField(..)
  , RustVariant(..)
  , RustMatchArm(..)
  , Span(..)
  , Pos(..)
  , Vis(..)
  ) where

import Data.Text (Text)
import Data.Aeson (FromJSON(..), withObject, withText, (.:), (.:?), (.!=))
import Data.Aeson.Types (Parser)

-- ── Position & Span ──────────────────────────────────────────────────

-- | Position in source
data Pos = Pos
  { posLine :: !Int
  , posCol  :: !Int
  } deriving (Show, Eq)

-- | Span in source
data Span = Span
  { spanStart :: !Pos
  , spanEnd   :: !Pos
  } deriving (Show, Eq)

-- ── Visibility ───────────────────────────────────────────────────────

-- | Visibility
data Vis = VisPub | VisPubCrate | VisPubSuper | VisPubIn Text | VisPrivate
  deriving (Show, Eq)

-- ── Top-level file ───────────────────────────────────────────────────

-- | Top-level file
data RustFile = RustFile
  { rfItems :: ![RustItem]
  } deriving (Show, Eq)

-- ── Items (top-level declarations) ───────────────────────────────────

data RustItem
  = ItemFn
      { ifIdent   :: !Text
      , ifVis     :: !Vis
      , ifSig     :: !RustFnSig
      , ifBlock   :: !RustBlock
      , ifAttrs   :: ![RustAttribute]
      , ifSpan    :: !Span
      }
  | ItemStruct
      { isIdent   :: !Text
      , isVis     :: !Vis
      , isFields  :: ![RustField]
      , isAttrs   :: ![RustAttribute]
      , isSpan    :: !Span
      , isTuple   :: !Bool
      , isUnit    :: !Bool
      }
  | ItemEnum
      { ieIdent    :: !Text
      , ieVis      :: !Vis
      , ieVariants :: ![RustVariant]
      , ieAttrs    :: ![RustAttribute]
      , ieSpan     :: !Span
      }
  | ItemImpl
      { iiSelfTy  :: !RustType
      , iiTrait   :: !(Maybe Text)
      , iiItems   :: ![RustItem]
      , iiSpan    :: !Span
      , iiAttrs   :: ![RustAttribute]
      , iiUnsafe  :: !Bool
      }
  | ItemTrait
      { itIdent   :: !Text
      , itVis     :: !Vis
      , itItems   :: ![RustItem]
      , itAttrs   :: ![RustAttribute]
      , itSpan    :: !Span
      , itUnsafe  :: !Bool
      }
  | ItemMod
      { imIdent   :: !Text
      , imVis     :: !Vis
      , imContent :: !(Maybe [RustItem])
      , imSpan    :: !Span
      , imAttrs   :: ![RustAttribute]
      }
  | ItemUse
      { iuTree  :: !RustUseTree
      , iuVis   :: !Vis
      , iuSpan  :: !Span
      , iuAttrs :: ![RustAttribute]
      }
  | ItemType
      { itypIdent :: !Text
      , itypVis   :: !Vis
      , itypTy    :: !RustType
      , itypSpan  :: !Span
      , itypAttrs :: ![RustAttribute]
      }
  | ItemConst
      { icIdent :: !Text
      , icVis   :: !Vis
      , icTy    :: !RustType
      , icExpr  :: !RustExpr
      , icSpan  :: !Span
      , icAttrs :: ![RustAttribute]
      }
  | ItemStatic
      { istIdent    :: !Text
      , istVis      :: !Vis
      , istTy       :: !RustType
      , istMut      :: !Bool
      , istExpr     :: !RustExpr
      , istSpan     :: !Span
      , istAttrs    :: ![RustAttribute]
      }
  | ItemTraitMethod   -- method signature in trait (no body)
      { itmIdent :: !Text
      , itmSig   :: !RustFnSig
      , itmSpan  :: !Span
      , itmAttrs :: ![RustAttribute]
      }
  | ItemAssocType     -- associated type in trait/impl
      { iatIdent :: !Text
      , iatSpan  :: !Span
      , iatAttrs :: ![RustAttribute]
      }
  | ItemMacro
      { imacSpan :: !Span
      }
  | ItemForeignMod
      { ifmSpan :: !Span
      }
  | ItemUnknown
      { iuSpan' :: !Span
      }
  deriving (Show, Eq)

-- ── Function signature ───────────────────────────────────────────────

data RustFnSig = RustFnSig
  { fsAsync  :: !Bool
  , fsUnsafe :: !Bool
  , fsConst  :: !Bool
  , fsInputs :: ![RustFnArg]
  , fsOutput :: !(Maybe RustType)
  } deriving (Show, Eq)

-- ── Function argument ────────────────────────────────────────────────

data RustFnArg
  = FnArgSelf { faSelfMut :: !Bool }
  | FnArgTyped { faPat :: !RustPat, faTy :: !RustType }
  deriving (Show, Eq)

-- ── Block ────────────────────────────────────────────────────────────

data RustBlock = RustBlock
  { rbStmts :: ![RustStmt]
  } deriving (Show, Eq)

-- ── Statement ────────────────────────────────────────────────────────

data RustStmt
  = StmtLocal  { slPat :: !RustPat, slInit :: !(Maybe RustExpr), slSpan :: !Span }
  | StmtExpr   { seExpr :: !RustExpr }
  | StmtSemi   { ssExpr :: !RustExpr }
  | StmtItem   { siItem :: !RustItem }
  | StmtMacro  { smSpan :: !Span }
  deriving (Show, Eq)

-- ── Expression types ─────────────────────────────────────────────────

data RustExpr
  = ExprCall       { ecFunc :: !RustExpr, ecArgs :: ![RustExpr], ecSpan :: !Span }
  | ExprMethodCall { emcReceiver :: !RustExpr, emcMethod :: !Text, emcArgs :: ![RustExpr], emcSpan :: !Span }
  | ExprBinary     { ebLeft :: !RustExpr, ebOp :: !Text, ebRight :: !RustExpr, ebSpan :: !Span }
  | ExprUnary      { euOp :: !Text, euExpr :: !RustExpr, euSpan :: !Span }
  | ExprBlock      { eblStmts :: ![RustStmt], eblSpan :: !Span }
  | ExprIf         { eiCond :: !RustExpr, eiThen :: !RustBlock, eiElse :: !(Maybe RustExpr), eiSpan :: !Span }
  | ExprMatch      { emaExpr :: !RustExpr, emaArms :: ![RustMatchArm], emaSpan :: !Span }
  | ExprLoop       { elBody :: !RustBlock, elLabel :: !(Maybe Text), elSpan :: !Span }
  | ExprWhile      { ewCond :: !RustExpr, ewBody :: !RustBlock, ewLabel :: !(Maybe Text), ewSpan :: !Span }
  | ExprForLoop    { efPat :: !RustPat, efExpr :: !RustExpr, efBody :: !RustBlock, efLabel :: !(Maybe Text), efSpan :: !Span }
  | ExprReturn     { erExpr :: !(Maybe RustExpr), erSpan :: !Span }
  | ExprBreak      { ebrExpr :: !(Maybe RustExpr), ebrLabel :: !(Maybe Text), ebrSpan :: !Span }
  | ExprContinue   { ecnLabel :: !(Maybe Text), ecnSpan :: !Span }
  | ExprClosure    { eclInputs :: ![RustPat], eclOutput :: !(Maybe RustType), eclBody :: !RustExpr, eclCapture :: !Bool, eclSpan :: !Span }
  | ExprField      { efBase :: !RustExpr, efMember :: !Text, efSpan' :: !Span }
  | ExprIndex      { eixExpr :: !RustExpr, eixIndex :: !RustExpr, eixSpan :: !Span }
  | ExprPath       { epPath :: !Text, epSpan :: !Span }
  | ExprReference  { erefExpr :: !RustExpr, erefMut :: !Bool, erefSpan :: !Span }
  | ExprStruct     { esPath :: !Text, esFields :: ![(Text, RustExpr)], esRest :: !(Maybe RustExpr), esSpan :: !Span }
  | ExprTuple      { etElems :: ![RustExpr], etSpan :: !Span }
  | ExprArray      { eaElems :: ![RustExpr], eaSpan :: !Span }
  | ExprRange      { ergStart :: !(Maybe RustExpr), ergEnd :: !(Maybe RustExpr), ergSpan :: !Span }
  | ExprAwait      { eawBase :: !RustExpr, eawSpan :: !Span }
  | ExprAsync      { easCapture :: !Bool, easBlock :: !RustBlock, easSpan :: !Span }
  | ExprTry        { etrExpr :: !RustExpr, etrSpan :: !Span }
  | ExprLet        { eltPat :: !RustPat, eltExpr :: !RustExpr, eltSpan :: !Span }
  | ExprAssign     { easLeft :: !RustExpr, easRight :: !RustExpr, easSpan' :: !Span }
  | ExprUnsafe     { eunBlock :: !RustBlock, eunSpan :: !Span }
  | ExprLit        { elLit :: !Text, elSpan' :: !Span }
  | ExprCast       { ecaExpr :: !RustExpr, ecaTy :: !RustType, ecaSpan :: !Span }
  | ExprUnknown    { euSpan :: !Span }
  deriving (Show, Eq)

-- ── Pattern types ────────────────────────────────────────────────────

data RustPat
  = PatIdent    { piIdent :: !Text, piMut :: !Bool, piByRef :: !Bool, piSpan :: !Span }
  | PatStruct   { psPath :: !Text, psFields :: ![(Text, RustPat)], psSpan :: !Span }
  | PatTupleStruct { ptsPath :: !Text, ptsElems :: ![RustPat], ptsSpan :: !Span }
  | PatTuple    { ptElems :: ![RustPat], ptSpan :: !Span }
  | PatPath     { ppPath :: !Text, ppSpan :: !Span }
  | PatWild     { pwSpan :: !Span }
  | PatOr       { poCases :: ![RustPat], poSpan :: !Span }
  | PatRange    { prStart :: !(Maybe RustExpr), prEnd :: !(Maybe RustExpr), prSpan :: !Span }
  | PatReference { prefPat :: !RustPat, prefMut :: !Bool, prefSpan :: !Span }
  | PatSlice    { pslElems :: ![RustPat], pslSpan :: !Span }
  | PatLit      { plExpr :: !RustExpr, plSpan :: !Span }
  | PatUnknown  { puSpan :: !Span }
  deriving (Show, Eq)

-- ── Type representations ─────────────────────────────────────────────

data RustType
  = TypePath        { tpPath :: !Text, tpArgs :: ![RustType], tpSpan :: !Span }
  | TypeReference   { trLifetime :: !(Maybe Text), trMut :: !Bool, trElem :: !RustType, trSpan :: !Span }
  | TypeSlice       { tslElem :: !RustType, tslSpan :: !Span }
  | TypeArray       { taElem :: !RustType, taSpan :: !Span }
  | TypeTuple       { ttElems :: ![RustType], ttSpan :: !Span }
  | TypeFn          { tfInputs :: ![RustType], tfOutput :: !(Maybe RustType), tfSpan :: !Span }
  | TypeImplTrait   { tiBounds :: ![Text], tiSpan :: !Span }
  | TypeTraitObject { toBounds :: ![Text], toSpan :: !Span }
  | TypeNever       { tnSpan :: !Span }
  | TypeUnknown     { tuSpan :: !Span }
  deriving (Show, Eq)

-- ── Use tree (for import declarations) ───────────────────────────────

data RustUseTree
  = UsePath  { upIdent :: !Text, upTree :: !RustUseTree }
  | UseName  { unIdent :: !Text }
  | UseRename { urIdent :: !Text, urRename :: !Text }
  | UseGlob
  | UseGroup { ugItems :: ![RustUseTree] }
  deriving (Show, Eq)

-- ── Struct/variant field ─────────────────────────────────────────────

data RustField = RustField
  { rfIdent :: !(Maybe Text)   -- Nothing for tuple fields
  , rfTy    :: !RustType
  , rfVis   :: !Vis
  } deriving (Show, Eq)

-- ── Enum variant ─────────────────────────────────────────────────────

data RustVariant = RustVariant
  { rvIdent  :: !Text
  , rvFields :: ![RustField]
  , rvSpan   :: !Span
  } deriving (Show, Eq)

-- ── Match arm ────────────────────────────────────────────────────────

data RustMatchArm = RustMatchArm
  { raPat   :: !RustPat
  , raGuard :: !(Maybe RustExpr)
  , raBody  :: !RustExpr
  , raSpan  :: !Span
  } deriving (Show, Eq)

-- ── Attribute ────────────────────────────────────────────────────────

data RustAttribute = RustAttribute
  { raStyle  :: !Text    -- "outer" or "inner"
  , raPath   :: !Text    -- e.g. "derive", "cfg", "test"
  , raTokens :: !Text    -- token string
  } deriving (Show, Eq)

-- ══════════════════════════════════════════════════════════════════════
-- FromJSON instances
-- ══════════════════════════════════════════════════════════════════════

instance FromJSON Pos where
  parseJSON = withObject "Pos" $ \v -> Pos
    <$> v .: "line"
    <*> v .: "col"

instance FromJSON Span where
  parseJSON = withObject "Span" $ \v -> Span
    <$> v .: "start"
    <*> v .: "end"

instance FromJSON Vis where
  parseJSON = withText "Vis" $ \case
    "pub"        -> pure VisPub
    "pub(crate)" -> pure VisPubCrate
    "pub(super)" -> pure VisPubSuper
    ""           -> pure VisPrivate
    other        -> pure (VisPubIn other)

instance FromJSON RustFile where
  parseJSON = withObject "RustFile" $ \v -> RustFile
    <$> v .: "items"

instance FromJSON RustItem where
  parseJSON = withObject "RustItem" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "ItemFn" -> ItemFn
        <$> v .:  "ident"
        <*> v .:  "vis"
        <*> v .:  "sig"
        <*> v .:  "block"
        <*> v .:? "attrs" .!= []
        <*> v .:  "span"
      "ItemStruct" -> ItemStruct
        <$> v .:  "ident"
        <*> v .:  "vis"
        <*> v .:? "fields" .!= []
        <*> v .:? "attrs" .!= []
        <*> v .:  "span"
        <*> v .:? "tuple" .!= False
        <*> v .:? "unit" .!= False
      "ItemEnum" -> ItemEnum
        <$> v .:  "ident"
        <*> v .:  "vis"
        <*> v .:? "variants" .!= []
        <*> v .:? "attrs" .!= []
        <*> v .:  "span"
      "ItemImpl" -> ItemImpl
        <$> v .:  "self_ty"
        <*> v .:? "trait"
        <*> v .:? "items" .!= []
        <*> v .:  "span"
        <*> v .:? "attrs" .!= []
        <*> v .:? "unsafe" .!= False
      "ItemTrait" -> ItemTrait
        <$> v .:  "ident"
        <*> v .:  "vis"
        <*> v .:? "items" .!= []
        <*> v .:? "attrs" .!= []
        <*> v .:  "span"
        <*> v .:? "unsafe" .!= False
      "ItemMod" -> ItemMod
        <$> v .:  "ident"
        <*> v .:  "vis"
        <*> v .:? "content"
        <*> v .:  "span"
        <*> v .:? "attrs" .!= []
      "ItemUse" -> ItemUse
        <$> v .:  "tree"
        <*> v .:  "vis"
        <*> v .:  "span"
        <*> v .:? "attrs" .!= []
      "ItemType" -> ItemType
        <$> v .:  "ident"
        <*> v .:  "vis"
        <*> v .:  "ty"
        <*> v .:  "span"
        <*> v .:? "attrs" .!= []
      "ItemConst" -> ItemConst
        <$> v .:  "ident"
        <*> v .:  "vis"
        <*> v .:  "ty"
        <*> v .:  "expr"
        <*> v .:  "span"
        <*> v .:? "attrs" .!= []
      "ItemStatic" -> ItemStatic
        <$> v .:  "ident"
        <*> v .:  "vis"
        <*> v .:  "ty"
        <*> v .:? "mutable" .!= False
        <*> v .:  "expr"
        <*> v .:  "span"
        <*> v .:? "attrs" .!= []
      "ItemTraitMethod" -> ItemTraitMethod
        <$> v .:  "ident"
        <*> v .:  "sig"
        <*> v .:  "span"
        <*> v .:? "attrs" .!= []
      "ItemAssocType" -> ItemAssocType
        <$> v .:  "ident"
        <*> v .:  "span"
        <*> v .:? "attrs" .!= []
      "ItemMacro" -> ItemMacro
        <$> v .: "span"
      "ItemForeignMod" -> ItemForeignMod
        <$> v .: "span"
      _ -> ItemUnknown
        <$> v .: "span"

instance FromJSON RustFnSig where
  parseJSON = withObject "RustFnSig" $ \v -> RustFnSig
    <$> v .:? "async"  .!= False
    <*> v .:? "unsafe" .!= False
    <*> v .:? "const"  .!= False
    <*> v .:? "inputs" .!= []
    <*> v .:? "output"

instance FromJSON RustFnArg where
  parseJSON = withObject "RustFnArg" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "self" -> FnArgSelf
        <$> v .:? "mutable" .!= False
      "typed" -> FnArgTyped
        <$> v .: "pat"
        <*> v .: "ty"
      _ -> FnArgTyped
        <$> v .: "pat"
        <*> v .: "ty"

instance FromJSON RustBlock where
  parseJSON = withObject "RustBlock" $ \v -> RustBlock
    <$> v .:? "stmts" .!= []

instance FromJSON RustStmt where
  parseJSON = withObject "RustStmt" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "Local" -> StmtLocal
        <$> v .:  "pat"
        <*> v .:? "init"
        <*> v .:  "span"
      "Expr" -> StmtExpr
        <$> v .: "expr"
      "Semi" -> StmtSemi
        <$> v .: "expr"
      "Item" -> StmtItem
        <$> v .: "item"
      "Macro" -> StmtMacro
        <$> v .: "span"
      _ -> StmtMacro
        <$> v .: "span"

instance FromJSON RustExpr where
  parseJSON = withObject "RustExpr" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "Call" -> ExprCall
        <$> v .:  "func"
        <*> v .:? "args" .!= []
        <*> v .:  "span"
      "MethodCall" -> ExprMethodCall
        <$> v .:  "receiver"
        <*> v .:  "method"
        <*> v .:? "args" .!= []
        <*> v .:  "span"
      "Binary" -> ExprBinary
        <$> v .: "left"
        <*> v .: "op"
        <*> v .: "right"
        <*> v .: "span"
      "Unary" -> ExprUnary
        <$> v .: "op"
        <*> v .: "expr"
        <*> v .: "span"
      "Block" -> ExprBlock
        <$> v .:? "stmts" .!= []
        <*> v .:  "span"
      "If" -> ExprIf
        <$> v .:  "cond"
        <*> v .:  "then"
        <*> v .:? "else"
        <*> v .:  "span"
      "Match" -> ExprMatch
        <$> v .:  "expr"
        <*> v .:? "arms" .!= []
        <*> v .:  "span"
      "Loop" -> ExprLoop
        <$> v .:  "body"
        <*> v .:? "label"
        <*> v .:  "span"
      "While" -> ExprWhile
        <$> v .: "cond"
        <*> v .: "body"
        <*> v .:? "label"
        <*> v .:  "span"
      "ForLoop" -> ExprForLoop
        <$> v .:  "pat"
        <*> v .:  "expr"
        <*> v .:  "body"
        <*> v .:? "label"
        <*> v .:  "span"
      "Return" -> ExprReturn
        <$> v .:? "expr"
        <*> v .:  "span"
      "Break" -> ExprBreak
        <$> v .:? "expr"
        <*> v .:? "label"
        <*> v .:  "span"
      "Continue" -> ExprContinue
        <$> v .:? "label"
        <*> v .:  "span"
      "Closure" -> ExprClosure
        <$> v .:? "inputs" .!= []
        <*> v .:? "output"
        <*> v .:  "body"
        <*> v .:? "capture" .!= False
        <*> v .:  "span"
      "Field" -> ExprField
        <$> v .: "base"
        <*> v .: "member"
        <*> v .: "span"
      "Index" -> ExprIndex
        <$> v .: "expr"
        <*> v .: "index"
        <*> v .: "span"
      "Path" -> ExprPath
        <$> v .: "path"
        <*> v .: "span"
      "Reference" -> ExprReference
        <$> v .:  "expr"
        <*> v .:? "mutable" .!= False
        <*> v .:  "span"
      "Struct" -> ExprStruct
        <$> v .:  "path"
        <*> v .:? "fields" .!= []
        <*> v .:? "rest"
        <*> v .:  "span"
      "Tuple" -> ExprTuple
        <$> v .:? "elems" .!= []
        <*> v .:  "span"
      "Array" -> ExprArray
        <$> v .:? "elems" .!= []
        <*> v .:  "span"
      "Range" -> ExprRange
        <$> v .:? "start"
        <*> v .:? "end"
        <*> v .:  "span"
      "Await" -> ExprAwait
        <$> v .: "base"
        <*> v .: "span"
      "Async" -> ExprAsync
        <$> v .:? "capture" .!= False
        <*> v .:  "block"
        <*> v .:  "span"
      "Try" -> ExprTry
        <$> v .: "expr"
        <*> v .: "span"
      "Let" -> ExprLet
        <$> v .: "pat"
        <*> v .: "expr"
        <*> v .: "span"
      "Assign" -> ExprAssign
        <$> v .: "left"
        <*> v .: "right"
        <*> v .: "span"
      "Unsafe" -> ExprUnsafe
        <$> v .: "block"
        <*> v .: "span"
      "Lit" -> ExprLit
        <$> v .: "lit"
        <*> v .: "span"
      "Cast" -> ExprCast
        <$> v .: "expr"
        <*> v .: "ty"
        <*> v .: "span"
      _ -> ExprUnknown
        <$> v .: "span"

instance FromJSON RustPat where
  parseJSON = withObject "RustPat" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "Ident" -> PatIdent
        <$> v .:  "ident"
        <*> v .:? "mutable" .!= False
        <*> v .:? "by_ref" .!= False
        <*> v .:  "span"
      "Struct" -> PatStruct
        <$> v .:  "path"
        <*> v .:? "fields" .!= []
        <*> v .:  "span"
      "TupleStruct" -> PatTupleStruct
        <$> v .:  "path"
        <*> v .:? "elems" .!= []
        <*> v .:  "span"
      "Tuple" -> PatTuple
        <$> v .:? "elems" .!= []
        <*> v .:  "span"
      "Path" -> PatPath
        <$> v .: "path"
        <*> v .: "span"
      "Wild" -> PatWild
        <$> v .: "span"
      "Or" -> PatOr
        <$> v .:? "cases" .!= []
        <*> v .:  "span"
      "Range" -> PatRange
        <$> v .:? "start"
        <*> v .:? "end"
        <*> v .:  "span"
      "Reference" -> PatReference
        <$> v .:  "pat"
        <*> v .:? "mutable" .!= False
        <*> v .:  "span"
      "Slice" -> PatSlice
        <$> v .:? "elems" .!= []
        <*> v .:  "span"
      "Lit" -> PatLit
        <$> v .: "expr"
        <*> v .: "span"
      _ -> PatUnknown
        <$> v .: "span"

instance FromJSON RustType where
  parseJSON = withObject "RustType" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "Path" -> TypePath
        <$> v .:  "path"
        <*> v .:? "args" .!= []
        <*> v .:  "span"
      "Reference" -> TypeReference
        <$> v .:? "lifetime"
        <*> v .:? "mutable" .!= False
        <*> v .:  "elem"
        <*> v .:  "span"
      "Slice" -> TypeSlice
        <$> v .: "elem"
        <*> v .: "span"
      "Array" -> TypeArray
        <$> v .: "elem"
        <*> v .: "span"
      "Tuple" -> TypeTuple
        <$> v .:? "elems" .!= []
        <*> v .:  "span"
      "Fn" -> TypeFn
        <$> v .:? "inputs" .!= []
        <*> v .:? "output"
        <*> v .:  "span"
      "ImplTrait" -> TypeImplTrait
        <$> v .:? "bounds" .!= []
        <*> v .:  "span"
      "TraitObject" -> TypeTraitObject
        <$> v .:? "bounds" .!= []
        <*> v .:  "span"
      "Never" -> TypeNever
        <$> v .: "span"
      _ -> TypeUnknown
        <$> v .: "span"

instance FromJSON RustUseTree where
  parseJSON = withObject "RustUseTree" $ \v -> do
    ty <- v .: "type" :: Parser Text
    case ty of
      "Path" -> UsePath
        <$> v .: "ident"
        <*> v .: "tree"
      "Name" -> UseName
        <$> v .: "ident"
      "Rename" -> UseRename
        <$> v .: "ident"
        <*> v .: "rename"
      "Glob" -> pure UseGlob
      "Group" -> UseGroup
        <$> v .:? "items" .!= []
      _ -> UseName
        <$> v .: "ident"

instance FromJSON RustField where
  parseJSON = withObject "RustField" $ \v -> RustField
    <$> v .:? "ident"
    <*> v .:  "ty"
    <*> v .:? "vis" .!= VisPrivate

instance FromJSON RustVariant where
  parseJSON = withObject "RustVariant" $ \v -> RustVariant
    <$> v .:  "ident"
    <*> v .:? "fields" .!= []
    <*> v .:  "span"

instance FromJSON RustMatchArm where
  parseJSON = withObject "RustMatchArm" $ \v -> RustMatchArm
    <$> v .:  "pat"
    <*> v .:? "guard"
    <*> v .:  "body"
    <*> v .:  "span"

instance FromJSON RustAttribute where
  parseJSON = withObject "RustAttribute" $ \v -> RustAttribute
    <$> v .:? "style"  .!= "outer"
    <*> v .:? "path"   .!= ""
    <*> v .:? "tokens" .!= ""
