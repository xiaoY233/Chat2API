const { createCanvas, loadImage } = require('canvas')
const fs = require('fs')
const path = require('path')

const ICON_SIZE = 1024
const PADDING_PERCENT = 0.05

async function addPadding(inputPath, outputPath) {
  const image = await loadImage(inputPath)
  const canvas = createCanvas(ICON_SIZE, ICON_SIZE)
  const ctx = canvas.getContext('2d')

  ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE)

  const padding = ICON_SIZE * PADDING_PERCENT
  const innerSize = ICON_SIZE - padding * 2

  const scale = Math.min(innerSize / image.width, innerSize / image.height)
  const scaledWidth = image.width * scale
  const scaledHeight = image.height * scale
  const x = (ICON_SIZE - scaledWidth) / 2
  const y = (ICON_SIZE - scaledHeight) / 2

  ctx.drawImage(image, x, y, scaledWidth, scaledHeight)

  const buffer = canvas.toBuffer('image/png')
  fs.writeFileSync(outputPath, buffer)
  console.log(`Icon saved to ${outputPath}`)
}

const inputPath = path.join(__dirname, '..', 'build', 'icon.png')
const outputPath = path.join(__dirname, '..', 'build', 'icon.png')

loadImage(inputPath).then(img => {
  console.log(`Original image size: ${img.width}x${img.height}`)
  return addPadding(inputPath, outputPath)
}).catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
