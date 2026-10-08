#!/bin/bash
# Compile rng_dice.c to a Hooks WASM module with hook and cbak exported.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# xahaud is checked out beside this directory (hooks/xahaud).
ROOT="$(cd "$HERE/.." && pwd)"

CLANG=""
for c in \
  /opt/homebrew/opt/llvm/bin/clang \
  /opt/homebrew/opt/llvm@22/bin/clang \
  /opt/homebrew/opt/llvm@14/bin/clang \
  /usr/local/opt/llvm/bin/clang \
  /opt/homebrew/Cellar/llvm@14/14.0.6/bin/clang
do
  if [ -x "$c" ] && [ -x "$(dirname "$c")/wasm-ld" ]; then
    CLANG="$c"
    break
  fi
done
if [ -z "$CLANG" ]; then
  echo "Need LLVM clang and wasm-ld (brew install llvm)" >&2
  exit 1
fi

export PATH="$(dirname "$CLANG"):$PATH"

if [ ! -f "$ROOT/xahaud/hook/hookapi.h" ]; then
  echo "hookapi.h not found at $ROOT/xahaud/hook" >&2
  exit 1
fi

OUT="$HERE/rng_dice.wasm"
"$CLANG" \
  --target=wasm32-unknown-unknown \
  -std=c11 \
  -O2 \
  -nostdlib \
  -ffreestanding \
  -fno-builtin \
  -fno-stack-protector \
  -mno-bulk-memory \
  -I "$ROOT/xahaud/hook" \
  -Wl,--allow-undefined \
  -Wl,--no-entry \
  -Wl,--export=hook \
  -Wl,--export=cbak \
  -o "$OUT" \
  "$HERE/rng_dice.c"

python3 - "$OUT" << 'PY'
import sys
path = sys.argv[1]
data = bytearray(open(path, "rb").read())
if data[:4] != b"\x00asm":
    raise SystemExit("not wasm")

def leb(buf, i):
    n = shift = 0
    while True:
        b = buf[i]
        i += 1
        n |= (b & 0x7F) << shift
        if b < 128:
            return n, i
        shift += 7

def sleb(buf, i):
    n = shift = 0
    while True:
        b = buf[i]
        i += 1
        n |= (b & 0x7F) << shift
        shift += 7
        if b < 128:
            if shift < 64 and (b & 0x40):
                n |= (~0 << shift)
            return n, i

def name_at(buf, i):
    n, i = leb(buf, i)
    return bytes(buf[i:i + n]), i + n

out = bytearray(data[:8])
i = 8
kept = []
while i < len(data):
    start = i
    section_type = data[i]
    i += 1
    length, i = leb(data, i)
    end = i + length
    if section_type != 0:
        out += data[start:end]
        kept.append(section_type)
    i = end
open(path, "wb").write(out)

def section(buf, want):
    i = 8
    while i < len(buf):
        st = buf[i]
        i += 1
        ln, i = leb(buf, i)
        if st == want:
            return buf[i:i + ln]
        i += ln
    return None

imports = section(out, 2)
j = 0
import_count, j = leb(imports, j)
import_names = []
for _ in range(import_count):
    module, j = name_at(imports, j)
    field, j = name_at(imports, j)
    kind = imports[j]
    j += 1
    if kind == 0:
        _, j = leb(imports, j)
    elif kind == 1:
        j += 1
        _, j = leb(imports, j)
        mx = imports[j]
        j += 1
        if mx:
            _, j = leb(imports, j)
    elif kind == 2:
        _, j = leb(imports, j)
        _, j = leb(imports, j)
    elif kind == 3:
        _, j = leb(imports, j)
        _, j = leb(imports, j)
    import_names.append(field.decode())

exports = section(out, 7)
j = 0
export_count, j = leb(exports, j)
export_names = []
for _ in range(export_count):
    field, j = name_at(exports, j)
    j += 1
    _, j = leb(exports, j)
    export_names.append(field.decode())

funcs = section(out, 3)
code = section(out, 10)
j = 0
func_count, j = leb(funcs, j)
j = 0
code_count, j = leb(code, j)
problems = []
if func_count != 2 or code_count != 2:
    problems.append(f"expected hook and cbak, got funcs={func_count} code={code_count}")
fn_exports = [name for name in export_names if name != "memory"]
if set(fn_exports) != {"hook", "cbak"}:
    problems.append(f"exports {export_names}")
if "dice" not in import_names:
    problems.append(f"dice is not imported: {import_names}")
if "_g" not in import_names:
    problems.append(f"guard _g is not imported: {import_names}")
if any(a >= b for a, b in zip(kept, kept[1:])):
    problems.append(f"sections out of order: {kept}")

# Every loop must open with a guard call. This hook is straight-line.
for fn in range(code_count):
    body_size, j = leb(code, j)
    end = j + body_size
    nlocals, j = leb(code, j)
    for _ in range(nlocals):
        _, j = leb(code, j)
        j += 1
    body = code[j:end]
    k = 0
    while k < len(body):
        op = body[k]
        if op in (0x02, 0x03, 0x04):
            if op == 0x03 and (k + 2 >= len(body) or body[k + 1] != 0x40 or body[k + 2] != 0x41):
                problems.append(f"loop at {k} does not start with a guard: {body[k:k+8].hex()}")
            k += 1
            if k < len(body) and body[k] == 0x40:
                k += 1
            elif k < len(body) and body[k] in (0x7C, 0x7D, 0x7E, 0x7F):
                k += 1
            else:
                _, k = sleb(body, k)
            continue
        if op == 0x0E:
            n, k = leb(body, k + 1)
            for _ in range(n + 1):
                _, k = leb(body, k)
            continue
        if op in (0x0C, 0x0D, 0x10, 0x20, 0x21, 0x22, 0x23, 0x24):
            _, k = leb(body, k + 1)
            continue
        if op in (0x41, 0x42):
            _, k = sleb(body, k + 1)
            continue
        if 0x28 <= op <= 0x3E:
            _, k = leb(body, k + 1)
            _, k = leb(body, k)
            continue
        if op == 0xFC:
            t, k = leb(body, k + 1)
            if t in (10, 11):
                problems.append(f"illegal bulk-memory opcode fc {t}")
            continue
        if op == 0x40:
            problems.append("memory.grow")
        if op == 0x11:
            problems.append("call_indirect")
        k += 1
    j = end

print(f"wasm {len(out)} bytes sections {kept} imports {import_names} exports {export_names}")
if problems:
    raise SystemExit("wasm rejected:\n  " + "\n  ".join(problems))
PY

echo "wrote $OUT ($(wc -c < "$OUT") bytes) with $CLANG"
