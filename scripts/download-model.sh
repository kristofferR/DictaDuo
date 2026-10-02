#!/bin/bash
set -euo pipefail

# Usage: download-model.sh [whisper|parakeet]. Parakeet is an optional second engine.
model_dir="${SOTTODUO_MODEL_DIR:-${MURMUR_MODEL_DIR:-$HOME/Library/Application Support/Murmur/Models}}"
case "${1:-whisper}" in
    whisper)
        label="Whisper large-v3-turbo (1.62 GB)"
        model_name="ggml-large-v3-turbo.bin"
        model_sha="1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69"
        model_url="https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/$model_name"
        ;;
    parakeet)
        label="Parakeet TDT 0.6B v3 (1.26 GB)"
        model_name="ggml-parakeet-tdt-0.6b-v3-f16.bin"
        model_sha="833bffc9513b2cae867ee9e51633cfd11e4d51aaa5597c8ac02159385a2b426f"
        model_url="https://huggingface.co/ggml-org/parakeet-GGUF/resolve/35156454d1a39de06863303dd209fd2bed6ee079/$model_name"
        ;;
    *)
        printf 'Usage: %s [whisper|parakeet]\n' "$0" >&2
        exit 2
        ;;
esac
mkdir -p "$model_dir"

verify_model() {
    local actual_sha
    actual_sha=$(shasum -a 256 "$1" | cut -d ' ' -f 1)
    [[ "$actual_sha" == "$model_sha" ]]
}

if [[ -f "$model_dir/$model_name" ]] && verify_model "$model_dir/$model_name"; then
    printf 'Verified model already installed: %s\n' "$model_dir/$model_name"
    exit 0
fi

printf 'Downloading %s.\n' "$label"
curl --fail --location --retry 3 --connect-timeout 20 --continue-at - \
    --output "$model_dir/$model_name.download" "$model_url"
printf 'Verifying SHA-256…\n'
if ! verify_model "$model_dir/$model_name.download"; then
    rm -f "$model_dir/$model_name.download"
    printf 'Model integrity check failed; run this command again.\n' >&2
    exit 1
fi
mv -f "$model_dir/$model_name.download" "$model_dir/$model_name"
printf 'Ready: %s\n' "$model_dir/$model_name"
