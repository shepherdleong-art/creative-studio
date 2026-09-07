'use client';

/**
 * 批量实时预览的 .cube LUT 解析与 WebGL2 3D 纹理封装(C1)。
 *
 * 数学与 ffmpeg `lut3d trilinear` 一致:3D 纹理按硬件三线性(线性过滤 +
 * CLAMP_TO_EDGE)采样;解析按 .cube 规范"红轴变化最快"展开为 RGBA 数据体,
 * DOMAIN_MIN/MAX 在 shader 端做归一映射。
 *
 * 纯 UI 层组件——不进 lib/、不依赖服务端;WebGL2 不可用时不创建上下文,
 * 由调用方回退"无 LUT 预览 + 提示"(不做 WebGL1 模拟)。
 */

export interface ParsedCubeLut {
  /** LUT_3D_SIZE(立方体边长) */
  size: number;
  /** size^3 * 4 的 RGBA 展开(alpha=1);texel 顺序 = .cube 数据顺序,即红轴(r)变化最快 */
  data: Float32Array;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
}

export type CubeLutParseCode =
  | 'missing_size'
  | 'invalid_size'
  | 'missing_size_header'
  | 'data_shape_mismatch'
  | 'invalid_channel'
  | 'invalid_domain';

export class CubeLutParseError extends Error {
  readonly code: CubeLutParseCode;

  constructor(code: CubeLutParseCode, message: string) {
    super(message);
    this.name = 'CubeLutParseError';
    this.code = code;
  }
}

const MAX_LUT_SIZE = 128;

function parseFloat3(tokens: string[], context: string): [number, number, number] {
  if (tokens.length < 3) {
    throw new CubeLutParseError('invalid_domain', `${context} 需要 3 个数值`);
  }
  const values = tokens.slice(0, 3).map(Number);
  if (values.some((value) => !Number.isFinite(value))) {
    throw new CubeLutParseError('invalid_domain', `${context} 含非数值`);
  }
  return [values[0], values[1], values[2]];
}

/**
 * 解析 .cube 文本。兼容注释(#)、空行、TITLE/DOMAIN_MIN/DOMAIN_MAX 头;
 * 数据体每行 3 个浮点,共 size^3 行,红轴变化最快。
 * 损坏/截断/非法尺寸/非法数值一律抛出带 code 的可识别错误,绝不静默。
 */
export function parseCubeLut(text: string): ParsedCubeLut {
  let size = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const values: number[] = [];
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const upper = line.toUpperCase();
    const tokens = line.split(/\s+/);
    if (upper.startsWith('LUT_3D_SIZE')) {
      const parsed = Number.parseInt(tokens[1] ?? '', 10);
      if (!Number.isInteger(parsed) || parsed < 2 || parsed > MAX_LUT_SIZE) {
        throw new CubeLutParseError('invalid_size', `LUT_3D_SIZE 非法: ${tokens[1] ?? '(缺失)'}（允许 2–${MAX_LUT_SIZE}）`);
      }
      size = parsed;
      continue;
    }
    if (upper.startsWith('DOMAIN_MIN')) {
      domainMin = parseFloat3(tokens.slice(1), 'DOMAIN_MIN');
      continue;
    }
    if (upper.startsWith('DOMAIN_MAX')) {
      domainMax = parseFloat3(tokens.slice(1), 'DOMAIN_MAX');
      continue;
    }
    if (upper.startsWith('TITLE')) continue;
    // 其余未知"关键字头"(纯大写字母/下划线)跳过;一旦出现数值行即视为数据体
    if (/^[A-Z_]+$/.test(line)) continue;
    const floats = tokens.map(Number);
    if (floats.length !== 3 || floats.some((value) => !Number.isFinite(value))) {
      throw new CubeLutParseError('invalid_channel', `数据行非法(应为 3 个数值): ${line.slice(0, 40)}`);
    }
    values.push(floats[0], floats[1], floats[2]);
  }
  if (size === 0) {
    throw new CubeLutParseError('missing_size', '缺少 LUT_3D_SIZE 头');
  }
  const expected = size * size * size * 3;
  if (values.length !== expected) {
    throw new CubeLutParseError(
      'data_shape_mismatch',
      `数据体应为 ${expected} 个数(每个 texel 3 个),实际 ${values.length}(${values.length / 3} 行)`,
    );
  }
  if (domainMin.some((value, index) => value >= domainMax[index])) {
    throw new CubeLutParseError('invalid_domain', 'DOMAIN_MIN 必须逐通道小于 DOMAIN_MAX');
  }
  const data = new Float32Array(size * size * size * 4);
  for (let i = 0; i < size * size * size; i += 1) {
    const r = values[i * 3];
    const g = values[i * 3 + 1];
    const b = values[i * 3 + 2];
    // 越界钳制到 [0,1]:GL 采样在此基础上做三线性,避免采出负值/超界伪影
    data[i * 4] = Math.min(1, Math.max(0, r));
    data[i * 4 + 1] = Math.min(1, Math.max(0, g));
    data[i * 4 + 2] = Math.min(1, Math.max(0, b));
    data[i * 4 + 3] = 1;
  }
  return { size, data, domainMin, domainMax };
}

