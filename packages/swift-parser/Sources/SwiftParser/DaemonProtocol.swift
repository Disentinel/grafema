import Foundation

enum DaemonProtocol {
    /// Read a single length-prefixed frame from stdin.
    /// Returns nil on EOF.
    static func readFrame(from input: FileHandle) -> Data? {
        let lenData = input.readData(ofLength: 4)
        guard lenData.count == 4 else { return nil }
        let len = lenData.withUnsafeBytes { ptr in
            Int(ptr.load(as: UInt32.self).bigEndian)
        }
        guard len >= 0, len <= 100_000_000 else {
            fputs("Invalid frame length: \(len)\n", stderr)
            return nil
        }
        var payload = Data()
        while payload.count < len {
            let chunk = input.readData(ofLength: len - payload.count)
            if chunk.isEmpty { break }
            payload.append(chunk)
        }
        guard payload.count == len else {
            fputs("Truncated frame: expected \(len) bytes, got \(payload.count)\n", stderr)
            return nil
        }
        return payload
    }

    /// Write a length-prefixed frame to stdout and flush.
    static func writeFrame(to output: FileHandle, payload: Data) {
        var len = UInt32(payload.count).bigEndian
        let lenData = Data(bytes: &len, count: 4)
        output.write(lenData)
        output.write(payload)
    }
}
