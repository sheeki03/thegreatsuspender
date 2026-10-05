#!/bin/bash
set -euo pipefail
# Reuse installation path parsing and ownership checks; removal requires the
# same --extension-id, --browser-dir and --install-dir used for installation.
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
exec "${source_dir}/install-host.sh" --uninstall "$@"
