// Sound Space Quantum Editor Plus as a desktop app: the web editor and map player in their own window, served from
// the files that come with the app, with Discord rich presence, files opened with the app (.ssqes setups, .sspm
// maps) and a check for new releases.
const { app, BrowserWindow, protocol, net, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { Readable } = require('stream');

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

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain',
    '.md': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff': 'font/woff',
    '.woff2': 'font/woff2', '.webm': 'video/webm', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
    '.wav': 'audio/wav', '.obj': 'text/plain', '.wasm': 'application/wasm', '': 'text/plain',
};

// Files are sent in the parts asked for (byte ranges): videos and long songs need that to load and seek
function serve(request) {
    const url = new URL(request.url);
    let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    // nothing outside the app's own files
    if (file !== ROOT && !file.startsWith(ROOT + path.sep))
        return new Response('Not found', { status: 404 });
    let stat;
    try {
        stat = fs.statSync(file);
        if (stat.isDirectory()) {
            file = path.join(file, 'index.html');
            stat = fs.statSync(file);
        }
    } catch {
        return new Response('Not found', { status: 404 });
    }
    const size = stat.size;
    const headers = { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
    if (range && size > 0) {
        let start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
        let end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start > end || start >= size)
            return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
            status: 206,
            headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
        });
    }
    return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
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
// the editor asks for the update check once it's open (it has the 'Check For Updates' setting)
ipcMain.on('ssqe-check-updates', (_, enabled) => {
    if (enabled !== false)
        setTimeout(checkForUpdate, 1500);
});
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

// Auto update (Windows): the new release's zip is downloaded, then a little PowerShell script waits for the app to
// close, puts the new files over the old ones and starts it again. Settings and maps are kept (they live in the
// user's app data, not next to the .exe). Where the app's folder can't be written to, the download page opens instead.
let checked = false;
async function checkForUpdate() {
    if (!app.isPackaged || checked)
        return;
    checked = true;
    let release;
    try {
        const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
        if (!res.ok)
            return;
        release = await res.json();
    } catch {
        return; // offline: try next time
    }
    if (!release.tag_name || !newer(release.tag_name, app.getVersion()))
        return;
    const version = release.tag_name.replace(/^v/, '');
    const asset = (release.assets || []).find(a => /^SSQEPlus.*\.zip$/i.test(a.name));
    const installDir = path.dirname(process.execPath);
    const canInstall = process.platform === 'win32' && asset && writable(installDir);
    const { response } = await dialog.showMessageBox(win, {
        type: 'info',
        title: NAME,
        message: `${NAME} ${version} is out (you have ${app.getVersion()}).`,
        detail: `${String(release.body || '').split('\n---')[0].slice(0, 900)}${canInstall ? '' : '\n\n(The new version opens in your browser to download.)'}`,
        buttons: [canInstall ? 'Update Now' : 'Download', 'Later'],
        defaultId: 0,
        cancelId: 1,
    });
    if (response !== 0)
        return;
    if (!canInstall) {
        shell.openExternal(release.html_url);
        return;
    }
    try {
        await installUpdate(asset, installDir, version);
    } catch (e) {
        progress(null);
        const again = await dialog.showMessageBox(win, {
            type: 'error', title: NAME, message: `The update couldn't be installed: ${e.message}`,
            buttons: ['Open Download Page', 'Close'], defaultId: 0, cancelId: 1,
        });
        if (again.response === 0)
            shell.openExternal(release.html_url);
    }
}

function writable(dir) {
    try {
        const probe = path.join(dir, `.ssqe-write-test-${process.pid}`);
        fs.writeFileSync(probe, '');
        fs.unlinkSync(probe);
        return true;
    } catch {
        return false;
    }
}

// shows the download in the window (and on the taskbar button); null hides it
function progress(text, fraction = -1) {
    if (!win)
        return;
    win.setProgressBar(text === null ? -1 : fraction < 0 ? 2 : fraction);
    win.webContents.send('ssqe-update-progress', text);
}

