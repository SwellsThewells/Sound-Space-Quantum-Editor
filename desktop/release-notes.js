// Prints the release notes for a new desktop release: the newest entry of the changelog, then how to install.
const fs = require('fs');
const path = require('path');

const text = fs.readFileSync(path.join(__dirname, '..', 'changelog'), 'utf8').replace(/\r/g, '');
// entries are separated by a line of dashes; the first block is a notice
const parts = text.split(/\n-{10,}\n/);
const latest = (parts[1] || parts[0]).trim();

console.log(latest);
console.log(`
---

**Download**
- \`Sound-Space-Quantum-Editor-Plus-Setup-*.exe\`: installs the app (with a desktop shortcut, and \`.ssqes\`/\`.sspm\` files opening with it)
- \`Sound-Space-Quantum-Editor-Plus-Portable-*.exe\`: runs without installing

Windows may warn that the app is from an unknown publisher (it isn't code-signed): choose *More info* > *Run anyway*.
The app checks for new releases when it starts. It also runs in the browser: https://iloverhythia.github.io/Sound-Space-Quantum-Editor/`);
