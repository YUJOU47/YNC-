#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  TYN Bridge Manager · v1.0.1-beta  —  AUTO-BOOTSTRAP MODE                ║
# ║                                                                          ║
# ║  Saat dijalankan:                                                         ║
# ║   1. Auto-extract server.html (kalau belum ada)                          ║
# ║   2. Auto-generate API token (kalau belum ada valid)                     ║
# ║   3. Auto-start node bridge                                              ║
# ║   4. Set state → ON                                                      ║
# ║   5. Tampilkan: API Token · Console URL · Admin URL · WS URL             ║
# ║                                                                          ║
# ║  Manajemen lengkap via Web: http://127.0.0.1:7700/admin                  ║
# ║  Dev: YUJOU · TikTok: @bigboosme                                         ║
# ╚══════════════════════════════════════════════════════════════════════════╝
set -u

TYN_VERSION="1.0.1-beta"
TYN_DEV="YUJOU"
TYN_TIKTOK="@bigboosme"
TYN_TIKTOK_URL="https://tiktok.com/@bigboosme"

TYN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# FIX: Paksa shell untuk selalu berada di folder proyek (tempat tyn.sh berada)
cd "$TYN_DIR" || { echo "Gagal masuk ke direktori $TYN_DIR"; exit 1; }

APIS_FILE="$TYN_DIR/apis.json"
CONFIG_FILE="$TYN_DIR/config.json"
STATE_FILE="$TYN_DIR/server.state"
PID_FILE="$TYN_DIR/.server.pid"
LOG_FILE="$TYN_DIR/bridge.log"
BRIDGE_JS="$TYN_DIR/bridge.js"
SERVER_HTML="$TYN_DIR/server.html"
INDEX_HTML="$TYN_DIR/index.html"
BACKUP_DIR="$TYN_DIR/.backups"

mkdir -p "$BACKUP_DIR" 2>/dev/null || true

# ─── COLORS ───
R='\033[0m'; B='\033[1m'; D='\033[2m'; I='\033[3m'; U='\033[4m'
RED='\033[38;5;196m'; GRN='\033[38;5;46m'; YEL='\033[38;5;220m'
BLU='\033[38;5;39m'; MAG='\033[38;5;171m'; CYN='\033[38;5;51m'
WHT='\033[38;5;255m'; ORG='\033[38;5;208m'; PNK='\033[38;5;213m'
PRP='\033[38;5;135m'; TEAL='\033[38;5;44m'; GREY='\033[38;5;245m'
BG_PRP='\033[48;5;55m'; BG_CYN='\033[48;5;23m'; BG_GRN='\033[48;5;22m'
BG_RED='\033[48;5;52m'; BG_ORG='\033[48;5;94m'

# ─── HELPERS ───
pause() { echo ""; printf "${D}── press ENTER ──${R} "; read -r _ 2>/dev/null || true; echo ""; }
err()   { echo -e "${RED}${B} ✗ ${R}${RED}$*${R}"; }
ok()    { echo -e "${GRN}${B} ✓ ${R}${GRN}$*${R}"; }
info()  { echo -e "${CYN}${B} ℹ ${R}${CYN}$*${R}"; }
warn()  { echo -e "${YEL}${B} ⚠ ${R}${YEL}$*${R}"; }
note()  { echo -e "${GREY}${D}   $*${R}"; }
arrow() { echo -e "${PRP}${B} ▸ ${R}$*"; }
have_node() { command -v node >/dev/null 2>&1; }
line() { printf "${D}  %s${R}\n" "─────────────────────────────────────────────────────────────"; }

SPIN=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
spinner_run() {
  local text="${1:-loading}" dur="${2:-1}" i=0
  [ "$dur" -le 0 ] && return 0
  local end=$((SECONDS + dur))
  while [ $SECONDS -lt $end ]; do
    printf "\r${CYN}${B}  %s${R}  ${WHT}%s${R}  " "${SPIN[$i]}" "$text"
    i=$(( (i+1) % 10 ))
    sleep 0.08
  done
  printf "\r%-70s\r" " "
}
trim() {
  local s="${1:-}"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}
strip_ws() { printf '%s' "${1:-}" | tr -d '[:space:]'; }
now_ms() { echo $(($(date +%s) * 1000)); }

