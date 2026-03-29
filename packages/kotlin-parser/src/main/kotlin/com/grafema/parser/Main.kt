package com.grafema.parser

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import org.jetbrains.kotlin.cli.common.CLIConfigurationKeys
import org.jetbrains.kotlin.cli.common.messages.MessageCollector
import org.jetbrains.kotlin.cli.jvm.compiler.EnvironmentConfigFiles
import org.jetbrains.kotlin.cli.jvm.compiler.KotlinCoreEnvironment
import org.jetbrains.kotlin.config.CompilerConfiguration
import org.jetbrains.kotlin.psi.KtPsiFactory
import org.jetbrains.kotlin.com.intellij.openapi.Disposable
import org.jetbrains.kotlin.com.intellij.openapi.util.Disposer
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path

/**
 * CLI entry point for kotlin-parser.
 *
 * Single-file mode: kotlin-parser <file.kt> — reads file, outputs JSON AST to stdout.
 * Daemon mode: kotlin-parser --daemon — length-prefixed frame protocol on stdin/stdout.
 *   Input frame:  {"file":"path/Foo.kt","source":"..."}
 *   Output frame: {"status":"ok","ast":{...}} or {"status":"error","error":"..."}
 */

private val GSON: Gson = GsonBuilder().create()

fun main(args: Array<String>) {
    val daemon = args.any { it == "--daemon" }

    if (daemon) {
        daemonLoop()
    } else {
        singleFileMode(args)
    }
}

private fun createEnvironment(): Pair<KotlinCoreEnvironment, Disposable> {
    val disposable = Disposer.newDisposable("kotlin-parser")
    val configuration = CompilerConfiguration().apply {
        put(CLIConfigurationKeys.MESSAGE_COLLECTOR_KEY, MessageCollector.NONE)
    }
    val environment = KotlinCoreEnvironment.createForProduction(
        disposable,
        configuration,
        EnvironmentConfigFiles.JVM_CONFIG_FILES
    )
    return Pair(environment, disposable)
}

private fun singleFileMode(args: Array<String>) {
    if (args.isEmpty()) {
        System.err.println("Usage: kotlin-parser <file.kt>")
        System.err.println("       kotlin-parser --daemon")
        System.exit(1)
    }

    val filePath = Path.of(args[0])
    if (!Files.exists(filePath)) {
        System.err.println("File not found: $filePath")
        System.exit(1)
    }

    val source = Files.readString(filePath, StandardCharsets.UTF_8)
    val (environment, disposable) = createEnvironment()
    try {
        val psiFactory = KtPsiFactory(environment.project)
        val ktFile = psiFactory.createFile(filePath.fileName.toString(), source)
        val ast = KotlinAstSerializer.serialize(ktFile)
        print(GSON.toJson(ast))
    } catch (e: Exception) {
        val resp = JsonObject()
        resp.addProperty("status", "error")
        resp.addProperty("error", e.message)
        System.err.println(GSON.toJson(resp))
        System.exit(1)
    } finally {
        Disposer.dispose(disposable)
    }
}

private fun daemonLoop() {
    val input = System.`in`
    val output = System.out

    val (environment, disposable) = createEnvironment()
    val psiFactory = KtPsiFactory(environment.project)

    try {
        while (true) {
            val frame = DaemonProtocol.readFrame(input) ?: break // EOF

            val json = String(frame, StandardCharsets.UTF_8)
            val req = GSON.fromJson(json, JsonObject::class.java)
            val source = req.get("source").asString
            val fileName = req.get("file")?.asString ?: "input.kt"

            val resp = JsonObject()
            try {
                val ktFile = psiFactory.createFile(fileName, source)
                val ast = KotlinAstSerializer.serialize(ktFile)
                resp.addProperty("status", "ok")
                resp.add("ast", ast)
            } catch (e: Exception) {
                resp.addProperty("status", "error")
                resp.addProperty("error", e.message)
            }

            val respBytes = GSON.toJson(resp).toByteArray(StandardCharsets.UTF_8)
            DaemonProtocol.writeFrame(output, respBytes)
        }
    } finally {
        Disposer.dispose(disposable)
    }
}
