'use strict';
const SuiteRemBg = (() => {
  function _buildRemBgApi(log) {
    // u2net.onnx ≈ 176MB：session 挂 window 跨脚本 / 跨注入复用，
    // 避免批量处理时重复加载造成内存峰值与并发 createSession 冲突。
    const U2NET_CACHE_KEY = '__u2net_onnx_session_cache_v1__';
    const U2NET_PROMISE_KEY = '__u2net_onnx_session_promise_v1__';
    /** 网格划分粒度（衣服区域检测用） */
    const GRID_SIZE = 100;

    async function getOrCreateU2NetSession() {
      await SuiteRuntime.ready();
      if (!window.ort) throw new Error('ONNX Runtime Web 未加载');

      if (window.ort.env && window.ort.env.wasm) {
        if (!window.ort.env.wasm.wasmPaths) {
          window.ort.env.wasm.wasmPaths = SuiteRuntime.url('runtime/');
        }
        if (window.ort.env.wasm.numThreads !== 1) {
          window.ort.env.wasm.numThreads = 1;
        }
      }

      if (window[U2NET_CACHE_KEY]) return window[U2NET_CACHE_KEY];
      if (window[U2NET_PROMISE_KEY]) return window[U2NET_PROMISE_KEY];

      const createPromise = (async () => {
        try {
          const modelUrl = SuiteRuntime.url('runtime/u2net.onnx');
          const response = await fetch(modelUrl);
          if (!response.ok) throw new Error('u2net.onnx 加载失败 HTTP ' + response.status);
          const arrayBuffer = await response.arrayBuffer();
          const session = await window.ort.InferenceSession.create(arrayBuffer);
          window[U2NET_CACHE_KEY] = session;
          return session;
        } finally {
          delete window[U2NET_PROMISE_KEY];
        }
      })();

      window[U2NET_PROMISE_KEY] = createPromise;
      return createPromise;
    }

    /**
     * rembg 抠图 → alpha mask（严格对齐 Python rembg BaseSession.normalize + U2netSession.predict）
     * Python: im.convert("RGB").resize((320,320), LANCZOS) → /max(pixel) → (x-mean)/std
     *         → transpose((2,0,1)) → 推理 → (pred-mi)/(ma-mi) → mask.resize(img.size, LANCZOS)
     * @param {HTMLImageElement} imgElement - 原图
     * @returns {Promise<HTMLCanvasElement>} 与原图同尺寸的 alpha mask 画布
     */
    async function rembgRemoveBackground(imgElement) {
      await SuiteRuntime.ready();
      if (!window.ort) throw new Error('ONNX Runtime Web 未加载');

      const startedAt = Date.now();
      const R = 320, C = 320;
      const resizedCanvas = document.createElement('canvas');
      resizedCanvas.width = R;
      resizedCanvas.height = C;
      const rc = resizedCanvas.getContext('2d');
      rc.imageSmoothingEnabled = true;
      rc.imageSmoothingQuality = 'high';
      rc.drawImage(imgElement, 0, 0, R, C);

      const imgData = rc.getImageData(0, 0, R, C);
      const data = imgData.data;

      // Step1：找最大像素值 → 归一化（对齐 Python /max(np.max(im_ary))）
      let pixMax = 1;
      for (let i = 0; i < data.length; i += 4) {
        const v = Math.max(data[i], data[i + 1], data[i + 2]);
        if (v > pixMax) pixMax = v;
      }
      const invMax = 1 / Math.max(pixMax, 1);

      // Step2：ImageNet 归一化，NCHW 平面布局（对齐 Python transpose((2,0,1))）
      const mean = [0.485, 0.456, 0.406];
      const std = [0.229, 0.224, 0.225];
      const planeSize = R * C;
      const inputData = new Float32Array(planeSize * 3);
      for (let i = 0; i < data.length; i += 4) {
        const pixIdx = i >> 2;
        const rr = data[i] * invMax;
        const gg = data[i + 1] * invMax;   // 变量名避开外层画布上下文 g
        const bb = data[i + 2] * invMax;
        inputData[pixIdx] = (rr - mean[0]) / std[0];
        inputData[pixIdx + planeSize] = (gg - mean[1]) / std[1];
        inputData[pixIdx + planeSize * 2] = (bb - mean[2]) / std[2];
      }

      // Step3：全局缓存 + 并发去重，避免批量时 N 次重复创建 session
      const ortSession = await getOrCreateU2NetSession();

      const inputName = (ortSession.inputNames && ortSession.inputNames[0]) || 'input';
      const inputTensor = new window.ort.Tensor('float32', inputData, [1, 3, C, R]);
      const output = await ortSession.run({ [inputName]: inputTensor });
      const outputNames = ortSession.outputNames || [];
      const outputName = outputNames[outputNames.length - 1] || 'output';
      const outputData = output[outputName].data;

      // Step4：纯 min-max 归一化（对齐 Python，不做 sigmoid）
      const maskData = new Float32Array(R * C);
      let mi = Infinity, ma = -Infinity;
      for (let i = 0; i < R * C; i++) {
        maskData[i] = outputData[i];
        if (outputData[i] < mi) mi = outputData[i];
        if (outputData[i] > ma) ma = outputData[i];
      }
      const range = ma - mi;
      if (range > 0) {
        for (let i = 0; i < maskData.length; i++) maskData[i] = (maskData[i] - mi) / range;
      }

      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = R;
      maskCanvas.height = C;
      const maskCtx = maskCanvas.getContext('2d');
      const maskImgData = maskCtx.createImageData(R, C);
      const mp = maskImgData.data;
      for (let i = 0; i < maskData.length; i++) {
        const val = Math.round(maskData[i] * 255);
        const j = i * 4;
        mp[j] = mp[j + 1] = mp[j + 2] = val;
        mp[j + 3] = 255;
      }
      maskCtx.putImageData(maskImgData, 0, 0);

      // Step5：mask 缩回原图尺寸（对齐 Python mask.resize(img.size, LANCZOS)）
      const finalMask = document.createElement('canvas');
      finalMask.width = imgElement.width;
      finalMask.height = imgElement.height;
      const fc = finalMask.getContext('2d');
      fc.imageSmoothingEnabled = true;
      fc.imageSmoothingQuality = 'high';
      fc.drawImage(maskCanvas, 0, 0, imgElement.width, imgElement.height);

      if (typeof log === 'function') {
        log('rembg 完成，耗时: ' + (Date.now() - startedAt) + 'ms');
      }
      return finalMask;
    }

    /**
     * 网格分析：按 GRID_SIZE×GRID_SIZE 统计衣服占比 → BFS 取最大连通分量 → 像素级 bbox
     * @param {HTMLCanvasElement} alphaCanvas - rembg 产出的 alpha mask
     * @returns {{clothCells:number, cellRatio:number, bbox:number[]|null}} bbox = [top, bottom, left, right]
     */
    function gridAnalysis(alphaCanvas) {
      const w = alphaCanvas.width, h = alphaCanvas.height;
      const aCtx = alphaCanvas.getContext('2d');
      const aData = aCtx.getImageData(0, 0, w, h).data;

      const cw = w / GRID_SIZE, ch = h / GRID_SIZE;
      const gg = new Array(GRID_SIZE * GRID_SIZE).fill(false);

      for (let gy = 0; gy < GRID_SIZE; gy++) {
        const y1 = Math.floor(gy * ch), y2 = Math.floor((gy + 1) * ch);
        for (let gx = 0; gx < GRID_SIZE; gx++) {
          const x1 = Math.floor(gx * cw), x2 = Math.floor((gx + 1) * cw);
          let total = 0, cloth = 0;
          for (let y = y1; y < y2; y++) {
            for (let x = x1; x < x2; x++) {
              total++;
              if (aData[(y * w + x) * 4] > 30) cloth++;
            }
          }
          if (total > 0 && cloth / total > 0.05) gg[gy * GRID_SIZE + gx] = true;
        }
      }

      // BFS 找最大连通分量
      const visited = new Array(GRID_SIZE * GRID_SIZE).fill(false);
      let largestComp = [];
      for (let i = 0; i < GRID_SIZE * GRID_SIZE; i++) {
        if (!gg[i] || visited[i]) continue;
        const comp = [];
        const queue = [i];
        visited[i] = true;
        while (queue.length) {
          const idx = queue.shift();
          comp.push(idx);
          const gy = Math.floor(idx / GRID_SIZE), gx = idx % GRID_SIZE;
          for (const [dy, dx] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
            const ny = gy + dy, nx = gx + dx;
            if (ny >= 0 && ny < GRID_SIZE && nx >= 0 && nx < GRID_SIZE) {
              const ni = ny * GRID_SIZE + nx;
              if (gg[ni] && !visited[ni]) { visited[ni] = true; queue.push(ni); }
            }
          }
        }
        if (comp.length > largestComp.length) largestComp = comp;
      }

      if (largestComp.length === 0) return { clothCells: 0, cellRatio: 0, bbox: null };

      // 重建 gg 为最大分量
      const keep = new Set(largestComp);
      for (let i = 0; i < GRID_SIZE * GRID_SIZE; i++) gg[i] = keep.has(i);

      // 找 bbox（像素级）
      let top = h, bot = 0, left = w, right = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (aData[(y * w + x) * 4] > 30) {
            if (y < top) top = y;
            if (y > bot) bot = y;
            if (x < left) left = x;
            if (x > right) right = x;
          }
        }
      }
      if (top > bot) return { clothCells: 0, cellRatio: 0, bbox: null };

      const cellRatio = largestComp.length / (GRID_SIZE * GRID_SIZE);
      return { clothCells: largestComp.length, cellRatio, bbox: [top, bot, left, right] };
    }

    return { getOrCreateU2NetSession, rembgRemoveBackground, gridAnalysis };
  }

return _buildRemBgApi;
})();
globalThis.SuiteRemBg=SuiteRemBg;