# ═══════════════════════════════════════════════════════════════════════════
# BANNER
# ═══════════════════════════════════════════════════════════════════════════
banner() {
  clear 2>/dev/null || printf '\033[2J\033[H'
  echo ""
  printf "${PRP}${B}"
  cat <<'ASCII'
   ████████╗██╗   ██╗███╗   ██╗
   ╚══██╔══╝╚██╗ ██╔╝████╗  ██║
      ██║    ╚████╔╝ ██╔██╗ ██║
      ██║     ╚██╔╝  ██║╚██╗██║
      ██║      ██║   ██║ ╚████║
      ╚═╝      ╚═╝   ╚═╝  ╚═══╝
ASCII
  printf "${R}"
  echo ""
  printf "${MAG}${B}        T E R M I N A L   Y   N E T W O R K${R}\n"
  printf "${D}              ${I}auto-bootstrap · v${TYN_VERSION}${R}\n"
  echo ""
  printf "${GREY}  ┌─────────────────────────────────────────────────────────┐${R}\n"
  printf "${GREY}  │${R}  ${CYN}${B}Version${R}  ${WHT}%-45s${R} ${GREY}│${R}\n" "v${TYN_VERSION}"
  printf "${GREY}  │${R}  ${CYN}${B}Dev${R}      ${WHT}%-45s${R} ${GREY}│${R}\n" "${TYN_DEV}"
  printf "${GREY}  │${R}  ${PNK}${B}TikTok${R}   ${PNK}${U}%-45s${R} ${GREY}│${R}\n" "${TYN_TIKTOK}"
  printf "${GREY}  └─────────────────────────────────────────────────────────┘${R}\n"
  echo ""
}

# ═══════════════════════════════════════════════════════════════════════════
# INIT FILES
# ═══════════════════════════════════════════════════════════════════════════
validate_json() {
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$1" 2>/dev/null
}

init_files() {
  if [ ! -f "$APIS_FILE" ]; then echo '{"apis":[]}' > "$APIS_FILE"
  elif ! validate_json "$APIS_FILE"; then
    warn "apis.json corrupted — recreating"
    cp "$APIS_FILE" "$BACKUP_DIR/apis.corrupt.$(date +%s).json" 2>/dev/null || true
    echo '{"apis":[]}' > "$APIS_FILE"
  fi

  if [ ! -f "$CONFIG_FILE" ]; then
    cat > "$CONFIG_FILE" <<JSON
{
  "shell": "bash",
  "termType": "xterm-256color",
  "cwd": "$TYN_DIR",
  "port": 7700,
  "host": "127.0.0.1",
  "webrunPortStart": 8080,
  "webrunPortEnd": 8200,
  "mode": "standard",
  "features": {"webrun":true,"flutter":true,"nano":true,"sessions":true},
  "advanced": {"keepAliveMs":3600000,"maxSessions":10,"bufferSize":100000,"progressFlushMs":500,"strip2004":true}
}
JSON
  elif ! validate_json "$CONFIG_FILE"; then
    warn "config.json corrupted — recreating"
    cp "$CONFIG_FILE" "$BACKUP_DIR/config.corrupt.$(date +%s).json" 2>/dev/null || true
    cat > "$CONFIG_FILE" <<JSON
{"shell":"bash","termType":"xterm-256color","cwd":"$TYN_DIR","port":7700,"host":"127.0.0.1","webrunPortStart":8080,"webrunPortEnd":8200,"mode":"standard","features":{"webrun":true,"flutter":true,"nano":true,"sessions":true},"advanced":{"keepAliveMs":3600000,"maxSessions":10,"bufferSize":100000,"progressFlushMs":500,"strip2004":true}}
JSON
  else
    # FIX: Pastikan cwd di config selalu mengarah ke folder proyek (bukan "~")
    local current_cwd
    current_cwd=$(json_get "$CONFIG_FILE" 'd.cwd')
    if [ "$current_cwd" = "~" ] || [ -z "$current_cwd" ]; then
      json_set "$CONFIG_FILE" "d.cwd=\"$TYN_DIR\""
    fi
  fi

  [ -f "$STATE_FILE" ] || echo "off" > "$STATE_FILE"
}

