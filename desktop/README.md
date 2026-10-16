# Sound Space Quantum Editor Plus (desktop app)

The web editor and map player (`../Web Editor`, `../Web Player`) as a Windows desktop app, built with Electron.

- Every update to `master` builds the app and publishes it as a GitHub release (`.github/workflows/desktop-release.yml`):
  `SSQEPlus<version>.zip`, with `Sound Space Quantum Editor Plus.exe` inside, like the original editor's zips. The
  release notes are the newest entry of `../changelog`.
- It updates itself: on start (when Check For Updates is on) it looks for a newer release, downloads and unpacks its
  zip, and starts the new version's own .exe from it, which waits for the app to close, copies the new files over the
  old ones and starts it again (`update.js`). Every step is written to `update-log.txt` in the app data.
- Playtesting in Rhythia: the path is chosen in SETTINGS > PLAYER and kept by the app (`desktop-settings.json` in its
  app data), and PLAYTEST starts Rhythia with the map and song like the original editor.
- Discord rich presence shows what you're doing (in the menu, editing a map, playing a map). The application ID and
  the picture are at the top of `main.js` (`DISCORD_CLIENT_ID`, `DISCORD_IMAGE`). To have Discord show your own app
  name, create an application at https://discord.com/developers/applications and put its ID there.
- `.ssqes` setup files and `.sspm` maps opened with the app ("Open with") are loaded.

Run it from source: `npm install`, then `npm start`. Build locally: `npm run dist:win` (on Windows).
