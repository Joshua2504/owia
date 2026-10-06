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
for (const filename of [...walk('public/js'), 'public/sw.js'].filter(f => f.endsWith('.js'))) {
  execFileSync(process.execPath, ['--check', filename])
}
for (const filename of walk('src/views').filter(f => f.endsWith('.ejs'))) {
  ejs.compile(fs.readFileSync(filename, 'utf8'), { filename })
}
console.log('Browser-JavaScript und EJS-Templates: Syntax OK.')
