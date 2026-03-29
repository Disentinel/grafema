#include "daemon_protocol.h"
#include <stdlib.h>
#include <string.h>
#include <arpa/inet.h>  // for ntohl/htonl

char* read_frame(FILE* input, uint32_t* out_len) {
    uint32_t net_len;
    if (fread(&net_len, 4, 1, input) != 1) {
        return NULL;  // EOF
    }
    uint32_t len = ntohl(net_len);
    if (len > 100000000) {
        fprintf(stderr, "Invalid frame length: %u\n", len);
        return NULL;
    }
    char* buf = malloc(len + 1);
    if (!buf) return NULL;
    if (fread(buf, 1, len, input) != len) {
        free(buf);
        return NULL;
    }
    buf[len] = '\0';
    *out_len = len;
    return buf;
}

void write_frame(FILE* output, const char* payload, uint32_t len) {
    uint32_t net_len = htonl(len);
    fwrite(&net_len, 4, 1, output);
    fwrite(payload, 1, len, output);
    fflush(output);
}
