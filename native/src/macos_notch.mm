#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <napi.h>
#include <cmath>

// Loaded only by Electron's main process. No event taps, private APIs, or key monitors.
static __weak NSWindow *panel;
static id localMonitor, globalMonitor, spaceObserver;
static Napi::ThreadSafeFunction pointerCallback;
static bool monitoring = false, fullScreenAllowed = true;
static NSRect activationRect = NSZeroRect, surfaceRect = NSZeroRect, notchRect = NSZeroRect;
static CGPathRef surfacePath = nullptr;
static int lastPointerFlags = -1;
static NSPoint pointerLocation = NSZeroPoint;
static bool pointerLocationKnown = false;
static NSUInteger pointerButtons = 0;
@interface AstraNotchPresentationObserver : NSObject
@end
static AstraNotchPresentationObserver *presentationObserver;

static bool OnMainThread(const Napi::CallbackInfo &info) {
  if ([NSThread isMainThread]) return true;
  Napi::Error::New(info.Env(), "Notch AppKit operations require the main thread").ThrowAsJavaScriptException();
  return false;
}
static double Number(Napi::Object object, const char *key) {
  auto value = object.Get(key);
  return value.IsNumber() ? value.As<Napi::Number>().DoubleValue() : 0;
}
static bool InsideSurface(NSPoint point) {
  return surfacePath && NSPointInRect(point, surfaceRect) && CGPathContainsPoint(surfacePath, nullptr, point, false);
}
// Distance to the camera's lower edge, with a generous downward approach zone.
// The camera gap itself is a target too; adjacent menu items are excluded.
static int Proximity(NSPoint point) {
  if (NSPointInRect(point, notchRect)) return 16;
  if (point.y > NSMinY(notchRect) + 2) return 0;
  double dx = MAX(0, MAX(NSMinX(notchRect) - point.x, point.x - NSMaxX(notchRect)));
  double dy = MAX(0, NSMinY(notchRect) - point.y);
  return int(std::ceil(MAX(0, 1 - std::hypot(dx / 52, dy / 64)) * 16));
}
struct PointerFlags {
  bool near, inside, down, dragging, onActiveSpace, motion, withinHover, overHardware;
  double proximity, x, y, edgeDistance;
};
static void UpdatePointer(bool down, NSEvent *event = nil) {
  NSWindow *window = panel;
  if (!window || !monitoring) return;
  // Local events can be delivered by accessibility without moving the hardware
  // cursor. Their own window coordinates are authoritative (especially sliders).
  if (event || !pointerLocationKnown) {
    pointerLocation = event.window ? [event.window convertPointToScreen:event.locationInWindow] : NSEvent.mouseLocation;
    pointerLocationKnown = true;
    if (!event) pointerButtons = NSEvent.pressedMouseButtons;
    else if (down) pointerButtons |= (1UL << event.buttonNumber);
    else if (event.type == NSEventTypeLeftMouseUp || event.type == NSEventTypeRightMouseUp || event.type == NSEventTypeOtherMouseUp)
      pointerButtons &= ~(1UL << event.buttonNumber);
  }
  NSPoint point = pointerLocation;
  bool motionEvent = event && (event.type == NSEventTypeMouseMoved || event.type == NSEventTypeLeftMouseDragged ||
    event.type == NSEventTypeRightMouseDragged || event.type == NSEventTypeOtherMouseDragged);
  bool fullscreenSuppressed = !fullScreenAllowed && (NSApp.currentSystemPresentationOptions & NSApplicationPresentationFullScreen);
  CGFloat alpha = fullscreenSuppressed ? 0 : 1;
  if (window.alphaValue != alpha) window.alphaValue = alpha;
  bool usable = window.visible && window.onActiveSpace && !fullscreenSuppressed;
  // The wrap is decorative in the menu-bar lane. Menu items and the camera
  // region always pass through; controls live strictly beneath the camera.
  bool inside = usable && point.y <= NSMinY(notchRect) && InsideSurface(point);
  bool dragging = pointerButtons != 0;
  // Preserve pointer capture during a slider drag, including when it leaves the panel.
  if ((!dragging || down) && window.ignoresMouseEvents != !inside) window.ignoresMouseEvents = !inside;
  int proximity = usable ? Proximity(point) : 0;
  bool near = proximity > 0;
  bool overHardware = usable && NSPointInRect(point, notchRect);
  bool withinHover = usable && !NSIsEmptyRect(surfaceRect) && point.y <= NSMinY(notchRect) + 2 &&
    NSPointInRect(point, NSInsetRect(surfaceRect, -12, -12));
  int flags = int(near) | (int(inside) << 1) | (int(dragging) << 2) | (int(usable) << 3) |
    (int(withinHover) << 4) | (proximity << 5) | (int(overHardware) << 10);
  // Slow motion and the final turn matter too. Do not throttle away the last
  // event before a stop. Only nearby movement is reported; far-away motion is
  // still deduplicated, and contour updates are never movement evidence.
  bool reportMotion = near && motionEvent;
  if (flags == lastPointerFlags && !down && !reportMotion) return;
  lastPointerFlags = flags;
  double x = point.x - NSMidX(notchRect), y = NSMinY(notchRect) - point.y;
  double edgeDistance = std::hypot(MAX(0, std::abs(x) - NSWidth(notchRect) / 2), MAX(0, y));
  auto *data = new PointerFlags{near, inside, down, dragging, usable, motionEvent, withinHover, overHardware, proximity / 16.0, x, y, edgeDistance};
  auto status = pointerCallback.NonBlockingCall(data, [](Napi::Env env, Napi::Function callback, PointerFlags *p) {
    if (env && callback) {
      auto value = Napi::Object::New(env);
      value.Set("near", p->near); value.Set("inside", p->inside);
      value.Set("down", p->down); value.Set("dragging", p->dragging);
      value.Set("onActiveSpace", p->onActiveSpace);
      value.Set("motion", p->motion); value.Set("withinHover", p->withinHover); value.Set("proximity", p->proximity);
      value.Set("x", p->x); value.Set("y", p->y); value.Set("edgeDistance", p->edgeDistance);
      value.Set("overHardware", p->overHardware);
      callback.Call({value});
    }
    delete p;
  });
  if (status != napi_ok) delete data;
}
@implementation AstraNotchPresentationObserver
- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
  pointerLocationKnown = false;
  UpdatePointer(false);
}
@end
static void Stop() {
  if (localMonitor) { [NSEvent removeMonitor:localMonitor]; localMonitor = nil; }
  if (globalMonitor) { [NSEvent removeMonitor:globalMonitor]; globalMonitor = nil; }
  if (spaceObserver) { [NSWorkspace.sharedWorkspace.notificationCenter removeObserver:spaceObserver]; spaceObserver = nil; }
  if (presentationObserver) { [NSApp removeObserver:presentationObserver forKeyPath:@"currentSystemPresentationOptions"]; presentationObserver = nil; }
  if (monitoring) { monitoring = false; pointerCallback.Abort(); }
  if (surfacePath) { CGPathRelease(surfacePath); surfacePath = nullptr; }
  panel = nil; surfaceRect = NSZeroRect; lastPointerFlags = -1; pointerLocationKnown = false; pointerButtons = 0;
}
static Napi::Value Geometry(const Napi::CallbackInfo &info) {
  if (!OnMainThread(info)) return info.Env().Null();
  if (@available(macOS 12.0, *)) {
    CGFloat desktopTop = NSMaxY(NSScreen.screens.firstObject.frame);
    for (NSScreen *screen in NSScreen.screens) {
      NSNumber *identifier = screen.deviceDescription[@"NSScreenNumber"];
      if (!CGDisplayIsBuiltin(identifier.unsignedIntValue) || screen.safeAreaInsets.top <= 0) continue;
      NSRect left = screen.auxiliaryTopLeftArea, right = screen.auxiliaryTopRightArea;
      CGFloat gap = NSMinX(right) - NSMaxX(left);
      if (NSIsEmptyRect(left) || NSIsEmptyRect(right) || gap <= 0) continue;
      auto result = Napi::Object::New(info.Env());
      result.Set("displayId", identifier.unsignedIntValue);
      result.Set("x", NSMaxX(left));
      result.Set("y", desktopTop - NSMaxY(screen.frame));
      result.Set("width", gap); result.Set("height", screen.safeAreaInsets.top);
      return result;
    }
  }
  return info.Env().Null();
}
static void Configure(const Napi::CallbackInfo &info) {
  if (!OnMainThread(info) || !info[0].IsBuffer() || !info[1].IsObject()) return;
  auto buffer = info[0].As<Napi::Buffer<unsigned char>>();
  if (buffer.Length() != sizeof(void *)) return;
  NSView *view = (__bridge NSView *)(*reinterpret_cast<void **>(buffer.Data()));
  panel = view.window;
  if (!panel) return;
  auto geometry = info[1].As<Napi::Object>();
  fullScreenAllowed = info[2].ToBoolean().Value();
  CGFloat desktopTop = NSMaxY(NSScreen.screens.firstObject.frame);
  CGFloat x = Number(geometry, "x"), y = Number(geometry, "y");
  CGFloat width = Number(geometry, "width"), height = Number(geometry, "height");
  // AppKit frame positioning avoids Electron's menu-bar clamp (a visible one-point gap).
  [panel setFrame:NSMakeRect(x + width / 2 - 220, desktopTop - y - height - 224, 440, height + 224) display:YES];
  notchRect = NSMakeRect(x, desktopTop - y - height, width, height);
  activationRect = NSMakeRect(x - 52, NSMinY(notchRect) - 64, width + 104, 66);
  panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
    NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorIgnoresCycle |
    (fullScreenAllowed ? NSWindowCollectionBehaviorFullScreenAuxiliary : NSWindowCollectionBehaviorFullScreenNone);
  panel.level = NSStatusWindowLevel;
  panel.hasShadow = NO;
  panel.hidesOnDeactivate = NO;
  // Electron releases focus by ordering the window out and back in. AppKit's
  // default panel animation fades a snapshot of the whole expanded window,
  // covering the renderer's retraction. The renderer owns all visible motion.
  panel.animationBehavior = NSWindowAnimationBehaviorNone;
  panel.ignoresMouseEvents = YES;
  surfaceRect = NSZeroRect;
  if (surfacePath) { CGPathRelease(surfacePath); surfacePath = nullptr; }
  lastPointerFlags = -1;
}
static void Surface(const Napi::CallbackInfo &info) {
  if (!OnMainThread(info) || !panel || !info[0].IsObject()) return;
  auto rect = info[0].As<Napi::Object>();
  CGFloat x = Number(rect, "x"), y = Number(rect, "y");
  CGFloat w = Number(rect, "width"), h = Number(rect, "height");
  if (!std::isfinite(x + y + w + h) || x < 0 || y < 0 || w < 0 || h < 0 ||
    x + w > panel.frame.size.width + 1 || y + h > panel.frame.size.height + 1) return;
  if (!rect.Get("points").IsArray()) return;
  auto points = rect.Get("points").As<Napi::Array>();
  if (points.Length() > 64 || (points.Length() < 3 && (w > 0 || h > 0))) return;
  CGMutablePathRef nextPath = CGPathCreateMutable();
  for (uint32_t i = 0; i < points.Length(); i++) {
    if (!points.Get(i).IsObject()) { CGPathRelease(nextPath); return; }
    auto point = points.Get(i).As<Napi::Object>();
    CGFloat px = Number(point, "x"), py = Number(point, "y");
    if (!std::isfinite(px + py) || px < x || px > x + w || py < y || py > y + h) { CGPathRelease(nextPath); return; }
    CGFloat screenX = NSMinX(panel.frame) + px, screenY = NSMaxY(panel.frame) - py;
    if (i == 0) CGPathMoveToPoint(nextPath, nullptr, screenX, screenY);
    else CGPathAddLineToPoint(nextPath, nullptr, screenX, screenY);
  }
  CGPathCloseSubpath(nextPath);
  if (surfacePath) CGPathRelease(surfacePath);
  surfacePath = nextPath;
  surfaceRect = NSMakeRect(NSMinX(panel.frame) + x, NSMaxY(panel.frame) - y - h, w, h);
  UpdatePointer(false);
}
static void Start(const Napi::CallbackInfo &info) {
  if (!OnMainThread(info) || !panel || monitoring || !info[0].IsFunction()) return;
  pointerCallback = Napi::ThreadSafeFunction::New(info.Env(), info[0].As<Napi::Function>(), "notch pointer", 0, 1);
  pointerCallback.Unref(info.Env());
  monitoring = true;
  presentationObserver = [AstraNotchPresentationObserver new];
  [NSApp addObserver:presentationObserver forKeyPath:@"currentSystemPresentationOptions" options:0 context:nullptr];
  NSEventMask mask = NSEventMaskMouseMoved | NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown |
    NSEventMaskOtherMouseDown | NSEventMaskLeftMouseUp | NSEventMaskRightMouseUp | NSEventMaskOtherMouseUp |
    NSEventMaskLeftMouseDragged | NSEventMaskRightMouseDragged | NSEventMaskOtherMouseDragged;
  void (^observe)(NSEvent *) = ^(NSEvent *event) {
    bool down = event.type == NSEventTypeLeftMouseDown || event.type == NSEventTypeRightMouseDown || event.type == NSEventTypeOtherMouseDown;
    UpdatePointer(down, event);
  };
  globalMonitor = [NSEvent addGlobalMonitorForEventsMatchingMask:mask handler:observe];
  localMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:mask handler:^NSEvent *(NSEvent *event) {
    observe(event); return event;
  }];
  spaceObserver = [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceActiveSpaceDidChangeNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *) {
    pointerLocationKnown = false;
    UpdatePointer(false);
  }];
  UpdatePointer(false);
}
static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("getDiagnostics", Napi::Function::New(env, [](const Napi::CallbackInfo &info) {
    auto result = Napi::Object::New(info.Env());
    if (!OnMainThread(info)) return result;
    result.Set("monitoring", monitoring);
    result.Set("visible", bool(panel.visible));
    result.Set("onActiveSpace", bool(panel.onActiveSpace));
    result.Set("ignoresMouse", bool(panel.ignoresMouseEvents));
    result.Set("systemFullscreen", bool(NSApp.currentSystemPresentationOptions & NSApplicationPresentationFullScreen));
    result.Set("alpha", panel.alphaValue);
    result.Set("animationDisabled", panel.animationBehavior == NSWindowAnimationBehaviorNone);
    result.Set("surface", NSStringFromRect(surfaceRect).UTF8String);
    result.Set("hasContour", surfacePath && !CGPathIsEmpty(surfacePath));
    result.Set("notch", NSStringFromRect(notchRect).UTF8String);
    result.Set("activation", NSStringFromRect(activationRect).UTF8String);
    result.Set("pointer", NSStringFromPoint(NSEvent.mouseLocation).UTF8String);
    return result;
  }));
  exports.Set("getGeometry", Napi::Function::New(env, Geometry));
  exports.Set("configure", Napi::Function::New(env, Configure));
  exports.Set("setSurface", Napi::Function::New(env, Surface));
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, [](const Napi::CallbackInfo &info) { if (OnMainThread(info)) Stop(); }));
  env.AddCleanupHook([] { Stop(); });
  return exports;
}
NODE_API_MODULE(macos_notch, Init)
