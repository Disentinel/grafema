#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <clang-c/Index.h>
#include "daemon_protocol.h"
#include "objc_serializer.h"

// Simple JSON string extraction (find "field":"value" or "field": "value")
static char* json_get_string(const char* json, const char* field) {
    char pattern[256];
    // Try compact form first: "field":"value"
    snprintf(pattern, sizeof(pattern), "\"%s\":\"", field);
    const char* start = strstr(json, pattern);
    if (!start) {
        // Try with space: "field": "value"
        snprintf(pattern, sizeof(pattern), "\"%s\": \"", field);
        start = strstr(json, pattern);
    }
    if (!start) return NULL;
    start += strlen(pattern);
    const char* end = start;
    while (*end && *end != '"') {
        if (*end == '\\') end++;  // skip escaped chars
        end++;
    }
    size_t len = (size_t)(end - start);
    char* result = malloc(len + 1);
    memcpy(result, start, len);
    result[len] = '\0';
    return result;
}

static void single_file_mode(const char* filepath) {
    CXIndex index = clang_createIndex(0, 0);
    const char* args[] = { "-x", "objective-c", "-fno-color-diagnostics" };
    CXTranslationUnit tu = clang_parseTranslationUnit(
        index, filepath, args, 3, NULL, 0,
        CXTranslationUnit_DetailedPreprocessingRecord
    );

    if (!tu) {
        fprintf(stderr, "{\"status\":\"error\",\"error\":\"Failed to parse %s\"}\n", filepath);
        clang_disposeIndex(index);
        exit(1);
    }

    char* json = serialize_translation_unit(tu, filepath);
    printf("{\"status\":\"ok\",\"ast\":%s}", json);
    free(json);
    clang_disposeTranslationUnit(tu);
    clang_disposeIndex(index);
}

static void daemon_loop(void) {
    CXIndex index = clang_createIndex(0, 0);
    uint32_t len;

    while (1) {
        char* frame = read_frame(stdin, &len);
        if (!frame) break;  // EOF

        char* filepath = json_get_string(frame, "file");
        char* source = json_get_string(frame, "source");

        if (!filepath || !source) {
            const char* err = "{\"status\":\"error\",\"error\":\"Missing file or source field\"}";
            write_frame(stdout, err, (uint32_t)strlen(err));
            free(frame);
            if (filepath) free(filepath);
            if (source) free(source);
            continue;
        }

        // Parse from unsaved file (in-memory source)
        struct CXUnsavedFile unsaved = { filepath, source, (unsigned long)strlen(source) };
        const char* args[] = { "-x", "objective-c", "-fno-color-diagnostics" };
        CXTranslationUnit tu = clang_parseTranslationUnit(
            index, filepath, args, 3, &unsaved, 1,
            CXTranslationUnit_DetailedPreprocessingRecord
        );

        char response[65536];
        if (tu) {
            char* ast = serialize_translation_unit(tu, filepath);
            snprintf(response, sizeof(response), "{\"status\":\"ok\",\"ast\":%s}", ast);
            free(ast);
            clang_disposeTranslationUnit(tu);
        } else {
            snprintf(response, sizeof(response),
                "{\"status\":\"error\",\"error\":\"Failed to parse %s\"}", filepath);
        }

        write_frame(stdout, response, (uint32_t)strlen(response));

        free(frame);
        free(filepath);
        free(source);
    }

    clang_disposeIndex(index);
}

int main(int argc, char** argv) {
    if (argc > 1 && strcmp(argv[1], "--daemon") == 0) {
        daemon_loop();
    } else if (argc > 1) {
        single_file_mode(argv[1]);
    } else {
        fprintf(stderr, "Usage: objc-parser <file.m>\n");
        fprintf(stderr, "       objc-parser --daemon\n");
        return 1;
    }
    return 0;
}
