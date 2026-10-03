#!/bin/sh
# No-model fallback when a Cursor sketch does not render.
# Usage: sketch/screenshot.sh wireframe.html outdir
set -eu
html=$1
out=$2
mkdir -p "$out"
google-chrome --headless=new --disable-gpu --no-sandbox --window-size=390,844 --screenshot="$out/wireframe-390x844.png" "file://$(pwd)/$html"
google-chrome --headless=new --disable-gpu --no-sandbox --window-size=1440,900 --screenshot="$out/wireframe-1440x900.png" "file://$(pwd)/$html"