# ═══════════════════════════════════════════════════════════════════════════
# JSON HELPERS
# ═══════════════════════════════════════════════════════════════════════════
json_get() {
  node -e '
    try {
      const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
      process.stdout.write(String(eval(process.argv[2]) ?? ""));
    } catch(_) { process.stdout.write(""); }
  ' "$1" "$2" 2>/dev/null || true
}
json_set() {
  node -e '
    const fs=require("fs");const f=process.argv[1];
    const d=JSON.parse(fs.readFileSync(f,"utf8"));
    eval(process.argv[2]);
    fs.writeFileSync(f,JSON.stringify(d,null,2));
  ' "$1" "$2" 2>/dev/null || true
}

# ═══════════════════════════════════════════════════════════════════════════
# STATE
# ═══════════════════════════════════════════════════════════════════════════
get_state() { [ -f "$STATE_FILE" ] && tr -d '\n\r ' < "$STATE_FILE" || echo "off"; }
set_state() { echo "$1" > "$STATE_FILE"; }

is_node_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid; pid=$(tr -d '\n\r ' < "$PID_FILE")
  [ -z "$pid" ] && return 1
  if kill -0 "$pid" 2>/dev/null; then return 0; fi
  rm -f "$PID_FILE"; return 1
}

# ═══════════════════════════════════════════════════════════════════════════
# NODE PROCESS
# ═══════════════════════════════════════════════════════════════════════════
start_node_process() {
  is_node_running && { info "Node already running (PID $(cat "$PID_FILE"))"; return 0; }
  have_node || { err "Node.js not installed"; return 1; }
  [ -f "$BRIDGE_JS" ] || { err "bridge.js not found"; return 1; }
  arrow "Starting node bridge..."
  nohup node "$BRIDGE_JS" >> "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  sleep 2
  if kill -0 "$pid" 2>/dev/null; then ok "Node started (PID $pid)"; return 0
  else
    err "Node exited immediately"
    note "Last 5 log lines:"
    tail -5 "$LOG_FILE" 2>/dev/null | sed 's/^/    /'
    rm -f "$PID_FILE"; return 1
  fi
}

stop_node_process() {
  is_node_running || { info "Node not running"; rm -f "$PID_FILE"; return 0; }
  local pid; pid=$(cat "$PID_FILE")
  arrow "Stopping node (PID $pid)..."
  kill "$pid" 2>/dev/null || true
  spinner_run "Shutting down" 1
  kill -0 "$pid" 2>/dev/null && { warn "Force killing"; kill -9 "$pid" 2>/dev/null; }
  rm -f "$PID_FILE"
  ok "Node stopped"
}

# ═══════════════════════════════════════════════════════════════════════════
# API HELPERS
# ═══════════════════════════════════════════════════════════════════════════
gen_token() { node -e 'console.log("tyn_"+require("crypto").randomBytes(20).toString("hex"))'; }

save_api_safe() {
  local token; token=$(trim "${1:-}")
  local label="${2:-unknown}"
  local created="${3:-$(now_ms)}"
  local expires="${4:-0}"

  [ -z "$token" ] && { err "Empty token"; return 1; }

  [ -f "$APIS_FILE" ] && cp "$APIS_FILE" "$BACKUP_DIR/apis.$(date +%s).json" 2>/dev/null || true

  if ! node -e '
    const fs=require("fs");
    const f=process.argv[1];
    const [tok,label,now,exp]=process.argv.slice(2);
    try {
      const d=JSON.parse(fs.readFileSync(f,"utf8"));
      d.apis=d.apis||[];
      d.apis.push({token:tok.trim(),label:"Trial "+label,duration:label,createdAt:+now,expiresAt:+exp,revoked:false});
      fs.writeFileSync(f,JSON.stringify(d,null,2));
      process.exit(0);
    } catch(e) { console.error(e.message); process.exit(1); }
  ' "$APIS_FILE" "$token" "$label" "$created" "$expires"; then
    err "Write failed"; return 1
  fi

  validate_json "$APIS_FILE" || { err "File corrupted after write!"; return 1; }
  node -e '
    const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    process.exit((d.apis||[]).some(a=>a.token===process.argv[2])?0:1)
  ' "$APIS_FILE" "$token" 2>/dev/null || { err "Token not found after save!"; return 1; }
  return 0
}

