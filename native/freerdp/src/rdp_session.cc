// FreeRDP N-API addon — 嵌入式 RDP 会话（ZYXterm）
//
// Phase 1：建立 RDP 连接、上报状态。
// Phase 2：帧链路——gdi primary_buffer 整帧对比检测脏区，节流投递到 JS 主线程。
//   （FreeRDP 3 的 gdi->hdc->hwnd 为 NULL，无法用 hwnd->invalid，故用整帧像素
//     对比找差异 bounding box，稳定可靠）
// Phase 3：键盘/鼠标输入注入（sendMouse / sendKey / sendUnicode）。
//
// 实现：FreeRDP 底层 API（freerdp_new + freerdp_context_new_ex + freerdp_connect）
// 在工作线程运行；事件经 N-API ThreadSafeFunction 投递到 JS 主线程。
//
// JS 侧用法（见 scripts/poc-freerdp-addon.cjs）：
//   const session = new addon.RdpSession(cfg, handler)
//   session.connect()
//   session.sendMouse(x, y, flags)
//   session.sendKey(scancode, pressed)
//   session.sendUnicode(codePoint, pressed)
//   session.disconnect()
// handler: (type, payload) => void
//   type = 'status' | 'error' | 'frame' | 'resize'
//   frame payload = { x, y, width, height, data(Buffer RGBA) }

#include <napi.h>
#include <atomic>
#include <chrono>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include <winpr/synch.h>

#include <freerdp/codec/color.h>
#include <freerdp/freerdp.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/input.h>
#include <freerdp/pointer.h>
#include <freerdp/settings.h>

#ifndef KBD_FLAGS_RELEASE
#define KBD_FLAGS_RELEASE 0x4000
#endif
#ifndef KBD_FLAGS_EXTENDED
#define KBD_FLAGS_EXTENDED 0x0100
#endif

using namespace Napi;

// ---------- 配置 ----------
struct RdpConfig {
  std::string host = "127.0.0.1";
  uint32_t port = 3389;
  std::string username;
  std::string password;
  std::string domain;
  uint32_t width = 1280;
  uint32_t height = 720;
};

// ---------- 跨线程共享数据 ----------
struct SessionData {
  RdpConfig cfg;
  std::atomic<bool> running{false};
  std::atomic<bool> connected{false};
  freerdp* instance = nullptr;
  ThreadSafeFunction tsfn;

  // 帧链路（EndPaint 与事件循环同在 worker 线程，无需锁）
  bool pending_update = false;
  std::vector<uint8_t> prev_frame;  // 紧凑 BGRA 整帧缓存（每行 w*4）
  // 已上报尺寸：gdi 尺寸变化时先发 resize，确保渲染端缓冲与帧坐标匹配
  int reported_w = 0;
  int reported_h = 0;
  // 指针缓存：服务器用 PointerNew 首次发完整数据（含 cacheIndex），之后用
  // PointerCached 只发 cacheIndex 切换光标（箭头/竖线/手等）。必须自维护缓存，
  // 否则进入 RDP 后光标不再随场景变化
  struct CachedPointer {
    std::vector<uint8_t> rgba;
    UINT32 w = 0;
    UINT32 h = 0;
    UINT32 hot_x = 0;
    UINT32 hot_y = 0;
  };
  std::unordered_map<UINT32, CachedPointer> pointer_cache;
};

// FreeRDP 回调（工作线程）需要通过 instance 找到对应 SessionData
static std::mutex g_sessions_mutex;
static std::unordered_map<freerdp*, std::shared_ptr<SessionData>> g_sessions;

static void register_session(freerdp* instance,
                             std::shared_ptr<SessionData> data) {
  std::lock_guard<std::mutex> lock(g_sessions_mutex);
  g_sessions[instance] = std::move(data);
}

static std::shared_ptr<SessionData> lookup_session(freerdp* instance) {
  std::lock_guard<std::mutex> lock(g_sessions_mutex);
  auto it = g_sessions.find(instance);
  return it != g_sessions.end() ? it->second : nullptr;
}

static void unregister_session(freerdp* instance) {
  std::lock_guard<std::mutex> lock(g_sessions_mutex);
  g_sessions.erase(instance);
}

