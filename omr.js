// 領域指定型 簡易OMR（光学楽譜認識）
(function() {
    'use strict';

    let cvReady = false;
    function checkCv() {
        if (typeof cv !== 'undefined' && cv.Mat) {
            cvReady = true;
            console.log('OpenCV.js ready');
            return true;
        }
        return false;
    }

    if (!checkCv()) {
        if (typeof cv !== 'undefined') {
            cv['onRuntimeInitialized'] = () => { cvReady = true; console.log('OpenCV.js ready'); };
        } else {
            const iv = setInterval(() => {
                if (checkCv()) clearInterval(iv);
            }, 200);
        }
    }

    /**
     * 指定領域内の楽譜を認識
     */
    function recognizeRegion(sourceCanvas, region, opts = {}) {
        if (!cvReady) throw new Error('OpenCV.js未準備');
        const threshold = opts.threshold || 160;
        const defaultDuration = opts.defaultDuration || 1;
        const clef = opts.clef || 'treble';
        const onStatus = opts.onStatus || (() => {});
        const debugCanvas = opts.debugCanvas;

        const sub = document.createElement('canvas');
        sub.width = region.w;
        sub.height = region.h;
        sub.getContext('2d').drawImage(
            sourceCanvas,
            region.x, region.y, region.w, region.h,
            0, 0, region.w, region.h
        );

        const src = cv.imread(sub);
        const gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        const binary = new cv.Mat();
        cv.threshold(gray, binary, threshold, 255, cv.THRESH_BINARY_INV);

        onStatus(`五線検出中... (領域 ${region.w}×${region.h})`, 'ok');
        const staves = detectStaves(binary);
        if (staves.length < 5) {
            cleanup([src, gray, binary]);
            throw new Error(`五線が見つかりません(検出${staves.length}本)。領域選択や閾値を調整してください。`);
        }

        // 最も等間隔な5本を抽出
        const fiveLines = pickBestFive(staves);
        const system = buildSystem(fiveLines);
        onStatus(`五線5本検出 (間隔${system.spacing.toFixed(1)}px)`, 'ok');

        const noStaff = removeStaves(binary, system);
        const heads = detectNoteHeads(noStaff, system);
        onStatus(`音符候補 ${heads.length}個検出`, 'ok');

        const notes = estimatePitches(heads, system, clef);
        notes.sort((a, b) => a.x - b.x);

        if (debugCanvas) drawDebug(debugCanvas, sub, system, notes);

        const epianoNotes = notes.map(n => ({
            note: n.pitch,
            duration: defaultDuration,
            velocity: 80
        }));

        cleanup([src, gray, binary, noStaff]);
        return epianoNotes;
    }

    /**
     * 段の自動検出
     */
    function detectSystems(sourceCanvas, opts = {}) {
        if (!cvReady) throw new Error('OpenCV.js未準備');
        const threshold = opts.threshold || 160;

        const src = cv.imread(sourceCanvas);
        const gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        const binary = new cv.Mat();
        cv.threshold(gray, binary, threshold, 255, cv.THRESH_BINARY_INV);

        const staves = detectStaves(binary);
        cleanup([src, gray, binary]);

        if (staves.length < 5) return [];

        // 連続する5本ずつをグループ化
        const systems = [];
        let i = 0;
        while (i + 4 < staves.length) {
            const five = staves.slice(i, i + 5);
            const gaps = [];
            for (let j = 1; j < 5; j++) gaps.push(five[j] - five[j - 1]);
            const avg = gaps.reduce((a, b) => a + b, 0) / 4;
            const ok = gaps.every(g => Math.abs(g - avg) < avg * 0.6) && avg > 3 && avg < 60;
            if (ok) {
                const margin = avg * 4;
                systems.push({
                    y: Math.max(0, Math.round(five[0] - margin)),
                    height: Math.round(five[4] - five[0] + margin * 2),
                    lines: five
                });
                i += 5;
            } else {
                i += 1;
            }
        }
        return systems;
    }

    /**
     * 指定座標のピッチを判定（クリックモード用）
     */
    function pitchAtPoint(sourceCanvas, region, clickX, clickY, opts = {}) {
        if (!cvReady) throw new Error('OpenCV.js未準備');
        const threshold = opts.threshold || 160;
        const clef = opts.clef || 'treble';

        const sub = document.createElement('canvas');
        sub.width = region.w; sub.height = region.h;
        sub.getContext('2d').drawImage(
            sourceCanvas, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h
        );
        const src = cv.imread(sub);
        const gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        const binary = new cv.Mat();
        cv.threshold(gray, binary, threshold, 255, cv.THRESH_BINARY_INV);

        const staves = detectStaves(binary);
        cleanup([src, gray, binary]);
        if (staves.length < 5) return null;

        const fiveLines = pickBestFive(staves);
        const system = buildSystem(fiveLines);
        const localY = clickY - region.y;
        return yToPitch(localY, system, clef);
    }

    // ========== 内部関数 ==========

    function cleanup(mats) { mats.forEach(m => { try { m.delete(); } catch(e){} }); }

    function detectStaves(binary) {
        const rows = binary.rows, cols = binary.cols;
        const proj = new Array(rows).fill(0);
        for (let y = 0; y < rows; y++) {
            let s = 0;
            for (let x = 0; x < cols; x++) {
                if (binary.ucharPtr(y, x)[0] > 0) s++;
            }
            proj[y] = s;
        }
        const thresh = cols * 0.5;
        const lines = [];
        let inL = false, lst = 0;
        for (let y = 0; y < rows; y++) {
            if (proj[y] > thresh) {
                if (!inL) { lst = y; inL = true; }
            } else if (inL) {
                lines.push((lst + y - 1) / 2);
                inL = false;
            }
        }
        return lines;
    }

    function pickBestFive(staves) {
        // 5本以上ある場合、最も均等な5本連続を選ぶ
        if (staves.length === 5) return staves;
        let bestIdx = 0, bestVar = Infinity;
        for (let i = 0; i + 4 < staves.length; i++) {
            const five = staves.slice(i, i + 5);
            const gaps = [];
            for (let j = 1; j < 5; j++) gaps.push(five[j] - five[j - 1]);
            const avg = gaps.reduce((a, b) => a + b, 0) / 4;
            const variance = gaps.reduce((s, g) => s + (g - avg) ** 2, 0) / 4;
            if (variance < bestVar) { bestVar = variance; bestIdx = i; }
        }
        return staves.slice(bestIdx, bestIdx + 5);
    }

    function buildSystem(fiveLines) {
        const gaps = [];
        for (let i = 1; i < 5; i++) gaps.push(fiveLines[i] - fiveLines[i - 1]);
        const spacing = gaps.reduce((a, b) => a + b, 0) / 4;
        return {
            lines: fiveLines,
            spacing,
            topY: fiveLines[0],
            bottomY: fiveLines[4],
            centerY: (fiveLines[0] + fiveLines[4]) / 2
        };
    }

    function removeStaves(binary, system) {
        const result = binary.clone();
        const kSize = Math.max(20, Math.floor(system.spacing * 5));
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kSize, 1));
        const horizontal = new cv.Mat();
        cv.morphologyEx(binary, horizontal, cv.MORPH_OPEN, kernel);
        cv.subtract(result, horizontal, result);
        kernel.delete(); horizontal.delete();
        return result;
    }

    function detectNoteHeads(noStaff, system) {
        const sp = system.spacing;
        const minW = sp * 0.6, maxW = sp * 2.2;
        const minH = sp * 0.5, maxH = sp * 2.0;
        const minArea = sp * sp * 0.3;

        const labels = new cv.Mat();
        const stats = new cv.Mat();
        const centroids = new cv.Mat();
        const n = cv.connectedComponentsWithStats(noStaff, labels, stats, centroids);

        const heads = [];
        for (let i = 1; i < n; i++) {
            const w = stats.intAt(i, cv.CC_STAT_WIDTH);
            const h = stats.intAt(i, cv.CC_STAT_HEIGHT);
            const area = stats.intAt(i, cv.CC_STAT_AREA);
            const cx = centroids.doubleAt(i, 0);
            const cy = centroids.doubleAt(i, 1);
            if (w < minW || w > maxW) continue;
            if (h < minH || h > maxH) continue;
            if (area < minArea) continue;
            const ratio = w / h;
            if (ratio < 0.5 || ratio > 2.5) continue;
            // 五線範囲±6spacing以内
            if (cy < system.topY - sp * 6 || cy > system.bottomY + sp * 6) continue;
            heads.push({ x: cx, y: cy, w, h, area });
        }
        labels.delete(); stats.delete(); centroids.delete();
        return heads;
    }

    function yToPitch(y, system, clef) {
        // 五線の上端=line5の音、spacing/2 = ダイアトニック1step
        const stepFromTop = (system.topY - y) / (system.spacing / 2);
        // ト音記号: 第5線=F5、ヘ音記号: 第5線=A3
        const baseIndex = clef === 'bass' ? (5 + 7 * 3) : (3 + 7 * 5);
        const target = Math.round(baseIndex + stepFromTop);
        const noteIdx = ((target % 7) + 7) % 7;
        const octave = Math.floor(target / 7);
        const scale = ['C','D','E','F','G','A','B'];
        return scale[noteIdx] + Math.max(0, Math.min(9, octave));
    }

    function estimatePitches(heads, system, clef) {
        return heads.map(h => ({ ...h, pitch: yToPitch(h.y, system, clef) }));
    }

    function drawDebug(canvas, srcCanvas, system, notes) {
        canvas.width = srcCanvas.width;
        canvas.height = srcCanvas.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(srcCanvas, 0, 0);

        ctx.strokeStyle = 'rgba(255,80,80,0.7)';
        ctx.lineWidth = 1;
        for (const y of system.lines) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
        }

        ctx.strokeStyle = '#00e676';
        ctx.fillStyle = '#00e676';
        ctx.lineWidth = 2;
        ctx.font = 'bold 12px monospace';
        notes.forEach(n => {
            ctx.beginPath();
            ctx.ellipse(n.x, n.y, n.w / 2, n.h / 2, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillText(n.pitch, n.x + n.w / 2 + 3, n.y + 4);
        });

        canvas.classList.add('show');
    }

    window.OMR = {
        recognize: recognizeRegion,
        detectSystems,
        pitchAtPoint,
        isReady: () => cvReady
    };
})();
