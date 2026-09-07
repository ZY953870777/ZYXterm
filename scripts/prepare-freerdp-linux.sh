#!/bin/bash
# ============================================================
#  Linux FreeRDP 打包资源准备（在 electron-builder 之前运行）
#
#  产出 build/freerdp-linux/：freerdp.node（Electron ABI addon）+
#  libfreerdp3.so.3 / libwinpr3.so.3 + ldd 收集的全部依赖，
#  由 package.json 的 linux extraResources 合并为包内
#  resources/freerdp/build/Release/（目标机无需安装任何系统库）。
#
#  设计目标：可在任意 Linux 环境运行（不需要系统里有 FreeRDP 3 包）：
#   1. 优先 apt 安装 freerdp3-dev / libfreerdp3-dev（Ubuntu 24.04+）
#   2. 源里没有（如 Ubuntu 22.04/18.04、Debian 旧版）则源码编译 FreeRDP 3
#      到 $FREERDP_CACHE（默认 ~/.cache/freerdp3；build-docker.sh 已把
#      docker-cache 卷挂载为 /root/.cache，源码编译结果跨构建复用）
#
#  使用：
#   - build-docker.sh（容器内，npm ci/build 之后、electron-builder 之前）
#   - GitHub release.yml（linux job）
#   - 也可在有 freerdp3-dev 的宿主机直接手动运行
#
#  注意：源码树的 resources/freerdp/（Windows 产物）本脚本不做任何改动。
# ============================================================
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$PROJECT_DIR/build/freerdp-linux"
FREERDP_CACHE="${FREERDP_CACHE:-$HOME/.cache/freerdp3}"
FREERDP_VERSION="${FREERDP_VERSION:-3.30.0}"
export FREERDP_PREFIX="/usr"   # binding.gyp 通过该变量定位头文件/库

log()  { echo "  ✓ $*"; }
fail() { echo "❌ $*" >&2; exit 1; }

# ---------- 基础工具 ----------
MISSING_TOOLS=""
for t in file patchelf; do
  command -v "$t" >/dev/null 2>&1 || MISSING_TOOLS="$MISSING_TOOLS $t"
done
if [ -n "$MISSING_TOOLS" ]; then
  if [ "$(id -u)" = "0" ] && command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq $MISSING_TOOLS >/dev/null
  else
    fail "缺少工具:$MISSING_TOOLS（非 root 无法自动安装，请先：sudo apt-get install -y$MISSING_TOOLS）"
  fi
fi

# ---------- 1. 获取 FreeRDP 3 开发包（apt → 源码编译） ----------
FREERDP_FOUND=""
if [ -d /usr/include/freerdp3 ] && [ -d /usr/include/winpr3 ]; then
  FREERDP_FOUND="/usr"
else
  if [ "$(id -u)" = "0" ] && command -v apt-get >/dev/null 2>&1; then
    echo "→ 系统无 FreeRDP 3 开发包，尝试 apt 安装 ..."
    apt-get update -qq >/dev/null 2>&1 || true
    apt-get install -y -qq freerdp3-dev >/dev/null 2>&1 \
      || apt-get install -y -qq libfreerdp3-dev >/dev/null 2>&1 \
      || true
    [ -d /usr/include/freerdp3 ] && FREERDP_FOUND="/usr"
  fi
fi

