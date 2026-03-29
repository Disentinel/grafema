package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"go/parser"
	"go/token"
	"io"
	"os"
)

// daemonRequest is the JSON structure received in each daemon frame.
type daemonRequest struct {
	File   string `json:"file"`
	Source string `json:"source"`
}

// readFrame reads a single length-prefixed frame from the reader.
// Frame format: 4-byte big-endian u32 length + payload bytes.
// Returns nil, nil on EOF.
func readFrame(r io.Reader) ([]byte, error) {
	lenBuf := make([]byte, 4)
	n, err := io.ReadFull(r, lenBuf)
	if err != nil {
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			if n == 0 {
				return nil, nil // clean EOF
			}
			return nil, fmt.Errorf("truncated frame header: got %d bytes", n)
		}
		return nil, err
	}

	length := binary.BigEndian.Uint32(lenBuf)
	if length > 100_000_000 {
		return nil, fmt.Errorf("invalid frame length: %d", length)
	}

	payload := make([]byte, length)
	_, err = io.ReadFull(r, payload)
	if err != nil {
		return nil, fmt.Errorf("truncated frame: expected %d bytes: %w", length, err)
	}
	return payload, nil
}

// writeFrame writes a length-prefixed frame to the writer and flushes.
func writeFrame(w *bufio.Writer, payload []byte) error {
	lenBuf := make([]byte, 4)
	binary.BigEndian.PutUint32(lenBuf, uint32(len(payload)))
	if _, err := w.Write(lenBuf); err != nil {
		return err
	}
	if _, err := w.Write(payload); err != nil {
		return err
	}
	return w.Flush()
}

// daemonLoop runs the daemon protocol: reads frames from stdin, parses Go source,
// writes response frames to stdout.
func daemonLoop() {
	reader := bufio.NewReader(os.Stdin)
	writer := bufio.NewWriter(os.Stdout)

	for {
		frame, err := readFrame(reader)
		if err != nil {
			fmt.Fprintf(os.Stderr, "frame read error: %v\n", err)
			return
		}
		if frame == nil {
			return // EOF
		}

		var req daemonRequest
		if err := json.Unmarshal(frame, &req); err != nil {
			resp := map[string]interface{}{
				"status": "error",
				"error":  fmt.Sprintf("invalid request JSON: %v", err),
			}
			respBytes, _ := json.Marshal(resp)
			if writeErr := writeFrame(writer, respBytes); writeErr != nil {
				fmt.Fprintf(os.Stderr, "frame write error: %v\n", writeErr)
				return
			}
			continue
		}

		fset := token.NewFileSet()
		filename := req.File
		if filename == "" {
			filename = "input.go"
		}

		f, parseErr := parser.ParseFile(fset, filename, req.Source, parser.ParseComments)

		var resp map[string]interface{}
		if parseErr != nil && f == nil {
			resp = map[string]interface{}{
				"status": "error",
				"error":  parseErr.Error(),
			}
		} else {
			ast := serializeFile(fset, f)
			resp = map[string]interface{}{
				"status": "ok",
				"ast":    ast,
			}
		}

		respBytes, _ := json.Marshal(resp)
		if writeErr := writeFrame(writer, respBytes); writeErr != nil {
			fmt.Fprintf(os.Stderr, "frame write error: %v\n", writeErr)
			return
		}
	}
}
