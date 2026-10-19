const fontkit = require("fontkit");
console.log("fontkit loaded");
const font = fontkit.openSync("C:/Windows/Fonts/simhei.ttf");
console.log("family:", font.familyName, "| full:", font.fullName, "| hasCn:", font.hasGlyphForCodePoint(0x4e2d));
const ttc = fontkit.openSync("C:/Windows/Fonts/msyh.ttc");
console.log("ttc fonts count:", ttc.fonts ? ttc.fonts.length : "n/a");
if (ttc.fonts) {
  for (const face of ttc.fonts.slice(0, 3)) {
    console.log("face:", face.familyName, "| cn:", face.hasGlyphForCodePoint(0x4e2d));
  }
}
// 中文显示名探测：name 表记录
try {
  const recs = font.name.records;
  console.log("records type:", typeof recs, Array.isArray(recs) ? "array" : "");
  const entries = Array.isArray(recs) ? recs : Object.values(recs);
  for (const r of entries.slice(0, 14)) {
    console.log(JSON.stringify(r));
  }
} catch (e) {
  console.log("name err:", e.message);
}