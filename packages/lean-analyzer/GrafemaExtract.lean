/-
  Grafema Lean Analyzer v6 — extracts declaration graph from Lean 4 environment.
  Outputs JSONL with nodes and edges for RFDB ingestion.

  Extracts:
  - Nodes: MODULE, THEOREM, DEFINITION, CLASS, INSTANCE, INDUCTIVE, CONSTRUCTOR,
    RECURSOR, AXIOM, OPAQUE, QUOTIENT, RULE_SET
  - Edges: CONTAINS, IMPORTS, TYPE_USES, PROOF_USES, VALUE_USES, HAS_CONSTRUCTOR,
    EXTENDS, INSTANCE_OF, MEMBER_OF
  - Attributes: @[simp], @[ext], @[norm_num], Aesop rule set membership
  - Source positions (line:col) from .ilean DeclarationRanges
  - Origin tag (lean_core / std / mathlib)

  Known limitation: tactic invocation attribution (which tactic found each lemma)
  is not extractable from .olean proof terms. Proof terms contain the RESULT of
  tactic execution (all lemma references are present as PROOF_USES edges) but not
  the tactic that produced them. Extracting tactic attribution would require
  compiler trace logs (set_option trace.Aesop true, etc.) during Mathlib
  compilation — useful for simp set optimization, not for structural analysis.

  Usage: cd mathlib4 && lake env lean --run GrafemaExtract.lean [module] [outfile]
-/
import Lean
-- Mathlib-specific imports: Aesop and NormNum are needed for extracting
-- rule set membership and @[norm_num] annotations. These will fail at
-- compile time for non-Mathlib projects. For generic Lean projects,
-- remove these imports and the corresponding extraction blocks below.
import Aesop
import Mathlib.Tactic.NormNum.Core

open Lean IO System Meta Ext Mathlib.Meta.NormNum Aesop

private def esc (s : String) : String := Id.run do
  let mut out := ""
  for c in s.toList do
    if c == '\\' then out := out ++ "\\\\"
    else if c == '"' then out := out ++ "\\\""
    else if c == '\n' then out := out ++ "\\n"
    else if c == '\r' then out := out ++ "\\r"
    else if c == '\t' then out := out ++ "\\t"
    else if c == '\x08' then out := out ++ "\\b"   -- backspace U+0008
    else if c == '\x0C' then out := out ++ "\\f"   -- form feed U+000C
    else if c.val ≤ 0x1F then
      -- Other control characters U+0000–U+001F → \uXXXX
      let hex := String.ofList (Nat.toDigits 16 c.val.toNat)
      out := out ++ "\\u" ++ String.ofList (List.replicate (4 - hex.length) '0') ++ hex
    else out := out.push c
  return out

private def J (s : String) : String := "\"" ++ esc s ++ "\""

private def declKind (ci : ConstantInfo) : String :=
  match ci with
  | .axiomInfo _  => "AXIOM"
  | .defnInfo _   => "DEFINITION"
  | .thmInfo _    => "THEOREM"
  | .opaqueInfo _ => "OPAQUE"
  | .quotInfo _   => "QUOTIENT"
  | .inductInfo _ => "INDUCTIVE"
  | .ctorInfo _   => "CONSTRUCTOR"
  | .recInfo _    => "RECURSOR"

private def shortName (n : Name) : String :=
  match n with
  | .str _ s => s
  | .num _ n => toString n
  | .anonymous => n.toString

private def modToFile (n : Name) : String :=
  n.toString.replace "." "/" ++ ".lean"

private def nsOrigin (ms : String) : String :=
  if ms.startsWith "Mathlib" then "mathlib"
  else if ms.startsWith "Std" then "std"
  else "lean_core"