async function installUpdate(asset, installDir, version) {
    const dir = path.join(app.getPath('temp'), 'ssqe-plus-update');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(dir, 'update.zip');

    progress('DOWNLOADING UPDATE...', 0);
    const res = await net.fetch(asset.browser_download_url);
    if (!res.ok || !res.body)
        throw new Error(`the download failed (${res.status})`);
    const total = Number(res.headers.get('content-length')) || asset.size || 0;
    const out = fs.createWriteStream(zip);
    let done = 0, shown = -1;
    for await (const chunk of res.body) {
        done += chunk.length;
        if (!out.write(chunk))
            await new Promise(r => out.once('drain', r));
        const pct = total ? Math.floor(done / total * 100) : -1;
        if (pct !== shown) {
            shown = pct;
            progress(`DOWNLOADING UPDATE ${version}${pct >= 0 ? ` - ${pct}%` : '...'}`, total ? done / total : -1);
        }
    }
    await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
    if (total && done < total)
        throw new Error('the download was cut off');

    progress('INSTALLING UPDATE...');
    const q = p => `'${p.replace(/'/g, "''")}'`;
    const exe = path.join(installDir, path.basename(process.execPath));
    const script = path.join(dir, 'update.ps1');
    const files = path.join(dir, 'files');
    // (a byte order mark, so Windows PowerShell reads paths with accents in them right)
    fs.writeFileSync(script, '\ufeff' + [
        '$ErrorActionPreference = "Stop"',
        `$log = ${q(path.join(dir, 'update.log'))}`,
        'try {',
        `    Wait-Process -Id ${process.pid} -Timeout 60 -ErrorAction SilentlyContinue`,
        '    Start-Sleep -Milliseconds 800',
        `    New-Item -ItemType Directory -Force -Path ${q(files)} | Out-Null`,
        // Windows' own tar unpacks zips quickly; Expand-Archive if it isn't there
        '    $unpacked = $false',
        `    try { & "$env:SystemRoot\\System32\\tar.exe" -xf ${q(zip)} -C ${q(files)}; $unpacked = ($LASTEXITCODE -eq 0) } catch { }`,
        `    if (-not $unpacked) { Expand-Archive -LiteralPath ${q(zip)} -DestinationPath ${q(files)} -Force }`,
        // the old app's helper processes can take a moment to let go of its files
        '    for ($i = 0; $i -lt 10; $i++) {',
        `        try { Copy-Item -Path (Join-Path ${q(files)} '*') -Destination ${q(installDir)} -Recurse -Force; break }`,
        '        catch { if ($i -eq 9) { throw }; Start-Sleep -Seconds 1 }',
        '    }',
        '    "updated" | Out-File $log',
        '} catch {',
        '    $_ | Out-File $log',
        '}',
        `Start-Process -FilePath ${q(exe)}`,
    ].join('\r\n'), 'utf8');
    await new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script], {
            detached: true, stdio: 'ignore', windowsHide: true,
        });
        child.once('error', reject);
        child.once('spawn', () => {
            child.unref();
            resolve();
        });
    });
    app.quit();
}

// ------------------------------------------------ playtesting in Rhythia

// The games' paths are kept here, chosen with the file picker, never taken from the editor's settings (so a shared
// setup file can't make PLAYTEST start some other program)
const prefsFile = () => path.join(app.getPath('userData'), 'desktop-settings.json');
function prefs() {
    try {
        return JSON.parse(fs.readFileSync(prefsFile(), 'utf8'));
    } catch {
        return {};
    }
}

ipcMain.handle('ssqe-playtest-paths', () => {
    const p = prefs();
    return { Rhythia: p.rhythiaPath || '', Novastra: p.novaPath || '' };
});

ipcMain.handle('ssqe-pick-playtest', async (_, game) => {
    const key = game === 'Novastra' ? 'novaPath' : 'rhythiaPath';
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: `Choose ${game === 'Novastra' ? 'Novastra' : 'Rhythia'}`,
        properties: ['openFile'],
        filters: process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }, { name: 'All Files', extensions: ['*'] }] : [],
    });
    if (canceled || !filePaths.length)
        return null;
    const p = prefs();
    p[key] = filePaths[0];
    fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
    fs.writeFileSync(prefsFile(), JSON.stringify(p, null, 2));
    return filePaths[0];
});

// Like the original editor: the map as a .txt and the song next to it in a temp folder, and Rhythia started with
// --a=<audio> --t=<map> --sp=<speed> --sf=<start ms>
ipcMain.handle('ssqe-playtest', async (_, job) => {
    try {
        if (!job || job.game !== 'Rhythia')
            return { error: 'Only Rhythia playtests are supported.' };
        const exe = prefs().rhythiaPath;
        if (!exe || !fs.existsSync(exe))
            return { error: 'INVALID RHYTHIA PATH [MENU > SETTINGS > PLAYER]' };
        const dir = path.join(app.getPath('temp'), 'ssqe-plus-playtest');
        fs.mkdirSync(dir, { recursive: true });
        const ext = /^(mp3|ogg|wav|flac|m4a)$/.test(job.audioExt) ? job.audioExt : 'mp3';
        const audio = path.join(dir, `tempaudio.${ext}`), txt = path.join(dir, 'tempmap.txt');
        fs.writeFileSync(audio, Buffer.from(job.audio));
        fs.writeFileSync(txt, String(job.txt));
        const slash = p => p.replace(/\\/g, '/');
        const args = [`--a=${slash(audio)}`, `--t=${slash(txt)}`, `--sp=${Number(job.tempo) || 1}`, `--sf=${Math.max(0, Math.floor(Number(job.startMs) || 0))}`];
        spawn(exe, args, { cwd: path.dirname(exe), detached: true, stdio: 'ignore' }).unref();
        return { ok: true };
    } catch (e) {
        return { error: `FAILED TO START RHYTHIA (${e.message})` };
    }
});

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
