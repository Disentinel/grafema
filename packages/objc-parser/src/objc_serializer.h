#ifndef OBJC_SERIALIZER_H
#define OBJC_SERIALIZER_H

#include <clang-c/Index.h>

// Serialize an Obj-C translation unit to JSON string.
// Returns allocated string (caller must free).
char* serialize_translation_unit(CXTranslationUnit tu, const char* filename);

#endif