unsafe def main (args : List String) : IO Unit := do
  let target := (args.head?.getD "Mathlib").toName
  let outFile := match args.tail? with
    | some (x :: _) => x
    | _ => "mathlib-graph.jsonl"

  initSearchPath (← findSysroot)
  enableInitializersExecution

  eprintln s!"Loading environment for `{target}`..."
  let env ← importModules #[{ module := target }] {} 0 (loadExts := true)
  let numMods := env.header.moduleNames.size
  eprintln s!"Loaded {numMods} modules in environment"

  -- Extract simp lemma set via CoreM
  eprintln "Extracting simp lemma set..."
  let coreCtx : Core.Context := { fileName := "<extract>", fileMap := default }
  let coreState : Core.State := { env }
  let (simpThms, _) ← Meta.getSimpTheorems.toIO coreCtx coreState
  let simpNames : NameHashSet := simpThms.lemmaNames.fold (init := ({} : NameHashSet)) fun acc origin =>
    match origin with
    | .decl n .. => acc.insert n
    | _          => acc
  eprintln s!"  {simpNames.size} simp lemmas"

  -- Extract @[ext] theorem set (Lean core — Lean.Meta.Ext.extExtension)
  eprintln "Extracting ext theorem set..."
  let extThms := extExtension.getState env
  let extNames : NameHashSet := extThms.tree.values.foldl (init := ({} : NameHashSet)) fun acc thm =>
    if extThms.erased.contains thm.declName then acc
    else acc.insert thm.declName
  eprintln s!"  {extNames.size} ext theorems"

  -- Extract @[norm_num] eval function names from NormNums state.
  -- NOTE: norm_num marks evaluator functions (like evalMul, evalNatCast),
  -- not lemmas. These are DEFINITION nodes in the graph.
  eprintln "Extracting norm_num extensions..."
  let normNumNames : NameHashSet ← try
    let normNumState := normNumExt.getState env
    let names : NameHashSet := normNumState.tree.values.foldl (init := ({} : NameHashSet)) fun acc ext =>
      if normNumState.erased.contains ext.name then acc
      else acc.insert ext.name
    eprintln s!"  {names.size} norm_num eval functions"
    pure names
  catch _ =>
    eprintln "  norm_num extensions not available (not a Mathlib project?)"
    pure ({} : NameHashSet)

  -- Extract Aesop rule sets (continuity, measurability, etc.)
  eprintln "Extracting Aesop rule sets..."
  let aesopRuleSetData : Array (String × NameHashSet) ← try
    let (aesopRuleSets, _) ← Frontend.getDeclaredGlobalRuleSets.toIO coreCtx coreState
    let mut data : Array (String × NameHashSet) := #[]
    for (rsName, grs, _, _) in aesopRuleSets do
      let rs := rsName.toString
      if rs == "default" || rs == "builtin" then continue
      let base := grs.toBaseRuleSet
      let names := base.ruleNames.foldl (init := ({} : NameHashSet)) fun acc declName _ =>
        acc.insert declName
      data := data.push (rs, names)
      eprintln s!"  {rs}: {names.size} rules"
    pure data
  catch _ =>
    eprintln "  Aesop rule sets not available (not a Mathlib project?)"
    pure #[]

  let h ← FS.Handle.mk outFile .write
  let mut mc : Nat := 0
  let mut dc : Nat := 0
  let mut ec : Nat := 0
  let mut classCount : Nat := 0
  let mut instanceCount : Nat := 0
  let mut extendsCount : Nat := 0
  let mut simpCount : Nat := 0
  let mut extCount : Nat := 0

  for i in [:numMods] do
    let modName := env.header.moduleNames[i]!
    let ms := modName.toString
    if ms == "" then continue
    let md := env.header.moduleData[i]!
    let fp := modToFile modName
    let origin := nsOrigin ms

    -- MODULE node
    h.putStrLn s!"\{\"t\":\"n\",\"id\":{J ms},\"type\":\"MODULE\",\"name\":{J ms},\"file\":{J fp},\"origin\":{J origin}}"
    mc := mc + 1

    -- IMPORTS edges
    for imp in md.imports do
      h.putStrLn s!"\{\"t\":\"e\",\"src\":{J ms},\"tgt\":{J imp.module.toString},\"type\":\"IMPORTS\"}"
      ec := ec + 1

    -- Declarations
    for j in [:md.constNames.size] do
      let name := md.constNames[j]!
      if name.isInternal then continue
      let ci := md.constants[j]!
      let ns := name.toString
      let sn := shortName name
      let k := declKind ci

      let isClsFlag := isClass env name
      let isInstFlag := isInstanceCore env name

      -- Refined type: CLASS if it's a class, INSTANCE if it's an instance
      let nodeType := if isClsFlag then "CLASS"
        else if isInstFlag then "INSTANCE"
        else k

      let isSimpFlag := simpNames.contains name
      if isSimpFlag then simpCount := simpCount + 1
      let isExtFlag := extNames.contains name
      if isExtFlag then extCount := extCount + 1

      -- Declaration node — with source position from DeclarationRanges
      let uparams := ci.levelParams.map (·.toString)
      let uparamsJson := String.intercalate "," (uparams.map (J ·))
      let isNormNumFlag := normNumNames.contains name
      let simpField := if isSimpFlag then ",\"simp\":true" else ""
      let extField := if isExtFlag then ",\"ext\":true" else ""
      let normNumField := if isNormNumFlag then ",\"norm_num\":true" else ""
      let posField := match declRangeExt.find? env name (level := .server) with
        | some dr =>
          let r := dr.selectionRange
          s!",\"line\":{r.pos.line},\"col\":{r.pos.column},\"endLine\":{r.endPos.line},\"endCol\":{r.endPos.column}"
        | none => ""
      h.putStrLn s!"\{\"t\":\"n\",\"id\":{J ns},\"type\":{J nodeType},\"name\":{J sn},\"file\":{J fp},\"module\":{J ms},\"origin\":{J origin},\"uparams\":[{uparamsJson}]{simpField}{extField}{normNumField}{posField}}"
      dc := dc + 1

      if isClsFlag then classCount := classCount + 1
      if isInstFlag then instanceCount := instanceCount + 1

      -- CONTAINS edge
      h.putStrLn s!"\{\"t\":\"e\",\"src\":{J ms},\"tgt\":{J ns},\"type\":\"CONTAINS\"}"
      ec := ec + 1

      -- EXTENDS edges (class hierarchy) — from StructureParentInfo
      if let some sinfo := getStructureInfo? env name then
        for parent in sinfo.parentInfo do
          h.putStrLn s!"\{\"t\":\"e\",\"src\":{J ns},\"tgt\":{J parent.structName.toString},\"type\":\"EXTENDS\"}"
          ec := ec + 1
          extendsCount := extendsCount + 1

      -- INSTANCE_OF edge: instance → class
      -- Extract class name from instance's type: first constant in the return type
      if isInstFlag then
        let mut returnType := ci.type
        -- Peel off forall binders to get to the conclusion
        while returnType.isForall do
          returnType := returnType.bindingBody!
        -- The head of the conclusion should be the class name
        let headConst := returnType.getAppFn
        if let .const className _ := headConst then
          if isClass env className then
            h.putStrLn s!"\{\"t\":\"e\",\"src\":{J ns},\"tgt\":{J className.toString},\"type\":\"INSTANCE_OF\"}"
            ec := ec + 1

      -- Type dependencies
      let typeDeps : NameSet := ci.type.getUsedConstantsAsSet
      for dep in typeDeps do
        if dep == name || dep.isInternal then continue
        h.putStrLn s!"\{\"t\":\"e\",\"src\":{J ns},\"tgt\":{J dep.toString},\"type\":\"TYPE_USES\"}"
        ec := ec + 1

      -- Value/proof dependencies
      let valInfo : Option (Expr × String) := match ci with
        | .defnInfo v => some (v.value, "VALUE_USES")
        | .thmInfo v  => some (v.value, "PROOF_USES")
        | _           => none
      if let some (val, edgeType) := valInfo then
        let valDeps : NameSet := val.getUsedConstantsAsSet
        for dep in valDeps do
          if dep == name || dep.isInternal then continue
          if typeDeps.contains dep then continue
          h.putStrLn s!"\{\"t\":\"e\",\"src\":{J ns},\"tgt\":{J dep.toString},\"type\":{J edgeType}}"
          ec := ec + 1

      -- Inductive → constructor edges
      match ci with
      | .inductInfo v =>
        for ctor in v.ctors do
          h.putStrLn s!"\{\"t\":\"e\",\"src\":{J ns},\"tgt\":{J ctor.toString},\"type\":\"HAS_CONSTRUCTOR\"}"
          ec := ec + 1
      | .ctorInfo v =>
        h.putStrLn s!"\{\"t\":\"e\",\"src\":{J v.induct.toString},\"tgt\":{J ns},\"type\":\"HAS_CONSTRUCTOR\"}"
        ec := ec + 1
      | _ => pure ()

    if mc % 200 == 0 && mc > 0 then
      eprintln s!"  {mc} modules, {dc} declarations, {ec} edges"

  -- Emit RULE_SET nodes and MEMBER_OF edges
  for (rsName, members) in aesopRuleSetData do
    let rsId := s!"__rule_set__/{rsName}"
    h.putStrLn s!"\{\"t\":\"n\",\"id\":{J rsId},\"type\":\"RULE_SET\",\"name\":{J rsName},\"file\":\"\",\"origin\":\"mathlib\"}"
    let memberArr := members.fold (init := #[]) fun acc n => acc.push n
    for member in memberArr do
      h.putStrLn s!"\{\"t\":\"e\",\"src\":{J member.toString},\"tgt\":{J rsId},\"type\":\"MEMBER_OF\"}"
      ec := ec + 1

  eprintln s!"Complete!"
  eprintln s!"  Modules:      {mc}"
  eprintln s!"  Declarations: {dc}"
  eprintln s!"  Edges:        {ec}"
  eprintln s!"  Classes:      {classCount}"
  eprintln s!"  Instances:    {instanceCount}"
  eprintln s!"  Extends:      {extendsCount}"
  eprintln s!"  Simp lemmas:  {simpCount}"
  eprintln s!"  Ext theorems: {extCount}"
  eprintln s!"  Output:       {outFile}"
