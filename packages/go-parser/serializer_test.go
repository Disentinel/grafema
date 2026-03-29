package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"go/parser"
	"go/token"
	"testing"
)

// helper: parse Go source and serialize to map
func parseAndSerialize(t *testing.T, src string) map[string]interface{} {
	t.Helper()
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "test.go", src, parser.ParseComments)
	if err != nil {
		t.Fatalf("parse error: %v", err)
	}
	result := serializeFile(fset, f)

	// Round-trip through JSON to normalize types (all numbers become float64)
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("json marshal error: %v", err)
	}
	var normalized map[string]interface{}
	if err := json.Unmarshal(data, &normalized); err != nil {
		t.Fatalf("json unmarshal error: %v", err)
	}
	return normalized
}

// helper: get first decl from parsed result
func firstDecl(t *testing.T, result map[string]interface{}) map[string]interface{} {
	t.Helper()
	decls := result["decls"].([]interface{})
	if len(decls) == 0 {
		t.Fatal("no declarations found")
	}
	return decls[0].(map[string]interface{})
}

func TestBasicFunction(t *testing.T) {
	src := `package main

func foo() {}
`
	result := parseAndSerialize(t, src)

	if result["package"] != "main" {
		t.Errorf("expected package 'main', got %v", result["package"])
	}

	decl := firstDecl(t, result)
	if decl["type"] != "FuncDecl" {
		t.Errorf("expected FuncDecl, got %v", decl["type"])
	}
	if decl["name"] != "foo" {
		t.Errorf("expected name 'foo', got %v", decl["name"])
	}
	if decl["recv"] != nil {
		t.Errorf("expected nil recv, got %v", decl["recv"])
	}

	// Check span exists and has valid structure
	sp := decl["span"].(map[string]interface{})
	start := sp["start"].(map[string]interface{})
	if start["line"].(float64) < 1 {
		t.Errorf("expected line >= 1, got %v", start["line"])
	}
	if start["col"].(float64) != 0 {
		t.Errorf("expected col 0 (0-based), got %v", start["col"])
	}
}

func TestMethodWithReceiver(t *testing.T) {
	src := `package main

type T struct{}

func (r *T) Method() {}
`
	result := parseAndSerialize(t, src)
	decls := result["decls"].([]interface{})

	// Find the FuncDecl (skip the StructType)
	var funcDecl map[string]interface{}
	for _, d := range decls {
		dm := d.(map[string]interface{})
		if dm["type"] == "FuncDecl" {
			funcDecl = dm
			break
		}
	}
	if funcDecl == nil {
		t.Fatal("no FuncDecl found")
	}

	if funcDecl["name"] != "Method" {
		t.Errorf("expected name 'Method', got %v", funcDecl["name"])
	}

	recv := funcDecl["recv"].(map[string]interface{})
	if recv["name"] != "r" {
		t.Errorf("expected receiver name 'r', got %v", recv["name"])
	}
	if recv["typeName"] != "T" {
		t.Errorf("expected receiver typeName 'T', got %v", recv["typeName"])
	}
	if recv["pointer"] != true {
		t.Errorf("expected pointer=true, got %v", recv["pointer"])
	}
}

func TestStructWithFields(t *testing.T) {
	src := `package main

type Foo struct {
	X int
	Y string
}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)

	if decl["type"] != "StructTypeDecl" {
		t.Errorf("expected StructTypeDecl, got %v", decl["type"])
	}
	if decl["name"] != "Foo" {
		t.Errorf("expected name 'Foo', got %v", decl["name"])
	}

	fields := decl["fields"].([]interface{})
	if len(fields) != 2 {
		t.Fatalf("expected 2 fields, got %d", len(fields))
	}

	f0 := fields[0].(map[string]interface{})
	if f0["name"] != "X" {
		t.Errorf("expected field name 'X', got %v", f0["name"])
	}
	if f0["embedded"] != false {
		t.Errorf("expected embedded=false, got %v", f0["embedded"])
	}

	ft := f0["fieldType"].(map[string]interface{})
	if ft["type"] != "Ident" || ft["name"] != "int" {
		t.Errorf("expected Ident int, got %v %v", ft["type"], ft["name"])
	}
}

func TestInterfaceWithMethods(t *testing.T) {
	src := `package main

type Bar interface {
	Method()
}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)

	if decl["type"] != "InterfaceTypeDecl" {
		t.Errorf("expected InterfaceTypeDecl, got %v", decl["type"])
	}
	if decl["name"] != "Bar" {
		t.Errorf("expected name 'Bar', got %v", decl["name"])
	}

	methods := decl["methods"].([]interface{})
	if len(methods) != 1 {
		t.Fatalf("expected 1 method, got %d", len(methods))
	}
	m0 := methods[0].(map[string]interface{})
	if m0["name"] != "Method" {
		t.Errorf("expected method name 'Method', got %v", m0["name"])
	}
}