if [ -z "$FREERDP_FOUND" ]; then
  # 源码编译 FreeRDP 3（与 Windows workflow 相同版本、相同的精简开关）
  if [ ! -f "$FREERDP_CACHE/lib/libfreerdp3.so.3" ]; then
    echo "→ apt 无 freerdp3 开发包，源码编译 FreeRDP $FREERDP_VERSION → $FREERDP_CACHE（首次较慢，之后走缓存）"
    if [ "$(id -u)" = "0" ] && command -v apt-get >/dev/null 2>&1; then
      # 源编译依赖：libicu-dev（winpr/crt 必需）、libkrb5-dev（krb5-config，
      # 配 WITH_KRB5=OFF 跳过但装上兜底）、pkg-config（cmake 探测 openssl 等）、
      # libusb-1.0-0-dev（FreeRDP3 urbdrc 通道在 WITH_CLIENT_CHANNELS 下强制
      # find_package(libusb-1.0 REQUIRED)，无 per-channel 开关，只能装包）
      apt-get install -y -qq build-essential cmake git zlib1g-dev pkg-config \
        libssl-dev liburiparser-dev libkrb5-dev libicu-dev \
        libusb-1.0-0-dev >/dev/null 2>&1 || true
    fi
    command -v cmake >/dev/null 2>&1 || fail "缺少 cmake（源码编译 FreeRDP 需要）"
    command -v git  >/dev/null 2>&1 || fail "缺少 git（源码编译 FreeRDP 需要）"
    SRC="$(mktemp -d)/freerdp-src"
    git clone --depth 1 --branch "$FREERDP_VERSION" \
      https://github.com/FreeRDP/FreeRDP.git "$SRC"
    cmake -S "$SRC" -B "${SRC}-build" \
      -DCMAKE_INSTALL_PREFIX="$FREERDP_CACHE" \
      -DCMAKE_BUILD_TYPE=Release \
      -DWITH_FFMPEG=OFF -DWITH_DSP_FFMPEG=OFF -DWITH_VIDEO_FFMPEG=OFF \
      -DWITH_SWSCALE=OFF -DWITH_CAIRO=OFF -DWITH_OPUS=OFF -DWITH_OPENH264=OFF \
      -DWITH_GSM=OFF -DWITH_LAME=OFF -DWITH_FAAD2=OFF -DWITH_FAAC=OFF \
      -DWITH_FDK_AAC=OFF -DWITH_SOXR=OFF \
      -DWITH_WAYLAND=OFF -DWITH_X11=OFF -DWITH_PULSE=OFF -DWITH_ALSA=OFF \
      -DWITH_PCSC=OFF -DWITH_SERVER=OFF -DWITH_SHADOW=OFF -DWITH_PROXY=OFF \
      -DWITH_CLIENT=ON -DWITH_OPENSSL=ON -DWITH_ZLIB=ON -DBUILD_TESTING=OFF \
      -DWITH_KRB5=OFF -DWITH_MANPAGES=OFF -DWITH_UNICODE_BUILTIN=OFF \
      -DWITH_CUPS=OFF -DWITH_URBDRC=OFF -DWITH_FFI=OFF -DWITH_SMARTCARD=OFF \
      -DWITH_FUSE=OFF -DWITH_SSO_MIB=OFF -DWITH_GSTREAMER=OFF -DWITH_SANITIZE=OFF \
      >/dev/null
    cmake --build "${SRC}-build" --parallel "$(nproc)" >/dev/null
    cmake --install "${SRC}-build" >/dev/null
  fi
  FREERDP_FOUND="$FREERDP_CACHE"
  export FREERDP_PREFIX="$FREERDP_CACHE"
fi
log "FreeRDP 3 开发包: $FREERDP_FOUND"

# binding.gyp（Linux）硬编码 -I /usr/include/freerdp3 与 /usr/include/winpr3、
# 链接用 -lfreerdp3/-lwinpr3（默认库目录）。apt 路径本就满足；源编译路径
# （FREERDP_FOUND 非 /usr）需把头文件/库软链到 /usr/include 与 /usr/lib，
# 否则 node-gyp 编 addon 时报 winpr/synch.h 找不到/链接不到。
if [ "$FREERDP_FOUND" != "/usr" ]; then
  F_H="$(find "$FREERDP_FOUND/include" -path '*/freerdp/freerdp.h' 2>/dev/null | head -1)" || true
  W_H="$(find "$FREERDP_FOUND/include" -path '*/winpr/synch.h' 2>/dev/null | head -1)" || true
  if [ -n "$F_H" ] && [ -n "$W_H" ]; then
    mkdir -p /usr/include/freerdp3 /usr/include/winpr3 /usr/lib
    ln -sfn "${F_H%/freerdp/freerdp.h}/freerdp" /usr/include/freerdp3/freerdp
    ln -sfn "${W_H%/winpr/synch.h}/winpr"      /usr/include/winpr3/winpr
    for l in "$FREERDP_FOUND"/lib/libfreerdp3.so* "$FREERDP_FOUND"/lib/libwinpr3.so*; do
      [ -f "$l" ] || [ -L "$l" ] && ln -sfn "$l" "/usr/lib/$(basename "$l")"
    done
    log "已把源编译 FreeRDP 头文件/库软链到 /usr/include /usr/lib（供 addon 编译）"
  else
    fail "找不到源编译 FreeRDP 头文件（$FREERDP_FOUND/include 下需 freerdp/freerdp.h 与 winpr/synch.h）"
  fi
