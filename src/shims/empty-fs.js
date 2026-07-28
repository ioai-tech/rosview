/**
 * Silent browser stub for Node's `fs`.
 *
 * `protobufjs` (and similar isomorphic packages) probe `require('fs')` at load time.
 * Vite's default external stub warns on every property access; this module returns
 * `null` so those probes fail quietly and fall back to XHR/fetch paths.
 */
export default null;
