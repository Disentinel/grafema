import Foundation
import SwiftSyntax
import SwiftParser

/// CLI entry point for swift-parser.
///
/// Single-file mode: swift-parser <file.swift> -- reads file, outputs JSON AST to stdout.
/// Daemon mode: swift-parser --daemon -- length-prefixed frame protocol on stdin/stdout.
///   Input frame:  {"file":"path/Foo.swift","source":"..."}
///   Output frame: {"status":"ok","ast":{...}} or {"status":"error","error":"..."}

@main
struct SwiftParserCLI {
    static func main() {
        let args = CommandLine.arguments
        if args.contains("--daemon") {
            daemonLoop()
        } else {
            singleFileMode(args: Array(args.dropFirst()))
        }
    }

    private static func singleFileMode(args: [String]) {
        guard let filePath = args.first else {
            fputs("Usage: swift-parser <file.swift>\n", stderr)
            fputs("       swift-parser --daemon\n", stderr)
            exit(1)
        }

        guard let source = try? String(contentsOfFile: filePath, encoding: .utf8) else {
            fputs("File not found: \(filePath)\n", stderr)
            exit(1)
        }

        do {
            let tree = Parser.parse(source: source)
            let serializer = SwiftAstSerializer()
            let ast = serializer.serialize(tree: tree, file: filePath)
            let data = try JSONSerialization.data(withJSONObject: ast, options: [])
            FileHandle.standardOutput.write(data)
        } catch {
            let resp: [String: Any] = ["status": "error", "error": error.localizedDescription]
            if let data = try? JSONSerialization.data(withJSONObject: resp) {
                FileHandle.standardError.write(data)
            }
            exit(1)
        }
    }

    private static func daemonLoop() {
        let input = FileHandle.standardInput
        let output = FileHandle.standardOutput

        while true {
            guard let frame = DaemonProtocol.readFrame(from: input) else {
                break  // EOF
            }

            var resp: [String: Any]

            do {
                guard let json = try JSONSerialization.jsonObject(with: frame) as? [String: Any],
                      let source = json["source"] as? String else {
                    resp = ["status": "error", "error": "Invalid request format"]
                    let data = try JSONSerialization.data(withJSONObject: resp)
                    DaemonProtocol.writeFrame(to: output, payload: data)
                    continue
                }

                let fileName = json["file"] as? String ?? "input.swift"
                let tree = Parser.parse(source: source)
                let serializer = SwiftAstSerializer()
                let ast = serializer.serialize(tree: tree, file: fileName)
                resp = ["status": "ok", "ast": ast]
            } catch {
                resp = ["status": "error", "error": error.localizedDescription]
            }

            do {
                let data = try JSONSerialization.data(withJSONObject: resp)
                DaemonProtocol.writeFrame(to: output, payload: data)
            } catch {
                fputs("Failed to serialize response: \(error)\n", stderr)
            }
        }
    }
}
