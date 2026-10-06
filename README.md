# Herdr EasyMotion

Jump directly between visible panes in the active [Herdr](https://github.com/ogulcancelik/herdr) tab with large numbered pane hints.

Herdr EasyMotion overlays each visible pane with a keyboard shortcut, then focuses the selected pane when you press the matching key. It is intended for layouts where directional pane movement is slower than selecting the destination directly.

Hold Shift while pressing a numbered pane shortcut to copy that pane's ID to the clipboard without switching panes.

![Herdr EasyMotion pane hints demo](assets/herdr-easymotion-pane-hints.png)

## Installation

Install the plugin:

```bash
herdr plugin install elliotekj/herdr-easymotion
```

On Herdr 0.9.3, the picker shows numbered pane IDs and their tab positions in a terminal popup. Press the matching shortcut to jump, or Esc/q to cancel. No graphics configuration is required.

On versions exposing the `pane.graphics.info/set/clear` socket APIs, graphical pane hints are used when experimental Kitty graphics support is enabled:

```toml
[experimental]
kitty_graphics = true
```

If the graphics API is unavailable or disabled, the plugin automatically uses the terminal picker. Enabling `kitty_graphics` cannot add missing socket methods; no server restart or version change is needed for the fallback.

The hint background follows the macOS light or dark appearance. On other platforms, or to override detection, set `HERDR_EASYMOTION_APPEARANCE` to `light` or `dark`.

## Usage

Invoke the plugin action directly:

```bash
herdr plugin action invoke com.elliotekj.herdr-easymotion.pane
```

Or add a keybinding to your Herdr config, for example:

```toml
[[keys.command]]
key = "prefix+e"
type = "plugin_action"
command = "com.elliotekj.herdr-easymotion.pane"
description = "select pane"
```

Hints target panes in the active tab layout. If the tab is zoomed, Herdr only exposes the zoomed pane as visible, so there is no alternate pane to jump to.

## License

[`Herdr EasyMotion`](LICENSE) is released under the Apache License 2.0.

## About

This plugin was written by Elliot Jackson.

- Blog: https://elliotekj.com
- Email: elliot@elliotekj.com