get_active_token() {
  node -e '
    try {
      const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
      const now=Date.now();
      const v=(d.apis||[]).find(a=>!a.revoked&&(!a.expiresAt||a.expiresAt>now));
      process.stdout.write(v?v.token:"");
    } catch(_) { process.stdout.write(""); }
  ' "$APIS_FILE" 2>/dev/null || true
}

# ═══════════════════════════════════════════════════════════════════════════
# NEW: AUTO-BOOTSTRAP HELPERS
# ═══════════════════════════════════════════════════════════════════════════

# Extract server.html dari bridge.js (baris yang diawali //@)
ensure_server_html() {
  if [ -f "$SERVER_HTML" ] && [ -s "$SERVER_HTML" ]; then
    return 0
  fi
  if [ ! -f "$BRIDGE_JS" ]; then
    warn "bridge.js tidak ditemukan — server.html tidak bisa dibuat"
    return 1
  fi
  arrow "Mengekstrak server.html dari bridge.js..."
  if grep -q '^//@' "$BRIDGE_JS" 2>/dev/null; then
    grep '^//@' "$BRIDGE_JS" | sed 's|^//@||' > "$SERVER_HTML"
    if [ -s "$SERVER_HTML" ]; then
      local sz; sz=$(wc -c < "$SERVER_HTML" 2>/dev/null || echo 0)
      ok "server.html dibuat (${sz} bytes)"
      return 0
    fi
  fi
  warn "Gagal ekstrak server.html (bridge.js belum embed server.html)"
  return 1
}

# Pastikan ada API token valid, generate kalau tidak ada
ensure_api_token() {
  local active
  active=$(get_active_token)
  if [ -n "$active" ]; then
    echo "$active"
    return 0
  fi
  arrow "Belum ada token valid — auto-generate 1-day trial..."
  local token now expires
  token=$(gen_token | tr -d '\r\n ')
  now=$(now_ms)
  expires=$((now + 86400 * 1000))
  if ! save_api_safe "$token" "1 day" "$now" "$expires"; then
    err "Gagal generate token"
    return 1
  fi
  ok "Token baru dibuat"
  echo "$token"
}

# Pastikan node berjalan
ensure_node_running() {
  if is_node_running; then
    info "Node sudah berjalan (PID $(cat "$PID_FILE"))"
    return 0
  fi
  start_node_process
}

# Host untuk ditampilkan di URL (127.0.0.1 kalau bind 0.0.0.0)
get_display_host() {
  local host
  host=$(json_get "$CONFIG_FILE" 'd.host' 2>/dev/null || echo "127.0.0.1")
  case "$host" in
    0.0.0.0|::|"") echo "127.0.0.1" ;;
    *) echo "$host" ;;
  esac
}