fi

# ---------- 2. 编译 addon（Electron ABI） ----------
cd "$PROJECT_DIR"
# node-addon-api / node-gyp 可能尚未安装（CI 中 npm ci 在后面才执行）
node -e "require.resolve('node-addon-api')" >/dev/null 2>&1 \
  || npm install --no-save --ignore-scripts node-addon-api node-gyp >/dev/null
EV="$(node -p "try{require('./node_modules/electron/package.json').version}catch(e){require('./package.json').devDependencies.electron.replace(/[\^~]/,'')}")"
rm -rf native/freerdp/build
npx node-gyp rebuild --directory=native/freerdp \
  --target="$EV" --arch=x64 --dist-url=https://electronjs.org/headers

file native/freerdp/build/Release/freerdp.node | grep -q ELF \
  || fail "addon 不是 Linux ELF（native/freerdp/build/Release/freerdp.node）"

# ---------- 3. 暂存 addon + 运行库 + 依赖 ----------
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -f native/freerdp/build/Release/freerdp.node "$STAGE/"

for lib in libfreerdp3.so.3 libwinpr3.so.3; do
  # find 在部分环境是 bfs，遇权限错误返回非零；|| true 防止 set -e 中断
  src="$(find "$FREERDP_FOUND/lib" /usr/lib -name "$lib*" -type f 2>/dev/null | head -1)" || true
  [ -n "$src" ] || fail "未找到 $lib（查找于 $FREERDP_FOUND/lib 与 /usr/lib）"
  cp -f "$src" "$STAGE/$lib"
  log "FreeRDP 运行库: $lib"
done

# 用 ldd 收集全部动态依赖（如 ICU/OpenSSL）随包分发，避免目标机版本不同报错
collect_deps() {
  ldd "$1" 2>/dev/null | grep '=>' | awk '{print $3}' | while read -r so; do
    case "$so" in /*) ;; *) continue ;; esac
    base="$(basename "$so")"
    # 跳过目标系统必有的 glibc 基础库
    case "$base" in
      libc.so*|libm.so*|libpthread.so*|libdl.so*|librt.so*|libgcc_s.so*|libstdc++.so*|ld-linux*) continue ;;
    esac
    if [ ! -f "$STAGE/$base" ]; then
      cp -f "$so" "$STAGE/$base" 2>/dev/null || true
      log "随包依赖: $base"
    fi
  done
}
collect_deps "$STAGE/freerdp.node"
collect_deps "$STAGE/libfreerdp3.so.3"
collect_deps "$STAGE/libwinpr3.so.3"

# rpath=$ORIGIN：freerdp 运行库的依赖（ICU 等）从自身目录加载；
# 不设全局 LD_LIBRARY_PATH，避免影响 Electron utility 进程
patchelf --set-rpath '$ORIGIN' --force-rpath "$STAGE/libfreerdp3.so.3"
patchelf --set-rpath '$ORIGIN' --force-rpath "$STAGE/libwinpr3.so.3"
log "已为 freerdp 运行库设置 rpath=\$ORIGIN"

# ---------- 4. 打包前硬校验（缺任何文件直接失败，不产出 RDP 不可用的包） ----------
for f in freerdp.node libfreerdp3.so.3 libwinpr3.so.3; do
  [ -f "$STAGE/$f" ] || fail "打包前校验失败：build/freerdp-linux/ 缺少 $f"
done
echo "✅ FreeRDP Linux 资源就绪: $STAGE（$(ls "$STAGE" | wc -l) 个文件）"