// ---------- 帧差异检测 ----------
// 比较两帧紧凑 BGRA，返回差异像素的 bounding box；无差异返回 false。
static bool diff_bbox(const uint8_t* a, const uint8_t* b, int w, int h,
                      int* left, int* top, int* right, int* bottom) {
  int minx = w, miny = h, maxx = -1, maxy = -1;
  const uint32_t* pa = reinterpret_cast<const uint32_t*>(a);
  const uint32_t* pb = reinterpret_cast<const uint32_t*>(b);
  for (int y = 0; y < h; y++) {
    const uint32_t* ra = pa + static_cast<size_t>(y) * w;
    const uint32_t* rb = pb + static_cast<size_t>(y) * w;
    for (int x = 0; x < w; x++) {
      if (ra[x] != rb[x]) {
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
      }
    }
  }
  if (maxx < 0) return false;
  *left = minx;
  *top = miny;
  *right = maxx + 1;
  *bottom = maxy + 1;
  return true;
}

// ---------- 事件投递辅助 ----------
static void emit(SessionData* data, const char* type, const std::string& msg) {
  if (!data->tsfn) return;
  std::string t(type);
  std::string m(msg);
  data->tsfn.BlockingCall([t, m](Napi::Env env, Napi::Function fn) {
    fn.Call({Napi::String::New(env, t), Napi::String::New(env, m)});
  });
}

// ---------- FreeRDP 回调（均在工作线程触发） ----------

// 事件循环里节流：读 primary_buffer、与上一帧对比、投递脏矩形
static void flush_frame(SessionData* data,
                        std::chrono::steady_clock::time_point& last_send) {
  if (!data->tsfn) return;
  const auto now = std::chrono::steady_clock::now();
  if (std::chrono::duration_cast<std::chrono::milliseconds>(now - last_send)
          .count() < 30) {
    return;
  }
  if (!data->instance || !data->instance->context) return;
  rdpGdi* gdi = data->instance->context->gdi;
  if (!gdi || !gdi->primary_buffer || gdi->width <= 0 || gdi->height <= 0) {
    return;
  }
  const int w = gdi->width;
  const int h = gdi->height;
  // gdi 尺寸变化（含连接初始、服务器桌面变化）→ 先发 resize，保证渲染端缓冲匹配。
  // 注意：服务器握手期桌面尺寸可能与请求不一致（固定分辨率服务器），且
  // update->DesktopResize 回调可能不触发，故在此主动检测上报。resize 与 frame
  // 同在一个 tsfn FIFO 队列，渲染端会先重建缓冲再处理后续帧，坐标不会错位。
  if (w != data->reported_w || h != data->reported_h) {
    data->reported_w = w;
    data->reported_h = h;
    data->tsfn.BlockingCall([w, h](Napi::Env env, Napi::Function fn) {
      fn.Call({Napi::String::New(env, "resize"),
               Napi::String::New(env, std::to_string(w) + "x" + std::to_string(h))});
    });
  }
  const UINT32 stride = gdi->stride;
  const BYTE* src = gdi->primary_buffer;
  const size_t frame_size = static_cast<size_t>(w) * h * 4;

  // 去 stride 对齐 → 紧凑 BGRA
  std::vector<uint8_t> cur(frame_size);
  for (int y = 0; y < h; y++) {
    std::memcpy(cur.data() + static_cast<size_t>(y) * w * 4,
                src + static_cast<size_t>(y) * stride, w * 4);
  }

  int left, top, right, bottom;
  if (data->prev_frame.size() != frame_size) {
    // 首帧或尺寸变化：整帧
    left = 0;
    top = 0;
    right = w;
    bottom = h;
  } else {
    if (!data->pending_update) {
      // 无新绘制，跳过（避免无意义全帧对比）
      return;
    }
    if (!diff_bbox(data->prev_frame.data(), cur.data(), w, h, &left, &top,
                   &right, &bottom)) {
      data->prev_frame = std::move(cur);
      data->pending_update = false;
      return;  // 无差异
    }
  }
  data->prev_frame = std::move(cur);
  data->pending_update = false;
  last_send = now;

  const int rw = right - left;
  const int rh = bottom - top;
  if (rw <= 0 || rh <= 0) return;

  // 脏区 BGRA → RGBA
  std::vector<uint8_t> rgba(static_cast<size_t>(rw) * rh * 4);
  for (int y = 0; y < rh; y++) {
    const BYTE* row =
        data->prev_frame.data() +
        (static_cast<size_t>(top + y) * w + static_cast<size_t>(left)) * 4;
    uint8_t* dst = rgba.data() + static_cast<size_t>(y) * rw * 4;
    for (int x = 0; x < rw; x++) {
      dst[x * 4] = row[x * 4 + 2];      // R
      dst[x * 4 + 1] = row[x * 4 + 1];  // G
      dst[x * 4 + 2] = row[x * 4];      // B
      dst[x * 4 + 3] = 0xff;            // A
    }
  }

  data->tsfn.BlockingCall(
      [left, top, rw, rh, rgba = std::move(rgba)](Napi::Env env,
                                                  Napi::Function fn) {
        auto buf = Napi::Buffer<uint8_t>::Copy(env, rgba.data(), rgba.size());
        auto obj = Napi::Object::New(env);
        obj.Set("x", left);
        obj.Set("y", top);
        obj.Set("width", rw);
        obj.Set("height", rh);
        obj.Set("data", buf);
        fn.Call({Napi::String::New(env, "frame"), obj});
      });
}