// ---- 采样坐标(tel 中心修正) ----
//
// ffmpeg `lut3d interp=trilinear` 的语义是 texel 中心落在 i/(n-1);
// GL 3D 纹理线性采样下 coord 落在 p = v·n − 0.5,直接 clamp((color−min)·s,0,1)
// 会系统性偏半格。修正后的映射(t 已先经 DOMAIN 归一在 [0,1]):
//   t' = t·(n−1)/n + 0.5/n
// 折叠进 shader 的 (color − offset) × scale:
//   scale  = (n−1) / (n·(max−min))
//   offset = min − 0.5·(max−min) / (n−1)
// 复合顺序:先 DOMAIN 归一到 [0,1](之上),再做 texel 中心映射。

/** 采样 scale:含 texel 中心修正的 (n−1)/n 因子(逐通道入参) */
export function lutSampleScale(domainMin: number, domainMax: number, size: number): number {
  return (size - 1) / (size * (domainMax - domainMin));
}

/** 采样 offset:含 texel 中心修正的 −0.5/n 平移(逐通道入参) */
export function lutSampleOffset(domainMin: number, domainMax: number, size: number): number {
  return domainMin - 0.5 * (domainMax - domainMin) / (size - 1);
}

// ---- WebGL2 渲染封装 ----

export const LUT_VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
out vec2 vUv;
void main() {
  // 视频帧按 texImage2D(video) 默认行序上传(顶行在 v=0);不翻转纹理坐标会上下颠倒
  vUv = vec2(aPosition.x * 0.5 + 0.5, 0.5 - aPosition.y * 0.5);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

/**
 * 一次 3D 纹理采样(硬件三线性,与 ffmpeg lut3d trilinear 同数学)。
 * uLutOffset/uLutScale 已经在 setLut 里折叠了 DOMAIN 归一与 texel 中心修正
 * (坐标偏移与 scale 因子见 lutSampleScale/lutSampleOffset),着色器本体只管
 * 线性映射后采样;CLAMP_TO_EDGE 兜底边界。
 */
export const LUT_FRAGMENT_SHADER = `#version 300 es
// GLSL ES 3.00 的 sampler 在 fragment 阶段没有默认精度,必须显式声明(否则编译失败);
// highp 顺带避免 mediump(2^-10)在坐标运算上对高分辨率 LUT 的精度隐患,WebGL2 保证 fragment highp 可用。
precision highp float;
in vec2 vUv;
uniform highp sampler2D uVideo;
uniform highp sampler3D uLut;
uniform vec3 uLutOffset;
uniform vec3 uLutScale;
out vec4 outColor;
void main() {
  vec3 color = texture(uVideo, vUv).rgb;
  vec3 coord = clamp((color - uLutOffset) * uLutScale, 0.0, 1.0);
  outColor = vec4(texture(uLut, coord).rgb, 1.0);
}`;

export interface LutRenderer {
  /** 上传 video 当前帧并绘制 LUT 结果;video 无数据时跳过,不产生黑色闪烁 */
  drawFrame(video: HTMLVideoElement): void;
  /** 换 LUT:上传新 3D 纹理,下一帧立即生效(不重载 video,不换源) */
  setLut(lut: ParsedCubeLut): void;
  dispose(): void;
}

export interface LutFileSource {
  lutId: string;
  /** 只读端点:按 lutId + projectId 返回 .cube 文本 */
  url: string;
}

/** fetch + parse 缓存:解析结果按 lutId 共享;纹理随各自 GL 上下文生命周期。 */
const cubeLutCache = new Map<string, Promise<ParsedCubeLut>>();

/** 从只读端点加载并解析 .cube(按 lutId 缓存,失败会清除缓存可重试)。 */
export async function loadCubeLutFromEndpoint(source: LutFileSource): Promise<ParsedCubeLut> {
  const cached = cubeLutCache.get(source.lutId);
  if (cached) return cached;
  const promise = fetch(source.url, { cache: 'no-store' })
    .then((response) => {
      if (!response.ok) throw new Error(`LUT 文件读取失败（HTTP ${response.status}）`);
      return response.text();
    })
    .then((text) => parseCubeLut(text))
    .catch((error) => {
      cubeLutCache.delete(source.lutId);
      throw error;
    });
  cubeLutCache.set(source.lutId, promise);
  return promise;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '';
    gl.deleteShader(shader);
    throw new Error(`LUT shader 编译失败: ${log}`);
  }
  return shader;
}

