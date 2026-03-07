package com.grafema.parser

import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Length-prefixed frame protocol matching Grafema.Protocol.
 * Frame format: 4-byte big-endian u32 length + payload bytes.
 */
object DaemonProtocol {

    /**
     * Read a single length-prefixed frame from the input stream.
     * Returns null on EOF (when fewer than 4 bytes available).
     */
    @Throws(IOException::class)
    fun readFrame(input: InputStream): ByteArray? {
        val lenBuf = ByteArray(4)
        val read = readFully(input, lenBuf)
        if (read < 4) {
            return null // EOF
        }
        val len = ByteBuffer.wrap(lenBuf).order(ByteOrder.BIG_ENDIAN).int
        if (len < 0 || len > 100_000_000) {
            throw IOException("Invalid frame length: $len")
        }
        val payload = ByteArray(len)
        val payloadRead = readFully(input, payload)
        if (payloadRead < len) {
            throw IOException("Truncated frame: expected $len bytes, got $payloadRead")
        }
        return payload
    }

    /**
     * Write a length-prefixed frame to the output stream and flush.
     */
    @Throws(IOException::class)
    fun writeFrame(output: OutputStream, payload: ByteArray) {
        val lenBuf = ByteBuffer.allocate(4)
            .order(ByteOrder.BIG_ENDIAN)
            .putInt(payload.size)
            .array()
        output.write(lenBuf)
        output.write(payload)
        output.flush()
    }

    @Throws(IOException::class)
    private fun readFully(input: InputStream, buf: ByteArray): Int {
        var total = 0
        while (total < buf.size) {
            val n = input.read(buf, total, buf.size - total)
            if (n < 0) break
            total += n
        }
        return total
    }
}