func TestImports(t *testing.T) {
	t.Run("simple import", func(t *testing.T) {
		src := `package main

import "fmt"
`
		result := parseAndSerialize(t, src)
		imports := result["imports"].([]interface{})
		if len(imports) != 1 {
			t.Fatalf("expected 1 import, got %d", len(imports))
		}
		imp := imports[0].(map[string]interface{})
		if imp["path"] != "fmt" {
			t.Errorf("expected path 'fmt', got %v", imp["path"])
		}
		if imp["name"] != "fmt" {
			t.Errorf("expected name 'fmt', got %v", imp["name"])
		}
		if imp["blank"] != false {
			t.Errorf("expected blank=false")
		}
		if imp["dot"] != false {
			t.Errorf("expected dot=false")
		}
		if imp["alias"] != nil {
			t.Errorf("expected alias=nil, got %v", imp["alias"])
		}
	})

	t.Run("aliased import", func(t *testing.T) {
		src := `package main

import f "fmt"
`
		result := parseAndSerialize(t, src)
		imports := result["imports"].([]interface{})
		imp := imports[0].(map[string]interface{})
		if imp["alias"] != "f" {
			t.Errorf("expected alias 'f', got %v", imp["alias"])
		}
		if imp["name"] != "f" {
			t.Errorf("expected name 'f', got %v", imp["name"])
		}
	})

	t.Run("blank import", func(t *testing.T) {
		src := `package main

import _ "net/http/pprof"
`
		result := parseAndSerialize(t, src)
		imports := result["imports"].([]interface{})
		imp := imports[0].(map[string]interface{})
		if imp["blank"] != true {
			t.Errorf("expected blank=true")
		}
		if imp["name"] != "pprof" {
			t.Errorf("expected name 'pprof', got %v", imp["name"])
		}
	})

	t.Run("dot import", func(t *testing.T) {
		src := `package main

import . "fmt"
`
		result := parseAndSerialize(t, src)
		imports := result["imports"].([]interface{})
		imp := imports[0].(map[string]interface{})
		if imp["dot"] != true {
			t.Errorf("expected dot=true")
		}
	})

	t.Run("grouped imports", func(t *testing.T) {
		src := `package main

import (
	"fmt"
	"os"
	"strings"
)
`
		result := parseAndSerialize(t, src)
		imports := result["imports"].([]interface{})
		if len(imports) != 3 {
			t.Fatalf("expected 3 imports, got %d", len(imports))
		}
	})
}

func TestConstantsAndVariables(t *testing.T) {
	t.Run("const", func(t *testing.T) {
		src := `package main

const C = 1
`
		result := parseAndSerialize(t, src)
		decl := firstDecl(t, result)
		if decl["type"] != "ConstDecl" {
			t.Errorf("expected ConstDecl, got %v", decl["type"])
		}
		specs := decl["specs"].([]interface{})
		if len(specs) != 1 {
			t.Fatalf("expected 1 spec, got %d", len(specs))
		}
		spec := specs[0].(map[string]interface{})
		names := spec["names"].([]interface{})
		if len(names) != 1 || names[0] != "C" {
			t.Errorf("expected names=['C'], got %v", names)
		}
	})

	t.Run("var", func(t *testing.T) {
		src := `package main

var x int
`
		result := parseAndSerialize(t, src)
		decl := firstDecl(t, result)
		if decl["type"] != "VarDecl" {
			t.Errorf("expected VarDecl, got %v", decl["type"])
		}
		specs := decl["specs"].([]interface{})
		spec := specs[0].(map[string]interface{})
		names := spec["names"].([]interface{})
		if names[0] != "x" {
			t.Errorf("expected name 'x', got %v", names[0])
		}
		vt := spec["varType"].(map[string]interface{})
		if vt["name"] != "int" {
			t.Errorf("expected varType int, got %v", vt["name"])
		}
	})
}

func TestMultipleReturnValues(t *testing.T) {
	src := `package main

func foo() (int, error) {
	return 0, nil
}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	results := decl["results"].([]interface{})
	if len(results) != 2 {
		t.Fatalf("expected 2 results, got %d", len(results))
	}

	// Check the body has a return statement
	body := decl["body"].(map[string]interface{})
	stmts := body["stmts"].([]interface{})
	if len(stmts) != 1 {
		t.Fatalf("expected 1 statement, got %d", len(stmts))
	}
	ret := stmts[0].(map[string]interface{})
	if ret["type"] != "ReturnStmt" {
		t.Errorf("expected ReturnStmt, got %v", ret["type"])
	}
	retResults := ret["results"].([]interface{})
	if len(retResults) != 2 {
		t.Errorf("expected 2 return results, got %d", len(retResults))
	}
}

func TestEmbeddedStruct(t *testing.T) {
	src := `package main

type Bar struct{}

type Foo struct {
	Bar
	X int
}
`
	result := parseAndSerialize(t, src)
	decls := result["decls"].([]interface{})

	// Find Foo (second struct)
	fooDecl := decls[1].(map[string]interface{})
	if fooDecl["name"] != "Foo" {
		t.Fatalf("expected Foo, got %v", fooDecl["name"])
	}

	fields := fooDecl["fields"].([]interface{})
	if len(fields) != 2 {
		t.Fatalf("expected 2 fields, got %d", len(fields))
	}

	// First field should be embedded
	f0 := fields[0].(map[string]interface{})
	if f0["embedded"] != true {
		t.Errorf("expected embedded=true for Bar")
	}
	if f0["name"] != "Bar" {
		t.Errorf("expected embedded name 'Bar', got %v", f0["name"])
	}

	// Second field should not be embedded
	f1 := fields[1].(map[string]interface{})
	if f1["embedded"] != false {
		t.Errorf("expected embedded=false for X")
	}
}

func TestGenerics(t *testing.T) {
	src := `package main

func foo[T any](x T) T {
	return x
}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)

	typeParams := decl["typeParams"].([]interface{})
	if len(typeParams) != 1 {
		t.Fatalf("expected 1 type param, got %d", len(typeParams))
	}

	tp := typeParams[0].(map[string]interface{})
	name := tp["name"].(string)
	if name != "T" {
		t.Errorf("expected typeParam name 'T', got %v", name)
	}
	constraint := tp["constraint"].(map[string]interface{})
	if constraint["name"] != "any" {
		t.Errorf("expected constraint 'any', got %v", constraint["name"])
	}
}

