#!/usr/bin/env node
/**
 * Build the macOS desktop launcher (`Job Tracker.app`).
 *
 * The bundle starts the web/worker server silently in the background, waits
 * for `/api/health`, then opens the tracker in a dedicated Chrome App Mode
 * window whose lifecycle owns the server (quitting Chrome stops the server).
 * macOS-only: PNG scaling needs `sips`, signing needs `codesign`; the
 * `.icns` container is written directly. All child processes use argv
 * arrays, never shell strings.
 *
 * Usage: `node scripts/create-desktop-app.mjs [--dry-run] [--out DIR]
 *   [--server-cmd=auto|start|dev] [--host 127.0.0.1|localhost] [--port N]
 *   [--icon-src PATH]`
 */
import { execFile } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const execFileAsync = promisify(execFile);

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const APP_NAME = "Job Tracker";
export const BUNDLE_FILE = `${APP_NAME}.app`;
export const BUNDLE_ID = "local.jobtracker.launcher";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3000;
export const DEFAULT_OUT_DIR = join(REPO_ROOT, "dist", "desktop");
export const DEFAULT_ICON_SRC = join("assets", "desktop-icon-1024.png");
export const ICON_SIZE = 1024;

const USAGE = `usage: create-desktop-app.mjs [--dry-run] [--out DIR] [--server-cmd=auto|start|dev] [--host HOST] [--port PORT] [--icon-src PATH]`;

export function parsePort(value, fallback = DEFAULT_PORT) {
  if (value === undefined || String(value).trim() === "") return fallback;
  const text = String(value).trim();
  if (!/^[0-9]+$/.test(text)) {
    throw new Error(`--port must be an integer, got ${JSON.stringify(value)}`);
  }
  const port = Number(text);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--port must be between 1 and 65535, got ${port}`);
  }
  return port;
}

export function parseHost(value) {
  const host = (value ?? DEFAULT_HOST).trim().toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(
      `--host must stay loopback-only (127.0.0.1 or localhost), got ${JSON.stringify(value)}`,
    );
  }
  return host;
}

export function parseServerCmd(value) {
  const cmd = (value ?? "auto").trim();
  if (cmd !== "auto" && cmd !== "start" && cmd !== "dev") {
    throw new Error(
      `--server-cmd must be auto, start, or dev, got ${JSON.stringify(value)}`,
    );
  }
  return cmd;
}

export function parseArgs(argv) {
  const opts = {
    dryRun: false,
    help: false,
    out: DEFAULT_OUT_DIR,
    serverCmd: "auto",
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    iconSrc: DEFAULT_ICON_SRC,
  };
  const takeValue = (flag, current, next) => {
    const eq = current.indexOf("=");
    if (eq !== -1) return current.slice(eq + 1);
    if (next === undefined) throw new Error(`${flag} requires a value\n${USAGE}`);
    return { value: next, consumed: true };
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--out" || arg.startsWith("--out=")) {
      const got = takeValue("--out", arg, argv[i + 1]);
      if (typeof got === "object") {
        opts.out = got.value;
        i += 1;
      } else opts.out = got;
    } else if (arg === "--server-cmd" || arg.startsWith("--server-cmd=")) {
      const got = takeValue("--server-cmd", arg, argv[i + 1]);
      if (typeof got === "object") {
        opts.serverCmd = got.value;
        i += 1;
      } else opts.serverCmd = got;
    } else if (arg === "--host" || arg.startsWith("--host=")) {
      const got = takeValue("--host", arg, argv[i + 1]);
      if (typeof got === "object") {
        opts.host = got.value;
        i += 1;
      } else opts.host = got;
    } else if (arg === "--port" || arg.startsWith("--port=")) {
      const got = takeValue("--port", arg, argv[i + 1]);
      if (typeof got === "object") {
        opts.port = got.value;
        i += 1;
      } else opts.port = got;
    } else if (arg === "--icon-src" || arg.startsWith("--icon-src=")) {
      const got = takeValue("--icon-src", arg, argv[i + 1]);
      if (typeof got === "object") {
        opts.iconSrc = got.value;
        i += 1;
      } else opts.iconSrc = got;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}\n${USAGE}`);
    }
  }
  return {
    dryRun: opts.dryRun,
    help: opts.help,
    out: opts.out,
    serverCmd: parseServerCmd(opts.serverCmd),
    host: parseHost(opts.host),
    port: parsePort(opts.port),
    iconSrc: opts.iconSrc,
  };
}

