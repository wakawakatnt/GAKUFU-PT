// 高精度OMR (Optical Music Recognition)
// 古典的画像処理を徹底的に作り込んだ実装
(function() {
    'use strict';

    let cvReady = false;
    function checkCv() {
        if (typeof cv !== 'undefined' && cv.Mat) { cvReady = true; return true; }
        return false;
    }
    if (!checkCv()) {
        if (typeof cv !== 'undefined') {
            cv['onRuntimeInitialized'] = () => { cvReady = true; console.log('[OMR] OpenCV.js ready'); };
        } else {
            const iv = setInterval(() => { if (checkCv()) { clearInterval(iv); console.log('[OMR] OpenCV.js ready (poll)'); } }, 200);
        }
    }

    // ============================================================
    // メイン認識関数（1段ぶん）
    // ============================================================
    function recognizeRegion(sourceCanvas, region, opts = {}) {
        if (!cvReady) throw new Error('OpenCV.js未準備');
        const onStatus = opts.onStatus || (() => {});
        const debugCanvas = opts.debugCanvas;
        const userClef = opts.clef || 'auto';
        const fallbackDuration = opts.defaultDuration || 1;

        // 領域を切り出してCanvas化
        const sub = document.createElement('canvas');
        sub.width = region.w;
        sub.height = region.h;
        sub.getContext('2d').drawImage(
            sourceCanvas, region.x, region.y, region.w, region.h,
            0, 0, region.w, region.h
        );

        // === Step 1: 前処理 ===
        onStatus('前処理中...', 'ok');
        const pre = preprocess(sub, opts);

        // === Step 2: 五線検出 ===
        onStatus('五線検出中...', 'ok');
        const staffInfo = detectStaffLines(pre.binary);
        if (!staffInfo || staffInfo.lines.length < 5) {
            pre.cleanup();
            throw new Error(`五線が検出できません(${staffInfo ? staffInfo.lines.length : 0}本)。閾値や領域を調整してください`);
        }
        const system = buildSystem(staffInfo.lines, staffInfo.lineThickness);
        onStatus(`五線5本検出 (間隔${system.spacing.toFixed(1)}px, 線太さ${system.lineThickness.toFixed(1)}px)`, 'ok');

        // === Step 3: 音部記号の推定 ===
        let clef = userClef;
        if (clef === 'auto') {
            clef = guessClef(pre.binary, system);
            onStatus(`音部記号: ${clef === 'treble' ? 'ト音' : 'ヘ音'} (自動推定)`, 'ok');
        }

        // === Step 4: 五線を除去（モルフォロジ） ===
        const noStaff = removeStaves(pre.binary, system);

        // === Step 5: ステム（縦棒）検出 ===
        onStatus('音符の縦棒を検出中...', 'ok');
        const stems = detectStems(pre.binary, system);
        onStatus(`縦棒 ${stems.length}本検出`, 'ok');

        // === Step 6: ノートヘッド検出（塗り潰し/中空を分類）===
        onStatus('音符ヘッド検出中...', 'ok');
        const heads = detectNoteHeadsAdvanced(pre.binary, noStaff, system, stems);
        onStatus(`音符ヘッド ${heads.length}個検出`, 'ok');

        // === Step 7: 連桁（beam）検出 → 8分・16分音符 ===
        const beams = detectBeams(pre.binary, system, stems);
        if (beams.length > 0) onStatus(`連桁 ${beams.length}本検出`, 'ok');

        // === Step 8: 旗（flag）検出（単独8分音符など） ===
        const flags = detectFlags(noStaff, system, stems);

        // === Step 9: 各ヘッドに音価を割り当て ===
        const notesRaw = assignDurations(heads, stems, beams, flags, system, fallbackDuration);

        // === Step 10: 付点検出 ===
        detectDots(noStaff, system, notesRaw);

        // === Step 11: 臨時記号(#/♭/♮)検出 ===
        detectAccidentals(noStaff, system, notesRaw);

        // === Step 12: 休符検出 ===
        const rests = detectRests(noStaff, system);

        // === Step 13: 小節線検出 ===
        const barLines = detectBarLines(pre.binary, system);

        // === Step 14: ピッチ計算 ===
        for (const n of notesRaw) {
            n.pitch = yToPitch(n.y, system, clef, n.accidental);
        }

        // === Step 15: 全要素を x 座標順にマージし、和音をグルーピング ===
        const merged = mergeAndGroup(notesRaw, rests, system);

        // === Step 16: 小節線で区切って整形 ===
        const ePianoNotes = toEpianoFormat(merged, barLines, fallbackDuration);

        // === デバッグ描画 ===
        if (debugCanvas) {
            drawDebug(debugCanvas, sub, system, {
                heads, stems, beams, flags, rests, barLines, notes: notesRaw
            });
        }

        onStatus(`完了: 音符${notesRaw.length}, 休符${rests.length}, 小節線${barLines.length}`, 'ok');

        pre.cleanup();
        return ePianoNotes;
    }

    // ============================================================
    // 段の自動検出（全画像から）
    // ============================================================
    function detectSystems(sourceCanvas, opts = {}) {
        if (!cvReady) throw new Error('OpenCV.js未準備');

        const pre = preprocess(sourceCanvas, opts);
        const info = detectStaffLines(pre.binary);
        pre.cleanup();

        if (!info || info.lines.length < 5) return [];

        // 5本ずつグループ化（連続して間隔が近いものを1段とみなす）
        const lines = info.lines;
        const systems = [];
        let i = 0;
        while (i + 4 < lines.length) {
            const five = lines.slice(i, i + 5);
            const gaps = [];
            for (let j = 1; j < 5; j++) gaps.push(five[j] - five[j - 1]);
            const avg = gaps.reduce((a, b) => a + b, 0) / 4;
            const ok = gaps.every(g => Math.abs(g - avg) < avg * 0.5) && avg > 3 && avg < 80;
            if (ok) {
                const margin = avg * 5;
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

    // ============================================================
    // クリックでピッチ取得
    // ============================================================
    function pitchAtPoint(sourceCanvas, region, clickX, clickY, opts = {}) {
        if (!cvReady) throw new Error('OpenCV.js未準備');
        const sub = document.createElement('canvas');
        sub.width = region.w; sub.height = region.h;
        sub.getContext('2d').drawImage(
            sourceCanvas, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h
        );
        const pre = preprocess(sub, opts);
        const info = detectStaffLines(pre.binary);
        if (!info || info.lines.length < 5) { pre.cleanup(); return null; }
        const system = buildSystem(info.lines, info.lineThickness);
        pre.cleanup();
        return yToPitch(clickY - region.y, system, opts.clef || 'treble', 0);
    }

    // ============================================================
    // === 前処理 ===
    // ============================================================
    function preprocess(canvas, opts) {
        const src = cv.imread(canvas);
        const gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

        // ノイズ除去
        const denoised = new cv.Mat();
        cv.medianBlur(gray, denoised, 3);

        // 適応的二値化（手動閾値が指定されていればそちらを優先）
        const binary = new cv.Mat();
        if (opts.threshold && opts.threshold > 0) {
            cv.threshold(denoised, binary, opts.threshold, 255, cv.THRESH_BINARY_INV);
        } else {
            cv.adaptiveThreshold(
                denoised, binary, 255,
                cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV,
                25, 10
            );
        }

        // 軽い膨張で線の途切れを補修
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
        const closed = new cv.Mat();
        cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel);
        kernel.delete();
        binary.delete();

        const cleanup = () => {
            [src, gray, denoised, closed].forEach(m => { try { m.delete(); } catch(e){} });
        };
        return { src, gray, denoised, binary: closed, cleanup };
    }

    // ============================================================
    // === 五線検出 (RLE方式で太さも検出) ===
    // ============================================================
    function detectStaffLines(binary) {
        const rows = binary.rows, cols = binary.cols;
        const proj = new Array(rows).fill(0);
        for (let y = 0; y < rows; y++) {
            let s = 0;
            // ucharPtrは遅いので生メモリアクセス
            const rowStart = y * cols;
            const data = binary.data;
            for (let x = 0; x < cols; x++) {
                if (data[rowStart + x] > 0) s++;
            }
            proj[y] = s;
        }
        // 横幅の50%以上黒い行を「線候補」
        const thresh = cols * 0.5;
        const segments = [];
        let inL = false, start = 0;
        for (let y = 0; y < rows; y++) {
            if (proj[y] > thresh) {
                if (!inL) { start = y; inL = true; }
            } else if (inL) {
                segments.push({ start, end: y - 1, center: (start + y - 1) / 2, thickness: y - start });
                inL = false;
            }
        }
        if (segments.length === 0) return null;

        // 線の太さの中央値を取得
        const thicks = segments.map(s => s.thickness).sort((a, b) => a - b);
        const lineThickness = thicks[Math.floor(thicks.length / 2)];

        return {
            lines: segments.map(s => s.center),
            lineThickness,
            segments
        };
    }

    function buildSystem(lines, lineThickness) {
        // 5本選択（最も均等な5本連続）
        let five;
        if (lines.length === 5) {
            five = lines.slice();
        } else {
            let bestIdx = 0, bestVar = Infinity;
            for (let i = 0; i + 4 < lines.length; i++) {
                const f = lines.slice(i, i + 5);
                const gaps = [];
                for (let j = 1; j < 5; j++) gaps.push(f[j] - f[j - 1]);
                const avg = gaps.reduce((a, b) => a + b, 0) / 4;
                const v = gaps.reduce((s, g) => s + (g - avg) ** 2, 0) / 4;
                if (v < bestVar) { bestVar = v; bestIdx = i; }
            }
            five = lines.slice(bestIdx, bestIdx + 5);
        }
        const gaps = [];
        for (let i = 1; i < 5; i++) gaps.push(five[i] - five[i - 1]);
        const spacing = gaps.reduce((a, b) => a + b, 0) / 4;
        return {
            lines: five,
            spacing,
            lineThickness: lineThickness || Math.max(1, spacing * 0.1),
            topY: five[0],
            bottomY: five[4],
            centerY: (five[0] + five[4]) / 2
        };
    }

    // ============================================================
    // === 音部記号推定 ===
    // 五線左端領域の黒画素重心を見て、上寄り→ト音、下寄り→ヘ音
    // ============================================================
    function guessClef(binary, system) {
        const xStart = 0;
        const xEnd = Math.min(binary.cols, Math.round(system.spacing * 4));
        const yStart = Math.max(0, Math.round(system.topY - system.spacing * 2));
        const yEnd = Math.min(binary.rows, Math.round(system.bottomY + system.spacing * 2));

        let sumY = 0, count = 0;
        for (let y = yStart; y < yEnd; y++) {
            for (let x = xStart; x < xEnd; x++) {
                if (binary.ucharPtr(y, x)[0] > 0) {
                    sumY += y; count++;
                }
            }
        }
        if (count === 0) return 'treble';
        const cy = sumY / count;
        // 重心が五線中央より上寄り → ト音、下寄り → ヘ音
        return cy < system.centerY ? 'treble' : 'bass';
    }

    // ============================================================
    // === 五線除去 ===
    // ============================================================
    function removeStaves(binary, system) {
        const result = binary.clone();
        const kSize = Math.max(20, Math.floor(system.spacing * 6));
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kSize, 1));
        const horizontal = new cv.Mat();
        cv.morphologyEx(binary, horizontal, cv.MORPH_OPEN, kernel);
        cv.subtract(result, horizontal, result);
        kernel.delete(); horizontal.delete();

        // 五線除去後の断片を軽くClose
        const k2 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, 2));
        const closed = new cv.Mat();
        cv.morphologyEx(result, closed, cv.MORPH_CLOSE, k2);
        k2.delete();
        result.delete();
        return closed;
    }

    // ============================================================
    // === ステム（縦棒）検出 ===
    // 縦方向に長い細い線を検出
    // ============================================================
    function detectStems(binary, system) {
        const sp = system.spacing;
        const minLength = Math.floor(sp * 2.5);   // ステムは最低でも2.5spacing
        const maxThickness = Math.max(2, Math.ceil(sp * 0.3));

        // 縦方向のオープニングで縦長要素を抽出
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, minLength));
        const vertical = new cv.Mat();
        cv.morphologyEx(binary, vertical, cv.MORPH_OPEN, kernel);
        kernel.delete();

        // 連結成分
        const labels = new cv.Mat();
        const stats = new cv.Mat();
        const centroids = new cv.Mat();
        const n = cv.connectedComponentsWithStats(vertical, labels, stats, centroids);

        const stems = [];
        for (let i = 1; i < n; i++) {
            const x = stats.intAt(i, cv.CC_STAT_LEFT);
            const y = stats.intAt(i, cv.CC_STAT_TOP);
            const w = stats.intAt(i, cv.CC_STAT_WIDTH);
            const h = stats.intAt(i, cv.CC_STAT_HEIGHT);
            if (w > maxThickness) continue;
            if (h < minLength) continue;
            stems.push({
                x: x + w / 2,
                yTop: y,
                yBottom: y + h,
                width: w,
                height: h
            });
        }
        labels.delete(); stats.delete(); centroids.delete(); vertical.delete();

        // 中央x座標でソート
        stems.sort((a, b) => a.x - b.x);
        return stems;
    }

    // ============================================================
    // === ノートヘッド検出（塗り潰し/中空を判定）===
    // ============================================================
    function detectNoteHeadsAdvanced(binary, noStaff, system, stems) {
        const sp = system.spacing;
        const minW = sp * 0.55, maxW = sp * 1.8;
        const minH = sp * 0.5,  maxH = sp * 1.5;
        const minArea = sp * sp * 0.25;

        const labels = new cv.Mat();
        const stats = new cv.Mat();
        const centroids = new cv.Mat();
        const n = cv.connectedComponentsWithStats(noStaff, labels, stats, centroids);

        const heads = [];
        for (let i = 1; i < n; i++) {
            const x = stats.intAt(i, cv.CC_STAT_LEFT);
            const y = stats.intAt(i, cv.CC_STAT_TOP);
            const w = stats.intAt(i, cv.CC_STAT_WIDTH);
            const h = stats.intAt(i, cv.CC_STAT_HEIGHT);
            const area = stats.intAt(i, cv.CC_STAT_AREA);
            const cx = centroids.doubleAt(i, 0);
            const cy = centroids.doubleAt(i, 1);

            if (w < minW || w > maxW) continue;
            if (h < minH || h > maxH) continue;
            if (area < minArea) continue;
            const ratio = w / h;
            if (ratio < 0.5 || ratio > 2.6) continue;
            // 五線範囲±6spacing以内
            if (cy < system.topY - sp * 6 || cy > system.bottomY + sp * 6) continue;

            // 塗り潰し率（中空 vs 塗り潰し判定）
            const bbox_area = w * h;
            const fill_ratio = area / bbox_area;
            // 塗り潰し: 0.7以上、中空: 0.4-0.7、それ以外は微妙
            let headType;
            if (fill_ratio >= 0.65) headType = 'filled';   // 4分以下
            else if (fill_ratio >= 0.35) headType = 'hollow'; // 2分 or 全音符
            else continue; // ノイズ

            // ステムとの関連付け
            const stem = findAttachedStem(cx, cy, w, h, stems, sp);

            // 全音符判定（ステムなし＆中空＆少し大きめ）
            const isWhole = (headType === 'hollow') && !stem && (w > sp * 0.9);

            heads.push({
                x: cx, y: cy, w, h, area,
                fillRatio: fill_ratio,
                headType,
                stem,
                isWhole,
                accidental: 0,  // 後で更新
                dotted: false,  // 後で更新
                pitch: null
            });
        }
        labels.delete(); stats.delete(); centroids.delete();

        heads.sort((a, b) => a.x - b.x);
        return heads;
    }

    function findAttachedStem(cx, cy, w, h, stems, sp) {
        // ヘッドの左右にステムがあれば返す（音符は ヘッドの右上 or 左下 にステムが付く）
        const tolerance = w * 0.7;
        let best = null, bestDist = Infinity;
        for (const stem of stems) {
            const dx = Math.abs(stem.x - cx);
            if (dx > tolerance) continue;
            // ステムの縦範囲内にヘッドが収まる
            if (cy < stem.yTop - sp * 0.5 || cy > stem.yBottom + sp * 0.5) continue;
            if (dx < bestDist) { bestDist = dx; best = stem; }
        }
        return best;
    }

    // ============================================================
    // === 連桁（beam）検出 ===
    // ステム上端付近に太い水平線があれば beam
    // ============================================================
    function detectBeams(binary, system, stems) {
        const sp = system.spacing;
        const minWidth = Math.floor(sp * 1.5);
        const minThickness = Math.max(2, Math.floor(sp * 0.4)); // 連桁は太い

        const kernelH = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(minWidth, 1));
        const horizontal = new cv.Mat();
        cv.morphologyEx(binary, horizontal, cv.MORPH_OPEN, kernelH);
        kernelH.delete();

        const labels = new cv.Mat();
        const stats = new cv.Mat();
        const centroids = new cv.Mat();
        const n = cv.connectedComponentsWithStats(horizontal, labels, stats, centroids);

        const beams = [];
        for (let i = 1; i < n; i++) {
            const x = stats.intAt(i, cv.CC_STAT_LEFT);
            const y = stats.intAt(i, cv.CC_STAT_TOP);
            const w = stats.intAt(i, cv.CC_STAT_WIDTH);
            const h = stats.intAt(i, cv.CC_STAT_HEIGHT);
            if (h < minThickness) continue;
            if (w < minWidth) continue;
            // 五線そのものはスキップ（五線の太さは細い）
            if (h <= system.lineThickness * 1.5 && w > system.spacing * 8) continue;
            // 五線位置にぴったり重なる場合もスキップ
            const cy = y + h / 2;
            let onStaff = false;
            for (const ly of system.lines) {
                if (Math.abs(cy - ly) < system.lineThickness) { onStaff = true; break; }
            }
            if (onStaff && w > system.spacing * 8) continue;

            beams.push({ x, y, w, h, cx: x + w / 2, cy });
        }
        labels.delete(); stats.delete(); centroids.delete(); horizontal.delete();

        // 各 beam にぶら下がってるステムを記録
        for (const beam of beams) {
            beam.stems = stems.filter(s =>
                s.x >= beam.x - 2 && s.x <= beam.x + beam.w + 2 &&
                (Math.abs(s.yTop - beam.cy) < beam.h * 1.5 || Math.abs(s.yBottom - beam.cy) < beam.h * 1.5)
            );
        }
        return beams;
    }

    // ============================================================
    // === 旗（flag）検出 ===
    // 単独8分音符などの旗形をステム端で検出
    // ============================================================
    function detectFlags(noStaff, system, stems) {
        const sp = system.spacing;
        const flags = [];

        for (const stem of stems) {
            // ステムの上端 or 下端付近に小さな塊があるか
            for (const endY of [stem.yTop, stem.yBottom]) {
                const checkY1 = Math.max(0, endY - Math.floor(sp * 1.2));
                const checkY2 = Math.min(noStaff.rows, endY + Math.floor(sp * 1.2));
                const checkX1 = Math.max(0, Math.floor(stem.x));
                const checkX2 = Math.min(noStaff.cols, Math.floor(stem.x + sp * 1.5));
                let pixCount = 0;
                for (let y = checkY1; y < checkY2; y++) {
                    for (let x = checkX1; x < checkX2; x++) {
                        if (noStaff.ucharPtr(y, x)[0] > 0) pixCount++;
                    }
                }
                if (pixCount > sp * sp * 0.3) {
                    flags.push({ stem, count: 1, side: endY === stem.yTop ? 'top' : 'bottom' });
                    break;
                }
            }
        }
        return flags;
    }

    // ============================================================
    // === 音価割り当て ===
    // ============================================================
    function assignDurations(heads, stems, beams, flags, system, fallback) {
        for (const h of heads) {
            let duration = fallback;

            if (h.isWhole) {
                duration = 4;
            } else if (h.headType === 'hollow' && h.stem) {
                duration = 2;
            } else if (h.headType === 'filled' && h.stem) {
                // ステムが連桁に属する？
                const beam = beams.find(b => b.stems && b.stems.includes(h.stem));
                if (beam) {
                    // 連桁が複数（積層）かは厳密には判定難。とりあえず8分とする
                    duration = 0.5;
                } else {
                    const flag = flags.find(f => f.stem === h.stem);
                    if (flag) duration = 0.5;
                    else duration = 1; // 普通の4分音符
                }
            } else if (h.headType === 'filled' && !h.stem) {
                // ステム見落としかもしれないが、暫定で4分
                duration = 1;
            }
            h.duration = duration;
        }
        return heads;
    }

    // ============================================================
    // === 付点検出 ===
    // ノートヘッド右側に小さな黒丸があれば付点 → 1.5倍
    // ============================================================
    function detectDots(noStaff, system, notes) {
        const sp = system.spacing;
        const dotRadius = sp * 0.25;
        for (const n of notes) {
            const xStart = Math.floor(n.x + n.w / 2 + 1);
            const xEnd = Math.min(noStaff.cols, xStart + Math.ceil(sp * 0.8));
            const yStart = Math.max(0, Math.floor(n.y - sp * 0.4));
            const yEnd = Math.min(noStaff.rows, Math.floor(n.y + sp * 0.4));
            let count = 0;
            for (let y = yStart; y < yEnd; y++) {
                for (let x = xStart; x < xEnd; x++) {
                    if (noStaff.ucharPtr(y, x)[0] > 0) count++;
                }
            }
            if (count > dotRadius * dotRadius * Math.PI * 0.5 && count < sp * sp * 0.5) {
                n.dotted = true;
                n.duration *= 1.5;
            }
        }
    }

    // ============================================================
    // === 臨時記号(#/♭/♮)検出 ===
    // ヘッド左の小領域を解析
    // ============================================================
    function detectAccidentals(noStaff, system, notes) {
        const sp = system.spacing;
        for (const n of notes) {
            const xEnd = Math.floor(n.x - n.w / 2 - 1);
            const xStart = Math.max(0, xEnd - Math.ceil(sp * 1.5));
            const yStart = Math.max(0, Math.floor(n.y - sp));
            const yEnd = Math.min(noStaff.rows, Math.floor(n.y + sp));

            let count = 0;
            let pxArr = [];
            for (let y = yStart; y < yEnd; y++) {
                for (let x = xStart; x < xEnd; x++) {
                    if (noStaff.ucharPtr(y, x)[0] > 0) {
                        count++;
                        pxArr.push({x, y});
                    }
                }
            }

            if (count < sp * 0.5) continue;
            if (count > sp * sp * 2) continue;

            // 形状で # / ♭ / ♮ を判別
            // ♯ : 縦長で2本の縦線
            // ♭ : 縦長で下半分が膨らむ
            // ♮ : ♯に似てるがシンプル
            // 簡略化: 縦幅と横幅、ピクセル分布から推定
            if (pxArr.length === 0) continue;
            const ys = pxArr.map(p => p.y);
            const xs = pxArr.map(p => p.x);
            const ymin = Math.min(...ys), ymax = Math.max(...ys);
            const xmin = Math.min(...xs), xmax = Math.max(...xs);
            const symH = ymax - ymin, symW = xmax - xmin;
            if (symH < sp * 0.6 || symW < sp * 0.2) continue;

            // 重心の上下比較で♭判定（♭は下部が重い）
            const cy = ys.reduce((a, b) => a + b, 0) / ys.length;
            const heightRatio = (cy - ymin) / symH;
            // ♭: 重心が下半分(0.55以上) かつ細長い
            if (heightRatio > 0.55 && symW / symH < 0.7) {
                n.accidental = -1; // flat
            } else {
                // デフォルトでシャープとみなす（実際はテンプレートマッチングが理想）
                n.accidental = 1; // sharp
            }
        }
    }

    // ============================================================
    // === 休符検出 ===
    // 五線中央域にある特定形状（4分休符は鋸歯状、8分は旗、全/2分は線上のブロック）
    // ============================================================
    function detectRests(noStaff, system) {
        const sp = system.spacing;
        const labels = new cv.Mat();
        const stats = new cv.Mat();
        const centroids = new cv.Mat();
        const n = cv.connectedComponentsWithStats(noStaff, labels, stats, centroids);

        const rests = [];
        for (let i = 1; i < n; i++) {
            const x = stats.intAt(i, cv.CC_STAT_LEFT);
            const y = stats.intAt(i, cv.CC_STAT_TOP);
            const w = stats.intAt(i, cv.CC_STAT_WIDTH);
            const h = stats.intAt(i, cv.CC_STAT_HEIGHT);
            const area = stats.intAt(i, cv.CC_STAT_AREA);
            const cx = centroids.doubleAt(i, 0);
            const cy = centroids.doubleAt(i, 1);

            // 五線中央付近、縦長か小さなブロック
            if (cy < system.topY - sp * 0.5 || cy > system.bottomY + sp * 0.5) continue;
            if (area < sp * sp * 0.15) continue;
            if (area > sp * sp * 4) continue;

            // 形で判定（簡易）
            // - 全休符/2分休符: 縦が短く、第3線か第4線上に小ブロック (h < sp * 0.7)
            // - 4分休符: 縦長で複雑 (h > sp * 1.5 && h < sp * 3, w < sp)
            // - 8分休符: 中サイズ (h ~ sp * 1.5, w ~ sp * 0.8)
            let dur = 0;
            if (h < sp * 0.7 && w > sp * 0.4 && w < sp * 1.5) {
                // 線にぴったり接触してるかチェック
                const onLine3 = Math.abs(cy - system.lines[2]) < sp * 0.4;
                const onLine4 = Math.abs(cy - system.lines[1]) < sp * 0.4;
                if (onLine3) dur = 4; // 全休符（多くは線下、ここでは緩く判定）
                else if (onLine4) dur = 2; // 2分休符
                else continue;
            } else if (h > sp * 1.5 && h < sp * 3.5 && w < sp * 1.2 && w > sp * 0.3) {
                dur = 1; // 4分休符
            } else if (h > sp && h < sp * 2 && w > sp * 0.5 && w < sp * 1.5) {
                dur = 0.5; // 8分休符
            } else continue;

            rests.push({ x: cx, y: cy, w, h, duration: dur, type: 'rest' });
        }
        labels.delete(); stats.delete(); centroids.delete();
        return rests;
    }

    // ============================================================
    // === 小節線検出 ===
    // 五線を縦に貫く細い線
    // ============================================================
    function detectBarLines(binary, system) {
        const sp = system.spacing;
        const yTop = Math.max(0, Math.round(system.topY - 1));
        const yBot = Math.min(binary.rows, Math.round(system.bottomY + 1));
        const expectedHeight = yBot - yTop;
        const maxWidth = Math.max(3, Math.ceil(sp * 0.5));

        // 縦方向openingで縦線抽出
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, Math.floor(expectedHeight * 0.8)));
        const vertical = new cv.Mat();
        cv.morphologyEx(binary, vertical, cv.MORPH_OPEN, kernel);
        kernel.delete();

        const labels = new cv.Mat();
        const stats = new cv.Mat();
        const centroids = new cv.Mat();
        const n = cv.connectedComponentsWithStats(vertical, labels, stats, centroids);

        const bars = [];
        for (let i = 1; i < n; i++) {
            const x = stats.intAt(i, cv.CC_STAT_LEFT);
            const y = stats.intAt(i, cv.CC_STAT_TOP);
            const w = stats.intAt(i, cv.CC_STAT_WIDTH);
            const h = stats.intAt(i, cv.CC_STAT_HEIGHT);
            if (w > maxWidth) continue;
            if (h < expectedHeight * 0.7) continue;
            // 五線をまたぐ位置にあるか
            const cy = y + h / 2;
            if (cy < system.topY - sp || cy > system.bottomY + sp) continue;
            bars.push({ x: x + w / 2, top: y, bottom: y + h });
        }
        labels.delete(); stats.delete(); centroids.delete(); vertical.delete();
        bars.sort((a, b) => a.x - b.x);
        return bars;
    }

    // ============================================================
    // === ピッチ計算（臨時記号を考慮） ===
    // ============================================================
    function yToPitch(y, system, clef, accidental) {
        const stepFromTop = (system.topY - y) / (system.spacing / 2);
        // ト音記号: 第5線=F5、ヘ音記号: 第5線=A3
        const baseIndex = clef === 'bass' ? (5 + 7 * 3) : (3 + 7 * 5);
        const target = Math.round(baseIndex + stepFromTop);
        const noteIdx = ((target % 7) + 7) % 7;
        const octave = Math.floor(target / 7);
        const scale = ['C','D','E','F','G','A','B'];
        let noteName = scale[noteIdx];
        const oct = Math.max(0, Math.min(9, octave));

        if (accidental === 1) {
            // シャープ
            if (noteName === 'E') return 'F' + oct;
            if (noteName === 'B') return 'C' + (oct + 1);
            return noteName + '#' + oct;
        } else if (accidental === -1) {
            // フラット → 半音下のシャープ表記に
            const flatMap = { 'C':'B', 'D':'C#', 'E':'D#', 'F':'E', 'G':'F#', 'A':'G#', 'B':'A#' };
            const conv = flatMap[noteName];
            const lowerOct = ['C','F'].includes(noteName) ? oct - 1 : oct;
            return conv + lowerOct;
        }
        return noteName + oct;
    }

    // ============================================================
    // === マージ&和音グルーピング ===
    // 近接するヘッドを和音とみなす
    // ============================================================
    function mergeAndGroup(notes, rests, system) {
        const events = [];
        for (const n of notes) events.push({ type: 'note', ...n });
        for (const r of rests) events.push({ type: 'rest', ...r });
        events.sort((a, b) => a.x - b.x);

        // 和音グルーピング: 同じx座標(±spacing*0.5)の音符を1つの和音にまとめる
        const sp = system.spacing;
        const grouped = [];
        let i = 0;
        while (i < events.length) {
            const ev = events[i];
            if (ev.type === 'rest') {
                grouped.push(ev);
                i++; continue;
            }
            // 後続のnoteで x が近いものをグループ化
            const chord = [ev];
            let j = i + 1;
            while (j < events.length && events[j].type === 'note' && Math.abs(events[j].x - ev.x) < sp * 0.6) {
                chord.push(events[j]);
                j++;
            }
            if (chord.length === 1) {
                grouped.push({ type: 'note', single: ev, x: ev.x });
            } else {
                // 和音: 全体の音価は最も短いものに合わせる(視覚的に近接=同時発音)
                const minDur = Math.min(...chord.map(c => c.duration));
                grouped.push({
                    type: 'chord',
                    notes: chord,
                    duration: minDur,
                    x: ev.x
                });
            }
            i = j;
        }
        return grouped;
    }

    // ============================================================
    // === ePiano形式に変換（小節線で休符パディングも行う） ===
    // ============================================================
    function toEpianoFormat(grouped, barLines, fallbackDur) {
        const result = [];
        for (const ev of grouped) {
            if (ev.type === 'rest') {
                result.push({ rest: ev.duration || fallbackDur });
            } else if (ev.type === 'note') {
                const n = ev.single;
                if (!n.pitch) continue;
                result.push({ note: n.pitch, duration: n.duration || fallbackDur, velocity: 80 });
            } else if (ev.type === 'chord') {
                const pitches = ev.notes.filter(n => n.pitch).map(n => n.pitch);
                if (pitches.length === 0) continue;
                if (pitches.length === 1) {
                    result.push({ note: pitches[0], duration: ev.duration, velocity: 80 });
                } else {
                    result.push({ notes: pitches, duration: ev.duration, velocity: 80 });
                }
            }
        }
        return result;
    }

    // ============================================================
    // === デバッグ描画 ===
    // ============================================================
    function drawDebug(canvas, srcCanvas, system, data) {
        canvas.width = srcCanvas.width;
        canvas.height = srcCanvas.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(srcCanvas, 0, 0);

        // 五線（赤）
        ctx.strokeStyle = 'rgba(255,80,80,0.6)';
        ctx.lineWidth = 1;
        for (const y of system.lines) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(canvas.width, y);
            ctx.stroke();
        }

        // ステム（青）
        ctx.strokeStyle = 'rgba(33,150,243,0.9)';
        ctx.lineWidth = 2;
        for (const stem of data.stems || []) {
            ctx.beginPath();
            ctx.moveTo(stem.x, stem.yTop);
            ctx.lineTo(stem.x, stem.yBottom);
            ctx.stroke();
        }

        // 連桁（オレンジ）
        ctx.strokeStyle = 'rgba(255,152,0,0.9)';
        ctx.lineWidth = 2;
        for (const beam of data.beams || []) {
            ctx.strokeRect(beam.x, beam.y, beam.w, beam.h);
        }

        // 小節線（紫の縦線）
        ctx.strokeStyle = 'rgba(156,39,176,0.8)';
        ctx.lineWidth = 2;
        for (const bar of data.barLines || []) {
            ctx.beginPath();
            ctx.moveTo(bar.x, bar.top);
            ctx.lineTo(bar.x, bar.bottom);
            ctx.stroke();
        }

        // 休符（黄色枠）
        ctx.strokeStyle = 'rgba(255,235,59,0.95)';
        ctx.lineWidth = 2;
        for (const rest of data.rests || []) {
            ctx.strokeRect(rest.x - rest.w / 2, rest.y - rest.h / 2, rest.w, rest.h);
            ctx.fillStyle = '#ffeb3b';
            ctx.font = 'bold 10px sans-serif';
            ctx.fillText(`R/${rest.duration}`, rest.x + rest.w / 2 + 2, rest.y);
        }

        // ノートヘッド（緑：塗り潰し、シアン：中空、ピンク：全音符）
        ctx.lineWidth = 2;
        ctx.font = 'bold 11px monospace';
        for (const n of data.notes || []) {
            let color;
            if (n.isWhole) color = '#ff80ab';
            else if (n.headType === 'hollow') color = '#00bcd4';
            else color = '#00e676';
            ctx.strokeStyle = color;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.ellipse(n.x, n.y, n.w / 2, n.h / 2, 0, 0, Math.PI * 2);
            ctx.stroke();
            const label = `${n.pitch}${n.dotted ? '.' : ''}/${n.duration}${n.accidental === 1 ? '#' : n.accidental === -1 ? 'b' : ''}`;
            ctx.fillText(label, n.x + n.w / 2 + 2, n.y + 4);
        }
    }

    window.OMR = {
        recognize: recognizeRegion,
        detectSystems,
        pitchAtPoint,
        isReady: () => cvReady
    };
})();
