{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE StrictData #-}
module ObjcAST
  ( ObjcFile(..)
  , ObjcDecl(..)
  , Span(..)
  , Pos(..)
  ) where

import Data.Text (Text)
import Data.Aeson (FromJSON(..), withObject, (.:), (.:?), (.!=))
import Data.Aeson.Types (Parser)

data Pos = Pos { posLine :: !Int, posCol :: !Int } deriving (Show, Eq)
data Span = Span { spanStart :: !Pos, spanEnd :: !Pos } deriving (Show, Eq)

instance FromJSON Pos where
  parseJSON = withObject "Pos" $ \v -> Pos <$> v .: "line" <*> v .: "column"
instance FromJSON Span where
  parseJSON = withObject "Span" $ \v -> Span <$> v .: "start" <*> v .: "end"

data ObjcFile = ObjcFile
  { ofFile         :: !(Maybe Text)
  , ofDeclarations :: ![ObjcDecl]
  } deriving (Show, Eq)

instance FromJSON ObjcFile where
  parseJSON = withObject "ObjcFile" $ \v -> ObjcFile
    <$> v .:? "file"
    <*> v .:? "declarations" .!= []

data ObjcDecl
  = ObjCInterfaceDecl
      { odName     :: !Text
      , odChildren :: ![ObjcDecl]
      , odSpan     :: !Span
      }
  | ObjCProtocolDecl
      { odName     :: !Text
      , odChildren :: ![ObjcDecl]
      , odSpan     :: !Span
      }
  | ObjCCategoryDecl
      { odName     :: !Text
      , odChildren :: ![ObjcDecl]
      , odSpan     :: !Span
      }
  | ObjCImplementationDecl
      { odName     :: !Text
      , odChildren :: ![ObjcDecl]
      , odSpan     :: !Span
      }
  | ObjCInstanceMethodDecl
      { odName       :: !Text
      , odReturnType :: !(Maybe Text)
      , odChildren   :: ![ObjcDecl]
      , odSpan       :: !Span
      }
  | ObjCClassMethodDecl
      { odName       :: !Text
      , odReturnType :: !(Maybe Text)
      , odChildren   :: ![ObjcDecl]
      , odSpan       :: !Span
      }
  | ObjCPropertyDecl
      { odName         :: !Text
      , odPropertyType :: !(Maybe Text)
      , odNullability  :: !(Maybe Text)
      , odChildren     :: ![ObjcDecl]
      , odSpan         :: !Span
      }
  | ObjCMessageExpr
      { odName     :: !Text
      , odSelector :: !(Maybe Text)
      , odChildren :: ![ObjcDecl]
      , odSpan     :: !Span
      }
  | ObjCProtocolRef
      { odName :: !Text, odSpan :: !Span }
  | ObjCSuperClassRef
      { odName :: !Text, odSpan :: !Span }
  | InclusionDirective
      { odName :: !Text, odSpan :: !Span }
  | TypedefDecl
      { odName :: !Text, odSpan :: !Span }
  | EnumDecl
      { odName :: !Text, odChildren :: ![ObjcDecl], odSpan :: !Span }
  | EnumConstantDecl
      { odName :: !Text, odSpan :: !Span }
  | FunctionDecl
      { odName :: !Text, odChildren :: ![ObjcDecl], odSpan :: !Span }
  | VarDecl
      { odName :: !Text, odSpan :: !Span }
  | UnknownDecl
      { odName :: !Text, odSpan :: !Span }
  deriving (Show, Eq)

instance FromJSON ObjcDecl where
  parseJSON = withObject "ObjcDecl" $ \v -> do
    typ <- v .: "type" :: Parser Text
    case typ of
      "ObjCInterfaceDecl" -> ObjCInterfaceDecl
        <$> v .: "name" <*> v .:? "children" .!= [] <*> v .: "span"
      "ObjCProtocolDecl" -> ObjCProtocolDecl
        <$> v .: "name" <*> v .:? "children" .!= [] <*> v .: "span"
      "ObjCCategoryDecl" -> ObjCCategoryDecl
        <$> v .: "name" <*> v .:? "children" .!= [] <*> v .: "span"
      "ObjCImplementationDecl" -> ObjCImplementationDecl
        <$> v .: "name" <*> v .:? "children" .!= [] <*> v .: "span"
      "ObjCInstanceMethodDecl" -> ObjCInstanceMethodDecl
        <$> v .: "name" <*> v .:? "returnType" <*> v .:? "children" .!= [] <*> v .: "span"
      "ObjCClassMethodDecl" -> ObjCClassMethodDecl
        <$> v .: "name" <*> v .:? "returnType" <*> v .:? "children" .!= [] <*> v .: "span"
      "ObjCPropertyDecl" -> ObjCPropertyDecl
        <$> v .: "name" <*> v .:? "propertyType" <*> v .:? "nullability"
        <*> v .:? "children" .!= [] <*> v .: "span"
      "ObjCMessageExpr" -> ObjCMessageExpr
        <$> v .: "name" <*> v .:? "selector" <*> v .:? "children" .!= [] <*> v .: "span"
      "ObjCProtocolRef" -> ObjCProtocolRef <$> v .: "name" <*> v .: "span"
      "ObjCSuperClassRef" -> ObjCSuperClassRef <$> v .: "name" <*> v .: "span"
      "InclusionDirective" -> InclusionDirective <$> v .: "name" <*> v .: "span"
      "TypedefDecl" -> TypedefDecl <$> v .: "name" <*> v .: "span"
      "EnumDecl" -> EnumDecl <$> v .: "name" <*> v .:? "children" .!= [] <*> v .: "span"
      "EnumConstantDecl" -> EnumConstantDecl <$> v .: "name" <*> v .: "span"
      "FunctionDecl" -> FunctionDecl
        <$> v .: "name" <*> v .:? "children" .!= [] <*> v .: "span"
      "VarDecl" -> VarDecl <$> v .: "name" <*> v .: "span"
      _ -> UnknownDecl <$> v .:? "name" .!= "" <*> v .: "span"