/** Quote a string for single-quoted bash embedding. */
export function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/* Deterministic icon source: a white briefcase badge on a blue squircle,
 * rendered in pure Node so generation needs no extra dependencies. */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
  crc.copy(chunk, 8 + data.length);
  return chunk;
}

export function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(6, 9);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1,
    );
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

const lerp = (a, b, t) => Math.round(a + (b - a) * t);

export function renderIconSource(size = ICON_SIZE) {
  const buf = new Uint8ClampedArray(size * size * 4);
  const set = (x, y, r, g, b, a) => {
    const i = (y * size + x) * 4;
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = a;
  };
  // Squircle-style background: vertical blue gradient, transparent outside.
  const m = Math.round(size * 0.058);
  const rad = Math.round(size * 0.228);
  const top = [58, 141, 255];
  const bottom = [0, 84, 178];
  for (let y = 0; y < size; y += 1) {
    const t = y / (size - 1);
    const r = lerp(top[0], bottom[0], t);
    const g = lerp(top[1], bottom[1], t);
    const b = lerp(top[2], bottom[2], t);
    for (let x = 0; x < size; x += 1) {
      if (inRoundedRect(x, y, m, m, size - m, size - m, rad)) set(x, y, r, g, b, 255);
    }
  }
  // Briefcase body: white, gently shaded toward the bottom.
  const bx0 = Math.round(size * 0.24);
  const bx1 = Math.round(size * 0.76);
  const by0 = Math.round(size * 0.4);
  const by1 = Math.round(size * 0.74);
  const br = Math.round(size * 0.035);
  for (let y = by0; y < by1; y += 1) {
    const t = (y - by0) / (by1 - by0);
    const shade = lerp(255, 226, t);
    for (let x = bx0; x < bx1; x += 1) {
      if (inRoundedRect(x, y, bx0, by0, bx1, by1, br)) {
        set(x, y, shade, lerp(255, 236, t), 255, 255);
      }
    }
  }
  // Handle: white arch above the body (posts + top bar).
  const postW = Math.round(size * 0.032);
  const hx0 = Math.round(size * 0.4);
  const hx1 = Math.round(size * 0.6);
  const hy0 = Math.round(size * 0.3);
  const hy1 = by0 + Math.round(size * 0.01);
  for (let y = hy0; y < hy1; y += 1) {
    for (let x = hx0; x < hx1; x += 1) {
      const onBar = y < hy0 + postW;
      const onPost = x < hx0 + postW || x >= hx1 - postW;
      if (onBar || onPost) set(x, y, 255, 255, 255, 255);
    }
  }
  // Center band across the body + amber clasp.
  const bandY0 = Math.round(size * 0.545);
  const bandY1 = Math.round(size * 0.585);
  for (let y = bandY0; y < bandY1; y += 1) {
    for (let x = bx0; x < bx1; x += 1) {
      if (inRoundedRect(x, y, bx0, by0, bx1, by1, br)) set(x, y, 24, 58, 120, 255);
    }
  }
  const cx0 = Math.round(size * 0.465);
  const cx1 = Math.round(size * 0.535);
  const cy0 = Math.round(size * 0.525);
  const cy1 = Math.round(size * 0.605);
  const cr = Math.round(size * 0.012);
  for (let y = cy0; y < cy1; y += 1) {
    for (let x = cx0; x < cx1; x += 1) {
      if (inRoundedRect(x, y, cx0, cy0, cx1, cy1, cr)) set(x, y, 245, 158, 11, 255);
    }
  }
  return encodePng(size, size, buf);
}

