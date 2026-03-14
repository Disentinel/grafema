CC = clang
# Headers: Homebrew LLVM > /usr/local/include > fallback. Runtime: CLT libclang.
LLVM_INC = $(shell \
  if [ -d "$$(brew --prefix llvm 2>/dev/null)/include/clang-c" ]; then echo "-I$$(brew --prefix llvm)/include"; \
  elif [ -d "/usr/local/include/clang-c" ]; then echo "-I/usr/local/include"; \
  else echo ""; fi)
CFLAGS = -Wall -Wextra -O2 $(LLVM_INC)
LDFLAGS = -L/Library/Developer/CommandLineTools/usr/lib -lclang -Wl,-rpath,/Library/Developer/CommandLineTools/usr/lib

TARGET = objc-parser
SRCS = src/main.c src/daemon_protocol.c src/objc_serializer.c
OBJS = $(SRCS:.c=.o)

all: $(TARGET)

$(TARGET): $(OBJS)
	$(CC) $(OBJS) $(LDFLAGS) -o $(TARGET)

%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@

clean:
	rm -f $(OBJS) $(TARGET)

.PHONY: all clean
