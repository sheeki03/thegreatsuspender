#!/bin/bash
set -euo pipefail
umask 077

host_name='com.sheeki.tab_memory'
extension_id=''
# Brave's macOS startup redirects native messaging to Chrome's registry.
browser_dir="${HOME}/Library/Application Support/Google/Chrome"
install_dir="${HOME}/Library/Application Support/TheGreatSuspender/MemoryHost"
uninstall=false

usage() {
  printf '%s\n' \
    'Usage: native/install-host.sh --extension-id ID [--browser-dir PATH] [--install-dir PATH]' \
    '' \
    'Installs a user-local macOS native messaging helper; no service, root access or network.' \
    'ID must be the 32-character extension ID shown in brave://extensions.' \
    '--browser-dir accepts a native-host registration base OR its NativeMessagingHosts directory.' \
    'macOS Brave uses the default Chrome registry; --user-data-dir does not redirect this lookup.' \
    '--install-dir is the directory for the compiled executable. Use absolute paths.' \
    '' \
    'Defaults:' \
    "  --browser-dir \"${HOME}/Library/Application Support/Google/Chrome\"" \
    "  --install-dir \"${HOME}/Library/Application Support/TheGreatSuspender/MemoryHost\"" \
    '' \
    'For isolated testing, launch Brave with HOME and CFFIXED_USER_HOME set to an isolated home.' \
    'Register under that home; an arbitrary --browser-dir does not change browser lookup.' \
    'Remove this registration and its binary with native/uninstall-host.sh using the same options.'
}

die() {
  printf 'Memory helper: %s\n' "$*" >&2
  exit 1
}

while (( $# )); do
  case "$1" in
    --extension-id|--browser-dir|--install-dir)
      (( $# >= 2 )) || die "Missing value for $1."
      [[ -n "$2" && "$2" != --* ]] || die "Missing value for $1."
      case "$1" in
        --extension-id) extension_id=$2 ;;
        --browser-dir) browser_dir=$2 ;;
        --install-dir) install_dir=$2 ;;
      esac
      shift 2
      ;;
    --uninstall) uninstall=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "Unknown option: $1. Use --help for usage." ;;
  esac
done

[[ "${OSTYPE:-}" == darwin* ]] || die 'This helper supports macOS only.'
(( EUID != 0 )) || die 'Run this as your normal user, not sudo/root; installation is user-local.'
[[ "$extension_id" =~ ^[a-p]{32}$ ]] || die '--extension-id must be exactly 32 lowercase letters a through p.'
[[ "$browser_dir" == /* && "$install_dir" == /* ]] || die '--browser-dir and --install-dir must be absolute paths.'
[[ ! "$browser_dir" =~ [[:cntrl:]] && ! "$install_dir" =~ [[:cntrl:]] ]] || die 'Directory names must not contain control characters.'

# A trailing slash must not change whether NativeMessagingHosts was supplied.
while [[ "$browser_dir" != / && "$browser_dir" == */ ]]; do browser_dir=${browser_dir%/}; done
while [[ "$install_dir" != / && "$install_dir" == */ ]]; do install_dir=${install_dir%/}; done
[[ "$browser_dir" != / && "$install_dir" != / ]] || die 'Choose user-local directories, not the filesystem root.'
if [[ "${browser_dir##*/}" == NativeMessagingHosts ]]; then
  hosts_dir=$browser_dir
else
  hosts_dir="${browser_dir}/NativeMessagingHosts"
fi
[[ ! -L "$hosts_dir" && ! -L "$install_dir" ]] || die 'Refusing a symlinked registration or helper directory.'