export function resolveIconSource(iconSrc) {
  const abs = isAbsolute(iconSrc) ? iconSrc : join(REPO_ROOT, iconSrc);
  if (!existsSync(abs)) {
    if (resolve(abs) !== resolve(REPO_ROOT, DEFAULT_ICON_SRC)) {
      throw new Error(`--icon-src not found: ${iconSrc}`);
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, renderIconSource());
    process.stdout.write(`generated deterministic icon source: ${abs}\n`);
  }
  return abs;
}

// .icns element types holding PNG payloads (matches Apple's own icon files).
const ICNS_ELEMENTS = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
];

export function readPngSize(png) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (png.length < 33 || !png.subarray(0, 8).equals(signature)) {
    throw new Error("not a PNG image");
  }
  if (png.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("PNG missing IHDR");
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

export function encodeIcns(elements) {
  const parts = [];
  let total = 8;
  for (const [type, data] of elements) {
    if (!/^[ -~]{4}$/.test(type)) throw new Error(`bad icns type ${JSON.stringify(type)}`);
    const header = Buffer.alloc(8);
    header.write(type, 0, "ascii");
    header.writeUInt32BE(8 + data.length, 4);
    parts.push(header, data);
    total += 8 + data.length;
  }
  const fileHeader = Buffer.alloc(8);
  fileHeader.write("icns", 0, "ascii");
  fileHeader.writeUInt32BE(total, 4);
  return Buffer.concat([fileHeader, ...parts]);
}

export async function buildIcns(iconSrcAbs) {
  const workDir = mkdtempSync(join(tmpdir(), "job-tracker-icon-"));
  try {
    const elements = [];
    for (const [type, pixels] of ICNS_ELEMENTS) {
      const pngPath = join(workDir, `${type}-${pixels}.png`);
      await execFileAsync("/usr/bin/sips", [
        "-z",
        String(pixels),
        String(pixels),
        iconSrcAbs,
        "--out",
        pngPath,
      ]);
      const data = readFileSync(pngPath);
      const size = readPngSize(data);
      if (size.width !== pixels || size.height !== pixels) {
        throw new Error(
          `sips produced ${size.width}x${size.height} for ${type}, want ${pixels}x${pixels}`,
        );
      }
      elements.push([type, data]);
    }
    return encodeIcns(elements);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildInfoPlist({ version }) {
  const v = escapeXml(version);
  const name = escapeXml(APP_NAME);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${name}</string>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>${escapeXml(BUNDLE_ID)}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${name}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${v}</string>
  <key>CFBundleVersion</key>
  <string>${v}</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

export function buildLauncher({
  nodeBin,
  nodeMajor,
  projectDir,
  host,
  port,
  serverCmd,
}) {
  return `#!/bin/bash
# Generated by scripts/create-desktop-app.mjs - do not edit by hand.
# Regenerate with: npm run desktop:app
set -u -o pipefail

APP_NAME=${shq(APP_NAME)}
NODE_BIN=${shq(nodeBin)}
NODE_MAJOR=${shq(nodeMajor)}
PROJECT_DIR=${shq(projectDir)}
APP_HOST=${shq(host)}
APP_PORT=${shq(String(port))}
SERVER_CMD=${shq(serverCmd)}
SUPPORT_DIR="$HOME/Library/Application Support/Job Tracker"
PROFILE_DIR="$SUPPORT_DIR/ChromeProfile"
LOG_DIR="$HOME/Library/Logs/Job Tracker"
SERVER_LOG="$LOG_DIR/server.log"
CHROME_LOG="$LOG_DIR/chrome.log"
LOCK_FILE="$SUPPORT_DIR/.launcher.pid"
DEV_NOTICE_FILE="$SUPPORT_DIR/.dev-fallback-noticed"
BASE_URL="http://$APP_HOST:$APP_PORT"
HEALTH_URL="$BASE_URL/api/health"
TIMEOUT_S="\${JOB_TRACKER_LAUNCHER_TIMEOUT_S:-60}"

log() {
  printf '%s %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$SERVER_LOG"
}

no_dialog() {
  [[ -n "\${JOB_TRACKER_LAUNCHER_NO_DIALOG:-}" ]]
}

show_dialog() {
  if no_dialog; then
    log "dialog suppressed: [$2] $1"
    return 0
  fi
  /usr/bin/osascript -e 'on run argv' -e 'display dialog (item 1 of argv) with title (item 2 of argv) buttons {"OK"} default button "OK" with icon caution' -e 'end run' "$1" "$2" >/dev/null 2>&1 || true
}

find_chrome() {
  local candidate
  for candidate in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    if [[ -x "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

health_status() {
  local body
  body="$(/usr/bin/curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null)" || return 1
  [[ "$body" == *'"status"'* ]] || return 1
  [[ "$body" == *'"dataRoot"'* ]] || return 1
  local status
  status="$(printf '%s' "$body" | /usr/bin/sed -n -E 's/.*"status"[[:space:]]*:[[:space:]]*"([^"]+)".*/\\1/p' | /usr/bin/head -n 1)"
  if [[ -z "$status" ]]; then
    status="unknown"
  fi
  printf '%s' "$status"
  return 0
}

OWNED="false"
SERVER_PID_STARTED=""
CHROME_PID=""

cleanup() {
  if [[ -n "$CHROME_PID" ]] && /bin/kill -0 "$CHROME_PID" 2>/dev/null; then
    /bin/kill -TERM "$CHROME_PID" 2>/dev/null || true
  fi
  if [[ "$OWNED" == "true" && -n "$SERVER_PID_STARTED" ]]; then
    /bin/kill -TERM "$SERVER_PID_STARTED" 2>/dev/null || true
    wait "$SERVER_PID_STARTED" 2>/dev/null || true
    OWNED="false"
  fi
  if [[ -f "$LOCK_FILE" ]]; then
    local owner
    owner="$(/bin/cat "$LOCK_FILE" 2>/dev/null || true)"
    if [[ "$owner" == "$$" ]]; then
      /bin/rm -f "$LOCK_FILE"
    fi
  fi
}

on_signal() {
  cleanup
  exit 143
}

trap cleanup EXIT
trap on_signal TERM INT HUP
main() {
  /bin/mkdir -p "$SUPPORT_DIR" "$PROFILE_DIR" "$LOG_DIR"

  if [[ ! "$TIMEOUT_S" =~ ^[0-9]+$ ]]; then
    TIMEOUT_S=60
  fi

  local node_version node_major
  if ! node_version="$("$NODE_BIN" --version 2>/dev/null)"; then
    show_dialog "Node.js was not found at the embedded path. Regenerate the app with: npm run desktop:app" "$APP_NAME"
    return 1
  fi
  node_major="$(printf '%s' "$node_version" | /usr/bin/sed -n -E 's/^v([0-9]+).*/\\1/p')"
  if [[ "$node_major" != "$NODE_MAJOR" ]]; then
    show_dialog "This launcher needs Node.js major version $NODE_MAJOR but found $node_version. Regenerate the app with: npm run desktop:app" "$APP_NAME"
    log "ERROR node major mismatch: need $NODE_MAJOR, found $node_version"
    return 1
  fi

  local chrome_bin
  if ! chrome_bin="$(find_chrome)"; then
    show_dialog "Google Chrome was not found in /Applications or ~/Applications. Install Chrome, then try again." "$APP_NAME"
    log "ERROR google chrome not found"
    return 1
  fi

  if [[ -f "$LOCK_FILE" ]]; then
    local owner_pid
    owner_pid="$(/bin/cat "$LOCK_FILE" 2>/dev/null || true)"
    if [[ "$owner_pid" =~ ^[0-9]+$ ]] && /bin/kill -0 "$owner_pid" 2>/dev/null; then
      log "launcher already running (pid $owner_pid); focusing Chrome and exiting"
      /usr/bin/osascript -e 'tell application "Google Chrome" to activate' >/dev/null 2>&1 || true
      return 0
    fi
    log "removing stale lock for pid \${owner_pid:-unknown}"
    /bin/rm -f "$LOCK_FILE"
  fi
  printf '%s' "$$" >"$LOCK_FILE"

  local probe_status cmd
  if probe_status="$(health_status)"; then
    log "server already running (health: $probe_status); reusing it"
  else
    cmd="$SERVER_CMD"
    if [[ "$cmd" == "auto" ]]; then
      if [[ -f "$PROJECT_DIR/.next/BUILD_ID" ]]; then
        cmd="start"
      else
        cmd="dev"
      fi
    fi
    if [[ "$cmd" == "dev" && ! -f "$DEV_NOTICE_FILE" ]]; then
      show_dialog "No production build found; starting in development mode. Run 'npm run build' once for faster launches." "$APP_NAME"
      date '+%Y-%m-%dT%H:%M:%S%z' >"$DEV_NOTICE_FILE"
    fi
    printf '\\n=== launcher session %s (cmd=%s host=%s port=%s) ===\\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$cmd" "$APP_HOST" "$APP_PORT" >>"$SERVER_LOG"
    log "starting server: node scripts/$cmd.mjs"
    HOST="$APP_HOST" PORT="$APP_PORT" "$NODE_BIN" "$PROJECT_DIR/scripts/$cmd.mjs" >>"$SERVER_LOG" 2>&1 &
    SERVER_PID_STARTED=$!
    OWNED="true"
    local deadline
    deadline=$((SECONDS + TIMEOUT_S))
    while true; do
      if probe_status="$(health_status)"; then
        log "server ready (health: $probe_status)"
        break
      fi
      if ! /bin/kill -0 "$SERVER_PID_STARTED" 2>/dev/null; then
        log "ERROR server process died during startup; see $SERVER_LOG"
        show_dialog "The Job Tracker server failed to start. Details in $SERVER_LOG." "$APP_NAME"
        return 1
      fi
      if (( SECONDS >= deadline )); then
        log "ERROR timed out after \${TIMEOUT_S}s waiting for $HEALTH_URL"
        show_dialog "The Job Tracker server did not become ready in time. Details in $SERVER_LOG." "$APP_NAME"
        return 1
      fi
      sleep 0.5
    done
  fi

  log "launching Chrome App window: $BASE_URL"
  "$chrome_bin" --app="$BASE_URL" --user-data-dir="$PROFILE_DIR" --no-first-run --no-default-browser-check >>"$CHROME_LOG" 2>&1 &
  CHROME_PID=$!
  wait "$CHROME_PID"
  local chrome_status=$?
  CHROME_PID=""
  log "Chrome exited (status $chrome_status)"

  if [[ "$OWNED" == "true" && -n "$SERVER_PID_STARTED" ]]; then
    if /bin/kill -0 "$SERVER_PID_STARTED" 2>/dev/null; then
      log "stopping owned server (pid $SERVER_PID_STARTED)"
    else
      log "owned server already exited"
    fi
    /bin/kill -TERM "$SERVER_PID_STARTED" 2>/dev/null || true
    wait "$SERVER_PID_STARTED" 2>/dev/null || true
    OWNED="false"
  fi
  return 0
}

main "$@"
exit $?
`;
}

function readPackageField(field) {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  return pkg[field];
}

function enginesMajor() {
  const engines = readPackageField("engines") ?? {};
  const match = /(\d+)/.exec(String(engines.node ?? ""));
  return match ? match[1] : null;
}

async function bestEffort(argv, label) {
  try {
    await execFileAsync(argv[0], argv.slice(1));
    return true;
  } catch (error) {
    process.stderr.write(
      `warning: ${label} failed (${error instanceof Error ? error.message : String(error)})\n`,
    );
    return false;
  }
}

export async function main(argv, env = process.env) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(
      `${USAGE}\n\nBuilds "Job Tracker.app" under --out (default dist/desktop) and,\nunless --dry-run, installs it to ~/Desktop.\n`,
    );
    return 0;
  }
  if (process.platform !== "darwin") {
    throw new Error("create-desktop-app.mjs is macOS-only (needs sips/codesign)");
  }
  const nodeBin = process.execPath;
  const nodeMajor = String(process.versions.node.split(".")[0]);
  const requiredMajor = enginesMajor();
  if (requiredMajor !== null && requiredMajor !== nodeMajor) {
    process.stderr.write(
      `warning: node v${process.versions.node} does not satisfy engines (major ${requiredMajor}); embedding it anyway because it runs this install (native addons bind to it). The launcher will require major ${nodeMajor}.\n`,
    );
  }

  const outDir = resolve(REPO_ROOT, opts.out);
  const iconSrcAbs = resolveIconSource(opts.iconSrc);
  const chromeCandidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    join(env.HOME || homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  ];
  if (!chromeCandidates.some((candidate) => existsSync(candidate))) {
    process.stderr.write(
      "warning: Google Chrome was not found; the launcher will show a dialog until Chrome is installed.\n",
    );
  }

  process.stdout.write("building AppIcon.icns...\n");
  const icns = await buildIcns(iconSrcAbs);

  const appDir = join(outDir, BUNDLE_FILE);
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(join(appDir, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(appDir, "Contents", "Resources"), { recursive: true });
  const version = readPackageField("version") || "0.0.0";
  writeFileSync(join(appDir, "Contents", "Info.plist"), buildInfoPlist({ version }));
  const launcherPath = join(appDir, "Contents", "MacOS", "launcher");
  writeFileSync(
    launcherPath,
    buildLauncher({
      nodeBin,
      nodeMajor,
      projectDir: REPO_ROOT,
      host: opts.host,
      port: opts.port,
      serverCmd: opts.serverCmd,
    }),
  );
  chmodSync(launcherPath, 0o755);
  writeFileSync(join(appDir, "Contents", "Resources", "AppIcon.icns"), icns);
  await bestEffort(["/usr/bin/codesign", "--force", "-s", "-", appDir], "ad-hoc codesign");
  try {
    const { stdout } = await execFileAsync("/usr/bin/xattr", [appDir]);
    if (stdout.split("\n").includes("com.apple.quarantine")) {
      await execFileAsync("/usr/bin/xattr", ["-d", "com.apple.quarantine", appDir]);
    }
  } catch (error) {
    process.stderr.write(
      `warning: quarantine clear failed (${error instanceof Error ? error.message : String(error)})\n`,
    );
  }
  await bestEffort(["/usr/bin/touch", appDir], "finder refresh");

  process.stdout.write(
    `built ${appDir} (node ${nodeBin} major ${nodeMajor}, ${opts.host}:${opts.port}, server-cmd=${opts.serverCmd})\n`,
  );
  if (opts.dryRun) {
    process.stdout.write("dry run: bundle left in place, not installed to ~/Desktop.\n");
    return 0;
  }
  const desktopApp = join(env.HOME || homedir(), "Desktop", BUNDLE_FILE);
  if (existsSync(desktopApp)) {
    const stat = statSync(desktopApp);
    if (!stat.isDirectory() && !stat.isSymbolicLink()) {
      throw new Error(`refusing to replace non-directory at ${desktopApp}`);
    }
    rmSync(desktopApp, { recursive: true, force: true });
  }
  mkdirSync(dirname(desktopApp), { recursive: true });
  cpSync(appDir, desktopApp, { recursive: true });
  await bestEffort(["/usr/bin/touch", desktopApp], "finder refresh");
  process.stdout.write(`installed ${desktopApp}\n`);
  process.stdout.write(
    "first run: double-click the app (right-click > Open if Gatekeeper prompts once).\n",
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
