// Package main provides a Go source parser that outputs JSON AST.
//
// Single-file mode: go-parser path/to/file.go
//
//	Reads file from disk, parses, serializes AST, prints JSON to stdout.
//
// Daemon mode: go-parser --daemon
//
//	Length-prefixed frame protocol on stdin/stdout.
//	Input frame:  {"file":"path.go","source":"package main..."}
//	Output frame: {"status":"ok","ast":{...}} or {"status":"error","error":"..."}
package main

import (
	"encoding/json"
	"fmt"
	"go/parser"
	"go/token"
	"os"
)

func main() {
	daemon := false
	var filePath string

	for _, arg := range os.Args[1:] {
		if arg == "--daemon" {
			daemon = true
		} else {
			filePath = arg
		}
	}

	if daemon {
		daemonLoop()
		return
	}

	if filePath == "" {
		fmt.Fprintln(os.Stderr, "Usage: go-parser <file.go>")
		fmt.Fprintln(os.Stderr, "       go-parser --daemon")
		os.Exit(1)
	}

	source, err := os.ReadFile(filePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "File not found: %s\n", filePath)
		os.Exit(1)
	}

	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, filePath, source, parser.ParseComments)
	if err != nil {
		resp := map[string]interface{}{
			"status": "error",
			"error":  err.Error(),
		}
		data, _ := json.Marshal(resp)
		fmt.Fprint(os.Stderr, string(data))
		os.Exit(1)
	}

	ast := serializeFile(fset, f)
	data, err := json.Marshal(ast)
	if err != nil {
		fmt.Fprintf(os.Stderr, "JSON serialization error: %s\n", err.Error())
		os.Exit(1)
	}
	fmt.Print(string(data))
}