// EndPaint：标记有待投递的更新（由事件循环节流做帧对比与投递）
static BOOL update_end_paint(rdpContext* context) {
  auto data = lookup_session(context->instance);
  if (data) data->pending_update = true;
  return TRUE;
}

// 桌面尺寸变化 → 通知 JS
static BOOL update_desktop_resize(rdpContext* context) {
  auto data = lookup_session(context->instance);
  if (!data || !data->tsfn) return TRUE;
  rdpGdi* gdi = context->gdi;
  const int w = gdi ? gdi->width : 0;
  const int h = gdi ? gdi->height : 0;
  if (w <= 0 || h <= 0) return TRUE;
  data->tsfn.BlockingCall([w, h](Napi::Env env, Napi::Function fn) {
    fn.Call({Napi::String::New(env, "resize"),
             Napi::String::New(env, std::to_string(w) + "x" + std::to_string(h))});
  });
  return TRUE;
}

// ---------- 鼠标指针形状 ----------
// 解码 RDP 指针（xorMask + andMask，按 xorBpp）为 RGBA，可选按 cacheIndex 缓存。
// 服务器对常用光标用 PointerNew 首次发完整数据（含 cacheIndex），之后用
// PointerCached（只发 cacheIndex）切换，因此必须自维护缓存。
static void send_pointer_impl(SessionData* data, UINT32 cache_index, UINT32 hot_x, UINT32 hot_y,
                              UINT32 w, UINT32 h, UINT32 xor_bpp, const BYTE* xor_mask,
                              UINT32 xor_len, const BYTE* and_mask, UINT32 and_len, BOOL cache) {
  if (!data || !data->tsfn || w <= 0 || h <= 0 || w > 512 || h > 512 || !xor_mask) return;
  std::vector<uint8_t> rgba(static_cast<size_t>(w) * h * 4);
  if (!freerdp_image_copy_from_pointer_data(
          rgba.data(), PIXEL_FORMAT_RGBA32, w * 4, 0, 0, w, h, xor_mask, xor_len, and_mask,
          and_len, xor_bpp, NULL)) {
    return;
  }
  if (cache) {
    data->pointer_cache[cache_index] = { rgba, w, h, hot_x, hot_y };
  }
  data->tsfn.BlockingCall([hot_x, hot_y, w, h, rgba = std::move(rgba)](Napi::Env env,
                                                                       Napi::Function fn) {
    auto buf = Napi::Buffer<uint8_t>::Copy(env, rgba.data(), rgba.size());
    auto obj = Napi::Object::New(env);
    obj.Set("x", hot_x);
    obj.Set("y", hot_y);
    obj.Set("width", w);
    obj.Set("height", h);
    obj.Set("data", buf);
    fn.Call({Napi::String::New(env, "pointer"), obj});
  });
}

