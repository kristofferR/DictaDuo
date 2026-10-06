# Bundled Wayland protocols

Definitions retain their upstream copyright and MIT license. Linux packages
install the XML files in `share/licenses/dictaduo`.
Trailing whitespace is normalized.

| Definition | Pinned upstream source |
| --- | --- |
| Virtual keyboard | [wtype d71be3a](https://github.com/atx/wtype/blob/d71be3a7b3f93b534a2823fd68cabd7ac2a02359/protocol/virtual-keyboard-unstable-v1.xml) |
| wlr data control | [wlr-protocols b010a03](https://github.com/swaywm/wlr-protocols/blob/b010a03648b88d143236de193bddbfea0c08bc84/unstable/wlr-data-control-unstable-v1.xml) |
| ext data control | [wayland-protocols 819004a](https://github.com/wayland-mirror/wayland-protocols/blob/819004adb3ab7e46f3fa3caef05b96e20434b244/staging/ext-data-control/ext-data-control-v1.xml) |
| Input method v2 | [wayland-rs ad7d6a9](https://github.com/Smithay/wayland-rs/blob/ad7d6a9b366441769990de04425ea2371e8a0e53/wayland-protocols-misc/protocols/input-method-unstable-v2.xml) |

The broker is compiled against each data-control interface separately. KWin
implements [ext data control](https://github.com/KDE/kwin/blob/master/src/wayland/datacontroldevicemanager_v1.cpp);
wlr-only implementations use the other binary. Input-method availability is
probed without a keyboard grab; an existing input method is never displaced.
