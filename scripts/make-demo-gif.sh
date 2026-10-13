#!/usr/bin/env bash
# Stitches the recordings from `E2E_DEMO=1 playwright test e2e/demo` (test-artifacts/demo/*) and some caption cards into
# docs/media/full-flow.gif: 900 px wide, 15 frames a second, a palette made for the content, under 10 MB.
#
#   pnpm demo:record            records and then runs this
#   bash scripts/make-demo-gif.sh   only this (needs ffmpeg and uv)
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=test-artifacts/demo
WORK=test-artifacts/demo-build
OUT=docs/media/full-flow.gif
FPS=15
mkdir -p "$WORK" docs/media
rm -f "$WORK"/*.mp4 "$WORK"/list.txt

command -v ffmpeg >/dev/null || { echo "ffmpeg is needed to make the GIF" >&2; exit 1; }
uv run --project services/ai python scripts/demo/make_frames.py "$WORK/frames"

clip() { find "$SRC/$1" -name '*.webm' | head -1; }
for d in 1-customer 1b-customer-waiting 2-officer 3-customer-done 4-auditor; do
  [ -n "$(clip $d)" ] || { echo "missing recording $SRC/$d (run pnpm demo:record)" >&2; exit 1; }
done

# a still image held for N seconds
still() { ffmpeg -v error -y -loop 1 -t "$3" -i "$1" -vf "fps=$FPS,format=yuv420p" "$2"; }

# a phone recording on its caption panel; $3 is how much faster than real time it plays
phone() {
  ffmpeg -v error -y -loop 1 -i "$WORK/frames/$2" -i "$(clip $1)" -filter_complex \
    "[1:v]setpts=PTS/$3,fps=$FPS,scale=-2:500[p];[0:v][p]overlay=70:30:shortest=1,format=yuv420p" "$4"
}

# a desktop recording with a caption strip across the bottom
desktop() {
  ffmpeg -v error -y -i "$(clip $1)" -i "$WORK/frames/$2" -filter_complex \
    "[0:v]setpts=PTS/$3,fps=$FPS,scale=900:560[v];[v][1:v]overlay=0:H-h,format=yuv420p" "$4"
}

still "$WORK/frames/card-0-intro.png" "$WORK/00.mp4" 3
phone 1-customer phone-1.png 1.15 "$WORK/01.mp4"
still "$WORK/frames/card-1-ocr.png" "$WORK/02.mp4" 4
phone 1b-customer-waiting phone-2.png 1.2 "$WORK/03.mp4"
desktop 2-officer bar-3.png 1.0 "$WORK/04.mp4"
phone 3-customer-done phone-4.png 1.1 "$WORK/05.mp4"
desktop 4-auditor bar-5.png 1.0 "$WORK/06.mp4"
still "$WORK/frames/card-9-end.png" "$WORK/07.mp4" 3

for f in "$WORK"/0?.mp4; do echo "file '$(basename "$f")'"; done > "$WORK/list.txt"
ffmpeg -v error -y -f concat -safe 0 -i "$WORK/list.txt" -c copy "$WORK/all.mp4"

ffmpeg -v error -y -i "$WORK/all.mp4" \
  -vf "fps=$FPS,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  -loop 0 "$OUT"

secs=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$WORK/all.mp4")
size=$(stat -f%z "$OUT" 2>/dev/null || stat -c%s "$OUT")
echo "wrote $OUT: $(printf '%.0f' "$secs") s, $((size / 1024)) KiB"
[ "$size" -lt 10485760 ] || { echo "the GIF is over 10 MB" >&2; exit 1; }