// 发送已缓存的光标（PointerCached 引用）
static void send_cached_pointer(SessionData* data, const SessionData::CachedPointer& cp) {
  if (!data || !data->tsfn) return;
  const std::vector<uint8_t> rgba = cp.rgba;
  const UINT32 w = cp.w, h = cp.h, hot_x = cp.hot_x, hot_y = cp.hot_y;
  data->tsfn.BlockingCall([hot_x, hot_y, w, h, rgba](Napi::Env env, Napi::Function fn) {
    auto buf = Napi::Buffer<uint8_t>::Copy(env, rgba.data(), rgba.size());
    auto obj = Napi::Object::New(env);
    obj.Set("x", hot_x);
    obj.Set("y", hot_y);
    obj.Set("width", w);
    obj.Set("height", h);
    obj.Set("data", buf);
    fn.Call({Napi::String::New(env, "pointer"), obj});
  });
}

// 新指针（含完整数据 + xorBpp + cacheIndex）→ 解码、缓存并投递
static BOOL update_pointer_new(rdpContext* context, const POINTER_NEW_UPDATE* ptr) {
  auto data = lookup_session(context->instance);
  if (!data) return TRUE;
  if (ptr && ptr->colorPtrAttr.xorMaskData) {
    send_pointer_impl(data.get(), ptr->colorPtrAttr.cacheIndex, ptr->colorPtrAttr.hotSpotX,
                      ptr->colorPtrAttr.hotSpotY, ptr->colorPtrAttr.width,
                      ptr->colorPtrAttr.height, ptr->xorBpp, ptr->colorPtrAttr.xorMaskData,
                      ptr->colorPtrAttr.lengthXorMask, ptr->colorPtrAttr.andMaskData,
                      ptr->colorPtrAttr.lengthAndMask, TRUE);
  }
  return TRUE;
}

// 大指针（超大光标）→ 解码、缓存并投递
static BOOL update_pointer_large(rdpContext* context, const POINTER_LARGE_UPDATE* ptr) {
  auto data = lookup_session(context->instance);
  if (!data) return TRUE;
  if (ptr && ptr->xorMaskData) {
    send_pointer_impl(data.get(), ptr->cacheIndex, ptr->hotSpotX, ptr->hotSpotY, ptr->width,
                      ptr->height, ptr->xorBpp, ptr->xorMaskData, ptr->lengthXorMask,
                      ptr->andMaskData, ptr->lengthAndMask, TRUE);
  }
  return TRUE;
}

// 缓存指针引用（服务器常用此切换光标）→ 从缓存取并投递
static BOOL update_pointer_cached(rdpContext* context, const POINTER_CACHED_UPDATE* ptr) {
  auto data = lookup_session(context->instance);
  if (!data || !data->tsfn) return TRUE;
  if (ptr) {
    auto it = data->pointer_cache.find(ptr->cacheIndex);
    if (it != data->pointer_cache.end()) {
      send_cached_pointer(data.get(), it->second);
    }
  }
  return TRUE;
}

// 连接成功后初始化 GDI（分配 primary_buffer，Bitmap 更新才能解码）
static BOOL post_connect(freerdp* instance) {
  if (!gdi_init(instance, PIXEL_FORMAT_BGRA32)) {
    return FALSE;
  }
  // gdi_init 会注册 GDI 自身的指针回调（绘制到 hwnd，而本方案 hwnd 为 NULL、
  // 画面由渲染端 canvas 绘制），因此在此覆盖为我们的回调，把 RDP 指针形状
  // 投递给渲染端（否则光标始终是默认箭头）
  if (instance->context && instance->context->update && instance->context->update->pointer) {
    instance->context->update->pointer->PointerNew = update_pointer_new;
    instance->context->update->pointer->PointerLarge = update_pointer_large;
    instance->context->update->pointer->PointerCached = update_pointer_cached;
  }
  return TRUE;
}

static void post_disconnect(freerdp* instance) { (void)instance; }

