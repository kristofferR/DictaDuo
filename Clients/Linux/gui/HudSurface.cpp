#include "HudSurface.h"
#include <LayerShellQt/Window>
#include <QGuiApplication>

void HudSurface::configure(QWindow *window) {
  if (!window || !QGuiApplication::platformName().startsWith("wayland"))
    return;

  // Attach before QML can show the window. Only the HUD gets a layer surface;
  // the settings window keeps its ordinary desktop window role.
  auto *layer = LayerShellQt::Window::get(window);
  layer->setScope("dictaduo-dictation");
  layer->setLayer(LayerShellQt::Window::LayerOverlay);
  layer->setAnchors(LayerShellQt::Window::AnchorBottom);
  layer->setMargins(QMargins(0, 0, 0, 80));
  layer->setExclusiveZone(-1);
  layer->setKeyboardInteractivity(
      LayerShellQt::Window::KeyboardInteractivityNone);
  layer->setActivateOnShow(false);
  layer->setWantsToBeOnActiveScreen(true);
}