func TestInitFunction(t *testing.T) {
	src := `package main

func init() {}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)

	if decl["type"] != "FuncDecl" {
		t.Errorf("expected FuncDecl, got %v", decl["type"])
	}
	if decl["name"] != "init" {
		t.Errorf("expected name 'init', got %v", decl["name"])
	}
}

func TestShortVarDecl(t *testing.T) {
	src := `package main

func foo() {
	x := 5
	_ = x
}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	body := decl["body"].(map[string]interface{})
	stmts := body["stmts"].([]interface{})

	assign := stmts[0].(map[string]interface{})
	if assign["type"] != "AssignStmt" {
		t.Errorf("expected AssignStmt, got %v", assign["type"])
	}
	if assign["tok"] != ":=" {
		t.Errorf("expected tok ':=', got %v", assign["tok"])
	}

	lhs := assign["lhs"].([]interface{})
	if len(lhs) != 1 {
		t.Fatalf("expected 1 lhs, got %d", len(lhs))
	}
	lhsIdent := lhs[0].(map[string]interface{})
	if lhsIdent["name"] != "x" {
		t.Errorf("expected lhs name 'x', got %v", lhsIdent["name"])
	}
}

func TestGoroutineAndChannel(t *testing.T) {
	src := `package main

func foo() {
	ch := make(chan int)
	go func() {
		ch <- 42
	}()
	_ = ch
}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	body := decl["body"].(map[string]interface{})
	stmts := body["stmts"].([]interface{})

	// Second statement should be GoStmt
	goStmt := stmts[1].(map[string]interface{})
	if goStmt["type"] != "GoStmt" {
		t.Errorf("expected GoStmt, got %v", goStmt["type"])
	}

	// Inside the goroutine, first stmt should be SendStmt
	call := goStmt["call"].(map[string]interface{})
	if call["type"] != "CallExpr" {
		t.Errorf("expected CallExpr for go func call, got %v", call["type"])
	}

	funcLit := call["fun"].(map[string]interface{})
	if funcLit["type"] != "FuncLit" {
		t.Errorf("expected FuncLit, got %v", funcLit["type"])
	}

	funcBody := funcLit["body"].(map[string]interface{})
	funcStmts := funcBody["stmts"].([]interface{})
	sendStmt := funcStmts[0].(map[string]interface{})
	if sendStmt["type"] != "SendStmt" {
		t.Errorf("expected SendStmt, got %v", sendStmt["type"])
	}
}

func TestDefer(t *testing.T) {
	src := `package main

func foo() {
	defer close()
}

func close() {}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	body := decl["body"].(map[string]interface{})
	stmts := body["stmts"].([]interface{})

	deferStmt := stmts[0].(map[string]interface{})
	if deferStmt["type"] != "DeferStmt" {
		t.Errorf("expected DeferStmt, got %v", deferStmt["type"])
	}
	call := deferStmt["call"].(map[string]interface{})
	if call["type"] != "CallExpr" {
		t.Errorf("expected CallExpr in defer, got %v", call["type"])
	}
}

func TestSelect(t *testing.T) {
	src := `package main

func foo() {
	ch := make(chan int)
	select {
	case v := <-ch:
		_ = v
	}
}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	body := decl["body"].(map[string]interface{})
	stmts := body["stmts"].([]interface{})

	selectStmt := stmts[1].(map[string]interface{})
	if selectStmt["type"] != "SelectStmt" {
		t.Errorf("expected SelectStmt, got %v", selectStmt["type"])
	}

	selectBody := selectStmt["body"].(map[string]interface{})
	if selectBody["type"] != "BlockStmt" {
		t.Errorf("expected BlockStmt in select body, got %v", selectBody["type"])
	}

	clauses := selectBody["stmts"].([]interface{})
	if len(clauses) != 1 {
		t.Fatalf("expected 1 comm clause, got %d", len(clauses))
	}
	clause := clauses[0].(map[string]interface{})
	if clause["type"] != "CommClause" {
		t.Errorf("expected CommClause, got %v", clause["type"])
	}
}

func TestTypeSwitch(t *testing.T) {
	src := `package main

func foo(v interface{}) {
	switch v.(type) {
	case int:
	}
}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	body := decl["body"].(map[string]interface{})
	stmts := body["stmts"].([]interface{})

	tsStmt := stmts[0].(map[string]interface{})
	if tsStmt["type"] != "TypeSwitchStmt" {
		t.Errorf("expected TypeSwitchStmt, got %v", tsStmt["type"])
	}
}