// ---------- 工作线程 ----------
static void worker_main(std::shared_ptr<SessionData> data) {
  const RdpConfig& cfg = data->cfg;

  emit(data.get(), "status", "connecting");

  rdpSettings* settings = freerdp_settings_new(0);
  if (!settings) {
    emit(data.get(), "error", "freerdp_settings_new 失败");
    return;
  }

  freerdp_settings_set_string(settings, FreeRDP_ServerHostname, cfg.host.c_str());
  freerdp_settings_set_uint32(settings, FreeRDP_ServerPort, cfg.port);
  freerdp_settings_set_string(settings, FreeRDP_Username, cfg.username.c_str());
  freerdp_settings_set_string(settings, FreeRDP_Password, cfg.password.c_str());
  if (!cfg.domain.empty()) {
    freerdp_settings_set_string(settings, FreeRDP_Domain, cfg.domain.c_str());
  }
  freerdp_settings_set_uint32(settings, FreeRDP_DesktopWidth, cfg.width);
  freerdp_settings_set_uint32(settings, FreeRDP_DesktopHeight, cfg.height);
  freerdp_settings_set_bool(settings, FreeRDP_IgnoreCertificate, TRUE);

  // 使用默认安全层协商（NLA/TLS），与 Linux 行为一致
  // （注：3.23.0 曾强制 TLS 规避 Windows NLA 崩溃；升级 3.30.0 后崩溃已修复，
  //  且强制 TLS 会导致部分服务器 "transport layer failed"，故恢复默认协商）

  freerdp* instance = freerdp_new();
  if (!instance) {
    freerdp_settings_free(settings);
    emit(data.get(), "error", "freerdp_new 失败");
    return;
  }

  if (!freerdp_context_new_ex(instance, settings)) {
    freerdp_settings_free(settings);
    freerdp_free(instance);
    emit(data.get(), "error", "freerdp_context_new 失败");
    return;
  }
  data->instance = instance;
  register_session(instance, data);

  instance->PostConnect = post_connect;
  instance->PostDisconnect = post_disconnect;
  if (instance->context && instance->context->update) {
    instance->context->update->EndPaint = update_end_paint;
    instance->context->update->DesktopResize = update_desktop_resize;
    if (instance->context->update->pointer) {
      instance->context->update->pointer->PointerNew = update_pointer_new;
      instance->context->update->pointer->PointerLarge = update_pointer_large;
      instance->context->update->pointer->PointerCached = update_pointer_cached;
    }
  }

  if (!freerdp_connect(instance)) {
    std::string msg = "freerdp_connect 失败";
    UINT32 code = freerdp_get_last_error(instance->context);
    const char* estr = freerdp_get_last_error_string(code);
    if (estr) {
      msg += ": ";
      msg += estr;
    }
    emit(data.get(), "error", msg);
    unregister_session(instance);
    freerdp_context_free(instance);
    freerdp_free(instance);
    data->instance = nullptr;
    return;
  }

  data->connected = true;
  emit(data.get(), "status", "connected");

  // 事件循环：等待 FreeRDP 事件句柄并处理；周期性投递累积脏矩形
  data->running = true;
  auto last_send = std::chrono::steady_clock::now();
  while (data->running.load()) {
    flush_frame(data.get(), last_send);
    HANDLE handles[64] = {0};
    DWORD count = freerdp_get_event_handles(instance->context, handles, 64);
    if (count == 0) break;
    DWORD rc = WaitForMultipleObjects(count, handles, FALSE, 30);
    if (rc == WAIT_FAILED) break;
    if (!freerdp_check_fds(instance)) break;  // 断开/错误
  }
  flush_frame(data.get(), last_send);

  data->connected = false;
  unregister_session(instance);
  freerdp_disconnect(instance);
  freerdp_context_free(instance);
  freerdp_free(instance);
  data->instance = nullptr;
  emit(data.get(), "status", "disconnected");
}

