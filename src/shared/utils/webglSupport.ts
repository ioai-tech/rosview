/** True when this browser can create a WebGL context (cached; false outside a browser). */
let cached: boolean | undefined;

export function isWebGLAvailable(): boolean {
  if (cached !== undefined) return cached;
  if (typeof document === 'undefined') return (cached = false);
  try {
    const canvas = document.createElement('canvas');
    cached = Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    cached = false;
  }
  return cached;
}
