#ifndef DAEMON_PROTOCOL_H
#define DAEMON_PROTOCOL_H

#include <stdint.h>
#include <stdio.h>

// Read a length-prefixed frame from stdin.
// Returns allocated buffer (caller must free), or NULL on EOF/error.
// Sets *out_len to the payload length.
char* read_frame(FILE* input, uint32_t* out_len);

// Write a length-prefixed frame to stdout.
void write_frame(FILE* output, const char* payload, uint32_t len);

#endif
