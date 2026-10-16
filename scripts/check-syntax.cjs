const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const ejs = require('ejs')
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(filename) : [filename]
  })
}
// Browser-JS (buildlos) und der Portal-Dienst (docker/portal, eigenes Image,
// sonst von keiner Prüfung erfasst).
const scripts = [
  ...walk('public/js').filter(f => f.endsWith('.js')),
  'public/sw.js',
  ...walk('docker/portal').filter(f => f.endsWith('.mjs')),
]
for (const filename of scripts) {
  execFileSync(process.execPath, ['--check', filename])
}
for (const filename of walk('src/views').filter(f => f.endsWith('.ejs'))) {
  ejs.compile(fs.readFileSync(filename, 'utf8'), { filename })
}
console.log('Browser-JavaScript, Portal-Dienst und EJS-Templates: Syntax OK.')
