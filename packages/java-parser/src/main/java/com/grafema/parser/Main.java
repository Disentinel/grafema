package com.grafema.parser;

import com.github.javaparser.StaticJavaParser;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ParserConfiguration;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * CLI entry point for java-parser.
 *
 * Single-file mode: reads source from stdin, writes JSON AST to stdout.
 * Daemon mode (--daemon): length-prefixed frame protocol on stdin/stdout.
 *   Input frame:  {"file":"path/Foo.java","source":"..."}
 *   Output frame: {"status":"ok","ast":{...}} or {"status":"error","error":"..."}
 */
public class Main {

    private static final Gson GSON = new GsonBuilder().create();

    public static void main(String[] args) throws Exception {
        // Configure JavaParser for Java 21+
        StaticJavaParser.getParserConfiguration()
                .setLanguageLevel(ParserConfiguration.LanguageLevel.JAVA_17);

        boolean daemon = false;
        for (String arg : args) {
            if ("--daemon".equals(arg)) {
                daemon = true;
            }
        }

        if (daemon) {
            daemonLoop();
        } else {
            singleFileMode(args);
        }
    }

    private static void singleFileMode(String[] args) throws Exception {
        if (args.length == 0) {
            System.err.println("Usage: java-parser <file.java>");
            System.err.println("       java-parser --daemon");
            System.exit(1);
        }

        Path filePath = Path.of(args[0]);
        if (!Files.exists(filePath)) {
            System.err.println("File not found: " + filePath);
            System.exit(1);
        }

        String source = Files.readString(filePath, StandardCharsets.UTF_8);
        try {
            CompilationUnit cu = StaticJavaParser.parse(source);
            JsonObject ast = AstSerializer.serialize(cu);
            System.out.print(GSON.toJson(ast));
        } catch (Exception e) {
            JsonObject resp = new JsonObject();
            resp.addProperty("status", "error");
            resp.addProperty("error", e.getMessage());
            System.err.println(GSON.toJson(resp));
            System.exit(1);
        }
    }

    private static void daemonLoop() throws Exception {
        InputStream in = System.in;
        OutputStream out = System.out;

        while (true) {
            byte[] frame = DaemonProtocol.readFrame(in);
            if (frame == null) break; // EOF

            String json = new String(frame, StandardCharsets.UTF_8);
            JsonObject req = GSON.fromJson(json, JsonObject.class);
            String source = req.get("source").getAsString();

            JsonObject resp = new JsonObject();
            try {
                CompilationUnit cu = StaticJavaParser.parse(source);
                JsonObject ast = AstSerializer.serialize(cu);
                resp.addProperty("status", "ok");
                resp.add("ast", ast);
            } catch (Exception e) {
                resp.addProperty("status", "error");
                resp.addProperty("error", e.getMessage());
            }

            byte[] respBytes = GSON.toJson(resp).getBytes(StandardCharsets.UTF_8);
            DaemonProtocol.writeFrame(out, respBytes);
        }
    }
}