// ---------- N-API 包装 ----------
class RdpSession : public Napi::ObjectWrap<RdpSession> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(
        env, "RdpSession",
        {
            InstanceMethod("connect", &RdpSession::Connect),
            InstanceMethod("disconnect", &RdpSession::Disconnect),
            InstanceMethod("sendMouse", &RdpSession::SendMouse),
            InstanceMethod("sendKey", &RdpSession::SendKey),
            InstanceMethod("sendUnicode", &RdpSession::SendUnicode),
        });
    exports.Set("RdpSession", func);
    return exports;
  }

  RdpSession(const Napi::CallbackInfo& info)
      : Napi::ObjectWrap<RdpSession>(info) {
    data_ = std::make_shared<SessionData>();
    if (info.Length() >= 2) {
      auto cfgObj = info[0].As<Napi::Object>();
      auto handler = info[1].As<Napi::Function>();
      data_->cfg.host = GetString(cfgObj, "host", "127.0.0.1");
      data_->cfg.port = GetUint(cfgObj, "port", 3389);
      data_->cfg.username = GetString(cfgObj, "username", "");
      data_->cfg.password = GetString(cfgObj, "password", "");
      data_->cfg.domain = GetString(cfgObj, "domain", "");
      data_->cfg.width = GetUint(cfgObj, "width", 1280);
      data_->cfg.height = GetUint(cfgObj, "height", 720);
      data_->tsfn = ThreadSafeFunction::New(
          info.Env(), handler, "rdp-events", 0, 1);
    }
  }

  ~RdpSession() override { Stop(); }

  Napi::Value Connect(const Napi::CallbackInfo& info) {
    if (thread_.joinable()) return info.Env().Undefined();
    auto data = data_;
    thread_ = std::thread([data]() { worker_main(data); });
    return info.Env().Undefined();
  }

  Napi::Value Disconnect(const Napi::CallbackInfo& info) {
    Stop();
    return info.Env().Undefined();
  }

  Napi::Value SendMouse(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) return env.Undefined();
    uint32_t x = info[0].As<Napi::Number>().Uint32Value();
    uint32_t y = info[1].As<Napi::Number>().Uint32Value();
    uint32_t flags = info[2].As<Napi::Number>().Uint32Value();
    rdpInput* input = Input();
    if (input) {
      freerdp_input_send_mouse_event(input, (UINT16)flags, (UINT16)x, (UINT16)y);
    }
    return env.Undefined();
  }

  Napi::Value SendKey(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) return env.Undefined();
    uint32_t scancode = info[0].As<Napi::Number>().Uint32Value();
    bool pressed = info[1].As<Napi::Boolean>().Value();
    rdpInput* input = Input();
    if (input) {
      // scancode 高位带 KBD_FLAGS_EXTENDED(0x100) 标记扩展键（方向键/编辑键/
      // 小键盘 Enter、/ 等），需将其剥离并写入键盘 flags，否则会与同值的
      // 小键盘键混淆（如 ArrowUp=0x48 vs Numpad8=0x48）。
      UINT32 flags = pressed ? 0 : KBD_FLAGS_RELEASE;
      if (scancode & KBD_FLAGS_EXTENDED) {
        flags |= KBD_FLAGS_EXTENDED;
        scancode &= ~KBD_FLAGS_EXTENDED;
      }
      freerdp_input_send_keyboard_event(input, (UINT16)flags, (UINT16)scancode);
    }
    return env.Undefined();
  }

  Napi::Value SendUnicode(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) return env.Undefined();
    uint32_t code = info[0].As<Napi::Number>().Uint32Value();
    bool pressed = info[1].As<Napi::Boolean>().Value();
    rdpInput* input = Input();
    if (input) {
      freerdp_input_send_unicode_keyboard_event(
          input, pressed ? 0 : KBD_FLAGS_RELEASE, (UINT16)code);
    }
    return env.Undefined();
  }

 private:
  std::shared_ptr<SessionData> data_;
  std::thread thread_;

  void Stop() {
    if (thread_.joinable()) {
      data_->running = false;
      if (data_->instance && data_->instance->context) {
        freerdp_abort_connect_context(data_->instance->context);
      }
      thread_.join();
    }
    if (data_->tsfn) {
      data_->tsfn.Release();
    }
  }

  rdpInput* Input() const {
    if (data_->instance && data_->instance->context) {
      return data_->instance->context->input;
    }
    return nullptr;
  }

  static std::string GetString(Napi::Object o, const char* k,
                               const std::string& def) {
    if (o.Has(k)) {
      auto v = o.Get(k);
      if (v.IsString()) return v.As<Napi::String>().Utf8Value();
    }
    return def;
  }

  static uint32_t GetUint(Napi::Object o, const char* k, uint32_t def) {
    if (o.Has(k)) {
      auto v = o.Get(k);
      if (v.IsNumber()) return v.As<Napi::Number>().Uint32Value();
    }
    return def;
  }
};

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  return RdpSession::Init(env, exports);
}

NODE_API_MODULE(freerdp, Init)
