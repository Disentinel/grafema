package main

import (
	"go/ast"
	"go/token"
	"strconv"
)

// ── Span helpers ────────────────────────────────────────────────────────

type spanPos struct {
	Line int `json:"line"`
	Col  int `json:"col"`
}

type span struct {
	Start spanPos `json:"start"`
	End   spanPos `json:"end"`
}

func makeSpan(fset *token.FileSet, pos, end token.Pos) span {
	s := span{}
	if pos.IsValid() {
		p := fset.Position(pos)
		s.Start = spanPos{Line: p.Line, Col: p.Column - 1} // 0-based col
	}
	if end.IsValid() {
		p := fset.Position(end)
		s.End = spanPos{Line: p.Line, Col: p.Column - 1}
	}
	return s
}

func nodeSpan(fset *token.FileSet, node ast.Node) span {
	if node == nil {
		return span{}
	}
	return makeSpan(fset, node.Pos(), node.End())
}

// ── Top-level file ──────────────────────────────────────────────────────

func serializeFile(fset *token.FileSet, f *ast.File) map[string]interface{} {
	result := map[string]interface{}{
		"package": f.Name.Name,
	}

	// Imports
	imports := make([]interface{}, 0)
	for _, imp := range f.Imports {
		imports = append(imports, serializeImport(fset, imp))
	}
	result["imports"] = imports

	// Declarations
	decls := make([]interface{}, 0)
	for _, decl := range f.Decls {
		serialized := serializeDecl(fset, decl)
		decls = append(decls, serialized...)
	}
	result["decls"] = decls

	return result
}

// ── Imports ─────────────────────────────────────────────────────────────

func serializeImport(fset *token.FileSet, imp *ast.ImportSpec) map[string]interface{} {
	path, _ := strconv.Unquote(imp.Path.Value)

	result := map[string]interface{}{
		"path":  path,
		"blank": false,
		"dot":   false,
		"span":  nodeSpan(fset, imp),
	}

	// Determine the effective name
	name := ""
	if imp.Name != nil {
		switch imp.Name.Name {
		case "_":
			result["blank"] = true
			name = "_"
		case ".":
			result["dot"] = true
			name = "."
		default:
			result["alias"] = imp.Name.Name
			name = imp.Name.Name
		}
	}

	if name == "" || name == "_" || name == "." {
		// Use the last element of the path as name
		result["name"] = lastPathElement(path)
	} else {
		result["name"] = name
	}

	if _, hasAlias := result["alias"]; !hasAlias {
		result["alias"] = nil
	}

	return result
}

func lastPathElement(path string) string {
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '/' {
			return path[i+1:]
		}
	}
	return path
}

// ── Declarations ────────────────────────────────────────────────────────

func serializeDecl(fset *token.FileSet, decl ast.Decl) []interface{} {
	switch d := decl.(type) {
	case *ast.FuncDecl:
		return []interface{}{serializeFuncDecl(fset, d)}
	case *ast.GenDecl:
		return serializeGenDecl(fset, d)
	default:
		return []interface{}{map[string]interface{}{
			"type": "UnknownDecl",
			"span": nodeSpan(fset, decl),
		}}
	}
}

func serializeFuncDecl(fset *token.FileSet, fd *ast.FuncDecl) map[string]interface{} {
	result := map[string]interface{}{
		"type": "FuncDecl",
		"name": fd.Name.Name,
		"span": nodeSpan(fset, fd),
	}

	// Receiver
	if fd.Recv != nil && len(fd.Recv.List) > 0 {
		result["recv"] = serializeReceiver(fset, fd.Recv.List[0])
	} else {
		result["recv"] = nil
	}

	// Type parameters (Go 1.18+ generics)
	if fd.Type.TypeParams != nil {
		result["typeParams"] = serializeTypeParamList(fset, fd.Type.TypeParams)
	} else {
		result["typeParams"] = []interface{}{}
	}

	// Parameters
	result["params"] = serializeParamList(fset, fd.Type.Params)

	// Results
	if fd.Type.Results != nil {
		result["results"] = serializeParamList(fset, fd.Type.Results)
	} else {
		result["results"] = []interface{}{}
	}

	// Body
	if fd.Body != nil {
		result["body"] = serializeBlockStmt(fset, fd.Body)
	} else {
		result["body"] = nil
	}

	return result
}

