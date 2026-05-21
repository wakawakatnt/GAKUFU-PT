// 簡易光学楽譜認識 (OpenCV.js使用)
// 完璧ではないが、印刷譜なら音符の概略を抽出可能
(function() {
    'use strict';

    let cvReady = false;
    function onOpenCvReady() { cvReady = true; console.log('OpenCV.js ready'); }
    // OpenCV.js は読み込み完了で window.cv に設定される
    if (typeof cv !== 'undefined') {
        if (cv.Mat) cvReady = true;
        else cv['onRuntimeInitialized'] = onOpenCvReady;
    } else {
        const checkInterval = setInterval(() => {
            if (typeof cv !== 'undefined' && cv.Mat) {
                cvReady = true; clearInterval(checkInterval);
            }
        }, 200);
    }

    /**
     * 楽譜画像から音符を抽出
     * @param {HTMLCanvasElement} canvas - 入力画像
     * @param {Object} opts - { threshold }
     * @returns {Object} - ePiano JSON
     */
    function recognize(canvas, opts = {}) {
        if (!cvReady) throw new Error('OpenCV.js がまだ読み込まれていません');
        const threshold = opts.threshold || 160;
        const debugCanvas = opts.debugCanvas;
        const onStatus = opts.onStatus || (() => {});

        onStatus('画像読込中...', 'ok');
        const src = cv.imread(canvas);
        const gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

        // 二値化
        const binary = new cv.Mat();
        cv.threshold(gray, binary, threshold, 255, cv.THRESH_BINARY_INV);

        // ステップ1: 五線検出 (水平投影)
        onStatus('五線を検出中...', 'ok');
        const staves = detectStaves(binary);
        if (staves.length === 0) {
            cleanup([src, gray, binary]);
            throw new Error('五線を検出できませんでした。画像をはっきりさせるか、別の画像を試してください。');
        }
        onStatus(`五線 ${staves.length}本を検出`, 'ok');

        // ステップ2: 五線を除去
        const noStaff = removeStaves(binary, staves);

        // ステップ3: 音符ヘッド検出 (連結成分)
        onStatus('音符を検出中...', 'ok');
        const noteHeads = detectNoteHeads(noStaff, staves);
        onStatus(`音符候補 ${noteHeads.length}個を検出`, 'ok');

        // ステップ4: ピッチ推定
        const stavesGrouped = groupStavesIntoSystems(staves);
        const notes = estimatePitches(noteHeads, stavesGrouped);

        // ステップ5: 時間順ソート（左から右、上から下）
        notes.sort((a, b) => {
            // 同じ譜表段なら x で、違うなら y で
            if (Math.abs(a.systemY - b.systemY) > 50) return a.systemY - b.systemY;
            return a.x - b.x;
        });

        // デバッグ描画
        if (debugCanvas) drawDebug(debugCanvas, src, staves, noteHeads);

        cleanup([src, gray, binary, noStaff]);

        // ePiano JSON 形式に変換
        // ※ 音価は推定できないので一律 1/4 拍とする（要ユーザー補正）
        const epianoNotes = notes.map(n => ({
            note: n.pitch,
            duration: 1,
            velocity: 80
        }));

        onStatus(`完了: ${epianoNotes.length}個の音符を抽出 (音価は1拍固定。手動補正推奨)`, 'warn');

        return {
            version: '5.0',
            title: 'OMR Result',
            bpm: 120,
            defaultInstrument: 'piano1',
            tracks: [{ name: 'Track 1', instrument: '', notes: epianoNotes }]
        };
    }

    function cleanup(mats) { mats.forEach(m => { try { m.delete(); } catch(e){} }); }

    // 水平方向の黒画素を投影して五線位置を検出
    function detectStaves(binary) {
        const rows = binary.rows, cols = binary.cols;
        const projection = new Array(rows).fill(0);
        for (let y = 0; y < rows; y++) {
            let sum = 0;
            for (let x = 0; x < cols; x++) {
                if (binary.ucharPtr(y, x)[0] > 0) sum++;
            }
            projection[y] = sum;
        }

        // 全幅の40%以上黒い行は五線候補
        const threshold = cols * 0.4;
        const lines = [];
        let inLine = false, lineStart = 0;
        for (let y = 0; y < rows; y++) {
            if (projection[y] > threshold) {
                if (!inLine) { lineStart = y; inLine = true; }
            } else {
                if (inLine) {
                    lines.push((lineStart + y - 1) / 2);
                    inLine = false;
                }
            }
        }
        return lines;
    }

    // 五線を5本ずつ「段」にグループ化
    function groupStavesIntoSystems(staves) {
        if (staves.length < 5) return [];
        const systems = [];
        for (let i = 0; i + 4 < staves.length; i += 5) {
            // 連続する5本のスペーシングが概ね均等ならそれを1段とする
            const lines = staves.slice(i, i + 5);
            const gaps = [];
            for (let j = 1; j < 5; j++) gaps.push(lines[j] - lines[j - 1]);
            const avgGap = gaps.reduce((a,b) => a+b, 0) / gaps.length;
            // 上限：行間が異常に広いならまとまっていない（系を分割）
            if (gaps.every(g => Math.abs(g - avgGap) < avgGap * 0.5)) {
                systems.push({
                    lines, // y座標5本
                    spacing: avgGap,
                    topY: lines[0],
                    bottomY: lines[4],
                    centerY: (lines[0] + lines[4]) / 2
                });
            } else {
                // 失敗した場合は近接5本の中央でリセット
                i -= 4; // 1本ずつズラして再試行を簡略化
            }
        }
        return systems;
    }

    // 五線を削除（実際は細くする：水平モルフォロジ）
    function removeStaves(binary, staves) {
        const result = binary.clone();
        // 水平方向の細長い要素を抽出してマスク
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(40, 1));
        const horizontal = new cv.Mat();
        cv.morphologyEx(binary, horizontal, cv.MORPH_OPEN, kernel);
        cv.subtract(result, horizontal, result);
        kernel.delete();
        horizontal.delete();
        return result;
    }

    // 連結成分から音符ヘッド(楕円形の塊)を検出
    function detectNoteHeads(noStaff, staves) {
        const avgGap = staves.length > 1
            ? (staves[staves.length - 1] - staves[0]) / (staves.length - 1)
            : 10;
        const minSize = avgGap * 0.5;
        const maxSize = avgGap * 2;

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

            // サイズフィルタ: 音符ヘッドっぽい大きさ
            if (w < minSize || w > maxSize) continue;
            if (h < minSize * 0.6 || h > maxSize) continue;
            if (area < minSize * minSize * 0.3) continue;
            // アスペクト比 0.5～2.0
            const ratio = w / h;
            if (ratio < 0.5 || ratio > 2.5) continue;

            heads.push({ x: cx, y: cy, w, h, area });
        }

        labels.delete(); stats.delete(); centroids.delete();
        return heads;
    }

    // 五線上の y 座標から音高を推定
    // ト音記号前提：第5線(一番上) = F5, 第1線(一番下) = E4
    function estimatePitches(heads, systems) {
        if (systems.length === 0) {
            return heads.map(h => ({ ...h, pitch: 'C4', systemY: h.y }));
        }

        // ト音記号の標準ピッチマッピング
        // y位置から「五線の何本目+間」を計算してピッチに変換
        // 上から: F5(線5), E5(間), D5(線4), C5(間), B4(線3), A4(間), G4(線2), F4(間), E4(線1)
        // 下加線まで含めて: ...A3,B3,C4,D4,E4(線1),F4,G4,A4,B4,C5,D5,E5,F5(線5),G5,A5,B5,C6...
        const scale = ['C','D','E','F','G','A','B'];

        return heads.map(head => {
            // 最も近いsystemを探す
            let bestSys = systems[0], bestDist = Infinity;
            for (const sys of systems) {
                const d = Math.abs(head.y - sys.centerY);
                if (d < bestDist) { bestDist = d; bestSys = sys; }
            }

            // 五線の上端=F5、各半階段(=spacing/2)で半音じゃなく1音(diatonic step)上下する
            // よってstep数 = (topY - headY) / (spacing/2) (正なら上)
            const stepFromTop = (bestSys.topY - head.y) / (bestSys.spacing / 2);
            // F5 から step ぶん上下したダイアトニック音
            // F5 を基準index=0として、scale配列の循環でピッチ算出
            // F=index 3, 5=octave
            const baseIndex = 3 + 7 * 5; // F5 を表す通し番号
            const targetIndex = Math.round(baseIndex + stepFromTop);
            const noteIdx = ((targetIndex % 7) + 7) % 7;
            const octave = Math.floor(targetIndex / 7);
            const pitch = scale[noteIdx] + octave;

            return { ...head, pitch, systemY: bestSys.centerY };
        });
    }

    // デバッグ描画
    function drawDebug(canvas, srcMat, staves, heads) {
        const ctx = canvas.getContext('2d');
        canvas.width = srcMat.cols;
        canvas.height = srcMat.rows;
        cv.imshow(canvas, srcMat);

        ctx.strokeStyle = 'rgba(255, 100, 100, 0.6)';
        ctx.lineWidth = 1;
        for (const y of staves) {
            ctx.beginPath();
            ctx.moveTo(0, y); ctx.lineTo(canvas.width, y);
            ctx.stroke();
        }

        ctx.strokeStyle = 'rgba(0, 255, 0, 0.9)';
        ctx.lineWidth = 2;
        ctx.font = '11px monospace';
        ctx.fillStyle = '#00ff00';
        heads.forEach((h, i) => {
            ctx.beginPath();
            ctx.ellipse(h.x, h.y, h.w / 2, h.h / 2, 0, 0, Math.PI * 2);
            ctx.stroke();
            if (h.pitch) ctx.fillText(h.pitch, h.x + h.w / 2 + 2, h.y);
        });

        canvas.classList.add('show');
    }

    window.OMR = { recognize, isReady: () => cvReady };
})();