func TestDaemonFrameRoundTrip(t *testing.T) {
	// Test writeFrame + readFrame round-trip
	payload := []byte(`{"file":"test.go","source":"package main"}`)

	var buf bytes.Buffer
	writer := bufio.NewWriter(&buf)
	err := writeFrame(writer, payload)
	if err != nil {
		t.Fatalf("writeFrame error: %v", err)
	}

	reader := bufio.NewReader(&buf)
	got, err := readFrame(reader)
	if err != nil {
		t.Fatalf("readFrame error: %v", err)
	}

	if !bytes.Equal(got, payload) {
		t.Errorf("round-trip mismatch: got %s, want %s", got, payload)
	}

	// Verify the wire format: 4-byte BE length prefix
	buf.Reset()
	writer = bufio.NewWriter(&buf)
	testPayload := []byte("hello")
	err = writeFrame(writer, testPayload)
	if err != nil {
		t.Fatalf("writeFrame error: %v", err)
	}

	raw := buf.Bytes()
	if len(raw) != 4+len(testPayload) {
		t.Fatalf("expected %d bytes, got %d", 4+len(testPayload), len(raw))
	}

	length := binary.BigEndian.Uint32(raw[:4])
	if length != uint32(len(testPayload)) {
		t.Errorf("expected length %d, got %d", len(testPayload), length)
	}
	if !bytes.Equal(raw[4:], testPayload) {
		t.Errorf("payload mismatch")
	}
}

func TestReadFrameEOF(t *testing.T) {
	// Empty reader should return nil, nil
	reader := bufio.NewReader(bytes.NewReader(nil))
	frame, err := readFrame(reader)
	if err != nil {
		t.Fatalf("expected nil error on EOF, got %v", err)
	}
	if frame != nil {
		t.Errorf("expected nil frame on EOF, got %v", frame)
	}
}

func TestExpressions(t *testing.T) {
	t.Run("binary expression", func(t *testing.T) {
		src := `package main

func foo() {
	_ = 1 + 2
}
`
		result := parseAndSerialize(t, src)
		decl := firstDecl(t, result)
		body := decl["body"].(map[string]interface{})
		stmts := body["stmts"].([]interface{})
		assign := stmts[0].(map[string]interface{})
		rhs := assign["rhs"].([]interface{})
		binExpr := rhs[0].(map[string]interface{})
		if binExpr["type"] != "BinaryExpr" {
			t.Errorf("expected BinaryExpr, got %v", binExpr["type"])
		}
		if binExpr["op"] != "+" {
			t.Errorf("expected op '+', got %v", binExpr["op"])
		}
	})

	t.Run("call expression", func(t *testing.T) {
		src := `package main

import "fmt"

func foo() {
	fmt.Println("hello")
}
`
		result := parseAndSerialize(t, src)
		decls := result["decls"].([]interface{})
		var funcDecl map[string]interface{}
		for _, d := range decls {
			dm := d.(map[string]interface{})
			if dm["type"] == "FuncDecl" {
				funcDecl = dm
				break
			}
		}
		body := funcDecl["body"].(map[string]interface{})
		stmts := body["stmts"].([]interface{})
		exprStmt := stmts[0].(map[string]interface{})
		callExpr := exprStmt["x"].(map[string]interface{})
		if callExpr["type"] != "CallExpr" {
			t.Errorf("expected CallExpr, got %v", callExpr["type"])
		}
		fun := callExpr["fun"].(map[string]interface{})
		if fun["type"] != "SelectorExpr" {
			t.Errorf("expected SelectorExpr, got %v", fun["type"])
		}
		if fun["sel"] != "Println" {
			t.Errorf("expected sel 'Println', got %v", fun["sel"])
		}
	})

	t.Run("composite literal", func(t *testing.T) {
		src := `package main

func foo() {
	_ = []int{1, 2, 3}
}
`
		result := parseAndSerialize(t, src)
		decl := firstDecl(t, result)
		body := decl["body"].(map[string]interface{})
		stmts := body["stmts"].([]interface{})
		assign := stmts[0].(map[string]interface{})
		rhs := assign["rhs"].([]interface{})
		lit := rhs[0].(map[string]interface{})
		if lit["type"] != "CompositeLit" {
			t.Errorf("expected CompositeLit, got %v", lit["type"])
		}
		elts := lit["elts"].([]interface{})
		if len(elts) != 3 {
			t.Errorf("expected 3 elements, got %d", len(elts))
		}
	})
}

