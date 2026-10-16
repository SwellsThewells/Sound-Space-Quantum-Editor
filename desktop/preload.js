// The bridge between the editor (a web page) and the desktop app: Discord presence and files opened with the app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ssqeDesktop', {
    version: ipcRenderer.sendSync('ssqe-version'),
    // { details, state } shown on Discord
    setPresence: presence => ipcRenderer.send('ssqe-presence', presence),
    // files the app was opened with (double-clicking a .ssqes or .sspm): cb([{ name, bytes: Uint8Array }])
    onOpenFiles: cb => {
        ipcRenderer.on('ssqe-open-files', (_, files) => cb(files));
        ipcRenderer.send('ssqe-ready');
    },
});