func serializeReceiver(fset *token.FileSet, field *ast.Field) map[string]interface{} {
	name := ""
	if len(field.Names) > 0 {
		name = field.Names[0].Name
	}

	typeName := ""
	pointer := false
	typeExpr := field.Type

	// Check if it's a pointer receiver
	if starExpr, ok := typeExpr.(*ast.StarExpr); ok {
		pointer = true
		typeExpr = starExpr.X
	}

	// Extract type name, handling generic receivers like T[K]
	switch t := typeExpr.(type) {
	case *ast.Ident:
		typeName = t.Name
	case *ast.IndexExpr:
		if ident, ok := t.X.(*ast.Ident); ok {
			typeName = ident.Name
		}
	case *ast.IndexListExpr:
		if ident, ok := t.X.(*ast.Ident); ok {
			typeName = ident.Name
		}
	}

	return map[string]interface{}{
		"name":     name,
		"typeName": typeName,
		"pointer":  pointer,
		"span":     nodeSpan(fset, field),
	}
}

func serializeParamList(fset *token.FileSet, fl *ast.FieldList) []interface{} {
	if fl == nil || fl.List == nil {
		return []interface{}{}
	}
	result := make([]interface{}, 0)
	for _, field := range fl.List {
		if len(field.Names) == 0 {
			// Unnamed param/result
			result = append(result, serializeParam(fset, field, ""))
		} else {
			// Expand multi-name params: func(a, b int) -> two separate params
			for _, name := range field.Names {
				result = append(result, serializeParam(fset, field, name.Name))
			}
		}
	}
	return result
}

func serializeParam(fset *token.FileSet, field *ast.Field, name string) map[string]interface{} {
	result := map[string]interface{}{
		"span": nodeSpan(fset, field),
	}
	if name != "" {
		result["name"] = name
	}
	if field.Type != nil {
		result["paramType"] = serializeExpr(fset, field.Type)
		if _, ok := field.Type.(*ast.Ellipsis); ok {
			result["variadic"] = true
		}
	}
	return result
}

func serializeTypeParamList(fset *token.FileSet, fl *ast.FieldList) []interface{} {
	if fl == nil || fl.List == nil {
		return []interface{}{}
	}
	result := make([]interface{}, 0)
	for _, field := range fl.List {
		for _, name := range field.Names {
			result = append(result, serializeTypeParam(fset, field, name.Name))
		}
	}
	return result
}

func serializeTypeParam(fset *token.FileSet, field *ast.Field, name string) map[string]interface{} {
	result := map[string]interface{}{
		"name": name,
		"span": nodeSpan(fset, field),
	}
	if field.Type != nil {
		result["constraint"] = serializeExpr(fset, field.Type)
	}
	return result
}

func serializeGenDecl(fset *token.FileSet, gd *ast.GenDecl) []interface{} {
	switch gd.Tok {
	case token.TYPE:
		return serializeTypeGenDecl(fset, gd)
	case token.VAR:
		return []interface{}{serializeVarConstDecl(fset, gd, "VarDecl")}
	case token.CONST:
		return []interface{}{serializeVarConstDecl(fset, gd, "ConstDecl")}
	case token.IMPORT:
		// Imports are handled at the file level; skip here
		return nil
	default:
		return []interface{}{map[string]interface{}{
			"type": "UnknownDecl",
			"span": nodeSpan(fset, gd),
		}}
	}
}

func serializeTypeGenDecl(fset *token.FileSet, gd *ast.GenDecl) []interface{} {
	result := make([]interface{}, 0, len(gd.Specs))
	for _, spec := range gd.Specs {
		if ts, ok := spec.(*ast.TypeSpec); ok {
			result = append(result, serializeTypeSpec(fset, ts))
		}
	}
	return result
}

