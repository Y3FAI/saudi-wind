import { geoContains } from "d3-geo";
import earcut, { flatten } from "earcut";

import { applyViewTransform, type ViewTransform } from "./map";
import { sampleWind, speedKmh } from "./wind";
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
  private readonly random = seededRandom(1446);
  private viewport: Viewport | null = null;
  private animationFrame = 0;
  private previousTime = 0;
  private particleCount = 0;
  private longitude = new Float32Array();
  private latitude = new Float32Array();
  private age = new Float32Array();
  private lifetime = new Float32Array();
  private lineVertices = new Float32Array();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly boundary: SaudiBoundary,
    private readonly dataset: WindDataset,
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
    this.rebuildStencil();
    this.previousTime = performance.now();
  }

  start() {
    if (!this.viewport || this.animationFrame) return;
    for (let index = 0; index < 18; index += 1) {
      this.drawFrame(1 / 45);
    }
    this.previousTime = performance.now();
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
    this.drawFrame(elapsed);
    this.animationFrame = requestAnimationFrame(this.animate);
  };

  private ensureParticles(width: number, height: number) {
    const mobile = width < 680;
    const target = Math.round(
      Math.min(
        mobile ? 1_600 : 3_600,
        Math.max(mobile ? 900 : 2_200, (width * height) / 260),
      ),
    );
    if (target === this.particleCount) return;

    this.particleCount = target;
    this.longitude = new Float32Array(target);
    this.latitude = new Float32Array(target);
    this.age = new Float32Array(target);
    this.lifetime = new Float32Array(target);
    this.lineVertices = new Float32Array(target * 18);
    for (let index = 0; index < target; index += 1) {
      this.resetParticle(index, true);
    }
  }

  private resetParticle(index: number, stagger: boolean) {
    const { grid } = this.dataset.manifest;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const longitude = grid.west + this.random() * (grid.east - grid.west);
      const latitude = grid.south + this.random() * (grid.north - grid.south);
      if (!geoContains(this.boundary, [longitude, latitude])) continue;
      this.longitude[index] = longitude;
      this.latitude[index] = latitude;
      this.age[index] = stagger ? this.random() * 5 : 0;
      this.lifetime[index] = 3.2 + this.random() * 6.8;
      return;
    }
    this.longitude[index] = 46.6753;
    this.latitude[index] = 24.7136;
    this.age[index] = 0;
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
    const position = gl.getAttribLocation(this.solidProgram, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, triangles.length / 2);
    gl.colorMask(true, true, true, true);
    gl.stencilMask(0);
    gl.stencilFunc(gl.EQUAL, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
  }

  private fadeTrails(elapsed: number) {
    const gl = this.gl;
    const opacity = 1 - Math.exp(-elapsed * 0.72);
    gl.useProgram(this.solidProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.solidBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(this.solidProgram, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const color = gl.getUniformLocation(this.solidProgram, "u_color");
    gl.uniform4f(color, 0, 0, 0, opacity);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private drawFrame(elapsed: number) {
    if (!this.viewport) return;
    const gl = this.gl;
    this.fadeTrails(elapsed);
    let used = 0;
    for (let index = 0; index < this.particleCount; index += 1) {
      const longitude = this.longitude[index];
      const latitude = this.latitude[index];
      const wind = sampleWind(
        this.dataset.vectors,
        this.dataset.manifest.grid,
        longitude,
        latitude,
      );
      const previous = this.project(longitude, latitude);
      this.age[index] += elapsed;

      if (!wind || !previous || this.age[index] > this.lifetime[index]) {
        this.resetParticle(index, false);
        continue;
      }

      const latitudeRadians = (latitude * Math.PI) / 180;
      const advection = elapsed * 0.038;
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
      const intensity = Math.min(1, speedKmh(wind) / 45);
      const alpha = 0.2 + intensity * 0.5;
      const dx = next[0] - previous[0];
      const dy = next[1] - previous[1];
      const length = Math.max(0.001, Math.hypot(dx, dy));
      const halfWidth = 0.36 + intensity * 0.34;
      const offsetX = (-dy / length) * halfWidth;
      const offsetY = (dx / length) * halfWidth;
      const startA = this.toClip([
        previous[0] + offsetX,
        previous[1] + offsetY,
      ]);
      const startB = this.toClip([
        previous[0] - offsetX,
        previous[1] - offsetY,
      ]);
      const endA = this.toClip([next[0] + offsetX, next[1] + offsetY]);
      const endB = this.toClip([next[0] - offsetX, next[1] - offsetY]);
      const fadedAlpha = alpha * 0.52;
      this.lineVertices[used++] = startA[0];
      this.lineVertices[used++] = startA[1];
      this.lineVertices[used++] = fadedAlpha;
      this.lineVertices[used++] = startB[0];
      this.lineVertices[used++] = startB[1];
      this.lineVertices[used++] = fadedAlpha;
      this.lineVertices[used++] = endA[0];
      this.lineVertices[used++] = endA[1];
      this.lineVertices[used++] = alpha;
      this.lineVertices[used++] = endA[0];
      this.lineVertices[used++] = endA[1];
      this.lineVertices[used++] = alpha;
      this.lineVertices[used++] = startB[0];
      this.lineVertices[used++] = startB[1];
      this.lineVertices[used++] = fadedAlpha;
      this.lineVertices[used++] = endB[0];
      this.lineVertices[used++] = endB[1];
      this.lineVertices[used++] = alpha;
    }

    gl.useProgram(this.lineProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      this.lineVertices.subarray(0, used),
      gl.DYNAMIC_DRAW,
    );
    const position = gl.getAttribLocation(this.lineProgram, "a_position");
    const alpha = gl.getAttribLocation(this.lineProgram, "a_alpha");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(alpha);
    gl.vertexAttribPointer(alpha, 1, gl.FLOAT, false, 12, 8);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, used / 3);
  }
}
