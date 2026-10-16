// Auto update (Windows), the parts that work on files: unpacking the release's zip, and the last step, which the NEW
// version's own .exe does, started from the unpacked download with --ssqe-finish-update=<job file>: wait until the old
// app has closed, copy the new files over it and start it again. No script and no PowerShell, and every step is
// written to update-log.txt in the app data.
// Every version from here on has to keep --ssqe-finish-update and the job's fields: the old version starts the new one
// with them.
'use strict';
// Electron's own fs treats .asar files as folders; original-fs works on them as the files they are
const fs = process.versions.electron ? require('original-fs') : require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const { spawn } = require('child_process');

const inflateRaw = promisify(zlib.inflateRaw);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FLAG = '--ssqe-finish-update=';

// appends to the update log (kept small)
function logger(file) {
    return (...parts) => {
        try {
            if (fs.existsSync(file) && fs.statSync(file).size > 200000)
                fs.renameSync(file, file + '.old');
            fs.appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${parts.join(' ')}\r\n`);
        } catch { /* a log that can't be written mustn't stop the update */ }
    };
}

// Unpacks a zip into dest: stored and deflated files, zip64 sizes, checked against their CRCs. onProgress(0..1).
async function unzip(zipFile, dest, onProgress = () => { }) {
    const buf = await fs.promises.readFile(zipFile);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--)
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    if (eocd < 0)
        throw new Error("the download isn't a zip");
    let count = buf.readUInt16LE(eocd + 10);
    let at = buf.readUInt32LE(eocd + 16);
    if ((count === 0xffff || at === 0xffffffff) && eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) {
        const z64 = Number(buf.readBigUInt64LE(eocd - 20 + 8));
        count = Number(buf.readBigUInt64LE(z64 + 32));
        at = Number(buf.readBigUInt64LE(z64 + 48));
    }
    const root = path.resolve(dest);
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(at) !== 0x02014b50)
            throw new Error('the zip is damaged');
        const madeOnUnix = buf.readUInt8(at + 5) === 3, mode = buf.readUInt32LE(at + 38) >>> 16;
        const flags = buf.readUInt16LE(at + 8), method = buf.readUInt16LE(at + 10), crc = buf.readUInt32LE(at + 16);
        let packed = buf.readUInt32LE(at + 20), size = buf.readUInt32LE(at + 24);
        const nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32);
        let local = buf.readUInt32LE(at + 42);
        const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', at + 46, at + 46 + nameLen).replace(/\\/g, '/');
        // zip64: the real sizes and offset are in an extra field, in this order, for those that didn't fit
        for (let e = at + 46 + nameLen, end = e + extraLen; e + 4 <= end;) {
            const id = buf.readUInt16LE(e), len = buf.readUInt16LE(e + 2);
            if (id === 1) {
                let f = e + 4;
                if (size === 0xffffffff) { size = Number(buf.readBigUInt64LE(f)); f += 8; }
                if (packed === 0xffffffff) { packed = Number(buf.readBigUInt64LE(f)); f += 8; }
                if (local === 0xffffffff) local = Number(buf.readBigUInt64LE(f));
            }
            e += 4 + len;
        }
        at += 46 + nameLen + extraLen + commentLen;

        const file = path.resolve(root, name);
        if (file !== root && !file.startsWith(root + path.sep))
            throw new Error(`the zip has a file outside its folder (${name})`);
        if (name.endsWith('/')) {
            await fs.promises.mkdir(file, { recursive: true });
            continue;
        }
        if (buf.readUInt32LE(local) !== 0x04034b50)
            throw new Error('the zip is damaged');
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.subarray(start, start + packed);
        let data;
        if (method === 0)
            data = raw;
        else if (method === 8)
            data = await inflateRaw(raw);
        else
            throw new Error(`the zip uses a packing this can't unpack (${method})`);
        if (data.length !== size || (zlib.crc32 && zlib.crc32(data) >>> 0 !== crc))
            throw new Error(`the download is damaged (${name})`);
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, data);
        if (madeOnUnix && mode & 0o111)
            await fs.promises.chmod(file, mode & 0o777);
        onProgress((n + 1) / count);
    }
}

// every file under dir, as paths relative to it
function filesIn(dir, rel = '') {
    const out = [];
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const r = path.join(rel, e.name);
        if (e.isDirectory())
            out.push(...filesIn(dir, r));
        else
            out.push(r);
    }
    return out;
}

// the environment for a process started by the app, without what Electron and Chromium set for their own children
function cleanEnv() {
    const env = { ...process.env };
    for (const k of Object.keys(env))
        if (/^(ELECTRON_|CHROME_CRASHPAD)/i.test(k))
            delete env[k];
    return env;
}

// starts a program on its own (it keeps running after this process ends); resolves once it has started
function launch(exe, args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn(exe, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false, env: cleanEnv() });
        child.once('error', reject);
        child.once('spawn', () => {
            child.unref();
            resolve(child.pid);
        });
    });
}

const alive = pid => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
};

// The last step, in the new version's .exe from the download: job = { pid, files, installDir, exe, result, version, log }
async function finish(app, jobFile) {
    let job;
    try {
        job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
    } catch {
        app.exit(1);
        return;
    }
    const log = logger(job.log);
    log('finishing the update to', job.version, 'from', job.files);
    let error = null;
    try {
        // the old app closes after saving (a few seconds)
        for (let i = 0; i < 600 && job.pid && alive(job.pid); i++)
            await sleep(100);
        if (job.pid && alive(job.pid))
            throw new Error("the app didn't close");
        log('the old app has closed');
        // its other processes (and antivirus scans) can keep files locked for a moment: each file is tried again for a
        // while. The .exe goes last, so it's the old one if anything before it fails.
        const exeName = path.basename(job.exe).toLowerCase();
        const list = filesIn(job.files).sort((a, b) => (a.toLowerCase() === exeName) - (b.toLowerCase() === exeName));
        for (const rel of list) {
            const to = path.join(job.installDir, rel);
            for (let tries = 0; ; tries++) {
                try {
                    await fs.promises.mkdir(path.dirname(to), { recursive: true });
                    await fs.promises.copyFile(path.join(job.files, rel), to);
                    break;
                } catch (e) {
                    if (tries >= 60)
                        throw new Error(`couldn't replace ${rel} (${e.code || e.message})`);
                    await sleep(500);
                }
            }
        }
        log('copied', list.length, 'files to', job.installDir);
    } catch (e) {
        error = e.message;
        log('FAILED:', error);
    }
    try {
        fs.writeFileSync(job.result, JSON.stringify({ ok: !error, version: job.version, error }));
    } catch (e) {
        log("couldn't write the result:", e.message);
    }
    try {
        const pid = await launch(job.exe, [], job.installDir);
        log('started the app again, process', pid);
    } catch (e) {
        log("couldn't start the app again:", e.message);
    }
    app.exit(0);
}

// The update folders in the temp folder, once the app has started again (the helper may take a moment to close),
// except the one an update that has started since is using (inUse() gives its path)
function cleanUp(tempDir, inUse) {
    setTimeout(() => {
        try {
            for (const name of fs.readdirSync(tempDir))
                if (/^ssqe-plus-update/.test(name) && path.join(tempDir, name) !== inUse())
                    fs.rm(path.join(tempDir, name), { recursive: true, force: true, maxRetries: 3 }, () => { });
        } catch { /* nothing to clean */ }
    }, 15000);
}

module.exports = { FLAG, logger, unzip, launch, finish, cleanUp };