func TestMapType(t *testing.T) {
	src := `package main

var m map[string]int
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	specs := decl["specs"].([]interface{})
	spec := specs[0].(map[string]interface{})
	vt := spec["varType"].(map[string]interface{})
	if vt["type"] != "MapType" {
		t.Errorf("expected MapType, got %v", vt["type"])
	}
	key := vt["key"].(map[string]interface{})
	if key["name"] != "string" {
		t.Errorf("expected key 'string', got %v", key["name"])
	}
	value := vt["value"].(map[string]interface{})
	if value["name"] != "int" {
		t.Errorf("expected value 'int', got %v", value["name"])
	}
}

func TestChanType(t *testing.T) {
	src := `package main

var ch chan int
var sendCh chan<- int
var recvCh <-chan int
`
	result := parseAndSerialize(t, src)
	decls := result["decls"].([]interface{})

	// chan int -> both
	d0 := decls[0].(map[string]interface{})
	s0 := d0["specs"].([]interface{})[0].(map[string]interface{})
	ct0 := s0["varType"].(map[string]interface{})
	if ct0["type"] != "ChanType" {
		t.Errorf("expected ChanType, got %v", ct0["type"])
	}
	if ct0["dir"] != "both" {
		t.Errorf("expected dir 'both', got %v", ct0["dir"])
	}

	// chan<- int -> send
	d1 := decls[1].(map[string]interface{})
	s1 := d1["specs"].([]interface{})[0].(map[string]interface{})
	ct1 := s1["varType"].(map[string]interface{})
	if ct1["dir"] != "send" {
		t.Errorf("expected dir 'send', got %v", ct1["dir"])
	}

	// <-chan int -> recv
	d2 := decls[2].(map[string]interface{})
	s2 := d2["specs"].([]interface{})[0].(map[string]interface{})
	ct2 := s2["varType"].(map[string]interface{})
	if ct2["dir"] != "recv" {
		t.Errorf("expected dir 'recv', got %v", ct2["dir"])
	}
}

func TestForLoop(t *testing.T) {
	src := `package main

func foo() {
	for i := 0; i < 10; i++ {
	}
}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	body := decl["body"].(map[string]interface{})
	stmts := body["stmts"].([]interface{})
	forStmt := stmts[0].(map[string]interface{})
	if forStmt["type"] != "ForStmt" {
		t.Errorf("expected ForStmt, got %v", forStmt["type"])
	}
	if forStmt["init"] == nil {
		t.Error("expected non-nil init")
	}
	if forStmt["cond"] == nil {
		t.Error("expected non-nil cond")
	}
	if forStmt["post"] == nil {
		t.Error("expected non-nil post")
	}
}

func TestRangeLoop(t *testing.T) {
	src := `package main

func foo() {
	for k, v := range []int{1, 2} {
		_, _ = k, v
	}
}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	body := decl["body"].(map[string]interface{})
	stmts := body["stmts"].([]interface{})
	rangeStmt := stmts[0].(map[string]interface{})
	if rangeStmt["type"] != "RangeStmt" {
		t.Errorf("expected RangeStmt, got %v", rangeStmt["type"])
	}
	if rangeStmt["key"] == nil {
		t.Error("expected non-nil key")
	}
	if rangeStmt["value"] == nil {
		t.Error("expected non-nil value")
	}
}

func TestIfStatement(t *testing.T) {
	src := `package main

func foo() {
	if x := 1; x > 0 {
	} else {
	}
}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	body := decl["body"].(map[string]interface{})
	stmts := body["stmts"].([]interface{})
	ifStmt := stmts[0].(map[string]interface{})
	if ifStmt["type"] != "IfStmt" {
		t.Errorf("expected IfStmt, got %v", ifStmt["type"])
	}
	if ifStmt["init"] == nil {
		t.Error("expected non-nil init")
	}
	if ifStmt["cond"] == nil {
		t.Error("expected non-nil cond")
	}
	if ifStmt["else"] == nil {
		t.Error("expected non-nil else")
	}
}

func TestIncDecStatement(t *testing.T) {
	src := `package main

func foo() {
	x := 0
	x++
	x--
	_ = x
}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	body := decl["body"].(map[string]interface{})
	stmts := body["stmts"].([]interface{})

	inc := stmts[1].(map[string]interface{})
	if inc["type"] != "IncDecStmt" {
		t.Errorf("expected IncDecStmt, got %v", inc["type"])
	}
	if inc["tok"] != "++" {
		t.Errorf("expected tok '++', got %v", inc["tok"])
	}

	dec := stmts[2].(map[string]interface{})
	if dec["tok"] != "--" {
		t.Errorf("expected tok '--', got %v", dec["tok"])
	}
}

func TestBranchStatements(t *testing.T) {
	src := `package main

func foo() {
	for {
		break
		continue
	}
}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	body := decl["body"].(map[string]interface{})
	stmts := body["stmts"].([]interface{})
	forStmt := stmts[0].(map[string]interface{})
	forBody := forStmt["body"].(map[string]interface{})
	forStmts := forBody["stmts"].([]interface{})

	breakStmt := forStmts[0].(map[string]interface{})
	if breakStmt["type"] != "BranchStmt" {
		t.Errorf("expected BranchStmt, got %v", breakStmt["type"])
	}
	if breakStmt["tok"] != "break" {
		t.Errorf("expected tok 'break', got %v", breakStmt["tok"])
	}

	contStmt := forStmts[1].(map[string]interface{})
	if contStmt["tok"] != "continue" {
		t.Errorf("expected tok 'continue', got %v", contStmt["tok"])
	}
}

