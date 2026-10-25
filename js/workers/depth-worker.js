// ============================================================
// depth-worker.js  -  runs onnxruntime-web (WASM / CPU) OFF the UI thread
// ============================================================
// Started as a MODULE worker by js/portrait/edge-portrait.js:   new Worker(url, { type: 'module' })
// The runtime is the pinned, vendored build in ./vendor/ort (scripts/fetch_ort.py) - nothing is loaded from a CDN.
//
// Protocol (every request carries an `id` that is echoed back):
//   {type:'init',  id, model: ArrayBuffer (transferred)}      -> {type:'ready', id, input, output}
//   {type:'infer', id, input: Float32Array (transferred), size} -> {type:'result', id, depth: Float32Array (transferred), h, w}
//   {type:'dispose', id}                                       -> {type:'disposed', id}   (the worker then closes itself)
//   any failure                                                -> {type:'error', id, message}
// Single thread on purpose: multi-threaded WASM needs cross-origin isolation (SharedArrayBuffer), which an
// Android WebView / Cordova page does not have.
// ============================================================
'use strict';
import * as ort from '../../vendor/ort/ort.wasm.min.mjs';

ort.env.wasm.wasmPaths = new URL('../../vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

let session = null;
let inputName = '';
let outputName = '';

function reply(message, transfer) { self.postMessage(message, transfer || []); }

self.onmessage = async function (event) {
    const m = event.data || {};
    try {
        if (m.type === 'init') {
            if (session) { await session.release(); session = null; }
            session = await ort.InferenceSession.create(new Uint8Array(m.model), {
                executionProviders: ['wasm'], graphOptimizationLevel: 'all', enableMemPattern: true
            });
            inputName = session.inputNames[0];
            outputName = session.outputNames[0];
            reply({ type: 'ready', id: m.id, input: inputName, output: outputName });
        } else if (m.type === 'infer') {
            if (!session) throw new Error('session is not initialised');
            const size = m.size | 0;
            const tensor = new ort.Tensor('float32', new Float32Array(m.input), [1, 3, size, size]);
            const out = await session.run({ [inputName]: tensor });
            const t = out[outputName];
            if (!t || !t.data) throw new Error('depth model returned no output');
            const dims = t.dims;
            const h = dims[dims.length - 2], w = dims[dims.length - 1];
            const depth = new Float32Array(t.data);              // own copy: the ORT buffer is freed with the tensor
            if (t.dispose) t.dispose();
            if (tensor.dispose) tensor.dispose();
            reply({ type: 'result', id: m.id, depth: depth, h: h, w: w }, [depth.buffer]);
        } else if (m.type === 'dispose') {
            if (session) { try { await session.release(); } catch (e) { /* closing anyway */ } session = null; }
            reply({ type: 'disposed', id: m.id });
            self.close();
        }
    } catch (err) {
        reply({ type: 'error', id: m.id, message: String((err && err.message) || err) });
    }
};