func serializeTypeSpec(fset *token.FileSet, ts *ast.TypeSpec) map[string]interface{} {
	switch t := ts.Type.(type) {
	case *ast.StructType:
		return serializeStructType(fset, ts.Name.Name, t, ts)
	case *ast.InterfaceType:
		return serializeInterfaceType(fset, ts.Name.Name, t, ts)
	default:
		// Type alias or other type definition
		result := map[string]interface{}{
			"type":    "TypeAliasDecl",
			"name":    ts.Name.Name,
			"aliasOf": serializeExpr(fset, ts.Type),
			"span":    nodeSpan(fset, ts),
		}
		if ts.TypeParams != nil {
			result["typeParams"] = serializeTypeParamList(fset, ts.TypeParams)
		} else {
			result["typeParams"] = []interface{}{}
		}
		return result
	}
}

func serializeStructType(fset *token.FileSet, name string, st *ast.StructType, ts *ast.TypeSpec) map[string]interface{} {
	fields := make([]interface{}, 0)
	if st.Fields != nil {
		for _, field := range st.Fields.List {
			fields = append(fields, serializeStructField(fset, field))
		}
	}

	result := map[string]interface{}{
		"type":   "StructTypeDecl",
		"name":   name,
		"fields": fields,
		"span":   nodeSpan(fset, ts),
	}

	if ts.TypeParams != nil {
		result["typeParams"] = serializeTypeParamList(fset, ts.TypeParams)
	} else {
		result["typeParams"] = []interface{}{}
	}

	return result
}

func serializeStructField(fset *token.FileSet, field *ast.Field) map[string]interface{} {
	result := map[string]interface{}{
		"span": nodeSpan(fset, field),
	}

	embedded := len(field.Names) == 0

	if embedded {
		// For embedded fields, extract the type name
		result["name"] = typeNameString(field.Type)
		result["embedded"] = true
	} else {
		result["name"] = field.Names[0].Name
		result["embedded"] = false
	}

	result["fieldType"] = serializeExpr(fset, field.Type)

	if field.Tag != nil {
		tagVal, _ := strconv.Unquote(field.Tag.Value)
		result["tag"] = tagVal
	} else {
		result["tag"] = nil
	}

	return result
}

func typeNameString(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.Ident:
		return t.Name
	case *ast.SelectorExpr:
		if x, ok := t.X.(*ast.Ident); ok {
			return x.Name + "." + t.Sel.Name
		}
		return t.Sel.Name
	case *ast.StarExpr:
		return typeNameString(t.X)
	default:
		return ""
	}
}

func serializeInterfaceType(fset *token.FileSet, name string, it *ast.InterfaceType, ts *ast.TypeSpec) map[string]interface{} {
	methods := make([]interface{}, 0)
	embeds := make([]interface{}, 0)

	if it.Methods != nil {
		for _, field := range it.Methods.List {
			if len(field.Names) > 0 {
				// Named method
				methods = append(methods, serializeInterfaceMethod(fset, field))
			} else {
				// Embedded interface — serialize as GoType
				embeds = append(embeds, serializeExpr(fset, field.Type))
			}
		}
	}

	result := map[string]interface{}{
		"type":    "InterfaceTypeDecl",
		"name":    name,
		"methods": methods,
		"embeds":  embeds,
		"span":    nodeSpan(fset, ts),
	}

	if ts.TypeParams != nil {
		result["typeParams"] = serializeTypeParamList(fset, ts.TypeParams)
	} else {
		result["typeParams"] = []interface{}{}
	}

	return result
}

func serializeInterfaceMethod(fset *token.FileSet, field *ast.Field) map[string]interface{} {
	result := map[string]interface{}{
		"name": field.Names[0].Name,
		"span": nodeSpan(fset, field),
	}

	if ft, ok := field.Type.(*ast.FuncType); ok {
		result["params"] = serializeParamList(fset, ft.Params)
		if ft.Results != nil {
			result["results"] = serializeParamList(fset, ft.Results)
		} else {
			result["results"] = []interface{}{}
		}
	}

	return result
}