func TestSliceExpression(t *testing.T) {
	src := `package main

func foo() {
	s := []int{1, 2, 3}
	_ = s[1:2]
}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	body := decl["body"].(map[string]interface{})
	stmts := body["stmts"].([]interface{})
	assign := stmts[1].(map[string]interface{})
	rhs := assign["rhs"].([]interface{})
	sliceExpr := rhs[0].(map[string]interface{})
	if sliceExpr["type"] != "SliceExpr" {
		t.Errorf("expected SliceExpr, got %v", sliceExpr["type"])
	}
	if sliceExpr["slice3"] != false {
		t.Errorf("expected slice3=false")
	}
}

func TestTypeAssertExpression(t *testing.T) {
	src := `package main

func foo(v interface{}) {
	_ = v.(int)
}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	body := decl["body"].(map[string]interface{})
	stmts := body["stmts"].([]interface{})
	assign := stmts[0].(map[string]interface{})
	rhs := assign["rhs"].([]interface{})
	ta := rhs[0].(map[string]interface{})
	if ta["type"] != "TypeAssertExpr" {
		t.Errorf("expected TypeAssertExpr, got %v", ta["type"])
	}
	at := ta["assertType"].(map[string]interface{})
	if at["name"] != "int" {
		t.Errorf("expected assertType int, got %v", at["name"])
	}
}

func TestUnaryExpression(t *testing.T) {
	src := `package main

func foo() {
	x := 1
	_ = -x
	_ = &x
	_ = !true
}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	body := decl["body"].(map[string]interface{})
	stmts := body["stmts"].([]interface{})

	neg := stmts[1].(map[string]interface{})
	negRhs := neg["rhs"].([]interface{})
	negExpr := negRhs[0].(map[string]interface{})
	if negExpr["type"] != "UnaryExpr" {
		t.Errorf("expected UnaryExpr, got %v", negExpr["type"])
	}
	if negExpr["op"] != "-" {
		t.Errorf("expected op '-', got %v", negExpr["op"])
	}
}

func TestInterfaceWithEmbeds(t *testing.T) {
	src := `package main

type Reader interface {
	Read() int
}

type ReadWriter interface {
	Reader
	Write(data []byte)
}
`
	result := parseAndSerialize(t, src)
	decls := result["decls"].([]interface{})
	rwDecl := decls[1].(map[string]interface{})

	if rwDecl["type"] != "InterfaceTypeDecl" {
		t.Errorf("expected InterfaceTypeDecl, got %v", rwDecl["type"])
	}

	methods := rwDecl["methods"].([]interface{})
	if len(methods) != 1 {
		t.Errorf("expected 1 method, got %d", len(methods))
	}

	embeds := rwDecl["embeds"].([]interface{})
	if len(embeds) != 1 {
		t.Fatalf("expected 1 embed, got %d", len(embeds))
	}
	embed := embeds[0].(map[string]interface{})
	if embed["type"] != "Ident" {
		t.Errorf("expected embed type 'Ident', got %v", embed["type"])
	}
	if embed["name"] != "Reader" {
		t.Errorf("expected embed name 'Reader', got %v", embed["name"])
	}
}

func TestSwitchStatement(t *testing.T) {
	src := `package main

func foo(x int) {
	switch x {
	case 1:
	case 2, 3:
	default:
	}
}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	body := decl["body"].(map[string]interface{})
	stmts := body["stmts"].([]interface{})
	sw := stmts[0].(map[string]interface{})
	if sw["type"] != "SwitchStmt" {
		t.Errorf("expected SwitchStmt, got %v", sw["type"])
	}

	swBody := sw["body"].(map[string]interface{})
	cases := swBody["stmts"].([]interface{})
	if len(cases) != 3 {
		t.Fatalf("expected 3 case clauses, got %d", len(cases))
	}

	// default case has empty list
	defaultCase := cases[2].(map[string]interface{})
	defaultList := defaultCase["list"].([]interface{})
	if len(defaultList) != 0 {
		t.Errorf("expected empty list for default, got %d", len(defaultList))
	}
}

func TestLabeledStatement(t *testing.T) {
	src := `package main

func foo() {
outer:
	for {
		break outer
	}
}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	body := decl["body"].(map[string]interface{})
	stmts := body["stmts"].([]interface{})
	labeled := stmts[0].(map[string]interface{})
	if labeled["type"] != "LabeledStmt" {
		t.Errorf("expected LabeledStmt, got %v", labeled["type"])
	}
	if labeled["label"] != "outer" {
		t.Errorf("expected label 'outer', got %v", labeled["label"])
	}
}

func TestPointerType(t *testing.T) {
	src := `package main

var p *int
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	specs := decl["specs"].([]interface{})
	spec := specs[0].(map[string]interface{})
	vt := spec["varType"].(map[string]interface{})
	if vt["type"] != "StarExpr" {
		t.Errorf("expected StarExpr, got %v", vt["type"])
	}
	x := vt["x"].(map[string]interface{})
	if x["name"] != "int" {
		t.Errorf("expected x 'int', got %v", x["name"])
	}
}

