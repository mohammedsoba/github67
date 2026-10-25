// ============================================================
// webgl-renderer.js
// ============================================================
// ==================== WEBGL2 GPU RENDERER ====================
// Full replacement for the CPU ImageData loops. All slider adjustments
// (exposure, shadows, whites, blacks, vibrance, warmth, tint, sharpness,
// clarity, vignette, grain, HSL color-mix, tonal curves) are computed in
// a single fragment-shader pass on the GPU. Uniforms are updated live so
// dragging a slider re-renders in one draw call (~60 fps).
var GPU = (function(){
    var gl = null;
    var canvas = null;         // offscreen WebGL2 canvas
    var program = null;
    var vao = null;
    var srcTex = null;         // texture holding the pre-filtered source
    var lutTex = null;         // 256x1 RGBA LUT for tone curves
    var uniforms = {};
    var srcW = 0, srcH = 0;
    var lastKey = null;        // key of the image currently in srcTex (null = unknown / always re-upload)
    var lastLut = {};          // LUT array references last uploaded (skip identical re-uploads)
    var MAXF = 12;             // max CSS-filter steps (brightness/contrast/saturate + preset) run in the shader
    var fmBuf = new Float32Array(9 * 12);
    var foBuf = new Float32Array(3 * 12);
    var mixBuf = new Float32Array(24);
    var lutBuf = new Uint8Array(256 * 4);   // reused for every LUT upload (texImage2D copies synchronously)

    var VSRC = "#version 300 es\n" +
        "in vec2 a_pos;\n" +
        "in vec2 a_uv;\n" +
        "out vec2 v_uv;\n" +
        "void main(){ v_uv = a_uv; gl_Position = vec4(a_pos, 0.0, 1.0); }\n";

    // Fragment shader — every effect lives here. Add new sliders by wiring
    // another uniform and applying it in the pipeline order below.
    var FSRC = "#version 300 es\n" +
        "precision highp float;\n" +
        "in vec2 v_uv;\n" +
        "out vec4 outColor;\n" +
        "uniform sampler2D u_image;\n" +
        "uniform sampler2D u_lut;\n" +
        "uniform vec2  u_texel;\n" +
        "uniform int   u_fcount;\n" +   // number of CSS-filter steps (brightness, contrast, saturate, preset...)
        "uniform mat3  u_fm[12];\n" +   // per-step 3x3 colour matrix (column-major)
        "uniform vec3  u_fo[12];\n" +   // per-step offset
        "uniform float u_exposure;\n" +
        "uniform float u_shadows;\n" +
        "uniform float u_whites;\n" +
        "uniform float u_blacks;\n" +
        "uniform float u_vibrance;\n" +
        "uniform float u_warmth;\n" +
        "uniform float u_tint;\n" +
        "uniform float u_sharp;\n" +
        "uniform float u_clarity;\n" +
        "uniform float u_vignette;\n" +
        "uniform float u_grain;\n" +
        "uniform float u_grainSeed;\n" +
        "uniform float u_useLut;\n" +
        "uniform vec3  u_mix[8];\n" +   // per-channel (hue, sat, lum) deltas
        "\n" +
        "const vec3 LUM = vec3(0.299, 0.587, 0.114);\n" +
        "float smooth01(float x){ x = clamp(x,0.0,1.0); return x*x*(3.0-2.0*x); }\n" +
        "vec3 rgb2hsl(vec3 c){\n" +
        "  float mx = max(max(c.r,c.g),c.b);\n" +
        "  float mn = min(min(c.r,c.g),c.b);\n" +
        "  float l = (mx+mn)*0.5;\n" +
        "  float d = mx-mn;\n" +
        "  float h = 0.0, s = 0.0;\n" +
        "  if(d > 0.00001){\n" +
        "    s = l > 0.5 ? d/(2.0-mx-mn) : d/(mx+mn);\n" +
        "    if(mx==c.r)       h = mod((c.g-c.b)/d, 6.0);\n" +
        "    else if(mx==c.g)  h = (c.b-c.r)/d + 2.0;\n" +
        "    else              h = (c.r-c.g)/d + 4.0;\n" +
        "    h *= 60.0; if(h<0.0) h += 360.0;\n" +
        "  }\n" +
        "  return vec3(h, s*100.0, l*100.0);\n" +
        "}\n" +
        "float hue2rgb(float p,float q,float t){\n" +
        "  if(t<0.0) t+=1.0; if(t>1.0) t-=1.0;\n" +
        "  if(t<1.0/6.0) return p+(q-p)*6.0*t;\n" +
        "  if(t<0.5)     return q;\n" +
        "  if(t<2.0/3.0) return p+(q-p)*(2.0/3.0-t)*6.0;\n" +
        "  return p;\n" +
        "}\n" +
        "vec3 hsl2rgb(vec3 hsl){\n" +
        "  float h = hsl.x/360.0, s = hsl.y/100.0, l = hsl.z/100.0;\n" +
        "  if(s < 0.00001) return vec3(l);\n" +
        "  float q = l < 0.5 ? l*(1.0+s) : l+s - l*s;\n" +
        "  float p = 2.0*l - q;\n" +
        "  return vec3(hue2rgb(p,q,h+1.0/3.0), hue2rgb(p,q,h), hue2rgb(p,q,h-1.0/3.0));\n" +
        "}\n" +
        "\n" +
        // CSS filter functions (brightness/contrast/saturate/sepia/grayscale/hue-rotate) are all linear
        // colour matrices, so the whole chain runs here instead of through canvas ctx.filter
        // (which Safari / iOS WKWebView do not support). Clamped between steps like the browser does.
        "vec3 applyFilters(vec3 c){\n" +
        "  for(int i = 0; i < 12; i++){\n" +
        "    if(i >= u_fcount) break;\n" +
        "    c = clamp(u_fm[i] * c + u_fo[i], 0.0, 1.0);\n" +
        "  }\n" +
        "  return c;\n" +
        "}\n" +
        "vec3 fetchRGB(vec2 uv){ return applyFilters(texture(u_image, uv).rgb); }\n" +
        "\n" +
        "void main(){\n" +
        "  vec4 texel = texture(u_image, v_uv);\n" +
        "  vec3 c = applyFilters(texel.rgb);\n" +
        "  float alpha = texel.a;\n" +

        // --- Sharpness (simple 4-neighbor unsharp mask, protected at edges)
        "  if(u_sharp > 0.0){\n" +
        "    vec3 n = fetchRGB(v_uv + vec2(0.0, u_texel.y)) +\n" +
        "             fetchRGB(v_uv - vec2(0.0, u_texel.y)) +\n" +
        "             fetchRGB(v_uv + vec2(u_texel.x, 0.0)) +\n" +
        "             fetchRGB(v_uv - vec2(u_texel.x, 0.0));\n" +
        "    c = clamp(c + (c*4.0 - n) * (u_sharp/100.0) * 0.5, 0.0, 1.0);\n" +
        "  }\n" +

        // --- Exposure (mid-tone weighted)
        "  if(u_exposure != 0.0){\n" +
        "    float lum = dot(c, LUM);\n" +
        "    float w = 1.0 - abs(lum - 0.5) * 2.0;\n" +
        "    c += (u_exposure/50.0) * w * (40.0/255.0);\n" +
        "  }\n" +

        // --- Shadows / Whites / Blacks (tone-region weighted)
        "  {\n" +
        "    float lum = dot(c, LUM);\n" +
        "    if(u_shadows != 0.0 && lum < 0.5){\n" +
        "      float k = (0.5 - lum) * 2.0;\n" +
        "      c += (u_shadows/50.0) * k * (60.0/255.0);\n" +
        "    }\n" +
        "    if(u_whites != 0.0 && lum > 0.7529){\n" +
        "      float k = (lum - 0.7529) / 0.2471;\n" +
        "      c += (u_whites/50.0) * k * (50.0/255.0);\n" +
        "    }\n" +
        "    if(u_blacks != 0.0 && lum < 0.25){\n" +
        "      float k = (0.25 - lum) * 4.0;\n" +
        "      c += (u_blacks/50.0) * k * (40.0/255.0);\n" +
        "    }\n" +
        "  }\n" +

        // --- Vibrance (boost undersaturated pixels more)
        "  if(u_vibrance != 0.0){\n" +
        "    float mx = max(max(c.r,c.g),c.b);\n" +
        "    float mn = min(min(c.r,c.g),c.b);\n" +
        "    float sat = mx > 0.0 ? (mx-mn)/mx : 0.0;\n" +
        "    float intensity = (1.0 - sat) * (u_vibrance/100.0);\n" +
        "    float avg = (c.r + c.g + c.b) / 3.0;\n" +
        "    c += (c - vec3(avg)) * intensity;\n" +
        "  }\n" +

        // --- Warmth (red/blue balance shift)
        "  if(u_warmth != 0.0){\n" +
        "    float f = u_warmth/50.0;\n" +
        "    if(f > 0.0){\n" +
        "      c.r += f * (20.0/255.0);\n" +
        "      c.g += f * (10.0/255.0);\n" +
        "      c.b -= f * (15.0/255.0);\n" +
        "    } else {\n" +
        "      c.r += f * (10.0/255.0);\n" +
        "      c.b -= f * (20.0/255.0);\n" +
        "    }\n" +
        "  }\n" +

        // --- Tint (magenta/green)
        "  if(u_tint != 0.0){\n" +
        "    float a = (u_tint/50.0) * (30.0/255.0);\n" +
        "    c.r += a; c.g -= a*0.5; c.b += a;\n" +
        "  }\n" +

        // --- HSL Color Mix (8 hue bands, matches CPU version)
        "  {\n" +
        "    const float TARGETS[8] = float[8](0.0,30.0,60.0,120.0,180.0,240.0,270.0,330.0);\n" +
        "    const float HALF_WIN = 45.0;\n" +
        "    vec3 hsl = rgb2hsl(clamp(c,0.0,1.0));\n" +
        "    float satGate = smooth01((hsl.y - 8.0) / 12.0);\n" +
        "    if(satGate > 0.0){\n" +
        "      float dH = 0.0, dS = 0.0, dL = 0.0;\n" +
        "      bool any = false;\n" +
        "      for(int i=0; i<8; i++){\n" +
        "        vec3 m = u_mix[i];\n" +
        "        if(m.x==0.0 && m.y==0.0 && m.z==0.0) continue;\n" +
        "        float hd = abs(hsl.x - TARGETS[i]);\n" +
        "        if(hd > 180.0) hd = 360.0 - hd;\n" +
        "        if(hd >= HALF_WIN) continue;\n" +
        "        float t = 1.0 - hd/HALF_WIN;\n" +
        "        float w = smooth01(t) * satGate;\n" +
        "        if(w <= 0.0) continue;\n" +
        "        any = true;\n" +
        "        dH += m.x * w; dS += m.y * w; dL += m.z * w;\n" +
        "      }\n" +
        "      if(any){\n" +
        "        float nh = mod(hsl.x + dH*0.6, 360.0); if(nh < 0.0) nh += 360.0;\n" +
        "        float ns = clamp(hsl.y + dS*0.8, 0.0, 100.0);\n" +
        "        float nl = clamp(hsl.z + dL*0.5, 0.0, 100.0);\n" +
        "        c = hsl2rgb(vec3(nh, ns, nl));\n" +
        "      }\n" +
        "    }\n" +
        "  }\n" +

        // --- Clarity (local-contrast against per-pixel luminance)
        "  if(u_clarity > 0.0){\n" +
        "    float lum = dot(c, LUM);\n" +
        "    float protectF = lum < 0.117 ? 0.3 : (lum > 0.862 ? 0.5 : 1.0);\n" +
        "    float diff = (u_clarity/100.0) * protectF;\n" +
        "    c += (c - vec3(lum)) * diff;\n" +
        "  }\n" +

        // --- Vignette (smoothstep radial)
        "  if(u_vignette != 0.0){\n" +
        "    vec2 d = v_uv - vec2(0.5);\n" +
        "    float t = clamp(length(d) / 0.7071, 0.0, 1.0);\n" +
        "    float falloff = t*t*(3.0-2.0*t);\n" +
        "    float s = u_vignette/100.0;\n" +
        "    if(s < 0.0) c *= (1.0 + s * falloff);\n" +
        "    else        c += (vec3(1.0) - c) * (s * falloff);\n" +
        "  }\n" +

        // --- Grain (hash-based per-pixel noise)
        "  if(u_grain > 0.0){\n" +
        "    float n = fract(sin(dot(v_uv*vec2(1920.0,1080.0) + u_grainSeed, vec2(12.9898,78.233))) * 43758.5453);\n" +
        "    c += (n - 0.5) * (u_grain/100.0) * (50.0/255.0);\n" +
        "  }\n" +

        // --- Tone curves via LUT (red -> green -> blue -> composite rgb)
        "  if(u_useLut > 0.5){\n" +
        "    c = clamp(c, 0.0, 1.0);\n" +
        "    vec3 perChan = vec3(\n" +
        "      texture(u_lut, vec2(c.r, 0.5)).r,\n" +
        "      texture(u_lut, vec2(c.g, 0.5)).g,\n" +
        "      texture(u_lut, vec2(c.b, 0.5)).b);\n" +
        "    c = vec3(\n" +
        "      texture(u_lut, vec2(perChan.r, 0.5)).a,\n" +
        "      texture(u_lut, vec2(perChan.g, 0.5)).a,\n" +
        "      texture(u_lut, vec2(perChan.b, 0.5)).a);\n" +
        "  }\n" +

        "  outColor = vec4(clamp(c, 0.0, 1.0), alpha);\n" +
        "}\n";

    function compile(gl, type, src){
        var sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if(!gl.getShaderParameter(sh, gl.COMPILE_STATUS)){
            console.error('Shader compile failed:', gl.getShaderInfoLog(sh), src);
            gl.deleteShader(sh); return null;
        }
        return sh;
    }

    function init(){
        if(gl) return true;
        canvas = document.createElement('canvas');
        gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: false, antialias: false });
        if(!gl){ console.warn('WebGL2 not available; falling back to CPU'); canvas = null; return false; }
        // GPU context can be reclaimed by the OS (backgrounded tab, memory pressure). Drop everything so the
        // next render() builds a fresh context instead of drawing into a dead one.
        canvas.addEventListener('webglcontextlost', function(ev){ ev.preventDefault(); resetState(); }, false);

        var vs = compile(gl, gl.VERTEX_SHADER, VSRC);
        var fs = compile(gl, gl.FRAGMENT_SHADER, FSRC);
        if(!vs || !fs){ gl = null; return false; }
        program = gl.createProgram();
        gl.attachShader(program, vs); gl.attachShader(program, fs);
        gl.bindAttribLocation(program, 0, 'a_pos');
        gl.bindAttribLocation(program, 1, 'a_uv');
        gl.linkProgram(program);
        if(!gl.getProgramParameter(program, gl.LINK_STATUS)){
            console.error('Program link failed:', gl.getProgramInfoLog(program));
            gl = null; return false;
        }

        // Fullscreen triangle-strip quad (UV flipped so texture reads match 2D)
        var buf = gl.createBuffer();
        vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1,-1, 0,1,   1,-1, 1,1,   -1,1, 0,0,   1,1, 1,0
        ]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

        srcTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, srcTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        lutTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, lutTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        // Identity LUT initially (built in the shared buffer: no throw-away allocation)
        for(var i = 0; i < 256; i++){
            lutBuf[i*4]   = i; lutBuf[i*4+1] = i;
            lutBuf[i*4+2] = i; lutBuf[i*4+3] = i;
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lutBuf);
        lastLut = {};          // the texture holds the identity, not any caller's LUT

        gl.useProgram(program);
        var names = ['u_image','u_lut','u_texel','u_fcount','u_fm','u_fo',
            'u_exposure','u_shadows','u_whites','u_blacks','u_vibrance','u_warmth','u_tint',
            'u_sharp','u_clarity','u_vignette','u_grain','u_grainSeed','u_useLut','u_mix'];
        var arrays = { u_mix: 1, u_fm: 1, u_fo: 1 };
        for(var j=0;j<names.length;j++){
            uniforms[names[j]] = gl.getUniformLocation(program, names[j] + (arrays[names[j]] ? '[0]' : ''));
        }
        gl.uniform1i(uniforms.u_image, 0);
        gl.uniform1i(uniforms.u_lut, 1);
        return true;
    }

    function resetState(){
        gl = null; program = null; vao = null; srcTex = null; lutTex = null;
        uniforms = {}; canvas = null; srcW = 0; srcH = 0;
        lastKey = null; lastLut = {};
    }

    // Upload the source image (canvas / <img> / ImageBitmap). Alpha is kept un-premultiplied so
    // transparent cut-outs survive the shader pass.
    function uploadSource(source, w, h){
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, srcTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        srcW = w; srcH = h;
        if(canvas.width !== srcW) canvas.width = srcW;
        if(canvas.height !== srcH) canvas.height = srcH;
    }

    function uploadLUT(L){
        // Pack (redLUT, greenLUT, blueLUT, rgbLUT) into a 256x1 RGBA texture (reused buffer).
        var lut = lutBuf;
        var rL = L && L.red, gL = L && L.green, bL = L && L.blue, mL = L && L.rgb;
        for(var i = 0; i < 256; i++){
            lut[i*4  ] = rL ? rL[i] : i;
            lut[i*4+1] = gL ? gL[i] : i;
            lut[i*4+2] = bL ? bL[i] : i;
            lut[i*4+3] = mL ? mL[i] : i;
        }
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, lutTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
        lastLut = { red: rL, green: gL, blue: bL, rgb: mL };
    }

    // Public: render `source` with the edit state `opts.state` (defaults to the live editor state).
    //   opts.key    : same key as the previous call -> the source texture is NOT re-uploaded
    //                 (slider drags only change uniforms). null/undefined = always upload.
    //   opts.width / opts.height : source size when it is not a canvas (defaults to natural size).
    // Returns the internal WebGL canvas (alpha preserved) or null when the GPU path is unavailable.
    function render(source, opts){
        if(gl && gl.isContextLost && gl.isContextLost()) resetState();
        if(!init()) return null;
        opts = opts || {};
        var st = opts.state || ((typeof YoPipeline !== 'undefined') ? YoPipeline.currentEditState() : null);
        if(!st) return null;
        var w = opts.width  || source.naturalWidth  || source.width;
        var h = opts.height || source.naturalHeight || source.height;
        if(!w || !h) return null;
        if(Math.max(w, h) > gl.getParameter(gl.MAX_TEXTURE_SIZE)) return null;

        var key = (opts.key === undefined) ? null : opts.key;
        if(key === null || key !== lastKey || w !== srcW || h !== srcH){
            uploadSource(source, w, h);
            lastKey = key;
        }
        var L = st.lut || {};
        if(L.rgb !== lastLut.rgb || L.red !== lastLut.red || L.green !== lastLut.green || L.blue !== lastLut.blue){
            uploadLUT(L);
        }

        gl.useProgram(program);
        gl.bindVertexArray(vao);
        gl.viewport(0, 0, srcW, srcH);
        gl.uniform2f(uniforms.u_texel, 1.0/srcW, 1.0/srcH);

        // CSS-filter chain (brightness / contrast / saturate / preset) as colour-matrix steps
        var steps = st.filterSteps || [];
        var n = Math.min(steps.length, MAXF);
        for(var f = 0; f < n; f++){
            var m = steps[f].m, o = steps[f].o, b9 = f * 9, b3 = f * 3;
            fmBuf[b9]   = m[0]; fmBuf[b9+1] = m[3]; fmBuf[b9+2] = m[6];     // column 0
            fmBuf[b9+3] = m[1]; fmBuf[b9+4] = m[4]; fmBuf[b9+5] = m[7];     // column 1
            fmBuf[b9+6] = m[2]; fmBuf[b9+7] = m[5]; fmBuf[b9+8] = m[8];     // column 2
            foBuf[b3] = o[0]; foBuf[b3+1] = o[1]; foBuf[b3+2] = o[2];
        }
        gl.uniform1i(uniforms.u_fcount, n);
        gl.uniformMatrix3fv(uniforms.u_fm, false, fmBuf);
        gl.uniform3fv(uniforms.u_fo, foBuf);

        var s = st.sliders || {};
        gl.uniform1f(uniforms.u_exposure, s.exposure || 0);
        gl.uniform1f(uniforms.u_shadows,  s.shadows  || 0);
        gl.uniform1f(uniforms.u_whites,   s.whites   || 0);
        gl.uniform1f(uniforms.u_blacks,   s.blacks   || 0);
        gl.uniform1f(uniforms.u_vibrance, s.vibrance || 0);
        gl.uniform1f(uniforms.u_warmth,   s.warmth   || 0);
        gl.uniform1f(uniforms.u_tint,     s.tint     || 0);
        gl.uniform1f(uniforms.u_sharp,    s.sharp    || 0);
        gl.uniform1f(uniforms.u_clarity,  s.clarity  || 0);
        gl.uniform1f(uniforms.u_vignette, s.vignette || 0);
        gl.uniform1f(uniforms.u_grain,    s.grain    || 0);
        // Session seed (YoPipeline.grainSeed): constant while dragging -> no flicker; the same value feeds the
        // GPU export and the CPU fallback, so preview and export show the identical pattern. It only changes
        // when a new photo is uploaded.
        gl.uniform1f(uniforms.u_grainSeed, st.grainSeed || 0.0);

        gl.uniform1f(uniforms.u_useLut, st.useLut ? 1.0 : 0.0);

        var mix = st.mix;
        if(!mix){ mixBuf.fill(0); mix = mixBuf; }
        gl.uniform3fv(uniforms.u_mix, mix);

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        return canvas;
    }

    // Free the (potentially 26 MB) drawing buffer AND the source texture after a one-off full-resolution
    // export render: canvas backing store -> 0x0, texture storage -> 1x1. The next render() re-sizes the
    // canvas and re-uploads the source (lastKey is cleared), so nothing else needs to know.
    function release(){
        if(gl && srcTex){
            try {
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, srcTex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            } catch(e) { /* context lost: nothing left to free */ }
        }
        if(canvas){ canvas.width = 0; canvas.height = 0; }
        srcW = 0; srcH = 0; lastKey = null;
    }

    return {
        init: init, render: render, release: release,
        isAvailable: function(){ return init(); },
        getCanvas: function(){ return canvas; },
        maxTextureSize: function(){ return (init() && gl) ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 0; }
    };
})();
