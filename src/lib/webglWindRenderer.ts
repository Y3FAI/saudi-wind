import { geoContains } from "d3-geo";
import earcut, { flatten } from "earcut";

import { applyViewTransform, type ViewTransform } from "./map";
import { sampleWind, speedKmh } from "./wind";
import type { WindStylePreset } from "./windStyle";
import type { SaudiBoundary } from "../types/geo";
import type { WindDataset } from "../types/wind";

type Project = (coordinates: [number, number]) => [number, number] | null;

interface Viewport {
  width: number;
  height: number;
  ratio: number;
  project: Project;
  view: ViewTransform;
}

const LINE_VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in float a_alpha;
out float v_alpha;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_alpha = a_alpha;
}`;

const LINE_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in float v_alpha;
out vec4 outColor;

void main() {
  outColor = vec4(0.91, 0.93, 0.92, v_alpha);
}`;

const SOLID_VERTEX_SHADER = `#version 300 es
in vec2 a_position;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const SOLID_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 outColor;

void main() {
  outColor = u_color;
}`;

const FADE_VERTICES = new Float32Array([
  -1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1,
]);

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("تعذر إنشاء برنامج رسوم الرياح.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const detail = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(detail ?? "تعذر تجهيز برنامج رسوم الرياح.");
  }
  return shader;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error("تعذر إنشاء برنامج رسوم الرياح.");
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const detail = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(detail ?? "تعذر ربط برنامج رسوم الرياح.");
  }
  return program;
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export class WebglWindRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly lineProgram: WebGLProgram;
  private readonly solidProgram: WebGLProgram;
  private readonly lineBuffer: WebGLBuffer;
  private readonly solidBuffer: WebGLBuffer;
  private readonly linePositionLocation: number;
  private readonly lineAlphaLocation: number;
  private readonly solidPositionLocation: number;
  private readonly solidColorLocation: WebGLUniformLocation | null;
  private readonly random = seededRandom(1446);
  private viewport: Viewport | null = null;
  private animationFrame = 0;
  private previousTime = 0;
  private frameWindowStart = 0;
  private frameWindowCount = 0;
  private lastQualityAdjustment = 0;
  private solidBufferContainsFade = false;
  private particleCount = 0;
  private activeParticleCount = 0;
  private longitude = new Float32Array();
  private latitude = new Float32Array();
  private screenX = new Float32Array();
  private screenY = new Float32Array();
  private age = new Float32Array();
  private lifetime = new Float32Array();
  private lineVertices = new Float32Array();
  private readonly windSample: [number, number] = [0, 0];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly boundary: SaudiBoundary,
    private readonly dataset: WindDataset,
    private readonly style: WindStylePreset,
  ) {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      stencil: true,
    });
    if (!gl) {
      throw new Error(
        "هذا المتصفح لا يدعم WebGL2 اللازم لتحريك الرياح. يمكن استخدام أحدث إصدار من المتصفح.",
      );
    }
    this.gl = gl;
    this.lineProgram = createProgram(
      gl,
      LINE_VERTEX_SHADER,
      LINE_FRAGMENT_SHADER,
    );
    this.solidProgram = createProgram(
      gl,
      SOLID_VERTEX_SHADER,
      SOLID_FRAGMENT_SHADER,
    );
    const lineBuffer = gl.createBuffer();
    const solidBuffer = gl.createBuffer();
    if (!lineBuffer || !solidBuffer) {
      throw new Error("تعذر حجز ذاكرة رسوم الرياح.");
    }
    this.lineBuffer = lineBuffer;
    this.solidBuffer = solidBuffer;
    this.linePositionLocation = gl.getAttribLocation(
      this.lineProgram,
      "a_position",
    );
    this.lineAlphaLocation = gl.getAttribLocation(this.lineProgram, "a_alpha");
    this.solidPositionLocation = gl.getAttribLocation(
      this.solidProgram,
      "a_position",
    );
    this.solidColorLocation = gl.getUniformLocation(
      this.solidProgram,
      "u_color",
    );
  }

  setViewport(viewport: Viewport) {
    this.viewport = viewport;
    const pixelWidth = Math.max(1, Math.round(viewport.width * viewport.ratio));
    const pixelHeight = Math.max(
      1,
      Math.round(viewport.height * viewport.ratio),
    );
    if (
      this.canvas.width !== pixelWidth ||
      this.canvas.height !== pixelHeight
    ) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    this.gl.viewport(0, 0, pixelWidth, pixelHeight);
    this.ensureParticles(viewport.width, viewport.height);
    this.refreshParticleProjections();
    this.rebuildStencil();
    this.previousTime = performance.now();
  }

  start() {
    if (!this.viewport || this.animationFrame) return;
    this.previousTime = performance.now();
    this.frameWindowStart = 0;
    this.frameWindowCount = 0;
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  stop() {
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
  }

  destroy() {
    this.stop();
    this.gl.deleteBuffer(this.lineBuffer);
    this.gl.deleteBuffer(this.solidBuffer);
    this.gl.deleteProgram(this.lineProgram);
    this.gl.deleteProgram(this.solidProgram);
  }

  private readonly animate = (time: number) => {
    const elapsed = Math.min(
      0.05,
      Math.max(0.001, (time - this.previousTime) / 1000),
    );
    this.previousTime = time;
    const renderStart = performance.now();
    this.drawFrame(elapsed);
    this.adjustParticleBudget(performance.now() - renderStart, time);
    if (!this.frameWindowStart) this.frameWindowStart = time;
    this.frameWindowCount += 1;
    const frameWindowElapsed = time - this.frameWindowStart;
    if (frameWindowElapsed >= 1000) {
      this.canvas.dataset.fps = (
        (this.frameWindowCount * 1000) /
        frameWindowElapsed
      ).toFixed(1);
      this.canvas.dataset.particles = this.activeParticleCount.toString();
      this.frameWindowStart = time;
      this.frameWindowCount = 0;
    }
    this.animationFrame = requestAnimationFrame(this.animate);
  };

  private ensureParticles(width: number, height: number) {
    const mobile = width < 680;
    const { density } = this.style;
    const target = Math.round(
      Math.min(
        mobile ? density.mobileMax : density.desktopMax,
        Math.max(
          mobile ? density.mobileMin : density.desktopMin,
          (width * height) / density.areaDivisor,
        ),
      ),
    );
    if (target === this.particleCount) return;

    this.particleCount = target;
    this.activeParticleCount = Math.min(target, mobile ? 700 : 900);
    this.longitude = new Float32Array(target);
    this.latitude = new Float32Array(target);
    this.screenX = new Float32Array(target);
    this.screenY = new Float32Array(target);
    this.age = new Float32Array(target);
    this.lifetime = new Float32Array(target);
    this.lineVertices = new Float32Array(target * 18);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.lineBuffer);
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      this.lineVertices.byteLength,
      this.gl.DYNAMIC_DRAW,
    );
    for (let index = 0; index < target; index += 1) {
      this.resetParticle(index, true);
    }
  }

  private adjustParticleBudget(renderDuration: number, time: number) {
    if (!this.viewport || time - this.lastQualityAdjustment < 250) return;
    const mobile = this.viewport.width < 680;
    const renderBudget = mobile ? 24 : 12;
    const minimum = mobile ? 450 : 600;

    if (renderDuration > renderBudget && this.activeParticleCount > minimum) {
      this.activeParticleCount = Math.max(
        minimum,
        Math.floor(this.activeParticleCount * 0.8),
      );
      this.lastQualityAdjustment = time;
      return;
    }

    if (
      renderDuration < renderBudget * 0.45 &&
      this.activeParticleCount < this.particleCount
    ) {
      const previous = this.activeParticleCount;
      this.activeParticleCount = Math.min(
        this.particleCount,
        previous + Math.max(60, Math.round(this.particleCount * 0.08)),
      );
      this.lastQualityAdjustment = time;
    }
  }

  private refreshParticleProjections() {
    for (let index = 0; index < this.particleCount; index += 1) {
      const point = this.project(this.longitude[index], this.latitude[index]);
      this.screenX[index] = point?.[0] ?? Number.NaN;
      this.screenY[index] = point?.[1] ?? Number.NaN;
    }
  }

  private resetParticle(index: number, stagger: boolean) {
    const { grid } = this.dataset.manifest;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const longitude = grid.west + this.random() * (grid.east - grid.west);
      const latitude = grid.south + this.random() * (grid.north - grid.south);
      if (!geoContains(this.boundary, [longitude, latitude])) continue;
      const point = this.project(longitude, latitude);
      const viewport = this.viewport;
      if (!viewport || !point) continue;
      if (
        point[0] < -12 ||
        point[0] > viewport.width + 12 ||
        point[1] < -12 ||
        point[1] > viewport.height + 12
      ) {
        continue;
      }
      this.longitude[index] = longitude;
      this.latitude[index] = latitude;
      this.screenX[index] = point[0];
      this.screenY[index] = point[1];
      this.age[index] = stagger
        ? this.random() * 5
        : -this.style.warmup[0] -
          this.random() * (this.style.warmup[1] - this.style.warmup[0]);
      this.lifetime[index] = 3.2 + this.random() * 6.8;
      return;
    }
    this.longitude[index] = 46.6753;
    this.latitude[index] = 24.7136;
    const fallback = this.project(46.6753, 24.7136);
    this.screenX[index] = fallback?.[0] ?? Number.NaN;
    this.screenY[index] = fallback?.[1] ?? Number.NaN;
    this.age[index] = -this.style.warmup[1];
    this.lifetime[index] = 4;
  }

  private toClip(point: [number, number]): [number, number] {
    const viewport = this.viewport!;
    return [
      (point[0] / viewport.width) * 2 - 1,
      1 - (point[1] / viewport.height) * 2,
    ];
  }

  private project(longitude: number, latitude: number) {
    const viewport = this.viewport;
    if (!viewport) return null;
    const point = viewport.project([longitude, latitude]);
    return point ? applyViewTransform(point, viewport.view) : null;
  }

  private rebuildStencil() {
    const viewport = this.viewport;
    if (!viewport) return;
    const gl = this.gl;
    const polygons =
      this.boundary.geometry.type === "Polygon"
        ? [this.boundary.geometry.coordinates]
        : this.boundary.geometry.coordinates;
    const triangles: number[] = [];

    polygons.forEach((polygon) => {
      const projected = polygon
        .map((ring) =>
          ring
            .map((coordinates) => viewport.project(coordinates))
            .filter((point): point is [number, number] => Boolean(point))
            .map((point) => applyViewTransform(point, viewport.view)),
        )
        .filter((ring) => ring.length >= 3);
      if (!projected.length) return;
      const flat = flatten(projected);
      const indices = earcut(flat.vertices, flat.holes, flat.dimensions);
      indices.forEach((index) => {
        const point: [number, number] = [
          flat.vertices[index * 2],
          flat.vertices[index * 2 + 1],
        ];
        triangles.push(...this.toClip(point));
      });
    });

    gl.clearColor(0, 0, 0, 0);
    gl.clearStencil(0);
    gl.stencilMask(0xff);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.STENCIL_TEST);
    gl.colorMask(false, false, false, false);
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    gl.useProgram(this.solidProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.solidBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(triangles), gl.STATIC_DRAW);
    this.solidBufferContainsFade = false;
    gl.enableVertexAttribArray(this.solidPositionLocation);
    gl.vertexAttribPointer(
      this.solidPositionLocation,
      2,
      gl.FLOAT,
      false,
      0,
      0,
    );
    gl.drawArrays(gl.TRIANGLES, 0, triangles.length / 2);
    gl.colorMask(true, true, true, true);
    gl.stencilMask(0);
    gl.stencilFunc(gl.EQUAL, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
  }

  private fadeTrails(elapsed: number) {
    const gl = this.gl;
    const opacity = 1 - Math.exp(-elapsed * this.style.fadeRate);
    gl.useProgram(this.solidProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.solidBuffer);
    if (!this.solidBufferContainsFade) {
      gl.bufferData(gl.ARRAY_BUFFER, FADE_VERTICES, gl.STATIC_DRAW);
      this.solidBufferContainsFade = true;
    }
    gl.enableVertexAttribArray(this.solidPositionLocation);
    gl.vertexAttribPointer(
      this.solidPositionLocation,
      2,
      gl.FLOAT,
      false,
      0,
      0,
    );
    gl.uniform4f(this.solidColorLocation, 0, 0, 0, opacity);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private drawFrame(elapsed: number) {
    if (!this.viewport) return;
    const gl = this.gl;
    this.fadeTrails(elapsed);
    const clipScaleX = 2 / this.viewport.width;
    const clipScaleY = 2 / this.viewport.height;
    let used = 0;
    for (let index = 0; index < this.activeParticleCount; index += 1) {
      const longitude = this.longitude[index];
      const latitude = this.latitude[index];
      const wind = sampleWind(
        this.dataset.vectors,
        this.dataset.manifest.grid,
        longitude,
        latitude,
        this.windSample,
      );
      const previousX = this.screenX[index];
      const previousY = this.screenY[index];
      this.age[index] += elapsed;

      if (
        !wind ||
        !Number.isFinite(previousX) ||
        !Number.isFinite(previousY) ||
        previousX < -12 ||
        previousX > this.viewport.width + 12 ||
        previousY < -12 ||
        previousY > this.viewport.height + 12 ||
        this.age[index] > this.lifetime[index]
      ) {
        this.resetParticle(index, false);
        continue;
      }

      const latitudeRadians = (latitude * Math.PI) / 180;
      const mobile = this.viewport.width < 680;
      const advection =
        elapsed * (mobile ? this.style.advection[1] : this.style.advection[0]);
      const nextLongitude =
        longitude +
        (wind[0] * advection) / Math.max(Math.cos(latitudeRadians), 0.32);
      const nextLatitude = latitude + wind[1] * advection;
      const next = this.project(nextLongitude, nextLatitude);
      if (!next) {
        this.resetParticle(index, false);
        continue;
      }

      this.longitude[index] = nextLongitude;
      this.latitude[index] = nextLatitude;
      this.screenX[index] = next[0];
      this.screenY[index] = next[1];
      if (this.age[index] <= 0) continue;

      const intensity = Math.min(1, speedKmh(wind) / 45);
      const fadeIn = Math.min(1, this.age[index] / this.style.fadeInSeconds);
      const fadeOut = Math.min(
        1,
        Math.max(
          0,
          (this.lifetime[index] - this.age[index]) / this.style.fadeOutSeconds,
        ),
      );
      const smoothFadeIn = fadeIn * fadeIn * (3 - 2 * fadeIn);
      const smoothFadeOut = fadeOut * fadeOut * (3 - 2 * fadeOut);
      const opacityEnvelope = smoothFadeIn * smoothFadeOut;
      const alpha =
        (this.style.alpha[0] + intensity * this.style.alpha[1]) *
        opacityEnvelope;
      const movementX = next[0] - previousX;
      const movementY = next[1] - previousY;
      const movementLength = Math.max(0.001, Math.hypot(movementX, movementY));
      const minimumLength = mobile
        ? this.style.minimumLength[1]
        : this.style.minimumLength[0];
      const length = Math.max(minimumLength, movementLength);
      const directionX = movementX / movementLength;
      const directionY = movementY / movementLength;
      const renderStartX = next[0] - directionX * length;
      const renderStartY = next[1] - directionY * length;
      const widthScale = mobile
        ? this.style.width.mobileScale
        : this.style.width.desktopScale;
      const halfWidth =
        (this.style.width.base + intensity * this.style.width.speed) *
        widthScale;
      const offsetX = -directionY * halfWidth;
      const offsetY = directionX * halfWidth;
      const startAX = (renderStartX + offsetX) * clipScaleX - 1;
      const startAY = 1 - (renderStartY + offsetY) * clipScaleY;
      const startBX = (renderStartX - offsetX) * clipScaleX - 1;
      const startBY = 1 - (renderStartY - offsetY) * clipScaleY;
      const endAX = (next[0] + offsetX) * clipScaleX - 1;
      const endAY = 1 - (next[1] + offsetY) * clipScaleY;
      const endBX = (next[0] - offsetX) * clipScaleX - 1;
      const endBY = 1 - (next[1] - offsetY) * clipScaleY;
      const fadedAlpha = alpha * 0.62;
      this.lineVertices[used++] = startAX;
      this.lineVertices[used++] = startAY;
      this.lineVertices[used++] = fadedAlpha;
      this.lineVertices[used++] = startBX;
      this.lineVertices[used++] = startBY;
      this.lineVertices[used++] = fadedAlpha;
      this.lineVertices[used++] = endAX;
      this.lineVertices[used++] = endAY;
      this.lineVertices[used++] = alpha;
      this.lineVertices[used++] = endAX;
      this.lineVertices[used++] = endAY;
      this.lineVertices[used++] = alpha;
      this.lineVertices[used++] = startBX;
      this.lineVertices[used++] = startBY;
      this.lineVertices[used++] = fadedAlpha;
      this.lineVertices[used++] = endBX;
      this.lineVertices[used++] = endBY;
      this.lineVertices[used++] = alpha;
    }

    gl.useProgram(this.lineProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lineVertices, 0, used);
    gl.enableVertexAttribArray(this.linePositionLocation);
    gl.vertexAttribPointer(
      this.linePositionLocation,
      2,
      gl.FLOAT,
      false,
      12,
      0,
    );
    gl.enableVertexAttribArray(this.lineAlphaLocation);
    gl.vertexAttribPointer(this.lineAlphaLocation, 1, gl.FLOAT, false, 12, 8);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, used / 3);
  }
}