# Tampilkan info lengkap: token, URL console, URL admin, WS
show_console_info() {
  local token="$1" port="$2" host="$3"
  local console_url="http://${host}:${port}/index.html"
  local admin_url="http://${host}:${port}/admin"
  local admin_static_url="http://${host}:${port}/server.html"
  local ws_url="ws://${host}:${port}/term?token=${token}&session=console"

  banner
  echo -e "${B}${WHT} ✓  TYN Bridge Auto-Started${R}"
  echo ""

  # ─── Main box (token + URL) ───
  printf "${GREY}  ╔═════════════════════════════════════════════════════════════════╗${R}\n"
  printf "${GREY}  ║${R}  ${GRN}${B}✓  SERVER IS RUNNING${R}${GREY}                                             ║${R}\n"
  printf "${GREY}  ╠═════════════════════════════════════════════════════════════════╣${R}\n"
  printf "${GREY}  ║${R}  ${CYN}API Token${R}    : ${YEL}${B}%-44s${R}${GREY}║${R}\n" "$token"
  printf "${GREY}  ║${R}  ${CYN}Console      ${R} : ${WHT}%-44s${R}${GREY}║${R}\n" "$console_url"
  printf "${GREY}  ║${R}  ${CYN}Admin Panel  ${R} : ${WHT}%-44s${R}${GREY}║${R}\n" "$admin_url"
  printf "${GREY}  ╠═════════════════════════════════════════════════════════════════╣${R}\n"
  printf "${GREY}  ║${R}  ${PNK}WS Console${R}   : ${D}%-44s${R}${GREY}║${R}\n" "(lihat di bawah — full URL)"
  printf "${GREY}  ╚═════════════════════════════════════════════════════════════════╝${R}\n"
  echo ""

  # ─── Full URLs (tidak terpotong) ───
  echo -e "  ${B}${WHT}FULL URLS${R}  ${D}(untuk copy-paste)${R}"
  line
  echo -e "  ${CYN}${B}Console (main app)${R}"
  echo -e "    ${WHT}${console_url}${R}"
  echo ""
  echo -e "  ${MAG}${B}Admin Panel (Console TYN)${R}"
  echo -e "    ${WHT}${admin_url}${R}"
  if [ -f "$SERVER_HTML" ]; then
    echo -e "    ${D}atau static:${R} ${WHT}${admin_static_url}${R}"
  fi
  echo ""
  echo -e "  ${PNK}${B}WS Console${R}  ${D}(terminal stream)${R}"
  echo -e "    ${WHT}${ws_url}${R}"
  echo ""
  echo -e "  ${D}Main app WS:${R}  ${WHT}ws://${host}:${port}/term?token=${token}${R}"
  line
  echo ""

  # ─── Quick hints ───
  echo -e "  ${GRN}${B}●${R} ${D}Semua manajemen (server, tokens, config, modes, files,${R}"
  echo -e "  ${GRN}${B}●${R} ${D}sessions, health, dll) sekarang via ${R}${MAG}${admin_url}${R}${D}${R}"
  echo ""

  # ─── Clipboard ───
  if command -v termux-clipboard-set >/dev/null 2>&1; then
    echo -n "$token" | termux-clipboard-set 2>/dev/null && ok "Token disalin ke clipboard"
  elif command -v xclip >/dev/null 2>&1; then
    echo -n "$token" | xclip -selection clipboard 2>/dev/null && ok "Token disalin ke clipboard"
  fi

  # ─── Auto-open browser (optional, Termux) ───
  if command -v termux-open-url >/dev/null 2>&1; then
    echo ""
    read -r -p "  ${YEL}▸ Buka Admin Panel sekarang? [y/N]: ${R}" open_now
    case "$open_now" in
      y|Y) termux-open-url "$admin_url" 2>/dev/null && ok "Opening..." ;;
    esac
  fi
}

# ═══════════════════════════════════════════════════════════════════════════
# FEATURE FUNCTIONS (dipertahankan — dipakai oleh admin panel web)
# Semua fitur ini masih ada di code, tapi UI-nya ada di /admin
# ═══════════════════════════════════════════════════════════════════════════

# ─── Generate API (single, auto 1-day) ───
generate_api() {
  have_node || return 1
  banner
  echo -e "${B}${WHT} 🎫  Generate Trial API${R}"
  echo ""
  note "Auto-generating 1 day trial token..."
  echo ""
  local token now expires
  token=$(gen_token | tr -d '\r\n ')
  now=$(now_ms)
  expires=$((now + 86400 * 1000))
  arrow "Saving to apis.json..."
  if ! save_api_safe "$token" "1 day" "$now" "$expires"; then
    err "Failed to save token!"
    pause; return 1
  fi
  echo ""
  printf "${GREY}  ┌─────────────────────────────────────────────────────────┐${R}\n"
  printf "${GREY}  │${R}  ${GRN}${B}✓  API GENERATED & SAVED${R}${GREY}                              │${R}\n"
  printf "${GREY}  ├─────────────────────────────────────────────────────────┤${R}\n"
  printf "${GREY}  │${R}  ${CYN}Token    ${R}: ${YEL}${B}%-41s${R}${GREY}│${R}\n" "$token"
  printf "${GREY}  │${R}  ${CYN}Duration ${R}: ${WHT}%-41s${R}${GREY}│${R}\n" "1 day"
  printf "${GREY}  └─────────────────────────────────────────────────────────┘${R}\n"
  echo ""
  pause
}

