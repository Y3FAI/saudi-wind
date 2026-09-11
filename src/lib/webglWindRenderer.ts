import earcut, { flatten } from "earcut";

import {
  detectDeviceProfile,
  particleBudgetFor,
  type DeviceProfile,
} from "./deviceProfile";
import { type ViewTransform } from "./map";
import { sampleWind, speedKmh } from "./wind";
import type { WindStylePreset } from "./windStyle";
import type { SaudiBoundary } from "../types/geo";
import type { WindDataset } from "../types/wind";

type Project = (coordinates: [number, number]) => [number, number] | null;
type ProjectInto = (
  longitude: number,
  latitude: number,
  output: [number, number],
) => boolean;

interface Viewport {
  width: number;
  height: number;
  ratio: number;
  project: Project;
  /** Allocation-free projection used by the particle hot loop when provided. */
  projectInto?: ProjectInto;
  view: ViewTransform;
}

export interface WindRendererOptions {
  profile?: DeviceProfile;
  /** Called when the GPU context is lost; the map shows an Arabic notice. */
  onContextLost?: () => void;
  /** Called after a successful restore so the notice can be cleared. */
  onContextRestored?: () => void;
  /** Called when resources could not be rebuilt after a restore. */
  onContextRestoreFailed?: (message: string) => void;
}

/**
 * PERFORMANCE BUDGETS held by this renderer (see docs/PERFORMANCE.md):
 *  - steady-state frame time: tier budget 16.7 ms (high) / 22 ms (mid) / 26 ms (low)
 *  - CPU particle-pass budget: 0.75 x the frame budget before the governor shrinks
 *  - particle count: target from screen area, capped by device tier, floored so
 *    trails stay visible (`data-particles` exposes the live value)
 *  - peak GPU memory: <= MAX_RENDER_PIXELS colour+stencil (about 26 MB), plus
 *    the shared Canvas-2D base layer; JS typed arrays stay under ~3 MB
 * Real frame-time and memory numbers require a real browser on real hardware and
 * cannot be measured on a headless CI host.
 */

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

// Stencil geometry is uploaded once in *projected* screen space (independent of
// the pan/zoom view transform) and shaped by uniforms in the vertex shader, so a
// pan or pinch never re-triangulates the boundary on the CPU.
const STENCIL_VERTEX_SHADER = `#version 300 es
in vec2 a_position;
uniform vec2 u_clipScale;
uniform vec3 u_view;

void main() {
  vec2 screen = a_position * u_view.x + u_view.yz;
  gl_Position = vec4(
    screen.x * u_clipScale.x - 1.0,
    1.0 - screen.y * u_clipScale.y,
    0.0,
    1.0
  );
}`;

const FADE_VERTICES = new Float32Array([
  -1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1,
]);

