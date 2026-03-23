const Jimp = require('jimp');

async function main() {
  const img = await Jimp.read('icon.png');
  const w = img.bitmap.width;
  const h = img.bitmap.height;
  
  console.log(`Image size: ${w}x${h}`);
  
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  const centerColor = Jimp.intToRGBA(img.getPixelColor(cx, cy));
  console.log('Center color:', centerColor);

  const outImg = new Jimp(w, h, 0x00000000); // transparent background

  let kept = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const color = Jimp.intToRGBA(img.getPixelColor(x, y));
      // Checking for 'pink': R high, B relatively high, G somewhat lower than R.
      // E.g. R > 150, B > 100, R > G + 20
      // Also maybe just compare to center pixel if center is pink.
      
      const isPink = color.r > 150 && color.r > color.g + 20 && color.b > 100 && color.a > 10;
      
      if (isPink) {
        outImg.setPixelColor(img.getPixelColor(x, y), x, y);
        kept++;
      }
    }
  }
  
  console.log(`Kept ${kept} pixels based on pink color heuristic.`);
  await outImg.writeAsync('icon_pink_only.png');
  console.log('Saved to icon_pink_only.png');
}

main().catch(console.error);
