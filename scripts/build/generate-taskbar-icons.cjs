// Run with Node. Electron rasterizes the vector shapes without an additional image dependency.
// The resulting multi-resolution ICOs are committed; packaging does not need to run this script.
const electron = require('electron')
if (typeof electron === 'string') {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = require('node:child_process').spawnSync(electron, [__filename], {
    env, stdio: 'inherit', windowsHide: true,
  })
  if (result.error) console.error(result.error)
  process.exit(result.status ?? 1)
}

const { app, BrowserWindow } = electron
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const output = join(__dirname, '../../resources/taskbar')
app.setPath('userData', mkdtempSync(join(tmpdir(), 'astra-taskbar-icons-')))
const sizes = [16, 20, 24, 32, 40, 48, 64]
const heart = 'M12 20.5 3.5 12A5.4 5.4 0 0 1 12 5.4 5.4 5.4 0 0 1 20.5 12Z'
const shapes = {
  favorite: `<path d="${heart}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`,
  favorited: `<path d="${heart}"/>`,
  previous: '<path d="M5 5h3v14H5zM19 5v14L8 12z"/>',
  play: '<path d="M7 4.5v15L20 12z"/>',
  pause: '<path d="M5 5h5v14H5zM14 5h5v14h-5z"/>',
  next: '<path d="M16 5h3v14h-3zM5 5v14l11-7z"/>',
}

function encodeIco(images) {
  const header = Buffer.alloc(6 + images.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16
    header[entry] = size
    header[entry + 1] = size
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map(image => image.png)])
}

app.whenReady().then(async () => {
  mkdirSync(output, { recursive: true })
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  await win.loadURL('about:blank')
  for (const [theme, color] of [['dark', '#f5f5f5'], ['light', '#262626']]) {
    for (const [name, shape] of Object.entries(shapes)) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="${color}" color="${color}">${shape}</svg>`
      const svgUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
      const images = []
      for (const size of sizes) {
        const dataUrl = await win.webContents.executeJavaScript(`(async () => {
          const image = new Image(); image.src = ${JSON.stringify(svgUrl)}; await image.decode();
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = ${size};
          canvas.getContext('2d').drawImage(image, 0, 0, ${size}, ${size});
          return canvas.toDataURL('image/png');
        })()`)
        images.push({ size, png: Buffer.from(dataUrl.split(',')[1], 'base64') })
      }
      writeFileSync(join(output, `${name}-${theme}.ico`), encodeIco(images))
    }
  }
  console.log('Generated 12 Windows taskbar icons (16–64px).')
  win.destroy()
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})
