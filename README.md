# GlucoseAnywhere

See your Dexcom glucose reading in any browser or on Windows. Not affiliated with Dexcom. Not a medical device.

| | Web app (PWA) | Windows app |
|---|---|---|
| Folder | `web/` | `desktop/` |
| Runs on | Any modern browser; installable on phones and desktops | Windows 10/11 x64 |
| Data | Stays in the browser (localStorage + IndexedDB) | `%APPDATA%\GlucoseAnywhere`, password encrypted with DPAPI |
| Server | None. The browser talks straight to Dexcom Share | None |

Both need the Dexcom account of the **person wearing the sensor** (not a follower's), with Share on and at least one follower.

## Web app

Static files, no build step. To try it locally: `npx serve web`, then open the printed URL (service workers need `localhost` or HTTPS).

### Deploy to Cloudflare Pages

1. Cloudflare dashboard, Workers & Pages, Create, Pages, Upload assets. Upload the **contents** of `web/` (or `dist/GlucoseAnywhere-web-v1.0.0.zip`). `_headers` must sit at the root of what you upload.
2. Pages project, Custom domains, add `glucoseanywhere.com`.

`_headers` sets a strict Content-Security-Policy: scripts and styles only from the site itself, network calls only to Dexcom's three Share hosts. Keep it that way. The saved Dexcom password lives in this origin's storage, so **never add third-party scripts (ads, analytics, widgets) to the web app's origin.**

## Windows app

`desktop/` holds the WPF source. Build the single-file exe:

```
dotnet publish desktop/GlucoseAnywhere.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o desktop/publish
```

The exe is unsigned, so Windows SmartScreen will warn on first run (More info, Run anyway).

## Release files (`dist/`)

- `GlucoseAnywhere-win-x64-v1.0.0.zip`: Windows app + README.txt
- `GlucoseAnywhere-web-v1.0.0.zip`: the web app, for self-hosting

## Privacy and verification

Nothing is sent anywhere except to Dexcom's servers, to sign in and fetch readings. There is no GlucoseAnywhere server, account or analytics. The web app's Settings, About section explains how to check this in your browser's network tab, and has a "Show what's stored" button listing everything saved on the device (the password is never displayed).

Where to look in the code:

- `web/dexcom.js`: the only file that contacts Dexcom.
- `web/store.js`: the only file that saves user data.
- `web/_headers`: the Content-Security-Policy that stops the page connecting anywhere else.
- `desktop/GlucoseAnywhere.Core/DexcomClient.cs`: the Windows app's only network code.

## Publishing

- `docs/itch-page.md`: the itch.io page text, file list, `butler` command and a pre-publish checklist.
- `dist/SHA256SUMS.txt`: checksums for the release zips (regenerate when you rebuild them).

## License

[MIT](LICENSE). Not affiliated with or endorsed by Dexcom.

## Notes

- Dexcom Share is an unofficial API and can change or stop at any time.
- Don't use this in place of the Dexcom app's alarms.
- Readings are kept on the device for up to 90 days.
