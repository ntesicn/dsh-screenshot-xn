/**
 * A recording `CanvasRenderingContext2D` stub.
 *
 * The annotation renderer is expressed as canvas calls, so the offline tests
 * can assert *what was drawn* without a canvas implementation. Node has none,
 * which is exactly why the renderer takes its context (and its scratch-surface
 * factory) as parameters instead of creating them.
 */

/**
 * @param {{ width?: number, textWidths?: Record<string, number> }} [options]
 * @returns {{
 *   calls: Array<{ name: string, args: unknown[] }>,
 *   canvas: { width: number, height: number },
 *   names: () => string[],
 *   countOf: (name: string) => number,
 *   firstOf: (name: string) => unknown[] | undefined,
 *   scratch: () => { ctx: object, calls: Array<{name:string,args:unknown[]}> },
 *   ctx: object,
 * }} the stub context plus helpers.
 */
export function createRecordingContext(options = {}) {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push({ name, args });
  };

  const ctx = {
    calls,
    canvas: { width: options.width ?? 0, height: options.width ?? 0 },
    lineWidth: 1,
    strokeStyle: '#000',
    fillStyle: '#000',
    font: '',
    lineCap: 'round',
    lineJoin: 'round',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    imageSmoothingEnabled: true,
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    rect: record('rect'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    quadraticCurveTo: record('quadraticCurveTo'),
    arcTo: record('arcTo'),
    ellipse: record('ellipse'),
    stroke: record('stroke'),
    fill: record('fill'),
    fillText: record('fillText'),
    clearRect: record('clearRect'),
    drawImage: record('drawImage'),
    measureText: (text) => ({
      width: options.textWidths?.[text] ?? String(text).length * 10,
    }),
  };
  // `roundRect` is absent on purpose: the renderer must fall back to arcTo paths.
  if (options.roundRect === true) ctx.roundRect = record('roundRect');

  return {
    calls,
    canvas: ctx.canvas,
    names: () => calls.map((call) => call.name),
    countOf: (name) => calls.filter((call) => call.name === name).length,
    firstOf: (name) => calls.find((call) => call.name === name)?.args,
    scratch: () => createRecordingContext({ width: options.width }),
    ctx,
  };
}

/**
 * A recording surface factory for the mosaic passes.
 * @param {{ width?: number }} [options]
 * @returns {{ create: (width: number, height: number) => object, surfaces: object[] }}
 */
export function createScratchFactory(options = {}) {
  const surfaces = [];
  return {
    surfaces,
    create: (width, height) => {
      const recorder = createRecordingContext(options);
      recorder.ctx.canvas.width = width;
      recorder.ctx.canvas.height = height;
      surfaces.push(recorder);
      return recorder.ctx;
    },
  };
}
