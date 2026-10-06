# Herdr EasyMotion

Jump directly between visible panes in the active [Herdr](https://github.com/ogulcancelik/herdr) tab with large numbered pane hints.

Herdr EasyMotion captures the visible panes and reconstructs the tab in a full-size terminal popup, with a large keyboard shortcut and pane ID centered over each pane. Press the matching key to focus that real pane. It is intended for layouts where directional pane movement is slower than selecting the destination directly.

Hold Shift while pressing a numbered pane shortcut to copy that pane's ID to the clipboard without switching panes.

![Herdr EasyMotion pane hints demo](assets/herdr-easymotion-pane-hints.png)

## Installation

Install the plugin:

```bash
herdr plugin install elliotekj/herdr-easymotion
```

No Kitty graphics configuration or Herdr fork is required. The picker uses supported `pane.layout` and `pane.read` APIs, not the `pane.graphics.*` APIs removed in Herdr 0.9.2.

The background is a frozen text-and-color snapshot while you select; the underlying programs keep running and their terminals are not modified. Native images are not captured. Resizing refreshes the snapshots and layout while preserving the original shortcut-to-pane mapping. Small panes use compact hints.

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

Press a pane's shortcut to jump, Shift+number to copy its ID, or Esc, q, or Ctrl+C to cancel.

## License

[`Herdr EasyMotion`](LICENSE) is released under the Apache License 2.0.

## About

This plugin was written by Elliot Jackson.

- Blog: https://elliotekj.com
- Email: elliot@elliotekj.com
