-- | Haskell source parser using ghc-lib-parser.
--
-- Provides a single entry point 'parseHaskell' that takes a file path and
-- source text, and returns either a parse error string or the parsed
-- HsModule. Uses ghc-lib-parser (>= 9.8, < 9.10) so no real GHC installation
-- is required at runtime — we construct fake Settings/DynFlags.
--
-- Extensions: enables a broad set of commonly-used Haskell extensions so
-- that most real-world source files parse without needing per-file
-- configuration. The caller can extend this later if needed.
module Parser
  ( parseHaskell  -- :: FilePath -> Text -> Either String (HsModule GhcPs)
  ) where

import Data.Text (Text)
import qualified Data.Text as T

import GHC.Data.FastString (mkFastString)
import GHC.Data.StringBuffer (stringToStringBuffer)
import GHC.Driver.Config.Parser (initParserOpts)
import GHC.Driver.Session
  ( DynFlags
  , defaultDynFlags
  , xopt_set
  )
import GHC.Hs (HsModule, GhcPs)
import GHC.LanguageExtensions (Extension(..))
import qualified GHC.Parser as Parser
import qualified GHC.Parser.Lexer as Lexer
import GHC.Platform (genericPlatform)
import GHC.Settings
  ( FileSettings(..)
  , GhcNameVersion(..)
  , PlatformMisc(..)
  , Settings(..)
  , ToolSettings(..)
  )
import GHC.Types.Error (NoDiagnosticOpts(..))
import GHC.Types.SrcLoc (GenLocated(..), mkRealSrcLoc)
import GHC.Utils.Error (pprMessages)
import GHC.Utils.Fingerprint (fingerprint0)
import GHC.Utils.Outputable (defaultSDocContext, renderWithContext)

-- ── Fake GHC settings ─────────────────────────────────────────────────
--
-- ghc-lib-parser needs Settings/DynFlags but doesn't use a real GHC
-- installation. We construct minimal fakes — only the fields that the
-- parser actually inspects matter; the rest are safe defaults.

fakeSettings :: Settings
fakeSettings = Settings
  { sGhcNameVersion = GhcNameVersion
      { ghcNameVersion_programName    = "ghc"
      , ghcNameVersion_projectVersion = "9.8.4"
      }
  , sFileSettings = FileSettings
      { fileSettings_ghcUsagePath          = ""
      , fileSettings_ghciUsagePath         = ""
      , fileSettings_toolDir               = Nothing
      , fileSettings_topDir                = ""
      , fileSettings_globalPackageDatabase = ""
      }
  , sToolSettings = fakeToolSettings
  , sPlatformMisc = PlatformMisc
      { platformMisc_targetPlatformString = "x86_64-unknown-linux"
      , platformMisc_ghcWithInterpreter   = False
      , platformMisc_libFFI               = False
      , platformMisc_llvmTarget           = ""
      }
  , sTargetPlatform = genericPlatform
  , sRawSettings    = []
  }

-- | Minimal ToolSettings — the parser doesn't invoke any external tools,
-- so every field is a safe empty/default value.
fakeToolSettings :: ToolSettings
fakeToolSettings = ToolSettings
  { toolSettings_ldSupportsCompactUnwind  = False
  , toolSettings_ldSupportsFilelist       = False
  , toolSettings_ldSupportsResponseFiles  = False
  , toolSettings_ldSupportsSingleModule   = False
  , toolSettings_ldIsGnuLd                = False
  , toolSettings_ccSupportsNoPie          = False
  , toolSettings_useInplaceMinGW          = False
  , toolSettings_arSupportsDashL          = False
  , toolSettings_pgm_L                    = ""
  , toolSettings_pgm_P                    = ("", [])
  , toolSettings_pgm_F                    = ""
  , toolSettings_pgm_c                    = ""
  , toolSettings_pgm_cxx                  = ""
  , toolSettings_pgm_a                    = ("", [])
  , toolSettings_pgm_l                    = ("", [])
  , toolSettings_pgm_lm                   = Nothing
  , toolSettings_pgm_dll                  = ("", [])
  , toolSettings_pgm_T                    = ""
  , toolSettings_pgm_windres              = ""
  , toolSettings_pgm_ar                   = ""
  , toolSettings_pgm_otool                = ""
  , toolSettings_pgm_install_name_tool    = ""
  , toolSettings_pgm_ranlib               = ""
  , toolSettings_pgm_lo                   = ("", [])
  , toolSettings_pgm_lc                   = ("", [])
  , toolSettings_pgm_lcc                  = ("", [])
  , toolSettings_pgm_i                    = ""
  , toolSettings_opt_L                    = []
  , toolSettings_opt_P                    = []
  , toolSettings_opt_P_fingerprint        = fingerprint0
  , toolSettings_opt_F                    = []
  , toolSettings_opt_c                    = []
  , toolSettings_opt_cxx                  = []
  , toolSettings_opt_a                    = []
  , toolSettings_opt_l                    = []
  , toolSettings_opt_lm                   = []
  , toolSettings_opt_windres              = []
  , toolSettings_opt_lo                   = []
  , toolSettings_opt_lc                   = []
  , toolSettings_opt_lcc                  = []
  , toolSettings_opt_i                    = []
  , toolSettings_extraGccViaCFlags        = []
  }

-- | DynFlags configured for parsing.
-- Starts from defaults, then enables common extensions used in modern
-- Haskell code. This allows most real-world source files to parse
-- without per-file LANGUAGE pragma detection.
parseDynFlags :: DynFlags
parseDynFlags =
  foldl xopt_set base extensions
  where
    base = defaultDynFlags fakeSettings
    extensions =
      [ OverloadedStrings
      , LambdaCase
      , ImportQualifiedPost
      , MultiWayIf
      , BangPatterns
      , DerivingStrategies
      , TypeFamilies
      , DataKinds
      , TypeApplications
      , ScopedTypeVariables
      , RankNTypes
      , FlexibleContexts
      , FlexibleInstances
      , GeneralizedNewtypeDeriving
      , StandaloneDeriving
      , DeriveGeneric
      , DeriveFunctor
      , DeriveFoldable
      , DeriveTraversable
      , DeriveAnyClass
      , RecordWildCards
      , NamedFieldPuns
      , TupleSections
      , NumericUnderscores
      , BlockArguments
      , PatternSynonyms
      , ViewPatterns
      , GADTs
      , ConstraintKinds
      , KindSignatures
      , ExistentialQuantification
      , DefaultSignatures
      , InstanceSigs
      , MultiParamTypeClasses
      , FunctionalDependencies
      ]

-- ── Parser ────────────────────────────────────────────────────────────

-- | Parse Haskell source code into a GHC AST module.
--
-- @parseHaskell path source@ uses @path@ only for error messages and
-- source location tracking. The actual content comes from @source@.
--
-- Returns @Left errorMsg@ on parse failure, @Right module@ on success.
parseHaskell :: FilePath -> Text -> Either String (HsModule GhcPs)
parseHaskell path source =
  case Lexer.unP Parser.parseModule parseState of
    Lexer.POk _pstate (L _loc hsModule) ->
      Right hsModule
    Lexer.PFailed pstate ->
      let msgs = Lexer.getPsErrorMessages pstate
          sdoc = pprMessages NoDiagnosticOpts msgs
      in  Left (renderWithContext defaultSDocContext sdoc)
  where
    srcLoc     = mkRealSrcLoc (mkFastString path) 1 1
    buffer     = stringToStringBuffer (T.unpack source)
    opts       = initParserOpts parseDynFlags
    parseState = Lexer.initParserState opts buffer srcLoc
