#!/usr/bin/env bash
set -euo pipefail

command -v npx >/dev/null 2>&1 || { echo "npx is required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg is required" >&2; exit 1; }
command -v ffprobe >/dev/null 2>&1 || { echo "ffprobe is required" >&2; exit 1; }

mkdir -p output/playwright/cli
capture_port="${VIDEO_CAPTURE_PORT:-4173}"
capture_url="http://127.0.0.1:${capture_port}/"
active_session=""

run_pw() {
  if [[ -n "${PWCLI:-}" ]]; then
    "$PWCLI" "$@"
  else
    npx --yes --package @playwright/cli playwright-cli "$@"
  fi
}

cleanup() {
  if [[ -n "$active_session" ]]; then
    run_pw --session "$active_session" close >/dev/null 2>&1 || true
  fi
  if [[ -n "${capture_server_pid:-}" ]]; then
    kill "$capture_server_pid" >/dev/null 2>&1 || true
    wait "$capture_server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

npm run dev -- --host 127.0.0.1 --port "$capture_port" --strictPort \
  >output/playwright/vite.log 2>&1 &
capture_server_pid=$!
for _ in {1..80}; do
  if curl -fsS "$capture_url" >/dev/null 2>&1; then break; fi
  kill -0 "$capture_server_pid" 2>/dev/null || { cat output/playwright/vite.log >&2; exit 1; }
  sleep 0.25
done
curl -fsS "$capture_url" >/dev/null

capture_variant() {
  local variant="$1"
  local video_size="$2"
  local source="output/playwright/action-${variant}-source.webm"
  local source_abs="$PWD/$source"
  rm -f "$source"
  active_session="action-video-${variant}"
  run_pw --session "$active_session" open "$capture_url" \
    --config "scripts/action-video/${variant}.config.json" --headed
  run_pw --session "$active_session" snapshot
  run_pw --session "$active_session" run-code \
    --filename scripts/action-video/browser-setup.js
  run_pw --session "$active_session" snapshot
  run_pw --session "$active_session" video-start "$source_abs" --size "$video_size"
  run_pw --session "$active_session" run-code \
    --filename scripts/action-video/browser-flow.js
  run_pw --session "$active_session" video-stop
  run_pw --session "$active_session" close
  active_session=""
  [[ -f "$source" ]] || { echo "Capture failed: $source was not created" >&2; return 1; }
}

encode_video() {
  local source="$1"
  local destination="$2"
  local scale_filter="$3"
  local playback_speed=1.15
  local duration fade_start
  duration="$(ffprobe -v error -select_streams v:0 -show_frames \
    -show_entries frame=pts_time -of csv=p=0 "$source" | tail -n 1)"
  fade_start="$(awk -v duration="$duration" -v speed="$playback_speed" \
    'BEGIN { printf "%.3f", duration / speed - 0.25 }')"
  ffmpeg -y -i "$source" -vf \
    "setpts=PTS/${playback_speed},fps=30,${scale_filter}fade=t=in:st=0:d=0.12,fade=t=out:st=${fade_start}:d=0.25,format=yuv420p" \
    -an -c:v libx264 -preset slow -crf 18 -movflags +faststart "$destination"
}

capture_variant square 1000x1000
capture_variant mobile 540x960
encode_video output/playwright/action-square-source.webm store-assets/action-short.mp4 ""
encode_video output/playwright/action-mobile-source.webm store-assets/action-short-mobile.mp4 "scale=1080:1920:flags=lanczos,"
bash scripts/verify-action-videos.sh