# ─── List APIs ───
list_apis() {
  have_node || return 1
  banner
  echo -e "${B}${WHT} 📋  API Tokens${R}"
  echo ""
  node -e '
    const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    const apis=d.apis||[];
    const now=Date.now();
    const G="\x1b[38;5;46m",Y="\x1b[38;5;220m",Re="\x1b[38;5;196m",D="\x1b[2m",R="\x1b[0m",C="\x1b[38;5;51m",W="\x1b[38;5;255m",B="\x1b[1m",P="\x1b[38;5;213m";
    if(!apis.length){ console.log(`  ${D}(no tokens yet)${R}`); process.exit(0); }
    const active = apis.find(a => !a.revoked && (!a.expiresAt || a.expiresAt > now));
    apis.forEach((a,i)=>{
      let s,col;
      if(a.revoked){s="revoked";col=Re;}
      else if(a.expiresAt && now>a.expiresAt){s="expired";col=Y;}
      else{s="active";col=G;}
      const isActive = a === active;
      const marker = isActive ? `${P}${B}★${R}` : " ";
      console.log(`  ${marker} ${C}${B}[${i+1}]${R} ${(a.token||"").slice(0,33)} ${col}${s}${R}`);
    });
  ' "$APIS_FILE"
  echo ""
  pause
}

# ─── Revoke ───
revoke_api() {
  have_node || return 1
  banner
  echo -e "${B}${WHT} 🚫  Revoke API${R}"
  echo ""
  read -r -p "  ${YEL}▸ Revoke # (0=cancel): ${R}" idx
  [ "${idx:-0}" = "0" ] && { info "Cancelled"; pause; return 0; }
  cp "$APIS_FILE" "$BACKUP_DIR/apis.revoke.$(date +%s).json" 2>/dev/null || true
  node -e '
    const fs=require("fs");const f=process.argv[1];const i=+process.argv[2];
    const d=JSON.parse(fs.readFileSync(f,"utf8"));
    if(i>=1&&i<=(d.apis||[]).length){d.apis[i-1].revoked=true;fs.writeFileSync(f,JSON.stringify(d,null,2));}
  ' "$APIS_FILE" "$idx"
  ok "Revoked"; pause
}

# ─── Delete ───
delete_api() {
  have_node || return 1
  banner
  echo -e "${B}${WHT} 🗑  Delete API${R}"
  echo ""
  read -r -p "  ${YEL}▸ Delete # (0=cancel): ${R}" idx
  [ "${idx:-0}" = "0" ] && { info "Cancelled"; pause; return 0; }
  cp "$APIS_FILE" "$BACKUP_DIR/apis.delete.$(date +%s).json" 2>/dev/null || true
  node -e '
    const fs=require("fs");const f=process.argv[1];const i=+process.argv[2];
    const d=JSON.parse(fs.readFileSync(f,"utf8"));
    if(i>=1&&i<=(d.apis||[]).length){d.apis.splice(i-1,1);fs.writeFileSync(f,JSON.stringify(d,null,2));}
  ' "$APIS_FILE" "$idx"
  ok "Deleted"; pause
}

# ─── Cleanup ───
cleanup_tokens() {
  have_node || return 1
  banner
  echo -e "${B}${WHT} 🧹  Cleanup Invalid Tokens${R}"
  echo ""
  cp "$APIS_FILE" "$BACKUP_DIR/apis.cleanup.$(date +%s).json" 2>/dev/null || true
  node -e '
    const fs=require("fs");const f=process.argv[1];
    const d=JSON.parse(fs.readFileSync(f,"utf8"));
    const now=Date.now();
    const before=(d.apis||[]).length;
    d.apis=(d.apis||[]).filter(a=>!a.revoked&&(!a.expiresAt||a.expiresAt>now));
    fs.writeFileSync(f,JSON.stringify(d,null,2));
    process.stdout.write(String(before-d.apis.length));
  ' "$APIS_FILE"
  ok "Cleanup done"; pause
}

# ─── Show token ───
show_token() {
  have_node || return 1
  banner
  echo -e "${B}${WHT} 🔑  Active Token${R}"
  echo ""
  local token; token=$(get_active_token)
  if [ -z "$token" ]; then warn "No valid token"; pause; return; fi
  printf "${GREY}  ┌─────────────────────────────────────────────────────────┐${R}\n"
  printf "${GREY}  │${R}  ${PNK}${B}★ DEFAULT TOKEN${R}${GREY}                                        │${R}\n"
  printf "${GREY}  ├─────────────────────────────────────────────────────────┤${R}\n"
  printf "${GREY}  │${R}  ${YEL}${B}%-55s${R} ${GREY}│${R}\n" "$token"
  printf "${GREY}  └─────────────────────────────────────────────────────────┘${R}\n"
  echo ""
  if command -v termux-clipboard-set >/dev/null 2>&1; then
    echo -n "$token" | termux-clipboard-set 2>/dev/null && ok "Copied to clipboard"
  fi
  pause
}