stage_dir=''
manifest_tmp=''
cleanup() {
  [[ -z "$manifest_tmp" ]] || rm -f -- "$manifest_tmp"
  [[ -z "$stage_dir" ]] || rm -rf -- "$stage_dir"
}
trap cleanup EXIT
if $uninstall; then
  # Only remove a registration that agrees with every supplied option. Never
  # recursively remove a browser profile or an arbitrary installation directory.
  [[ -d "$hosts_dir" ]] || { printf '%s\n' 'No helper registration exists in this browser directory.'; exit 0; }
  hosts_dir=$(cd -- "$hosts_dir" && pwd -P)
  if [[ -d "$install_dir" ]]; then install_dir=$(cd -- "$install_dir" && pwd -P); fi
  manifest="${hosts_dir}/${host_name}.json"
  binary="${install_dir}/tab-memory-host"
  [[ ! -L "$manifest" && ! -L "$binary" ]] || die 'Refusing to uninstall symlinked files.'
  [[ -f "$manifest" ]] || { printf '%s\n' 'No helper registration exists in this browser directory.'; exit 0; }
  stage_dir=$(mktemp -d "${hosts_dir}/.tab-memory-uninstall.XXXXXX")
  registration_plist="${stage_dir}/registration.plist"
  /usr/bin/plutil -create xml1 "$registration_plist"
  /usr/bin/plutil -insert host -json "$(< "$manifest")" "$registration_plist" || die 'Cannot parse the existing JSON registration.'
  registered_name=$(/usr/bin/plutil -extract host.name raw -o - "$registration_plist") || die 'Cannot read the existing registration.'
  registered_path=$(/usr/bin/plutil -extract host.path raw -o - "$registration_plist") || die 'Cannot read the registered executable path.'
  registered_origin=$(/usr/bin/plutil -extract host.allowed_origins.0 raw -o - "$registration_plist") || die 'Cannot read the registered extension origin.'
  [[ "$registered_name" == "$host_name" ]] || die 'The registration does not belong to this helper.'
  [[ "$registered_path" == "$binary" ]] || die 'The registered binary differs from --install-dir; no files were removed.'
  [[ "$registered_origin" == "chrome-extension://${extension_id}/" ]] || die 'The registered extension differs from --extension-id; no files were removed.'
  [[ ! -d "$binary" ]] || die 'The registered executable path is a directory; no files were removed.'
  rm -f -- "$manifest" "$binary"
  printf 'Removed registration %s\nRemoved executable %s\n' "$manifest" "$binary"
  printf '%s\n' 'Existing browser profiles and directories were left intact. Disconnect/disable the helper in the extension.'
  exit 0
fi

command -v xcrun >/dev/null 2>&1 || die 'Apple command-line tools are required. Install them with xcode-select --install, then run this script again.'
compiler=$(xcrun --find swiftc 2>/dev/null) || die 'Swift compiler not found. Install Apple command-line tools with xcode-select --install.'
sdk=$(xcrun --sdk macosx --show-sdk-path) || die 'macOS SDK not found in the selected Apple command-line tools.'
architecture=$(/usr/bin/uname -m)
case "$architecture" in
  arm64|x86_64) ;;
  *) die "Unsupported macOS architecture: $architecture." ;;
esac
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
[[ -r "${source_dir}/MemoryHost.swift" ]] || die 'MemoryHost.swift must be readable next to this installer.'
mkdir -p -- "$install_dir" "$hosts_dir"
install_dir=$(cd -- "$install_dir" && pwd -P)
hosts_dir=$(cd -- "$hosts_dir" && pwd -P)
binary="${install_dir}/tab-memory-host"
manifest="${hosts_dir}/${host_name}.json"
[[ ! -L "$binary" && ! -L "$manifest" ]] || die 'Refusing to replace symlinked host files.'
[[ ! -d "$binary" && ! -d "$manifest" ]] || die 'A destination host file is a directory.'

stage_dir=$(mktemp -d "${install_dir}/.tab-memory-install.XXXXXX")
"$compiler" -O -sdk "$sdk" -target "${architecture}-apple-macosx11.0" "${source_dir}/MemoryHost.swift" -o "${stage_dir}/tab-memory-host"
chmod 700 "${stage_dir}/tab-memory-host"

# Control characters were rejected above; escape JSON quotes and backslashes
# rather than treating an installation path as shell, template or JSON code.
json_string() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '"%s"' "$value"
}
manifest_tmp=$(mktemp "${hosts_dir}/.tab-memory-manifest.XXXXXX")
{
  printf '{\n  "name": "%s",\n' "$host_name"
  printf '  "description": "Local macOS memory pressure reader for The Great Suspender",\n'
  printf '  "path": '; json_string "$binary"; printf ',\n'
  printf '  "type": "stdio",\n  "allowed_origins": ["chrome-extension://%s/"]\n}\n' "$extension_id"
} > "$manifest_tmp"
# plutil reads property lists; -json parses a JSON fragment without executing it.
registration_plist="${stage_dir}/registration.plist"
/usr/bin/plutil -create xml1 "$registration_plist"
/usr/bin/plutil -insert host -json "$(< "$manifest_tmp")" "$registration_plist" || die 'Generated host registration is not valid JSON.'
chmod 600 "$manifest_tmp"
mv -f -- "${stage_dir}/tab-memory-host" "$binary"
mv -f -- "$manifest_tmp" "$manifest"
manifest_tmp=''
printf 'Installed %s\nExecutable: %s\nRegistration: %s\nAllowed extension: %s\n' "$host_name" "$binary" "$manifest" "$extension_id"
printf '%s\n' 'Return to this extension in the selected Brave profile and choose Check pressure.'
printf '%s\n' 'Automatic polling remains off until enabled in the extension. No background service was installed.'