func serializeVarConstDecl(fset *token.FileSet, gd *ast.GenDecl, declType string) map[string]interface{} {
	specs := make([]interface{}, 0)
	for _, spec := range gd.Specs {
		if vs, ok := spec.(*ast.ValueSpec); ok {
			specs = append(specs, serializeValueSpec(fset, vs))
		}
	}
	return map[string]interface{}{
		"type":  declType,
		"specs": specs,
		"span":  nodeSpan(fset, gd),
	}
}

func serializeValueSpec(fset *token.FileSet, vs *ast.ValueSpec) map[string]interface{} {
	names := make([]string, 0)
	for _, name := range vs.Names {
		names = append(names, name.Name)
	}

	result := map[string]interface{}{
		"names": names,
		"span":  nodeSpan(fset, vs),
	}

	if vs.Type != nil {
		result["varType"] = serializeExpr(fset, vs.Type)
	} else {
		result["varType"] = nil
	}

	values := make([]interface{}, 0)
	for _, val := range vs.Values {
		values = append(values, serializeExpr(fset, val))
	}
	result["values"] = values

	return result
}

// ── Statements ──────────────────────────────────────────────────────────

func serializeStmt(fset *token.FileSet, stmt ast.Stmt) interface{} {
	if stmt == nil {
		return nil
	}

	switch s := stmt.(type) {
	case *ast.BlockStmt:
		return serializeBlockStmt(fset, s)

	case *ast.ReturnStmt:
		results := make([]interface{}, 0)
		for _, r := range s.Results {
			results = append(results, serializeExpr(fset, r))
		}
		return map[string]interface{}{
			"type":    "ReturnStmt",
			"results": results,
			"span":    nodeSpan(fset, s),
		}

	case *ast.IfStmt:
		result := map[string]interface{}{
			"type": "IfStmt",
			"cond": serializeExpr(fset, s.Cond),
			"body": serializeStmt(fset, s.Body),
			"span": nodeSpan(fset, s),
		}
		if s.Init != nil {
			result["init"] = serializeStmt(fset, s.Init)
		} else {
			result["init"] = nil
		}
		if s.Else != nil {
			result["else"] = serializeStmt(fset, s.Else)
		} else {
			result["else"] = nil
		}
		return result

	case *ast.ForStmt:
		result := map[string]interface{}{
			"type": "ForStmt",
			"body": serializeStmt(fset, s.Body),
			"span": nodeSpan(fset, s),
		}
		if s.Init != nil {
			result["init"] = serializeStmt(fset, s.Init)
		} else {
			result["init"] = nil
		}
		if s.Cond != nil {
			result["cond"] = serializeExpr(fset, s.Cond)
		} else {
			result["cond"] = nil
		}
		if s.Post != nil {
			result["post"] = serializeStmt(fset, s.Post)
		} else {
			result["post"] = nil
		}
		return result

	case *ast.RangeStmt:
		result := map[string]interface{}{
			"type": "RangeStmt",
			"x":    serializeExpr(fset, s.X),
			"body": serializeStmt(fset, s.Body),
			"span": nodeSpan(fset, s),
		}
		if s.Key != nil {
			result["key"] = serializeExpr(fset, s.Key)
		} else {
			result["key"] = nil
		}
		if s.Value != nil {
			result["value"] = serializeExpr(fset, s.Value)
		} else {
			result["value"] = nil
		}
		return result

	case *ast.SwitchStmt:
		result := map[string]interface{}{
			"type": "SwitchStmt",
			"body": serializeStmt(fset, s.Body),
			"span": nodeSpan(fset, s),
		}
		if s.Init != nil {
			result["init"] = serializeStmt(fset, s.Init)
		} else {
			result["init"] = nil
		}
		if s.Tag != nil {
			result["tag"] = serializeExpr(fset, s.Tag)
		} else {
			result["tag"] = nil
		}
		return result

	case *ast.TypeSwitchStmt:
		result := map[string]interface{}{
			"type":   "TypeSwitchStmt",
			"assign": serializeStmt(fset, s.Assign),
			"body":   serializeStmt(fset, s.Body),
			"span":   nodeSpan(fset, s),
		}
		if s.Init != nil {
			result["init"] = serializeStmt(fset, s.Init)
		} else {
			result["init"] = nil
		}
		return result

	case *ast.SelectStmt:
		return map[string]interface{}{
			"type": "SelectStmt",
			"body": serializeStmt(fset, s.Body),
			"span": nodeSpan(fset, s),
		}

	case *ast.CaseClause:
		list := make([]interface{}, 0)
		for _, expr := range s.List {
			list = append(list, serializeExpr(fset, expr))
		}
		return map[string]interface{}{
			"type": "CaseClause",
			"list": list,
			"body": serializeStmtList(fset, s.Body),
			"span": nodeSpan(fset, s),
		}

	case *ast.CommClause:
		result := map[string]interface{}{
			"type": "CommClause",
			"body": serializeStmtList(fset, s.Body),
			"span": nodeSpan(fset, s),
		}
		if s.Comm != nil {
			result["comm"] = serializeStmt(fset, s.Comm)
		} else {
			result["comm"] = nil
		}
		return result

	case *ast.GoStmt:
		return map[string]interface{}{
			"type": "GoStmt",
			"call": serializeExpr(fset, s.Call),
			"span": nodeSpan(fset, s),
		}

	case *ast.DeferStmt:
		return map[string]interface{}{
			"type": "DeferStmt",
			"call": serializeExpr(fset, s.Call),
			"span": nodeSpan(fset, s),
		}

	case *ast.SendStmt:
		return map[string]interface{}{
			"type":  "SendStmt",
			"chan":  serializeExpr(fset, s.Chan),
			"value": serializeExpr(fset, s.Value),
			"span":  nodeSpan(fset, s),
		}

	case *ast.AssignStmt:
		lhs := make([]interface{}, 0)
		for _, expr := range s.Lhs {
			lhs = append(lhs, serializeExpr(fset, expr))
		}
		rhs := make([]interface{}, 0)
		for _, expr := range s.Rhs {
			rhs = append(rhs, serializeExpr(fset, expr))
		}
		return map[string]interface{}{
			"type": "AssignStmt",
			"lhs":  lhs,
			"rhs":  rhs,
			"tok":  s.Tok.String(),
			"span": nodeSpan(fset, s),
		}

	case *ast.ExprStmt:
		return map[string]interface{}{
			"type": "ExprStmt",
			"x":    serializeExpr(fset, s.X),
			"span": nodeSpan(fset, s),
		}

	case *ast.DeclStmt:
		declResults := serializeDecl(fset, s.Decl)
		if len(declResults) > 0 {
			return map[string]interface{}{
				"type": "DeclStmt",
				"decl": declResults[0],
				"span": nodeSpan(fset, s),
			}
		}
		return map[string]interface{}{
			"type": "EmptyStmt",
			"span": nodeSpan(fset, s),
		}

	case *ast.IncDecStmt:
		return map[string]interface{}{
			"type": "IncDecStmt",
			"x":    serializeExpr(fset, s.X),
			"tok":  s.Tok.String(),
			"span": nodeSpan(fset, s),
		}

	case *ast.BranchStmt:
		result := map[string]interface{}{
			"type": "BranchStmt",
			"tok":  s.Tok.String(),
			"span": nodeSpan(fset, s),
		}
		if s.Label != nil {
			result["label"] = s.Label.Name
		} else {
			result["label"] = nil
		}
		return result

	case *ast.LabeledStmt:
		return map[string]interface{}{
			"type":  "LabeledStmt",
			"label": s.Label.Name,
			"stmt":  serializeStmt(fset, s.Stmt),
			"span":  nodeSpan(fset, s),
		}

	case *ast.EmptyStmt:
		return map[string]interface{}{
			"type": "EmptyStmt",
			"span": nodeSpan(fset, s),
		}

	default:
		return map[string]interface{}{
			"type": "UnknownStmt",
			"span": nodeSpan(fset, stmt),
		}
	}
}

