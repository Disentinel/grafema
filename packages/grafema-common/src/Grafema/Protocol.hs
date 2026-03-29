{-# LANGUAGE LambdaCase #-}
{-# LANGUAGE OverloadedStrings #-}
-- Plugin protocol types for streaming mode (NDJSON on stdin/stdout)
-- and length-prefixed MessagePack framing for daemon mode.
module Grafema.Protocol
  ( PluginCommand(..)
  , readNodesFromStdin
  , writeCommandsToStdout
  -- * Length-prefixed framing
  , readFrame
  , writeFrame
  -- * MessagePack encode/decode via aeson bridge
  , encodeMsgpack
  , decodeMsgpack
  -- * Direct msgpack encoding (bypasses aeson)
  , pluginCommandToMsgpack
  ) where

import Grafema.Types

import Data.Aeson (ToJSON(..), FromJSON(..), object, (.=), decode, encode, fromJSON)
import qualified Data.Aeson as Aeson
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import Data.Binary.Get (runGet, getWord32be)
import Data.Binary.Put (runPut, putWord32be)
import qualified Data.Binary as Binary
import qualified Data.MessagePack as MP
import Data.Scientific (floatingOrInteger)
import Data.Text (Text)
import qualified Data.Text.Lazy as TL
import qualified Data.Text.Lazy.Encoding as TLE
import Data.Word (Word32)
import qualified Data.Map.Strict as Map
import qualified Data.ByteString.Lazy as BL
import qualified Data.ByteString.Lazy.Char8 as BLC
import qualified Data.Vector as V
import System.IO (Handle, hFlush)

-- | A command emitted by a streaming plugin.
data PluginCommand
  = EmitNode GraphNode
  | EmitEdge GraphEdge
  deriving (Show, Eq)

-- | Encode a metadata map as a JSON-encoded string.
-- The Rust orchestrator expects metadata as Option<String> (JSON string),
-- not as a nested object.
metaToJSONString :: Map.Map Text MetaValue -> Text
metaToJSONString m = TL.toStrict (TLE.decodeUtf8 (encode (metaToJSON m)))

instance ToJSON PluginCommand where
  toJSON (EmitNode n) = object $
    [ "type"     .= ("emit_node" :: Text)
    , "id"       .= gnId n
    , "nodeType" .= gnType n
    , "name"     .= gnName n
    , "file"     .= gnFile n
    , "line"     .= gnLine n
    , "column"   .= gnColumn n
    , "exported" .= gnExported n
    ] ++
    [ "metadata" .= metaToJSONString (gnMetadata n) | not (Map.null (gnMetadata n)) ]
  toJSON (EmitEdge e) = object $
    [ "type" .= ("emit_edge" :: Text)
    , "src"  .= geSource e
    , "dst"  .= geTarget e
    , "edgeType" .= geType e
    ] ++
    [ "metadata" .= metaToJSONString (geMetadata e) | not (Map.null (geMetadata e)) ]

-- | Convert a PluginCommand directly to msgpack Object, bypassing aeson.
-- Used by the daemon's batch response path for better memory efficiency.
pluginCommandToMsgpack :: PluginCommand -> MP.Object
pluginCommandToMsgpack (EmitNode n) = MP.ObjectMap $ V.fromList $
  [ (MP.ObjectStr "type", MP.ObjectStr "emit_node")
  , (MP.ObjectStr "id", MP.ObjectStr (gnId n))
  , (MP.ObjectStr "nodeType", MP.ObjectStr (gnType n))
  , (MP.ObjectStr "name", MP.ObjectStr (gnName n))
  , (MP.ObjectStr "file", MP.ObjectStr (gnFile n))
  , (MP.ObjectStr "line", MP.ObjectInt (fromIntegral (gnLine n)))
  , (MP.ObjectStr "column", MP.ObjectInt (fromIntegral (gnColumn n)))
  , (MP.ObjectStr "exported", MP.ObjectBool (gnExported n))
  ] ++
  [ (MP.ObjectStr "metadata", MP.ObjectStr (metaToJSONString (gnMetadata n)))
  | not (Map.null (gnMetadata n))
  ]
pluginCommandToMsgpack (EmitEdge e) = MP.ObjectMap $ V.fromList $
  [ (MP.ObjectStr "type", MP.ObjectStr "emit_edge")
  , (MP.ObjectStr "src", MP.ObjectStr (geSource e))
  , (MP.ObjectStr "dst", MP.ObjectStr (geTarget e))
  , (MP.ObjectStr "edgeType", MP.ObjectStr (geType e))
  ] ++
  [ (MP.ObjectStr "metadata", MP.ObjectStr (metaToJSONString (geMetadata e)))
  | not (Map.null (geMetadata e))
  ]

-- | Read NDJSON nodes from stdin.
readNodesFromStdin :: IO [GraphNode]
readNodesFromStdin = do
  input <- BL.getContents
  let ls = BLC.lines input
  return [node | Just node <- map decode ls]

-- | Write NDJSON commands to stdout.
writeCommandsToStdout :: [PluginCommand] -> IO ()
writeCommandsToStdout = mapM_ (\cmd -> BLC.putStrLn (encode cmd))

-- ---------------------------------------------------------------------
-- Length-prefixed framing (4-byte BE u32 length + payload)
-- ---------------------------------------------------------------------

-- | Read a length-prefixed frame from a handle.
-- Returns Nothing on EOF (when fewer than 4 bytes available).
readFrame :: Handle -> IO (Maybe BL.ByteString)
readFrame h = do
  lenBs <- BL.hGet h 4
  if BL.length lenBs < 4
    then return Nothing
    else do
      let len = fromIntegral (runGet getWord32be lenBs) :: Int
      payload <- BL.hGet h len
      return (Just payload)

-- | Write a length-prefixed frame to a handle, flushing after.
writeFrame :: Handle -> BL.ByteString -> IO ()
writeFrame h payload = do
  let len = fromIntegral (BL.length payload) :: Word32
  BL.hPut h (runPut (putWord32be len))
  BL.hPut h payload
  hFlush h

-- ---------------------------------------------------------------------
-- MessagePack encode/decode via aeson bridge
-- ---------------------------------------------------------------------

-- | Encode a value with ToJSON to MessagePack bytes.
encodeMsgpack :: ToJSON a => a -> BL.ByteString
encodeMsgpack = Binary.encode . aesonToMsgpack . toJSON

-- | Decode MessagePack bytes to a value with FromJSON.
decodeMsgpack :: FromJSON a => BL.ByteString -> Either String a
decodeMsgpack bs =
  let obj = Binary.decode bs :: MP.Object
  in case msgpackToAeson obj of
    Nothing  -> Left "Failed to convert MessagePack to JSON Value"
    Just val -> case fromJSON val of
      Aeson.Success a -> Right a
      Aeson.Error e   -> Left e

-- | Convert aeson Value to MessagePack Object.
aesonToMsgpack :: Aeson.Value -> MP.Object
aesonToMsgpack = \case
  Aeson.Object km -> MP.ObjectMap $ V.fromList
    [ (MP.ObjectStr (Key.toText k), aesonToMsgpack v)
    | (k, v) <- KM.toList km
    ]
  Aeson.Array vec -> MP.ObjectArray (V.map aesonToMsgpack vec)
  Aeson.String t  -> MP.ObjectStr t
  Aeson.Number n  -> case floatingOrInteger n of
    Right i -> MP.ObjectInt i
    Left d  -> MP.ObjectDouble d
  Aeson.Bool b    -> MP.ObjectBool b
  Aeson.Null      -> MP.ObjectNil

-- | Convert MessagePack Object to aeson Value.
msgpackToAeson :: MP.Object -> Maybe Aeson.Value
msgpackToAeson = \case
  MP.ObjectNil      -> Just Aeson.Null
  MP.ObjectBool b   -> Just (Aeson.Bool b)
  MP.ObjectInt n    -> Just (Aeson.Number (fromIntegral n))
  MP.ObjectFloat f  -> Just (Aeson.Number (realToFrac f))
  MP.ObjectDouble d -> Just (Aeson.Number (realToFrac d))
  MP.ObjectStr t    -> Just (Aeson.String t)
  MP.ObjectBin _    -> Nothing
  MP.ObjectArray v  -> Aeson.Array <$> V.mapM msgpackToAeson v
  MP.ObjectMap m    -> do
    pairs <- V.mapM keyValPair m
    Just (Aeson.Object (KM.fromList (V.toList pairs)))
  MP.ObjectExt _ _  -> Nothing
  where
    keyValPair (k, v) = do
      kText <- case k of
        MP.ObjectStr t -> Just t
        _              -> Nothing
      val <- msgpackToAeson v
      return (Key.fromText kText, val)
