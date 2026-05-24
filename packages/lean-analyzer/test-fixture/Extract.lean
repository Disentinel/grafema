/-
  Grafema Lean Analyzer — standalone extractor (no Mathlib/Aesop dependency).
  Compatible with Lean 4.16.0 stdlib only.
  Stripped-down version of GrafemaExtract.lean for non-Mathlib projects.

  Outputs JSONL with nodes and edges for RFDB ingestion.

  Usage: lake env lean --run Extract.lean [module] [outfile]
-/
import Lean

open Lean IO System Meta

private def esc (s : String) : String := Id.run do
  let mut out := ""
  for c in s.toList do
    if c == '\\' then out := out ++ "\\\\"
    else if c == '"' then out := out ++ "\\\""
    else if c == '\n' then out := out ++ "\\n"
    else if c == '\r' then out := out ++ "\\r"
    else if c == '\t' then out := out ++ "\\t"
    else if c == '\x08' then out := out ++ "\\b"
    else if c == '\x0C' then out := out ++ "\\f"
    else if c.val ≤ 0x1F then
      let hex := String.mk (Nat.toDigits 16 c.val.toNat)
      out := out ++ "\\u" ++ String.mk (List.replicate (4 - hex.length) '0') ++ hex
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
  let target := (args.head?.getD "TestFixture").toName
  let outFile := match args.tail? with
    | some (x :: _) => x
    | _ => "test-output.jsonl"

  initSearchPath (← findSysroot)
  enableInitializersExecution

  eprintln s!"Loading environment for `{target}`..."
  let env ← importModules #[{ module := target }] {} 0
  let numMods := env.header.moduleNames.size
  eprintln s!"Loaded {numMods} modules in environment"

  -- CoreM context for MetaM queries (isInstance, getSimpTheorems)
  let coreCtx : Core.Context := { fileName := "<extract>", fileMap := default }
  let coreState : Core.State := { env }

  -- Extract simp lemma set via CoreM
  eprintln "Extracting simp lemma set..."
  let (simpThms, _) ← Meta.getSimpTheorems.toIO coreCtx coreState
  let simpNames : NameHashSet := simpThms.lemmaNames.fold (init := ({} : NameHashSet)) fun acc origin =>
    match origin with
    | .decl n .. => acc.insert n
    | _          => acc
  eprintln s!"  {simpNames.size} simp lemmas"

  -- Extract @[ext] theorem set (Lean.Elab.Tactic.Ext in v4.16.0)
  eprintln "Extracting ext theorem set..."
  let extThms := Lean.Elab.Tactic.Ext.extExtension.getState env
  let extNames : NameHashSet := extThms.tree.values.foldl (init := ({} : NameHashSet)) fun acc thm =>
    if extThms.erased.contains thm.declName then acc
    else acc.insert thm.declName
  eprintln s!"  {extNames.size} ext theorems"

  -- Build instance name set: iterate all constants, check via MetaM
  eprintln "Building instance set..."
  let mut instanceSet : NameHashSet := {}
  for (name, _) in env.constants.map₁.toList do
    if name.isInternal then continue
    let (isInst, _) ← (Meta.isInstance name).toIO coreCtx coreState
    if isInst then
      instanceSet := instanceSet.insert name
  eprintln s!"  {instanceSet.size} instances"

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
      let isInstFlag := instanceSet.contains name

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
      let simpField := if isSimpFlag then ",\"simp\":true" else ""
      let extField := if isExtFlag then ",\"ext\":true" else ""
      let posField := match declRangeExt.find? env name with
        | some dr =>
          let r := dr.selectionRange
          s!",\"line\":{r.pos.line},\"col\":{r.pos.column},\"endLine\":{r.endPos.line},\"endCol\":{r.endPos.column}"
        | none => ""
      h.putStrLn s!"\{\"t\":\"n\",\"id\":{J ns},\"type\":{J nodeType},\"name\":{J sn},\"file\":{J fp},\"module\":{J ms},\"origin\":{J origin},\"uparams\":[{uparamsJson}]{simpField}{extField}{posField}}"
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
      if isInstFlag then
        let mut returnType := ci.type
        while returnType.isForall do
          returnType := returnType.bindingBody!
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
