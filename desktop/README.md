# Sound Space Quantum Editor Plus (desktop app)

The web editor and map player (`../Web Editor`, `../Web Player`) as a Windows desktop app, built with Electron.

- Every update to `master` builds the app and publishes it as a GitHub release (`.github/workflows/desktop-release.yml`):
  an installer (`...-Setup-x.y.z.exe`) and a portable `.exe` that runs without installing. The release notes are the
  newest entry of `../changelog`.
- Discord rich presence shows what you're doing (in the menu, editing a map, playing a map). The application ID and
  the picture are at the top of `main.js` (`DISCORD_CLIENT_ID`, `DISCORD_IMAGE`). To have Discord show your own app
  name, create an application at https://discord.com/developers/applications and put its ID there.
- `.ssqes` setup files and `.sspm` maps open with the app (double-click them once it's installed).
- On start it checks GitHub for a newer release and offers to open the download page.

Run it from source: `npm install`, then `npm start`. Build locally: `npm run dist:win` (on Windows).
