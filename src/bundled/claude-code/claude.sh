# Buzz's own copy of Claude, apart from any `claude` the user installed.
# The plugin runs it as `bash -c` (see `withScript` in setup.ts), each time
# with one of these steps:
#
#   run [ARGS...]                    runs the copy in use with ARGS
#   install VERSION PLATFORM SHA256  downloads a release, unless it is already
#                                    downloaded, and checks it
#   use VERSION                      makes a downloaded release the one in use
#   review-token                     saves security reviews' sign-in from stdin
#   review                           prints their folder, then that sign-in
set -eu

# Shared by every Buzz build on this computer, so there is one download.
# Security reviews keep their own Claude folder beside it (macOS only), which
# Buzz Security hides from contained agents.
review=""
if [ "$(uname)" = Darwin ]; then
  dir="$HOME/Library/Application Support/Buzz/claude-code"
  review="$HOME/Library/Application Support/Buzz/claude-code-review-home"
else
  dir="${XDG_DATA_HOME:-$HOME/.local/share}/buzz/claude-code"
fi

# Refuses a review folder that is a link or not a folder.
review_folder() {
  if [ -h "$review" ] || { [ -e "$review" ] && [ ! -d "$review" ]; }; then
    echo "The Claude review folder is not a folder" >&2
    exit 1
  fi
}

# Versions name folders, so only digits and dots: no `..` or `/` escapes.
valid() {
  case "$1" in "" | [!0-9]* | *[!0-9.]*) return 1 ;; esac
}

# Whether release $1 is newer than release $2.
newer() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    split(a, x, "."); split(b, y, ".")
    for (i = 1; i <= 3; i++) if (x[i] + 0 != y[i] + 0) exit !(x[i] + 0 > y[i] + 0)
    exit 1
  }'
}

command="$1"
shift
case "$command" in
run)
  # A failed exec returns (execfail, without errexit), so the launcher can
  # look again when a release it read was pruned before it started.
  set +e
  shopt -s execfail
  while :; do
    # The plugin names a release to test it before it is in use.
    version="${BUZZ_CLAUDE_VERSION:-$(cat "$dir/current" 2>/dev/null)}"
    # 127, as for a missing program: the plugin reads it as "not installed".
    valid "$version" || { echo "Claude is not installed" >&2; exit 127; }
    exec "$dir/$version/claude" "$@"
    # Builds that switched after the read above may have pruned its release;
    # then start the one `current` names now.
    [ -z "${BUZZ_CLAUDE_VERSION:-}" ] &&
      [ "$(cat "$dir/current" 2>/dev/null)" != "$version" ] || exit 127
  done
  ;;
install)
  version="$1" platform="$2" checksum="$3"
  valid "$version" || { echo "Invalid version" >&2; exit 2; }
  case "$platform" in
  darwin-arm64 | darwin-x64 | linux-arm64 | linux-x64) ;;
  *) echo "Unsupported platform" >&2; exit 2 ;;
  esac
  # 64 hex digits, so a hash that failed and printed nothing can never match it.
  case "$checksum" in *[!0-9a-f]*) echo "Invalid checksum" >&2; exit 2 ;; esac
  [ "${#checksum}" = 64 ] || { echo "Invalid checksum" >&2; exit 2; }
  sha256() { (shasum -a 256 "$1" 2>/dev/null || sha256sum "$1") | cut -d" " -f1; }
  # A download whose switch never ran, such as one stopped before `use`, is
  # used again once its bytes match the checksum; anything else is replaced.
  binary="$dir/$version/claude"
  if [ -f "$binary" ] && [ ! -h "$binary" ] && [ "$(sha256 "$binary")" = "$checksum" ] &&
    { [ -x "$binary" ] || chmod +x "$binary" 2>/dev/null; }; then
    echo "Claude $version is already downloaded."
    exit 0
  fi
  mkdir -p "$dir/$version"
  # Each download has its own temporary file, so two Buzz builds updating at
  # once do not write over each other, and a stopped one leaves nothing.
  part="$dir/$version/claude.$$"
  trap 'rm -f "$part"' EXIT
  trap 'exit 143' INT TERM
  # Give up on a stalled download rather than holding the update forever.
  curl -fsSL --speed-limit 1024 --speed-time 60 -o "$part" \
    "https://downloads.claude.ai/claude-code-releases/$version/$platform/claude"
  # The release manifest's checksum, which the plugin passes in.
  [ "$(sha256 "$part")" = "$checksum" ] || { echo "The download did not match its checksum" >&2; exit 1; }
  chmod +x "$part"
  # A rename, so a session starting now sees the old file or the whole new one.
  mv -f "$part" "$binary"
  ;;
use)
  version="$1"
  valid "$version" || { echo "Invalid version" >&2; exit 2; }
  # One switch at a time across Buzz builds, so none prunes the release
  # another just switched to. The kernel holds the lock for this process and
  # releases it when the process ends, however it ends.
  exec 9>>"$dir/.lock"
  if command -v flock >/dev/null; then
    flock 9
  else # macOS has no flock(1)
    perl -MFcntl=:flock -e 'open(my $lock, ">&=9") or die "$!\n";
      flock($lock, LOCK_EX) or die "$!\n"'
  fi
  # Checked under the lock: another build may have pruned it meanwhile.
  test -x "$dir/$version/claude" ||
    { echo "Claude Code $version is no longer downloaded" >&2; exit 1; }
  previous=$(cat "$dir/current" 2>/dev/null || true)
  printf %s "$version" >"$dir/current.$$"
  mv -f "$dir/current.$$" "$dir/current"
  # Keep the new release, the one before it to fall back to, any newer one,
  # which another build may be testing, and the release protected agents run
  # (`PROTECTED_CLAUDE_VERSION`); remove the rest.
  for folder in "$dir"/*/; do
    folder=$(basename "$folder")
    [ "$folder" = "$version" ] || [ "$folder" = "$previous" ] || [ "$folder" = "2.1.305" ] ||
      newer "$folder" "$version" || rm -rf "${dir:?}/$folder"
  done
  ;;
review-token)
  # The token `claude setup-token` printed, read from stdin so it is never an
  # argument, and never printed: only these fixed lines are.
  [ -n "$review" ] || { echo "Claude security reviews need macOS" >&2; exit 2; }
  token=""
  IFS= read -r token || true
  # Loosely, as its exact form is Claude's: one `sk-ant-` word.
  LC_ALL=C
  case "$token" in
  sk-ant-?*) ;;
  *) token="" ;;
  esac
  case "$token" in "" | *[!A-Za-z0-9_-]*)
    echo "That is not a Claude token. Paste what claude setup-token printed." >&2
    exit 1
    ;;
  esac
  review_folder
  mkdir -p "${review%/*}"
  [ -d "$review" ] || mkdir -m 700 "$review"
  review_folder
  chmod 700 "$review"
  umask 077
  # A new file only, then a rename over the old one, so no link is followed.
  part="$review/token.$$"
  trap 'rm -f "$part"' EXIT
  (set -C && printf '%s\n' "$token" >"$part")
  mv -f -h "$part" "$review/token"
  echo "Saved the sign-in for Claude security reviews."
  ;;
review)
  # Nothing until a review folder exists; its folder alone until it holds a
  # sign-in.
  [ -n "$review" ] || { echo "Claude security reviews need macOS" >&2; exit 2; }
  review_folder
  [ -d "$review" ] || exit 0
  printf '%s\n' "$review"
  if [ -f "$review/token" ] && [ ! -h "$review/token" ]; then
    cat "$review/token"
  fi
  ;;
*)
  echo "Unknown command: $command" >&2
  exit 2
  ;;
esac
