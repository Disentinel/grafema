package com.grafema.parser;

import java.io.*;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Length-prefixed frame protocol matching Grafema.Protocol.
 * Frame format: 4-byte big-endian u32 length + payload bytes.
 */
public final class DaemonProtocol {

    private DaemonProtocol() {}

    /**
     * Read a single length-prefixed frame from the input stream.
     * Returns null on EOF (when fewer than 4 bytes available).
     */
    public static byte[] readFrame(InputStream in) throws IOException {
        byte[] lenBuf = new byte[4];
        int read = readFully(in, lenBuf);
        if (read < 4) {
            return null; // EOF
        }
        int len = ByteBuffer.wrap(lenBuf).order(ByteOrder.BIG_ENDIAN).getInt();
        if (len < 0 || len > 100_000_000) {
            throw new IOException("Invalid frame length: " + len);
        }
        byte[] payload = new byte[len];
        int payloadRead = readFully(in, payload);
        if (payloadRead < len) {
            throw new IOException("Truncated frame: expected " + len + " bytes, got " + payloadRead);
        }
        return payload;
    }

    /**
     * Write a length-prefixed frame to the output stream and flush.
     */
    public static void writeFrame(OutputStream out, byte[] payload) throws IOException {
        byte[] lenBuf = ByteBuffer.allocate(4)
                .order(ByteOrder.BIG_ENDIAN)
                .putInt(payload.length)
                .array();
        out.write(lenBuf);
        out.write(payload);
        out.flush();
    }

    private static int readFully(InputStream in, byte[] buf) throws IOException {
        int total = 0;
        while (total < buf.length) {
            int n = in.read(buf, total, buf.length - total);
            if (n < 0) break;
            total += n;
        }
        return total;
    }
}
