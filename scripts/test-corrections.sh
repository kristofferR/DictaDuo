#!/bin/bash
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
if [[ "$(uname -s)" == Darwin ]]; then
    test_script=test-text-engine.py
    helper_flag=--helper
    default_model="$HOME/.murmur/models/Qwen3-4B-Instruct-2507-MLX-4bit"
else
    test_script=test-llama-engine.py
    helper_flag=--engine
    default_model=""
fi
model="${DICTADUO_TEXT_MODEL:-$default_model}"
if [[ -z "$model" ]]; then
    printf 'Set DICTADUO_TEXT_MODEL to your Qwen GGUF file.\n' >&2
    exit 1
fi
exec python3 "$project_dir/scripts/$test_script" "$helper_flag" "$project_dir/build/server/helpers/dictaduo-text-engine" --model "$model" --server "$project_dir/build/server/dictaduo-server" "$@"
