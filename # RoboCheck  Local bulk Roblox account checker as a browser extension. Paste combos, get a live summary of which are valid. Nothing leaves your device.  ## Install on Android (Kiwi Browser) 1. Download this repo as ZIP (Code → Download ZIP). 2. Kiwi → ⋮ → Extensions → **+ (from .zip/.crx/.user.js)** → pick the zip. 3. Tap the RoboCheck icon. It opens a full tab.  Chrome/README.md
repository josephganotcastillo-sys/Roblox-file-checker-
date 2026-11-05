# RoboCheck

Local bulk Roblox account checker as a browser extension. Paste combos, get a live summary of which are valid. Nothing leaves your device.

## Install on Android (Kiwi Browser)
1. Download this repo as ZIP (Code → Download ZIP).
2. Kiwi → ⋮ → Extensions → **+ (from .zip/.crx/.user.js)** → pick the zip.
3. Tap the RoboCheck icon. It opens a full tab.

Chrome/Firefox mobile do not support extensions — use Kiwi or Firefox Nightly with debug extensions.

## Install on desktop
chrome://extensions → Developer mode → Load unpacked → select folder.

## Notes
- `.ROBLOSECURITY` is backed up before a run and restored after, so you stay logged in.
- Accounts behind captcha report `captcha` — retry them with threads = 1 and delay ≥ 1000.
- Robux only populates when threads = 1.
- Use ≤ 5 threads for big lists to avoid 429s.
