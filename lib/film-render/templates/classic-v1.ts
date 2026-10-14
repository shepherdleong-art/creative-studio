import fs from 'node:fs';
import path from 'node:path';
import type { ClassicComposition } from '../types.ts';
import { htmlEscape as esc, pyFloat as f, pyFixed, pyJson } from '../python-format.ts';
import { classicTemplateDir, CLASSIC_ASSETS, createOutputDirectory, projectFile, verifyClassicAssets } from '../files.ts';
import { renderClassicCallouts } from './classic-callouts-v1.ts';
import { validateClassicComposition } from '../spec.ts';

/** Frozen HTML implementation of scripts/reassembled-film/packaging.py. */
export function classicDocuments(spec: ClassicComposition, projectCss: string) {
  const { classic: c, canvas, project, shots, subtitles } = spec;
  const cover = c.cover;
  const duration = canvas.frames / canvas.fps;
  const callouts = renderClassicCallouts(spec);
  const css = callouts.css + projectCss;
  const animations: string[] = [];
  const tween = (selector: string, props: string, at: number) => animations.push(`tl.from(${pyJson(selector)},{${props}},${pyFixed(at, 6)});`);
  let body = `<div id="cover" class="clip scene" data-start="0" data-duration="${f(canvas.introFrames/canvas.fps)}" data-track-index="0" style="z-index:1"><img src="media/cover.png" alt="${esc(cover.productName)}" style="position:absolute;inset:0" data-layout-allow-overlap="true"><div class="scene-content" data-layout-allow-overlap="true"><div class="brandrow" id="cover-brand"><b>${esc(cover.brand)}</b><span class="model">${esc(cover.model)} / ${project.variant}</span></div><h1 class="cover-title"><span id="cover-line1">${esc(cover.title[0])}</span><span class="accent" id="cover-line2">${esc(cover.title[1])}</span></h1><div class="cover-detail" id="cover-detail"><i class="rule"></i><span>${esc(cover.tag)}</span></div><div class="cover-note" id="cover-note"><span>${esc(cover.note)}</span><span>HOME / LIVING</span></div></div></div>`;
  shots.forEach((s, i) => {
    const start = s.startFrame / 24, duration = (s.endFrame - s.startFrame) / 24;
    const tail = i === shots.length - 1 ? 0 : 4 / 24;
    body += `<video id="scene-${i}" class="clip scene" src="media/${s.id}.mp4" data-start="${f(start)}" data-duration="${f(duration+tail)}" data-track-index="${i+1}" muted playsinline data-layout-allow-overlap="true" style="z-index:${i+2}"></video>`;
    if (i !== 0) tween(`#scene-${i}`, 'opacity:0,filter:"blur(5px)",duration:0.166667,ease:"power2.out"', start);
  });
  subtitles.forEach((s, i) => {
    const start = s.startFrame / 24, duration = (s.endFrame - s.startFrame) / 24;
    body += `<div id="cap-${i}" class="clip overlay" data-start="${f(start)}" data-duration="${f(duration)}" data-track-index="20" style="z-index:40"><div class="cap" data-layout-allow-overlap="true"><span>${esc(s.text)}</span></div></div>`;
    tween(`#cap-${i} .cap`, 'y:12,opacity:0,duration:.16,ease:"power3.out"', start);
  });
  const annotated = new Set(c.callouts.map(item => item.shot));
  shots.forEach((s, i) => {
    if (!Object.hasOwn(c.labels, s.id) || annotated.has(s.id)) return;
    const [kicker, title, support, cl] = c.labels[s.id].map(esc);
    const start = s.startFrame / 24 + .18, end = s.endFrame / 24 - .02;
    if (end - start < .5) return;
    let inner = `<div class="label-content ${cl}" data-layout-allow-overlap="true"><div class="kicker" id="l${i}-k"><i class="rule"></i>${kicker}</div><h2 class="headline" id="l${i}-t">${title}</h2>`;
    if (support) inner += `<p class="support" id="l${i}-s">${support}</p>`;
    body += `<div id="label-${i}" class="clip overlay" data-start="${f(start)}" data-duration="${f(end-start)}" data-track-index="30" style="z-index:30">${inner}</div></div>`;
    tween(`#l${i}-t`, (i % 2 ? 'scale:1.06,' : 'x:-28,') + 'opacity:0,duration:.28,ease:"power4.out"', start);
    tween(`#l${i}-k`, 'opacity:0,y:-10,duration:.2,ease:"sine.out"', start + .06);
    if (support) tween(`#l${i}-s`, 'opacity:0,y:12,duration:.3,ease:"expo.out"', start + .12);
  });
  const end = shots[shots.length-1].startFrame / 24;
  body += callouts.body;
  animations.push(...callouts.animations);
  // Use the historical duration, including its original rounding, for parity.
  const sourceDuration = c.durationText === undefined ? duration : Number(c.durationText);
  body += `<div id="outro" class="clip overlay" data-start="${f(end)}" data-duration="${f(sourceDuration-end)}" data-track-index="30" style="z-index:30"><div class="scene-content" data-layout-allow-overlap="true"><div class="brandrow" id="outro-brand"><b>${esc(cover.brand)}</b><span class="model">${esc(cover.model)}</span></div><h2 class="end-title"><span id="outro-line1">${esc(c.outro.title[0])}</span><span class="accent" id="outro-line2">${esc(c.outro.title[1])}</span></h2><div class="end-model" id="outro-detail"><i class="rule"></i><span>${esc(cover.tag)}</span></div></div></div>`;
  for (const [selector, props, delta] of [
    ['#outro-brand', 'opacity:0,y:-12,duration:.25,ease:"sine.out"', .12],
    ['#outro-line1', 'opacity:0,x:-34,duration:.36,ease:"power4.out"', .12],
    ['#outro-line2', 'opacity:0,y:22,duration:.35,ease:"expo.out"', .24],
    ['#outro-detail', 'opacity:0,y:10,duration:.25,ease:"power2.out"', .45],
  ] as const) tween(selector, props, end + delta);
  return {
    'index.html': `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><script src="assets/scripts/gsap.min.js"></script><style>${css}</style></head><body><div id="root" data-composition-id="main" data-start="0" data-duration="${c.durationText ?? f(duration)}" data-width="1080" data-height="1440" data-fps="24">` + body + '</div><script>const tl=gsap.timeline({paused:true});' + animations.join('') + 'window.__timelines=window.__timelines||{};window.__timelines.main=tl;</script></body></html>',
    'meta.json': pyJson({ id: 'main', name: cover.model + ' ' + project.variant + ' ' + c.theme }, false),
    'hyperframes.json': pyJson({ media: { autoProxy: true } }),
  };
}

export function buildClassic(spec: ClassicComposition, outDir: string): void {
  validateClassicComposition(spec);
  const template = classicTemplateDir();
  verifyClassicAssets(template);
  const css = fs.readFileSync(projectFile(spec.project.root, spec.classic.projectCss), 'utf8');
  const design = fs.readFileSync(projectFile(spec.project.root, spec.classic.designDoc), 'utf8');
  const cover = projectFile(spec.project.root, spec.classic.cover.image);
  const docs = classicDocuments(spec, css);
  const output = createOutputDirectory(spec.project.root, outDir);
  for (const directory of ['assets/fonts', 'assets/scripts', 'media', 'renders']) fs.mkdirSync(path.join(output, directory), { recursive: true });
  for (const name of Object.keys(CLASSIC_ASSETS)) fs.copyFileSync(path.join(template, name), path.join(output, name), fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(cover, path.join(output, 'media/cover.png'), fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(path.join(output, 'DESIGN.md'), design, { flag: 'wx' });
  for (const [name, content] of Object.entries(docs)) fs.writeFileSync(path.join(output, name), content, { flag: 'wx' });
}