func TestArrayType(t *testing.T) {
	src := `package main

var a [5]int
var s []int
`
	result := parseAndSerialize(t, src)
	decls := result["decls"].([]interface{})

	// Fixed-size array
	d0 := decls[0].(map[string]interface{})
	s0 := d0["specs"].([]interface{})[0].(map[string]interface{})
	at0 := s0["varType"].(map[string]interface{})
	if at0["type"] != "ArrayType" {
		t.Errorf("expected ArrayType, got %v", at0["type"])
	}
	if at0["len"] == nil {
		t.Error("expected non-nil len for fixed array")
	}

	// Slice (nil len)
	d1 := decls[1].(map[string]interface{})
	s1 := d1["specs"].([]interface{})[0].(map[string]interface{})
	at1 := s1["varType"].(map[string]interface{})
	if at1["type"] != "ArrayType" {
		t.Errorf("expected ArrayType for slice, got %v", at1["type"])
	}
	if at1["len"] != nil {
		t.Errorf("expected nil len for slice, got %v", at1["len"])
	}
}

func TestFuncLiteral(t *testing.T) {
	src := `package main

func foo() {
	f := func(x int) int { return x }
	_ = f
}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	body := decl["body"].(map[string]interface{})
	stmts := body["stmts"].([]interface{})
	assign := stmts[0].(map[string]interface{})
	rhs := assign["rhs"].([]interface{})
	funcLit := rhs[0].(map[string]interface{})
	if funcLit["type"] != "FuncLit" {
		t.Errorf("expected FuncLit, got %v", funcLit["type"])
	}
	if funcLit["body"] == nil {
		t.Error("expected non-nil body")
	}
	if funcLit["funcType"] == nil {
		t.Error("expected non-nil funcType")
	}
}

func TestStructTag(t *testing.T) {
	src := "package main\n\ntype Foo struct {\n\tX int `json:\"x\"`\n}\n"
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	fields := decl["fields"].([]interface{})
	f0 := fields[0].(map[string]interface{})
	if f0["tag"] != `json:"x"` {
		t.Errorf("expected tag 'json:\"x\"', got %v", f0["tag"])
	}
}

func TestEllipsis(t *testing.T) {
	src := `package main

func foo(args ...int) {}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	params := decl["params"].([]interface{})
	if len(params) != 1 {
		t.Fatalf("expected 1 param, got %d", len(params))
	}
	p := params[0].(map[string]interface{})
	ft := p["paramType"].(map[string]interface{})
	if ft["type"] != "Ellipsis" {
		t.Errorf("expected Ellipsis, got %v", ft["type"])
	}
}

func TestCallWithEllipsis(t *testing.T) {
	src := `package main

func bar(args ...int) {}

func foo() {
	s := []int{1}
	bar(s...)
}
`
	result := parseAndSerialize(t, src)
	decls := result["decls"].([]interface{})
	var fooDecl map[string]interface{}
	for _, d := range decls {
		dm := d.(map[string]interface{})
		if dm["type"] == "FuncDecl" && dm["name"] == "foo" {
			fooDecl = dm
			break
		}
	}
	body := fooDecl["body"].(map[string]interface{})
	stmts := body["stmts"].([]interface{})
	exprStmt := stmts[1].(map[string]interface{})
	callExpr := exprStmt["x"].(map[string]interface{})
	if callExpr["ellipsis"] != true {
		t.Errorf("expected ellipsis=true for variadic call")
	}
}

func TestKeyValueExpression(t *testing.T) {
	src := `package main

type S struct{ X int }

func foo() {
	_ = S{X: 1}
}
`
	result := parseAndSerialize(t, src)
	decls := result["decls"].([]interface{})
	var fooDecl map[string]interface{}
	for _, d := range decls {
		dm := d.(map[string]interface{})
		if dm["type"] == "FuncDecl" {
			fooDecl = dm
			break
		}
	}
	body := fooDecl["body"].(map[string]interface{})
	stmts := body["stmts"].([]interface{})
	assign := stmts[0].(map[string]interface{})
	rhs := assign["rhs"].([]interface{})
	lit := rhs[0].(map[string]interface{})
	elts := lit["elts"].([]interface{})
	kv := elts[0].(map[string]interface{})
	if kv["type"] != "KeyValueExpr" {
		t.Errorf("expected KeyValueExpr, got %v", kv["type"])
	}
}

func TestBasicLitKinds(t *testing.T) {
	src := `package main

func foo() {
	_ = 42
	_ = 3.14
	_ = "hello"
	_ = 'a'
	_ = 1i
}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	body := decl["body"].(map[string]interface{})
	stmts := body["stmts"].([]interface{})

	kinds := []string{"INT", "FLOAT", "STRING", "CHAR", "IMAG"}
	for i, expected := range kinds {
		assign := stmts[i].(map[string]interface{})
		rhs := assign["rhs"].([]interface{})
		lit := rhs[0].(map[string]interface{})
		if lit["type"] != "BasicLit" {
			t.Errorf("stmt %d: expected BasicLit, got %v", i, lit["type"])
		}
		if lit["kind"] != expected {
			t.Errorf("stmt %d: expected kind '%s', got %v", i, expected, lit["kind"])
		}
	}
}

