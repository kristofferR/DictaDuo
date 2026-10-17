#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
version=$(cat "$project_dir/VERSION")
if [[ ! "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
    printf 'VERSION must contain a stable major.minor.patch version.\n' >&2
    exit 1
fi
if [[ $# -gt 1 || ( $# == 1 && "$1" != "v$version" ) ]]; then
    printf 'Release tag must match VERSION: v%s\n' "$version" >&2
    exit 1
fi
printf '%s\n' "$version"