func serializeStmtList(fset *token.FileSet, stmts []ast.Stmt) []interface{} {
	result := make([]interface{}, 0, len(stmts))
	for _, s := range stmts {
		if ds, ok := s.(*ast.DeclStmt); ok {
			declResults := serializeDecl(fset, ds.Decl)
			for _, d := range declResults {
				result = append(result, map[string]interface{}{
					"type": "DeclStmt",
					"decl": d,
					"span": nodeSpan(fset, ds),
				})
			}
		} else {
			result = append(result, serializeStmt(fset, s))
		}
	}
	return result
}

func serializeBlockStmt(fset *token.FileSet, bs *ast.BlockStmt) map[string]interface{} {
	stmts := make([]interface{}, 0)
	if bs != nil && bs.List != nil {
		stmts = serializeStmtList(fset, bs.List)
	}
	return map[string]interface{}{
		"type":  "BlockStmt",
		"stmts": stmts,
		"span":  nodeSpan(fset, bs),
	}
}

// ── Expressions ─────────────────────────────────────────────────────────

func serializeExpr(fset *token.FileSet, expr ast.Expr) interface{} {
	if expr == nil {
		return nil
	}

	switch e := expr.(type) {
	case *ast.Ident:
		return map[string]interface{}{
			"type": "Ident",
			"name": e.Name,
			"span": nodeSpan(fset, e),
		}

	case *ast.SelectorExpr:
		return map[string]interface{}{
			"type": "SelectorExpr",
			"x":    serializeExpr(fset, e.X),
			"sel":  e.Sel.Name,
			"span": nodeSpan(fset, e),
		}

	case *ast.StarExpr:
		return map[string]interface{}{
			"type": "StarExpr",
			"x":    serializeExpr(fset, e.X),
			"span": nodeSpan(fset, e),
		}

	case *ast.ArrayType:
		result := map[string]interface{}{
			"type": "ArrayType",
			"elt":  serializeExpr(fset, e.Elt),
			"span": nodeSpan(fset, e),
		}
		if e.Len != nil {
			result["len"] = serializeExpr(fset, e.Len)
		} else {
			result["len"] = nil
		}
		return result

	case *ast.MapType:
		return map[string]interface{}{
			"type":  "MapType",
			"key":   serializeExpr(fset, e.Key),
			"value": serializeExpr(fset, e.Value),
			"span":  nodeSpan(fset, e),
		}

	case *ast.ChanType:
		dir := "both"
		if e.Dir == ast.SEND {
			dir = "send"
		} else if e.Dir == ast.RECV {
			dir = "recv"
		}
		return map[string]interface{}{
			"type":  "ChanType",
			"dir":   dir,
			"value": serializeExpr(fset, e.Value),
			"span":  nodeSpan(fset, e),
		}

	case *ast.FuncType:
		result := map[string]interface{}{
			"type":   "FuncType",
			"params": serializeParamList(fset, e.Params),
			"span":   nodeSpan(fset, e),
		}
		if e.Results != nil {
			result["results"] = serializeParamList(fset, e.Results)
		} else {
			result["results"] = []interface{}{}
		}
		return result

	case *ast.InterfaceType:
		methods := make([]interface{}, 0)
		if e.Methods != nil {
			for _, field := range e.Methods.List {
				if len(field.Names) > 0 {
					methods = append(methods, serializeInterfaceMethod(fset, field))
				} else {
					methods = append(methods, map[string]interface{}{
						"name": typeNameString(field.Type),
						"span": nodeSpan(fset, field),
					})
				}
			}
		}
		return map[string]interface{}{
			"type":    "InterfaceType",
			"methods": methods,
			"span":    nodeSpan(fset, e),
		}

	case *ast.StructType:
		fields := make([]interface{}, 0)
		if e.Fields != nil {
			for _, field := range e.Fields.List {
				fields = append(fields, serializeStructField(fset, field))
			}
		}
		return map[string]interface{}{
			"type":   "StructType",
			"fields": fields,
			"span":   nodeSpan(fset, e),
		}

	case *ast.IndexExpr:
		return map[string]interface{}{
			"type":  "IndexExpr",
			"x":     serializeExpr(fset, e.X),
			"index": serializeExpr(fset, e.Index),
			"span":  nodeSpan(fset, e),
		}

	case *ast.IndexListExpr:
		indices := make([]interface{}, 0)
		for _, idx := range e.Indices {
			indices = append(indices, serializeExpr(fset, idx))
		}
		return map[string]interface{}{
			"type":    "IndexListExpr",
			"x":       serializeExpr(fset, e.X),
			"indices": indices,
			"span":    nodeSpan(fset, e),
		}

	case *ast.Ellipsis:
		result := map[string]interface{}{
			"type": "Ellipsis",
			"span": nodeSpan(fset, e),
		}
		if e.Elt != nil {
			result["elt"] = serializeExpr(fset, e.Elt)
		} else {
			result["elt"] = nil
		}
		return result

	case *ast.CallExpr:
		args := make([]interface{}, 0)
		for _, arg := range e.Args {
			args = append(args, serializeExpr(fset, arg))
		}
		return map[string]interface{}{
			"type":     "CallExpr",
			"fun":      serializeExpr(fset, e.Fun),
			"args":     args,
			"ellipsis": e.Ellipsis.IsValid(),
			"span":     nodeSpan(fset, e),
		}

	case *ast.BasicLit:
		return map[string]interface{}{
			"type":  "BasicLit",
			"kind":  e.Kind.String(),
			"value": e.Value,
			"span":  nodeSpan(fset, e),
		}

	case *ast.CompositeLit:
		elts := make([]interface{}, 0)
		for _, elt := range e.Elts {
			elts = append(elts, serializeExpr(fset, elt))
		}
		result := map[string]interface{}{
			"type": "CompositeLit",
			"elts": elts,
			"span": nodeSpan(fset, e),
		}
		if e.Type != nil {
			result["litType"] = serializeExpr(fset, e.Type)
		} else {
			result["litType"] = nil
		}
		return result

	case *ast.UnaryExpr:
		return map[string]interface{}{
			"type": "UnaryExpr",
			"op":   e.Op.String(),
			"x":    serializeExpr(fset, e.X),
			"span": nodeSpan(fset, e),
		}

	case *ast.BinaryExpr:
		return map[string]interface{}{
			"type": "BinaryExpr",
			"op":   e.Op.String(),
			"x":    serializeExpr(fset, e.X),
			"y":    serializeExpr(fset, e.Y),
			"span": nodeSpan(fset, e),
		}

	case *ast.KeyValueExpr:
		return map[string]interface{}{
			"type":  "KeyValueExpr",
			"key":   serializeExpr(fset, e.Key),
			"value": serializeExpr(fset, e.Value),
			"span":  nodeSpan(fset, e),
		}

	case *ast.ParenExpr:
		return map[string]interface{}{
			"type": "ParenExpr",
			"x":    serializeExpr(fset, e.X),
			"span": nodeSpan(fset, e),
		}

	case *ast.TypeAssertExpr:
		result := map[string]interface{}{
			"type": "TypeAssertExpr",
			"x":    serializeExpr(fset, e.X),
			"span": nodeSpan(fset, e),
		}
		if e.Type != nil {
			result["assertType"] = serializeExpr(fset, e.Type)
		} else {
			result["assertType"] = nil
		}
		return result

	case *ast.SliceExpr:
		result := map[string]interface{}{
			"type":   "SliceExpr",
			"x":      serializeExpr(fset, e.X),
			"slice3": e.Slice3,
			"span":   nodeSpan(fset, e),
		}
		if e.Low != nil {
			result["low"] = serializeExpr(fset, e.Low)
		} else {
			result["low"] = nil
		}
		if e.High != nil {
			result["high"] = serializeExpr(fset, e.High)
		} else {
			result["high"] = nil
		}
		if e.Max != nil {
			result["max"] = serializeExpr(fset, e.Max)
		} else {
			result["max"] = nil
		}
		return result

	case *ast.FuncLit:
		return map[string]interface{}{
			"type":     "FuncLit",
			"funcType": serializeExpr(fset, e.Type),
			"body":     serializeBlockStmt(fset, e.Body),
			"span":     nodeSpan(fset, e),
		}

	default:
		return map[string]interface{}{
			"type": "UnknownExpr",
			"span": nodeSpan(fset, expr),
		}
	}
}