# ─── Server Control (masih bisa dipanggil) ───
server_on() {
  have_node || return 1
  banner
  echo -e "${B}${WHT} ▶  Enable Server${R}"
  echo ""
  local active; active=$(ensure_api_token)
  [ -z "$active" ] && { err "No token"; pause; return 1; }
  ensure_node_running || { pause; return 1; }
  set_state "on"
  ok "Server ON"
  pause
}

server_off() { set_state "off"; echo ""; ok "Server → OFF"; echo ""; note "Node still running"; pause; }
server_restart() { arrow "Restarting node..."; is_node_running && stop_node_process; start_node_process && ok "Restarted" || err "Restart failed"; pause; }
server_kill() {
  banner
  echo -e "${RED}${B} ⛔  Full Shutdown${R}"
  echo ""
  read -r -p "  ${RED}▸ Confirm [y/N]: ${R}" c
  case "$c" in y|Y) ;; *) info "Cancelled"; pause; return 0 ;; esac
  stop_node_process; set_state "killed"; ok "Killed"; pause
}

server_status() {
  banner
  echo -e "${B}${WHT} 📊  Server Status${R}"
  echo ""
  local st; st=$(get_state)
  printf "${GREY}  ┌─────────────────────────────────────────────────────────┐${R}\n"
  if is_node_running; then
    printf "${GREY}  │${R}  ${GRN}● RUNNING${R} (PID $(cat "$PID_FILE"))${GREY}                                       │${R}\n"
  else
    printf "${GREY}  │${R}  ${RED}○ STOPPED${R}${GREY}                                               │${R}\n"
  fi
  printf "${GREY}  │${R}  State: ${WHT}%-49s${R}${GREY}│${R}\n" "$st"
  printf "${GREY}  └─────────────────────────────────────────────────────────┘${R}\n"
  pause
}

# ─── Config / Modes / Files / Sessions / Health ───
# (fungsi lengkap dipertahankan untuk kompatibilitas)
config_menu() {
  banner
  echo -e "${B}${WHT} ⚙   Configuration${R}"
  echo ""
  note "Menu lengkap tersedia via Admin Panel: /admin"
  echo ""
  node -e '
    const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    const C="\x1b[38;5;51m",W="\x1b[38;5;255m",R="\x1b[0m",G="\x1b[38;5;245m";
    ["shell","termType","cwd","port","host","webrunPortStart","webrunPortEnd","mode"].forEach(k=>{
      if (d[k] !== undefined) console.log(`  ${G}│${R}  ${C}${k.padEnd(16)}${R}: ${W}${String(d[k]).padEnd(43)}${R} ${G}│${R}`);
    });
  ' "$CONFIG_FILE"
  pause
}

modes_menu() {
  banner
  echo -e "${B}${WHT} 🎨  Bridge Modes${R}"
  echo ""
  note "Menu lengkap tersedia via Admin Panel: /admin"
  pause
}

file_manager_menu() { banner; echo -e "${B}${WHT} 📁  File Manager${R}"; echo ""; note "Gunakan Admin Panel: /admin"; pause; }
session_manager()   { banner; echo -e "${B}${WHT} 🖥  Session Manager${R}"; echo ""; note "Gunakan Admin Panel: /admin"; pause; }

health_check() {
  banner
  echo -e "${B}${WHT} 💚  Health Check${R}"
  echo ""
  local port token passed=0 total=0
  port=$(json_get "$CONFIG_FILE" 'd.port'); port="${port:-7700}"
  token=$(get_active_token)
  total=$((total+1)); [ -f "$BRIDGE_JS" ] && { passed=$((passed+1)); printf "  ${GRN}✓${R} bridge.js present\n"; } || printf "  ${RED}✗${R} bridge.js MISSING\n"
  total=$((total+1)); is_node_running && { passed=$((passed+1)); printf "  ${GRN}✓${R} node running\n"; } || printf "  ${YEL}○${R} node not running\n"
  total=$((total+1)); [ -n "$token" ] && { passed=$((passed+1)); printf "  ${GRN}✓${R} API token valid\n"; } || printf "  ${RED}✗${R} no valid API\n"
  total=$((total+1)); [ -f "$SERVER_HTML" ] && { passed=$((passed+1)); printf "  ${GRN}✓${R} server.html present\n"; } || printf "  ${YEL}○${R} server.html missing (akan dibuat otomatis)\n"
  total=$((total+1)); [ -f "$INDEX_HTML" ] && { passed=$((passed+1)); printf "  ${GRN}✓${R} index.html present\n"; } || printf "  ${YEL}○${R} index.html missing\n"
  echo ""
  [ "$passed" -eq "$total" ] && ok "All checks passed ($passed/$total)" || warn "Partial: $passed/$total"
  pause
}

