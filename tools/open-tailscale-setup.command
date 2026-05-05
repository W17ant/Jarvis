#!/usr/bin/env bash
# open-tailscale-setup.command — wrapper that the HUD's settings panel
# launches via `open -a Terminal`. macOS treats `.command` files as
# "double-click to open in Terminal", so this opens its own window where
# the operator can step through sudo + browser SSO at their own pace.
#
# Why a wrapper: the bridge can't run `sudo tailscale up` itself (no TTY
# for the password prompt + browser auth). Handing off to Terminal lets
# the operator finish the flow with the keyboard.

cd "$(dirname "$0")/.."
exec ./tools/install-tailscale.sh
