#!/usr/bin/env bash
set -euo pipefail

verify_video() {
  local file="$1"
  local expected_width="$2"
  local expected_height="$3"

  [[ -f "$file" ]] || { echo "Missing video: $file" >&2; return 1; }

  local metadata duration
  metadata="$(ffprobe -v error -select_streams v:0 \
    -show_entries stream=codec_name,width,height,r_frame_rate \
    -of csv=p=0 "$file")"
  duration="$(ffprobe -v error -show_entries format=duration \
    -of default=nokey=1:noprint_wrappers=1 "$file")"

  IFS=',' read -r codec width height fps <<<"$metadata"
  [[ "$codec" == "h264" ]] || { echo "$file: expected h264, got $codec" >&2; return 1; }
  [[ "$width" == "$expected_width" && "$height" == "$expected_height" ]] || {
    echo "$file: expected ${expected_width}x${expected_height}, got ${width}x${height}" >&2
    return 1
  }
  [[ "$fps" == "30/1" ]] || { echo "$file: expected 30 fps, got $fps" >&2; return 1; }
  awk -v duration="$duration" 'BEGIN { exit !(duration >= 8 && duration <= 11.2) }' || {
    echo "$file: expected an 8-11.2 second clip, got ${duration}s" >&2
    return 1
  }

  local average_luma
  average_luma="$(ffmpeg -v error -ss 1 -i "$file" -frames:v 1 \
    -vf signalstats,metadata=print:file=- -f null - 2>/dev/null \
    | awk -F= '/lavfi.signalstats.YAVG/ && value == "" { value=$2 } END { print value }')"
  awk -v average_luma="$average_luma" 'BEGIN { exit !(average_luma >= 180 && average_luma <= 238) }' || {
    echo "$file: expected unwashed paper day mode, got average luma $average_luma" >&2
    return 1
  }

  local paper_luma
  paper_luma="$(ffmpeg -v error -ss 1 -i "$file" -frames:v 1 \
    -vf 'crop=iw/8:ih/8:0:ih/4,signalstats,metadata=print:file=-' -f null - 2>/dev/null \
    | awk -F= '/lavfi.signalstats.YAVG/ && value == "" { value=$2 } END { print value }')"
  awk -v paper_luma="$paper_luma" 'BEGIN { exit !(paper_luma >= 200 && paper_luma <= 230) }' || {
    echo "$file: paper background does not match the game, got luma $paper_luma" >&2
    return 1
  }
}

verify_video store-assets/action-short.mp4 1000 1000
verify_video store-assets/action-short-mobile.mp4 1080 1920

echo "Action videos verified."
