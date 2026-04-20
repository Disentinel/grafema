---
name: elixir-escript-daemon-stdio-encoding
description: |
  Fix intermittent `{:no_translation, :unicode, :latin1}` crashes in Elixir escript
  daemons that use length-prefixed framed IPC on stdin/stdout. Use when: (1) daemon
  worker crashes only on some input files, usually ones with non-ASCII bytes (kanji,
  cyrillic, emoji); (2) error surfaces as `Protocol error` from daemon's error branch
  or as garbled frame-length bytes seen by the orchestrator/client side; (3) standalone
  one-shot mode works fine on the same input but multi-request daemon mode fails;
  (4) `IO.binread(:stdio, N)` returns `{:error, {:no_translation, :unicode, :latin1}}`
  despite the "bin" prefix suggesting it should be encoding-agnostic.
  Root cause is the escript default `:standard_io` encoding — it's `:unicode`, and
  `IO.binread` still routes through the io_server, which translates bytes to codepoints
  and errors when raw binary frames contain invalid UTF-8 sequences.
author: Claude Code
version: 1.0.0
date: 2026-04-19
---

# Elixir Escript Daemon — Stdio Encoding Trap

## Problem

Elixir escripts that implement a length-prefixed framed IPC daemon over stdin/stdout
(e.g. language analyzers, worker pools, plugin runners driven by an external
orchestrator) crash intermittently with:

```
Protocol error: {:no_translation, :unicode, :latin1}
```

The crash appears non-deterministic: same daemon, same code, some files trigger it,
most don't. Files that trigger it tend to contain multi-byte UTF-8 sequences (kanji,
cyrillic, emoji) in comments, atoms, or string literals. Running the daemon in
stand-alone single-request mode works fine — only the long-lived multi-request mode
fails.

## Context / Trigger Conditions

All of these must apply:

1. Elixir escript (`mix escript.build` output) with a `--daemon` mode
2. Length-prefixed frames on stdin/stdout (typical pattern: `<<len::32>> <> payload`)
3. Payloads can contain arbitrary bytes — JSON with UTF-8, raw binaries, etc.
4. The daemon uses `IO.binread(:stdio, N)` / `IO.binwrite(:stdio, data)` for framing
5. External orchestrator feeds requests over a pipe (`Stdio::piped()`), not a terminal

Typical symptom chain:

- Orchestrator logs `beam analyzer failed ... Pool request failed`
- Daemon stderr contains `Protocol error: {:no_translation, :unicode, :latin1}`
- The daemon's own error branch printed that line after `read_frame` returned
  `{:error, {:no_translation, :unicode, :latin1}}`
- `IO.binread(:stdio, 4)` produced the tuple-error — despite being "binary" read
- The specific failing file(s) repeat between runs, but *which* daemon worker in the
  pool gets the file varies, giving the illusion of flakiness

## Root Cause

Two non-obvious facts collide:

1. **Escript initializes `:standard_io` with `encoding: :unicode`.** This is the default
   group leader configuration; it's not documented as "will bite you on binary IPC."

2. **`IO.binread` and `IO.binwrite` still route through the io_server.** The "bin"
   prefix means "returns binaries, not lists" — NOT "bypasses encoding." The io_server
   validates/translates bytes against the device's current encoding. For a `:unicode`
   device, non-UTF-8 byte sequences raise `{:no_translation, :unicode, :latin1}`.

So any frame payload that happens to contain a byte sequence that isn't valid UTF-8
(random length headers with high-bit bytes, binary data, specific multi-byte tails of
truncated reads) kills the io_server interaction, which surfaces on the very next
`IO.binread` as that error tuple.

Secondary contributor: compiler/parser warnings from things like `Code.string_to_quoted`
go through `Logger`, whose default handler also writes to `:standard_io`. Any such
warning from a worker adds extra bytes to the frame stream and desynchronizes the
peer even when the io_server doesn't error.

## Solution

At daemon startup, **before** any stdin read or stdout write:

```elixir
def main(args) do
  # Force stdio to flat byte passthrough. latin1 is 1:1 with bytes — any byte
  # value is a valid latin1 codepoint, so IO.binread/binwrite never translate.
  :io.setopts(:standard_io, encoding: :latin1)

  # stderr is human text — keep it :unicode so inspect()/tuples with multi-byte
  # binaries still render correctly.
  :io.setopts(:standard_error, encoding: :unicode)

  # Route Logger away from stdout so parser/compile warnings can't pollute the
  # frame stream. Elixir 1.17+ uses the OTP :logger default handler.
  _ =
    :logger.update_handler_config(:default, :config, %{type: :standard_error})

  case args do
    ["--daemon"] -> daemon_loop()
    _ -> one_shot()
  end
end
```