/**
 * 创建 LUT 渲染器。WebGL2 不可用(或上下文创建失败)时返回 null,
 * 调用方回退"无 LUT 预览 + 提示",不引入 WebGL1 模拟。
 */
export function createLutRenderer(canvas: HTMLCanvasElement): LutRenderer | null {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
  if (!gl) return null;
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, LUT_VERTEX_SHADER);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, LUT_FRAGMENT_SHADER);
  if (!vertexShader || !fragmentShader) {
    if (vertexShader) gl.deleteShader(vertexShader);
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return null;
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  // 全屏三角
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const positionLoc = gl.getAttribLocation(program, 'aPosition');
  gl.enableVertexAttribArray(positionLoc);
  gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // 视频帧(2D)与 LUT(3D)纹理;LUT 纹理在首次 setLut 时上传
  const videoTexture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, videoTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const lutTexture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, lutTexture);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);

  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, 'uVideo'), 0);
  gl.uniform1i(gl.getUniformLocation(program, 'uLut'), 1);
  const offsetLoc = gl.getUniformLocation(program, 'uLutOffset');
  const scaleLoc = gl.getUniformLocation(program, 'uLutScale');
  let disposed = false;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    gl.deleteTexture(videoTexture);
    gl.deleteTexture(lutTexture);
    gl.deleteBuffer(buffer);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
  };

  return {
    drawFrame(video) {
      if (disposed) return;
      // 帧上传(尺寸跟随 video 固有分辨率);就绪前跳过,不渲染黑帧
      if (video.readyState < 2) return; // HAVE_CURRENT_DATA
      if (video.videoWidth > 0 && (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, videoTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    },
    setLut(lut) {
      if (disposed) return;
      // GLES3:RGBA8 是 8-bit 归一化内部格式,配 FLOAT 上传类型是非法组合(INVALID_OPERATION,
      // 纹理保持全零);量化到 Uint8Array 走 UNSIGNED_BYTE——量化误差 ≤1/255,与 8bit 视频
      // 同量级(共识 10)。浮点纹理路线(RGBA32F)依赖 OES_texture_float_linear,不保证可用,不走。
      const u8 = new Uint8Array(lut.data.length);
      for (let i = 0; i < lut.data.length; i += 1) {
        u8[i] = Math.round(Math.min(1, Math.max(0, lut.data[i])) * 255);
      }
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, lutTexture);
      gl.texImage3D(
        gl.TEXTURE_3D, 0, gl.RGBA8,
        lut.size, lut.size, lut.size, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, u8,
      );
      // DOMAIN 归一 + texel 中心修正复合进 offset/scale(逐通道):
      // 采样语义与 ffmpeg lut3d trilinear 一致(texel 中心 i/(n-1) → (i+0.5)/n)
      gl.uniform3fv(offsetLoc, [
        lutSampleOffset(lut.domainMin[0], lut.domainMax[0], lut.size),
        lutSampleOffset(lut.domainMin[1], lut.domainMax[1], lut.size),
        lutSampleOffset(lut.domainMin[2], lut.domainMax[2], lut.size),
      ]);
      gl.uniform3fv(scaleLoc, [
        lutSampleScale(lut.domainMin[0], lut.domainMax[0], lut.size),
        lutSampleScale(lut.domainMin[1], lut.domainMax[1], lut.size),
        lutSampleScale(lut.domainMin[2], lut.domainMax[2], lut.size),
      ]);
    },
    dispose,
  };
}