func TestSpanIsZeroBased(t *testing.T) {
	src := `package main

func foo() {}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	sp := decl["span"].(map[string]interface{})
	start := sp["start"].(map[string]interface{})

	// "func" starts at column 1 in Go (1-based), which should be col 0 (0-based)
	if start["col"].(float64) != 0 {
		t.Errorf("expected 0-based col 0, got %v", start["col"])
	}
	// Should be on line 3
	if start["line"].(float64) != 3 {
		t.Errorf("expected line 3, got %v", start["line"])
	}
}

func TestParenExpression(t *testing.T) {
	src := `package main

func foo() {
	_ = (1 + 2)
}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	body := decl["body"].(map[string]interface{})
	stmts := body["stmts"].([]interface{})
	assign := stmts[0].(map[string]interface{})
	rhs := assign["rhs"].([]interface{})
	paren := rhs[0].(map[string]interface{})
	if paren["type"] != "ParenExpr" {
		t.Errorf("expected ParenExpr, got %v", paren["type"])
	}
}

func TestValueReceiverMethod(t *testing.T) {
	src := `package main

type T struct{}

func (t T) Method() {}
`
	result := parseAndSerialize(t, src)
	decls := result["decls"].([]interface{})
	var funcDecl map[string]interface{}
	for _, d := range decls {
		dm := d.(map[string]interface{})
		if dm["type"] == "FuncDecl" {
			funcDecl = dm
			break
		}
	}

	recv := funcDecl["recv"].(map[string]interface{})
	if recv["pointer"] != false {
		t.Errorf("expected pointer=false for value receiver")
	}
	if recv["typeName"] != "T" {
		t.Errorf("expected typeName 'T', got %v", recv["typeName"])
	}
}

func TestMultipleVarDecl(t *testing.T) {
	src := `package main

var (
	x int = 1
	y string = "hello"
)
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	if decl["type"] != "VarDecl" {
		t.Errorf("expected VarDecl, got %v", decl["type"])
	}
	specs := decl["specs"].([]interface{})
	if len(specs) != 2 {
		t.Fatalf("expected 2 specs, got %d", len(specs))
	}
}

func TestDeclStmt(t *testing.T) {
	src := `package main

func foo() {
	var x int = 5
	_ = x
}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	body := decl["body"].(map[string]interface{})
	stmts := body["stmts"].([]interface{})
	declStmt := stmts[0].(map[string]interface{})
	if declStmt["type"] != "DeclStmt" {
		t.Errorf("expected DeclStmt, got %v", declStmt["type"])
	}
	innerDecl := declStmt["decl"].(map[string]interface{})
	if innerDecl["type"] != "VarDecl" {
		t.Errorf("expected inner VarDecl, got %v", innerDecl["type"])
	}
}

func TestFuncTypeInVar(t *testing.T) {
	src := `package main

var f func(int) string
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	specs := decl["specs"].([]interface{})
	spec := specs[0].(map[string]interface{})
	vt := spec["varType"].(map[string]interface{})
	if vt["type"] != "FuncType" {
		t.Errorf("expected FuncType, got %v", vt["type"])
	}
	params := vt["params"].([]interface{})
	if len(params) != 1 {
		t.Errorf("expected 1 param, got %d", len(params))
	}
	results := vt["results"].([]interface{})
	if len(results) != 1 {
		t.Errorf("expected 1 result, got %d", len(results))
	}
}

func TestMultiNameParams(t *testing.T) {
	src := `package main

func foo(a, b int, c string) {}
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	params := decl["params"].([]interface{})
	if len(params) != 3 {
		t.Fatalf("expected 3 params (expanded), got %d", len(params))
	}
	p0 := params[0].(map[string]interface{})
	if p0["name"] != "a" {
		t.Errorf("expected param name 'a', got %v", p0["name"])
	}
	pt0 := p0["paramType"].(map[string]interface{})
	if pt0["name"] != "int" {
		t.Errorf("expected paramType 'int', got %v", pt0["name"])
	}
	p1 := params[1].(map[string]interface{})
	if p1["name"] != "b" {
		t.Errorf("expected param name 'b', got %v", p1["name"])
	}
}

func TestTypeAlias(t *testing.T) {
	src := `package main

type MyInt int
`
	result := parseAndSerialize(t, src)
	decl := firstDecl(t, result)
	if decl["type"] != "TypeAliasDecl" {
		t.Errorf("expected TypeAliasDecl, got %v", decl["type"])
	}
	if decl["name"] != "MyInt" {
		t.Errorf("expected name 'MyInt', got %v", decl["name"])
	}
	aliasOf := decl["aliasOf"].(map[string]interface{})
	if aliasOf["name"] != "int" {
		t.Errorf("expected aliasOf 'int', got %v", aliasOf["name"])
	}
}

func TestGroupedTypeDecls(t *testing.T) {
	src := `package main

type (
	A int
	B string
)
`
	result := parseAndSerialize(t, src)
	decls := result["decls"].([]interface{})
	if len(decls) != 2 {
		t.Fatalf("expected 2 decls (flattened), got %d", len(decls))
	}
	d0 := decls[0].(map[string]interface{})
	if d0["type"] != "TypeAliasDecl" {
		t.Errorf("expected TypeAliasDecl, got %v", d0["type"])
	}
	if d0["name"] != "A" {
		t.Errorf("expected name 'A', got %v", d0["name"])
	}
	d1 := decls[1].(map[string]interface{})
	if d1["name"] != "B" {
		t.Errorf("expected name 'B', got %v", d1["name"])
	}
}
