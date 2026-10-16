// Sound Space Quantum Editor Plus as a desktop app: the web editor and map player in their own window, served from
// the files that come with the app, with Discord rich presence, files opened with the app (.ssqes setups, .sspm
// maps) and a check for new releases.
const { app, BrowserWindow, protocol, net, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const NAME = 'Sound Space Quantum Editor Plus';
const REPO = 'iloverhythia/Sound-Space-Quantum-Editor';
// Discord: the application whose name Discord shows, and the picture for the presence (a link, so it can be changed
// without uploading anything to Discord)
const DISCORD_CLIENT_ID = '1067849747710345346';
const DISCORD_IMAGE = 'https://iloverhythia.github.io/Sound-Space-Quantum-Editor/discord.png';

// the web editor, map player and changelog: next to this folder while developing, in resources/app when installed
const ROOT = app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..');
const START = 'ssqe://app/Web%20Editor/index.html';
const OPENABLE = /\.(ssqes|sspm|rhm|txt|ini|osu|mp3|ogg|wav|flac|m4a|opus)$/i;

app.setName(NAME);
if (process.platform === 'win32')
    app.setAppUserModelId('io.github.swellsthewells.ssqeplus');

// ------------------------------------------------ the pages, served as ssqe://app/...

protocol.registerSchemesAsPrivileged([{
    scheme: 'ssqe',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}]);

function serve(request) {
    const url = new URL(request.url);
    let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    // nothing outside the app's own files
    if (file !== ROOT && !file.startsWith(ROOT + path.sep))
        return new Response('Not found', { status: 404 });
    try {
        if (fs.statSync(file).isDirectory())
            file = path.join(file, 'index.html');
    } catch {
        return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(file).toString());
}

// ------------------------------------------------ files opened with the app

let win = null, pageReady = false;
let pending = [];

function filesFrom(argv) {
    return argv.slice(1).filter(a => !a.startsWith('-') && OPENABLE.test(a) && fs.existsSync(a));
}

function sendFiles(paths) {
    if (!paths.length)
        return;
    if (!win || !pageReady) {
        pending.push(...paths);
        return;
    }
    const files = paths.map(p => ({ name: path.basename(p), bytes: new Uint8Array(fs.readFileSync(p)) }));
    win.webContents.send('ssqe-open-files', files);
}

// ------------------------------------------------ Discord rich presence

let rpc = null, rpcReady = false, rpcRetry = null;
let presence = { details: 'In the menu', state: '' }, presenceSince = Date.now(), sent = '';

function startDiscord() {
    clearTimeout(rpcRetry);
    try {
        const { Client } = require('@xhayper/discord-rpc');
        rpc = new Client({ clientId: DISCORD_CLIENT_ID });
        rpc.on('ready', () => {
            rpcReady = true;
            sent = '';
            pushPresence();
        });
        rpc.on('disconnected', () => {
            rpcReady = false;
            rpcRetry = setTimeout(startDiscord, 30000);
        });
        // Discord isn't open: try again in a while
        rpc.login().catch(() => {
            rpcReady = false;
            rpcRetry = setTimeout(startDiscord, 30000);
        });
    } catch {
        rpc = null;
    }
}

function pushPresence() {
    if (!rpc || !rpcReady || !rpc.user)
        return;
    const key = JSON.stringify(presence);
    if (key === sent)
        return;
    sent = key;
    rpc.user.setActivity({
        details: String(presence.details || NAME).slice(0, 128),
        state: presence.state ? String(presence.state).slice(0, 128) : undefined,
        startTimestamp: presenceSince,
        largeImageKey: DISCORD_IMAGE,
        largeImageText: `${NAME} ${app.getVersion()}`,
    }).catch(() => { sent = ''; });
}

ipcMain.on('ssqe-presence', (_, next) => {
    if (!next || typeof next !== 'object')
        return;
    // the timer starts again when what you're doing changes (menu, editing, playing)
    if (next.details !== presence.details && String(next.details).split(' - ')[0] !== String(presence.details).split(' - ')[0])
        presenceSince = Date.now();
    presence = { details: next.details, state: next.state };
    pushPresence();
});

ipcMain.on('ssqe-version', e => { e.returnValue = app.getVersion(); });
ipcMain.on('ssqe-ready', () => {
    pageReady = true;
    const paths = pending;
    pending = [];
    sendFiles(paths);
});

// ------------------------------------------------ new releases

function newer(a, b) {
    const pa = String(a).replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
    const pb = String(b).replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++)
        if ((pa[i] || 0) !== (pb[i] || 0))
            return (pa[i] || 0) > (pb[i] || 0);
    return false;
}

async function checkForUpdate() {
    if (!app.isPackaged)
        return;
    try {
        const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
        if (!res.ok)
            return;
        const release = await res.json();
        if (!release.tag_name || !newer(release.tag_name, app.getVersion()))
            return;
        const { response } = await dialog.showMessageBox(win, {
            type: 'info',
            title: NAME,
            message: `${NAME} ${release.tag_name.replace(/^v/, '')} is out (you have ${app.getVersion()}).`,
            detail: String(release.body || '').slice(0, 900),
            buttons: ['Download', 'Later'],
            defaultId: 0,
            cancelId: 1,
        });
        if (response === 0)
            shell.openExternal(release.html_url);
    } catch { /* offline: try next time */ }
}

// ------------------------------------------------ the window

function createWindow() {
    win = new BrowserWindow({
        width: 1600,
        height: 900,
        minWidth: 960,
        minHeight: 540,
        title: NAME,
        backgroundColor: '#1e1e1e',
        icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
        autoHideMenuBar: true,
        show: false,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
    });
    win.once('ready-to-show', () => win.show());
    // links (feedback form, GitHub) open in the browser
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url))
            shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith('ssqe://')) {
            e.preventDefault();
            if (/^https?:/i.test(url))
                shell.openExternal(url);
        }
    });
    // a reload (after importing a setup) asks for the opened files again
    win.webContents.on('did-start-navigation', (_, url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace)
            pageReady = false;
    });
    win.webContents.on('before-input-event', (e, input) => {
        if (input.type === 'keyDown' && input.key === 'F11') {
            win.setFullScreen(!win.isFullScreen());
            e.preventDefault();
        }
    });
    win.on('closed', () => { win = null; });
    win.loadURL(START);
}

if (!app.requestSingleInstanceLock())
    app.quit();
else {
    // opening another file while the app is open: it goes to this window
    app.on('second-instance', (_, argv) => {
        if (win) {
            if (win.isMinimized())
                win.restore();
            win.focus();
        }
        sendFiles(filesFrom(argv));
    });
    app.on('open-file', (e, file) => {
        e.preventDefault();
        sendFiles([file]);
    });
    pending.push(...filesFrom(process.argv));

    app.whenReady().then(() => {
        Menu.setApplicationMenu(null);
        protocol.handle('ssqe', serve);
        createWindow();
        startDiscord();
        setTimeout(checkForUpdate, 4000);
        app.on('activate', () => {
            if (!BrowserWindow.getAllWindows().length)
                createWindow();
        });
    });
    app.on('window-all-closed', () => {
        try {
            rpc && rpc.destroy();
        } catch { /* closing anyway */ }
        app.quit();
    });
}