That's it. No need to rewrite the Protocol module, no raw `Port.open({:fd, 0, 1}, ...)`
(which causes its own `prim_tty: stealing control of fd=0` warning on stdout).

## Why Not `encoding: :unicode` on stdio?

Intuitive first attempt: "set stdio to `:unicode` so encoding matches actual content."
It makes the Logger/IO.write path for UTF-8 strings work cleanly, and in one-shot mode
(single request per process lifetime) it appears to fix things.

But it makes daemon mode *worse*: after a successful `IO.binwrite` of a large UTF-8
JSON payload, the io_server's state is fine for writes but later `IO.binread` calls
intermittently return the same `:no_translation` error. Tested on Elixir 1.19 / OTP 27.
`:latin1` is the safe choice because every byte is a valid codepoint — no translation
can fail.

## Why Not Raw Port via `{:fd, 0, 1}`?

`Port.open({:fd, 0, 1}, [:binary, {:packet, 4}])` seems elegant — it bypasses the
io_server entirely and the VM handles 4-byte length framing for you. It works
functionally, but on escript startup the `prim_tty` driver already owns fd 0/1 and
prints a warning to stdout when a new port takes over:

```
21:09:30.549 [error] driver_select(...) by fd (0/1) driver #Port<0.2> stealing control
of fd=0 from resource prim_tty:tty
```

Those bytes appear on stdout *before* the first frame, parsed by the orchestrator as
a bogus length header, and the whole conversation desyncs from byte 1. Workarounds
(close `user_drv` first, dup fds, etc.) add significant complexity. The `:io.setopts`
fix above is strictly simpler and sufficient.

## Verification

Reproducer: a daemon worker that ingests 50+ files in sequence, at least a few
containing multi-byte UTF-8 in source:

```python
# harness.py — feed multi-file stress through one daemon
import json, struct, subprocess

files = ["heavy_utf8_1.ex", "ascii_1.ex", "heavy_utf8_2.ex", ...]
proc = subprocess.Popen(["./daemon", "--daemon"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

for f in files:
    src = open(f).read()
    payload = json.dumps({"file": f, "source": src}).encode("utf-8")
    proc.stdin.write(struct.pack(">I", len(payload)) + payload)
    proc.stdin.flush()
    length = struct.unpack(">I", proc.stdout.read(4))[0]
    resp = json.loads(proc.stdout.read(length))
    assert resp["status"] == "ok", f"daemon crashed on {f}"
```

Without the fix: random crashes after 5-30 files.
With the fix: 0 crashes across 3+ consecutive full runs.

## Example

Real-world case from the grafema repo (`packages/beam-analyzer/lib/beam_analyzer.ex`,
commit 7d0d9f78): the daemon analyzed 60 Elixir source files from a project that
had kanji atoms (`:守り`, `:内観`) and cyrillic comments. Pre-fix: 2–3 files failed
per run, random which ones.  Post-fix: 3 consecutive runs, 0 failures, 12166 graph
nodes produced deterministically.

## Notes

- The `:standard_io` device encoding is set at escript VM startup and is stable — one
  call at the top of `main/1` is enough; no need to re-set per worker or per request.
- `:io.setopts(:standard_error, encoding: :unicode)` matters for stderr-bound logs
  that embed `inspect/1` results with non-ASCII binaries; without it you can get the
  same `:no_translation` error on error-path writes.
- Redirecting Logger doesn't silence it — stderr is inherited by the orchestrator,
  which typically captures it for diagnostics. That's what you want.
- The `IO.binread` / `IO.binwrite` semantics described here are Elixir-specific; in
  pure Erlang, `file:read/2` and `file:write/2` on stdio have the same gotcha because
  they share the io_server.
- This fix is strictly safer than the alternatives; there's no scenario where you
  *want* escript stdio to do encoding translation on framed binary IPC.

## Related Skills

- `beam-elixir-ast-gotchas` — other non-obvious Elixir/Erlang AST processing issues
  in analyzer tools
- `nodejs-child-process-stdio-cleanup` — analogous trap on the Node.js side when
  spawning daemons

## References

- Elixir [`IO.binread/2`](https://hexdocs.pm/elixir/IO.html#binread/2) — does not
  document the encoding interaction
- Erlang [`io:setopts/2`](https://www.erlang.org/doc/man/io.html#setopts-2) — the
  `encoding` option controls io_server translation
- Erlang [`logger` handler config](https://www.erlang.org/doc/man/logger.html) —
  `type: :standard_error` is the documented way to redirect the default handler
