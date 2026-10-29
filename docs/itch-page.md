# itch.io page for GlucoseAnywhere

Copy these into the itch.io project editor. Nothing here is published automatically.

## Project settings

| Field | Value |
|---|---|
| Title | GlucoseAnywhere |
| Project URL | `glucoseanywhere.itch.io/glucoseanywhere` (any free URL works) |
| Short description / tagline | A free, no-setup big-screen glucose display for any browser or Windows PC. |
| Kind of project | **Downloadable** (the web version is linked from the description) |
| Classification | **Tools** |
| Release status | Released |
| Pricing | **Free**, or **$0 or donate** so people can leave a tip. No ads. |
| Tags | `diabetes`, `glucose`, `cgm`, `dexcom`, `health`, `utility`, `open-source`, `pwa` |
| Platforms | **Windows** |
| Community | Optional: enable comments so people can report problems |

## Files to upload

1. `dist/GlucoseAnywhere-win-x64-v1.0.0.zip` &mdash; mark as **Windows**.
2. `dist/SHA256SUMS.txt` &mdash; upload as an extra file so people can check their download.
3. Optional: `dist/GlucoseAnywhere-web-v1.0.0.zip` &mdash; for people who want to host the web app themselves. Mark it as **Other**, or leave the platform boxes empty.

With the itch `butler` tool instead (after `butler login`):

```
butler push dist/GlucoseAnywhere-win-x64-v1.0.0.zip YOUR-ITCH-USERNAME/glucoseanywhere:windows --userversion 1.0.0
```

For later releases, bump the version in `--userversion` and push again. itch.io only uploads what changed and tells people who installed it with the itch app that an update is available.

## Description (paste as is)

```markdown
**See your Dexcom glucose reading on any screen: a phone, a PC, a TV, a wall display.**

GlucoseAnywhere shows your current reading, trend arrow and a 3, 6, 12 or 24 hour chart, in a light or dark theme. Tap the expand button (double-click the number on Windows) for a big, always-on display. It's free, has no ads, and sets up in about 30 seconds.

## Made for a wall or desk display

Put a spare tablet, old phone or monitor to work as an always-on readout. Big-number mode fills the screen, keeps the display awake, and can open automatically every time the app starts. A stray tap won't close it: tapping only shows the controls. Works in portrait and landscape.

## Two ways to use it

**In your browser (nothing to install):** https://glucoseanywhere.com
Works in any modern browser. On a phone, use "Add to Home Screen" to install it like an app.

**On Windows:** download GlucoseAnywhere from this page, unzip, and run `GlucoseAnywhere.exe`. No installer.

## What you need

The Dexcom account of the **person wearing the sensor** (a follower's login won't work), with **Share turned on** and at least one follower in the Dexcom app.

## Your privacy

- Your sign-in and readings stay **on your own device**. There is no GlucoseAnywhere server, account, ad or analytics.
- The only servers the app talks to are Dexcom's, to sign in and fetch your readings.
- On the web, your password is saved in your browser so the app can sign in again. On Windows, it's encrypted with your Windows account. Use a Dexcom password you don't use anywhere else.
- Don't take our word for it: the web app has a **"Verify it yourself"** section in Settings, and the code is open source (MIT): https://github.com/SantasLair/glucoseanywhere

## Important

- **Not a medical device.** Don't use it to make treatment decisions, and don't use it instead of the Dexcom app's alarms. It has no alerts.
- **Not affiliated with or endorsed by Dexcom.** "Dexcom" is a trademark of its owner.
- It uses Dexcom's unofficial Share service, which can change or stop working at any time.

## Windows download notes

- The exe isn't code-signed, so Windows SmartScreen may warn: click **More info**, then **Run anyway**.
- Check your download against `SHA256SUMS.txt`. In PowerShell: `Get-FileHash .\GlucoseAnywhere-win-x64-v1.0.0.zip`.
- Windows 10 or 11, 64-bit.

## Feedback

Found a problem? Use the comments here or open an issue on GitHub.
```

## Before you hit publish

- [ ] Replace the hashes: run `Get-FileHash` on the final zip and make sure it matches `SHA256SUMS.txt`.
- [ ] Set the page to **Draft** first, open the preview, and click every link.
- [ ] Add 2 to 3 screenshots (home, big mode, settings).
- [ ] Confirm https://glucoseanywhere.com is live and a real sign-in works before linking to it.
- [ ] Decide on the repo: the description above links to the GitHub source, so the repo must be public first.