function createSeedMesh(boundary: SaudiBoundary) {
  const polygons =
    boundary.geometry.type === "Polygon"
      ? [boundary.geometry.coordinates]
      : boundary.geometry.coordinates;
  const triangles: number[] = [];
  const cumulativeAreas: number[] = [];
  let cumulativeArea = 0;

  polygons.forEach((polygon) => {
    const flat = flatten(polygon);
    const indices = earcut(flat.vertices, flat.holes, flat.dimensions);
    for (let index = 0; index < indices.length; index += 3) {
      const a = indices[index] * 2;
      const b = indices[index + 1] * 2;
      const c = indices[index + 2] * 2;
      const ax = flat.vertices[a];
      const ay = flat.vertices[a + 1];
      const bx = flat.vertices[b];
      const by = flat.vertices[b + 1];
      const cx = flat.vertices[c];
      const cy = flat.vertices[c + 1];
      const area = Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay));
      if (area <= Number.EPSILON) continue;
      triangles.push(ax, ay, bx, by, cx, cy);
      cumulativeArea += area;
      cumulativeAreas.push(cumulativeArea);
    }
  });

  return {
    triangles: new Float32Array(triangles),
    cumulativeAreas: new Float64Array(cumulativeAreas),
    totalArea: cumulativeArea,
  };
}

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
  private gl: WebGL2RenderingContext;
  private lineProgram!: WebGLProgram;
  private solidProgram!: WebGLProgram;
  private stencilProgram!: WebGLProgram;
  private lineBuffer!: WebGLBuffer;
  private fadeBuffer!: WebGLBuffer;
  private stencilBuffer!: WebGLBuffer;
  private linePositionLocation = -1;
  private lineAlphaLocation = -1;
  private solidPositionLocation = -1;
  private solidColorLocation: WebGLUniformLocation | null = null;
  private stencilPositionLocation = -1;
  private stencilClipScaleLocation: WebGLUniformLocation | null = null;
  private stencilViewLocation: WebGLUniformLocation | null = null;
  private readonly seedMesh;
  private readonly profile: DeviceProfile;
  private readonly random = seededRandom(1446);
  private viewport: Viewport | null = null;
  private animationFrame = 0;
  private previousTime = 0;
  private frameWindowStart = 0;
  private frameWindowCount = 0;
  private lastQualityAdjustment = 0;
  private slowFrameStreak = 0;
  private contextLost = false;
  private destroyed = false;
  private fadeBufferReady = false;
  private stencilGeometryKey = "";
  private stencilVertexCount = 0;
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
  private readonly scratch: [number, number] = [0, 0];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly boundary: SaudiBoundary,
    private readonly dataset: WindDataset,
    private readonly style: WindStylePreset,
    private readonly options: WindRendererOptions = {},
  ) {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      // Required by the frame-rate UI test which reads back the canvas.
      preserveDrawingBuffer: true,
      stencil: true,
    });
    if (!gl) {
      throw new Error(
        "هذا المتصفح لا يدعم WebGL2 اللازم لتحريك الرياح. يمكن استخدام أحدث إصدار من المتصفح.",
      );
    }
    this.gl = gl;
    this.profile = options.profile ?? detectDeviceProfile();
    this.createResources(gl);
    this.seedMesh = createSeedMesh(boundary);
    canvas.addEventListener("webglcontextlost", this.handleContextLost, false);
    canvas.addEventListener(
      "webglcontextrestored",
      this.handleContextRestored,
      false,
    );
    document.addEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
      false,
    );
  }

  private createResources(gl: WebGL2RenderingContext) {
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
    this.stencilProgram = createProgram(
      gl,
      STENCIL_VERTEX_SHADER,
      SOLID_FRAGMENT_SHADER,
    );
    const lineBuffer = gl.createBuffer();
    const fadeBuffer = gl.createBuffer();
    const stencilBuffer = gl.createBuffer();
    if (!lineBuffer || !fadeBuffer || !stencilBuffer) {
      throw new Error("تعذر حجز ذاكرة رسوم الرياح.");
    }
    this.lineBuffer = lineBuffer;
    this.fadeBuffer = fadeBuffer;
    this.stencilBuffer = stencilBuffer;
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
    this.stencilPositionLocation = gl.getAttribLocation(
      this.stencilProgram,
      "a_position",
    );
    this.stencilClipScaleLocation = gl.getUniformLocation(
      this.stencilProgram,
      "u_clipScale",
    );
    this.stencilViewLocation = gl.getUniformLocation(
      this.stencilProgram,
      "u_view",
    );
    this.fadeBufferReady = false;
    this.stencilGeometryKey = "";
    this.stencilVertexCount = 0;
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
    if (this.contextLost) return;
    this.gl.viewport(0, 0, pixelWidth, pixelHeight);
    this.ensureParticles(viewport.width, viewport.height);
    // Stencil geometry depends only on the projection (viewport size), not on the
    // pan/zoom transform, so it is rebuilt on resize only.
    const geometryKey = `${Math.round(viewport.width)}:${Math.round(
      viewport.height,
    )}`;
    if (geometryKey !== this.stencilGeometryKey) {
      this.stencilGeometryKey = geometryKey;
      this.buildStencilGeometry();
    }
    this.refreshParticleProjections();
    this.drawStencilMask();
    this.previousTime = performance.now();
  }

  start() {
    if (
      !this.viewport ||
      this.animationFrame ||
      this.contextLost ||
      this.destroyed
    )
      return;
    this.previousTime = performance.now();
    this.frameWindowStart = 0;
    this.frameWindowCount = 0;
    this.slowFrameStreak = 0;
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  stop() {
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
  }

  isContextLost() {
    return this.contextLost;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.removeEventListener(
      "webglcontextrestored",
      this.handleContextRestored,
    );
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    const gl = this.gl;
    if (!this.contextLost) {
      gl.deleteBuffer(this.lineBuffer);
      gl.deleteBuffer(this.fadeBuffer);
      gl.deleteBuffer(this.stencilBuffer);
      gl.deleteProgram(this.lineProgram);
      gl.deleteProgram(this.solidProgram);
      gl.deleteProgram(this.stencilProgram);
    }
    // Release typed memory immediately on unmount so re-mounts do not accumulate.
    this.longitude = new Float32Array();
    this.latitude = new Float32Array();
    this.screenX = new Float32Array();
    this.screenY = new Float32Array();
    this.age = new Float32Array();
    this.lifetime = new Float32Array();
    this.lineVertices = new Float32Array();
    this.viewport = null;
    this.particleCount = 0;
    this.activeParticleCount = 0;
  }

  private readonly handleVisibilityChange = () => {
    if (this.destroyed || this.contextLost) return;
    if (document.hidden) {
      this.stop();
      return;
    }
    // Reset timing so the first frame after resume is not a huge delta.
    this.previousTime = performance.now();
    this.start();
  };

  private readonly handleContextLost = (event: Event) => {
    event.preventDefault();
    this.contextLost = true;
    this.stop();
    this.options.onContextLost?.();
  };

  private readonly handleContextRestored = () => {
    if (this.destroyed) return;
    try {
      this.createResources(this.gl);
      this.contextLost = false;
      // Force a full reallocation of buffers and the stencil mask.
      this.particleCount = 0;
      const viewport = this.viewport;
      if (viewport) this.setViewport(viewport);
      this.options.onContextRestored?.();
      this.start();
    } catch (reason) {
      this.contextLost = true;
      this.options.onContextRestoreFailed?.(
        reason instanceof Error
          ? reason.message
          : "تعذر استعادة سياق الرسم بعد انقطاعه.",
      );
    }
  };

  private readonly animate = (time: number) => {
    const elapsed = Math.min(
      0.05,
      Math.max(0.001, (time - this.previousTime) / 1000),
    );
    const interval = time - this.previousTime;
    this.previousTime = time;
    const renderStart = performance.now();
    this.drawFrame(elapsed);
    this.adjustParticleBudget(performance.now() - renderStart, time, interval);
    if (!this.frameWindowStart) this.frameWindowStart = time;
    this.frameWindowCount += 1;
    const frameWindowElapsed = time - this.frameWindowStart;
    if (frameWindowElapsed >= 1000) {
      this.canvas.dataset.fps = (
        (this.frameWindowCount * 1000) /
        frameWindowElapsed
      ).toFixed(1);
      this.canvas.dataset.particles = this.activeParticleCount.toString();
      this.canvas.dataset.tier = this.profile.tier;
      this.canvas.dataset.dpr = this.viewport?.ratio.toFixed(2) ?? "1.00";
      this.frameWindowStart = time;
      this.frameWindowCount = 0;
    }
    this.animationFrame = requestAnimationFrame(this.animate);
  };

  private ensureParticles(width: number, height: number) {
    const { target, floor } = particleBudgetFor(
      this.style.density,
      this.profile,
      width,
      height,
    );
    if (target === this.particleCount) return;
    const mobile = width < 680;

    this.particleCount = target;
    // Start conservative and let the frame-time governor ramp up to the target.
    this.activeParticleCount = Math.min(
      target,
      Math.max(floor, mobile ? 700 : 900),
    );
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

  private adjustParticleBudget(
    renderDuration: number,
    time: number,
    frameInterval: number,
  ) {
    if (!this.viewport || this.contextLost) return;
    const mobile = this.viewport.width < 680;
    const renderBudget = this.profile.renderBudgetMs;
    const minimum = mobile
      ? this.profile.governorFloorMobile
      : this.profile.governorFloorDesktop;

    // Sustained dropped frames are a second overload signal, independent of the
    // CPU render duration. It only fires after 30 consecutive slow frames so a
    // single hiccup never triggers a quality change.
    if (frameInterval > this.profile.frameBudgetMs * 1.6) {
      this.slowFrameStreak += 1;
    } else {
      this.slowFrameStreak = 0;
    }

    if (time - this.lastQualityAdjustment < 400) return;

    const overloaded =
      renderDuration > renderBudget || this.slowFrameStreak >= 30;
    if (overloaded && this.activeParticleCount > minimum) {
      this.activeParticleCount = Math.max(
        minimum,
        Math.floor(this.activeParticleCount * 0.8),
      );
      this.lastQualityAdjustment = time;
      this.slowFrameStreak = 0;
      return;
    }

    if (
      renderDuration < renderBudget * 0.45 &&
      this.slowFrameStreak === 0 &&
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

  private projectInto(
    longitude: number,
    latitude: number,
    output: [number, number],
  ): boolean {
    const viewport = this.viewport;
    if (!viewport) return false;
    if (viewport.projectInto) {
      return viewport.projectInto(longitude, latitude, output);
    }
    const point = viewport.project([longitude, latitude]);
    if (!point) return false;
    output[0] = point[0] * viewport.view.scale + viewport.view.x;
    output[1] = point[1] * viewport.view.scale + viewport.view.y;
    return true;
  }

  private refreshParticleProjections() {
    const output = this.scratch;
    for (let index = 0; index < this.particleCount; index += 1) {
      if (
        this.projectInto(this.longitude[index], this.latitude[index], output)
      ) {
        this.screenX[index] = output[0];
        this.screenY[index] = output[1];
      } else {
        this.screenX[index] = Number.NaN;
        this.screenY[index] = Number.NaN;
      }
    }
  }

  private resetParticle(index: number, stagger: boolean) {
    const output = this.scratch;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const area = this.random() * this.seedMesh.totalArea;
      let low = 0;
      let high = this.seedMesh.cumulativeAreas.length - 1;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (this.seedMesh.cumulativeAreas[middle] < area) low = middle + 1;
        else high = middle;
      }
      const triangle = low * 6;
      const root = Math.sqrt(this.random());
      const mix = this.random();
      const a = 1 - root;
      const b = root * (1 - mix);
      const c = root * mix;
      const longitude =
        this.seedMesh.triangles[triangle] * a +
        this.seedMesh.triangles[triangle + 2] * b +
        this.seedMesh.triangles[triangle + 4] * c;
      const latitude =
        this.seedMesh.triangles[triangle + 1] * a +
        this.seedMesh.triangles[triangle + 3] * b +
        this.seedMesh.triangles[triangle + 5] * c;
      const viewport = this.viewport;
      if (!viewport) continue;
      if (!this.projectInto(longitude, latitude, output)) continue;
      if (
        output[0] < -12 ||
        output[0] > viewport.width + 12 ||
        output[1] < -12 ||
        output[1] > viewport.height + 12
      ) {
        continue;
      }
      this.longitude[index] = longitude;
      this.latitude[index] = latitude;
      this.screenX[index] = output[0];
      this.screenY[index] = output[1];
      this.age[index] = stagger
        ? this.random() * 5
        : -this.style.warmup[0] -
          this.random() * (this.style.warmup[1] - this.style.warmup[0]);
      this.lifetime[index] = 3.2 + this.random() * 6.8;
      return;
    }
    // Deterministic fallback over Riyadh if rejection sampling never lands.
    const fallback: [number, number] = [46.6753, 24.7136];
    this.longitude[index] = fallback[0];
    this.latitude[index] = fallback[1];
    if (this.projectInto(fallback[0], fallback[1], output)) {
      this.screenX[index] = output[0];
      this.screenY[index] = output[1];
    } else {
      this.screenX[index] = Number.NaN;
      this.screenY[index] = Number.NaN;
    }
    this.age[index] = -this.style.warmup[1];
    this.lifetime[index] = 4;
  }

  private buildStencilGeometry() {
    const viewport = this.viewport;
    if (!viewport || this.contextLost) return;
    const polygons =
      this.boundary.geometry.type === "Polygon"
        ? [this.boundary.geometry.coordinates]
        : this.boundary.geometry.coordinates;
    const vertices: number[] = [];

    polygons.forEach((polygon) => {
      const projected = polygon
        .map((ring) =>
          ring
            .map((coordinates) => viewport.project(coordinates))
            .filter((point): point is [number, number] => Boolean(point)),
        )
        .filter((ring) => ring.length >= 3);
      if (!projected.length) return;
      const flat = flatten(projected);
      const indices = earcut(flat.vertices, flat.holes, flat.dimensions);
      indices.forEach((index) => {
        vertices.push(flat.vertices[index * 2], flat.vertices[index * 2 + 1]);
      });
    });

    this.stencilVertexCount = vertices.length / 2;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.stencilBuffer);
    this.gl.bufferData(
      this.gl.ARRAY_BUFFER,
      new Float32Array(vertices),
      this.gl.STATIC_DRAW,
    );
  }

  private drawStencilMask() {
    const viewport = this.viewport;
    if (!viewport || this.contextLost) return;
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clearStencil(0);
    gl.stencilMask(0xff);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.STENCIL_TEST);
    gl.colorMask(false, false, false, false);
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    gl.useProgram(this.stencilProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stencilBuffer);
    gl.enableVertexAttribArray(this.stencilPositionLocation);
    gl.vertexAttribPointer(
      this.stencilPositionLocation,
      2,
      gl.FLOAT,
      false,
      0,
      0,
    );
    gl.uniform2f(
      this.stencilClipScaleLocation,
      2 / viewport.width,
      2 / viewport.height,
    );
    gl.uniform3f(
      this.stencilViewLocation,
      viewport.view.scale,
      viewport.view.x,
      viewport.view.y,
    );
    gl.drawArrays(gl.TRIANGLES, 0, this.stencilVertexCount);
    gl.colorMask(true, true, true, true);
    gl.stencilMask(0);
    gl.stencilFunc(gl.EQUAL, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
  }

  private fadeTrails(elapsed: number) {
    const gl = this.gl;
    const opacity = 1 - Math.exp(-elapsed * this.style.fadeRate);
    gl.useProgram(this.solidProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fadeBuffer);
    if (!this.fadeBufferReady) {
      gl.bufferData(gl.ARRAY_BUFFER, FADE_VERTICES, gl.STATIC_DRAW);
      this.fadeBufferReady = true;
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
    if (!this.viewport || this.contextLost) return;
    const gl = this.gl;
    this.fadeTrails(elapsed);
    const clipScaleX = 2 / this.viewport.width;
    const clipScaleY = 2 / this.viewport.height;
    const mobile = this.viewport.width < 680;
    const advection =
      elapsed * (mobile ? this.style.advection[1] : this.style.advection[0]);
    const minimumLength = mobile
      ? this.style.minimumLength[1]
      : this.style.minimumLength[0];
    const widthScale = mobile
      ? this.style.width.mobileScale
      : this.style.width.desktopScale;
    const output = this.scratch;
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
      const nextLongitude =
        longitude +
        (wind[0] * advection) / Math.max(Math.cos(latitudeRadians), 0.32);
      const nextLatitude = latitude + wind[1] * advection;
      if (!this.projectInto(nextLongitude, nextLatitude, output)) {
        this.resetParticle(index, false);
        continue;
      }
      const nextX = output[0];
      const nextY = output[1];

      this.longitude[index] = nextLongitude;
      this.latitude[index] = nextLatitude;
      this.screenX[index] = nextX;
      this.screenY[index] = nextY;
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
      const movementX = nextX - previousX;
      const movementY = nextY - previousY;
      const movementLength = Math.max(0.001, Math.hypot(movementX, movementY));
      const length = Math.max(minimumLength, movementLength);
      const directionX = movementX / movementLength;
      const directionY = movementY / movementLength;
      const renderStartX = nextX - directionX * length;
      const renderStartY = nextY - directionY * length;
      const halfWidth =
        (this.style.width.base + intensity * this.style.width.speed) *
        widthScale;
      const offsetX = -directionY * halfWidth;
      const offsetY = directionX * halfWidth;
      const startAX = (renderStartX + offsetX) * clipScaleX - 1;
      const startAY = 1 - (renderStartY + offsetY) * clipScaleY;
      const startBX = (renderStartX - offsetX) * clipScaleX - 1;
      const startBY = 1 - (renderStartY - offsetY) * clipScaleY;
      const endAX = (nextX + offsetX) * clipScaleX - 1;
      const endAY = 1 - (nextY + offsetY) * clipScaleY;
      const endBX = (nextX - offsetX) * clipScaleX - 1;
      const endBY = 1 - (nextY - offsetY) * clipScaleY;
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