quick_actions() {
  banner
  echo -e "${B}${WHT} ⚡  Quick Actions${R}"
  echo ""
  note "Buka Admin Panel: /admin"
  note "TikTok dev: $TYN_TIKTOK_URL"
  pause
}

advanced_menu() {
  banner
  echo -e "${B}${WHT} 🔧  Advanced Functions${R}"
  echo ""
  note "Menu lengkap tersedia via Admin Panel: /admin"
  pause
}

dev_menu() {
  banner
  echo -e "${B}${WHT} 👨‍💻  Developer Menu${R}"
  echo ""
  note "Menu lengkap tersedia via Admin Panel: /admin"
  pause
}

# ═══════════════════════════════════════════════════════════════════════════
# MAIN FLOW — AUTO BOOTSTRAP
# ═══════════════════════════════════════════════════════════════════════════
auto_bootstrap() {
  banner

  # ─── Check node ───
  if ! have_node; then
    err "Node.js required"
    note "Install: pkg install nodejs"
    echo ""
    pause
    exit 1
  fi

  # ─── Check npm deps ───
  if ! node -e "require('express')" 2>/dev/null; then
    warn "NPM dependencies missing (express, ws, multer)"
    read -r -p "  ${YEL}▸ Install sekarang? [Y/n]: ${R}" c
    case "$c" in
      n|N) note "Skip. Install manual: npm install express ws multer" ;;
      *) arrow "Installing..."; cd "$TYN_DIR" && npm install express ws multer --save 2>&1 | tail -3; ok "Installed" ;;
    esac
    echo ""
  fi

  # ─── 1. Ensure server.html ───
  ensure_server_html || true

  # ─── 2. Auto API token ───
  local token
  token=$(ensure_api_token)
  if [ -z "$token" ]; then
    err "Gagal mendapatkan/membuat API token"
    exit 1
  fi

  # ─── 3. Start node ───
  ensure_node_running || { err "Gagal start node"; exit 1; }

  # ─── 4. State ON ───
  set_state "on"

  # ─── 5. Verify ───
  local port host
  port=$(json_get "$CONFIG_FILE" 'd.port'); port="${port:-7700}"
  host=$(get_display_host)

  arrow "Verifying bridge..."
  sleep 1
  local check_resp
  check_resp=$(curl -s -m 5 -H "X-API-Token: $token" "http://${host}:${port}/check" 2>/dev/null || echo "")

  if echo "$check_resp" | grep -q '"ok":true'; then
    show_console_info "$token" "$port" "$host"
    echo ""
    ok "Semua siap. Bridge berjalan di background."
    note "Untuk manajemen lengkap: buka http://${host}:${port}/admin"
    note "Untuk berhenti: kill \$(cat $PID_FILE) atau via Admin Panel"
  else
    warn "Bridge ter-start tapi verifikasi gagal"
    note "Cek logs: tail -f $LOG_FILE"
    echo ""
    echo -e "  ${CYN}Console :${R} http://${host}:${port}/index.html"
    echo -e "  ${CYN}Admin   :${R} http://${host}:${port}/admin"
    echo -e "  ${CYN}Token   :${R} ${token}"
    echo -e "  ${CYN}WS      :${R} ws://${host}:${port}/term?token=${token}&session=console"
  fi

  echo ""
  pause
  exit 0
}

# ═══════════════════════════════════════════════════════════════════════════
# BOOT
# ═══════════════════════════════════════════════════════════════════════════
init_files

if ! have_node; then
  banner
  err "Node.js required"
  note "Install: pkg install nodejs"
  echo ""
  pause
  exit 1
fi

auto_bootstrap