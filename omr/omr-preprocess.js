// 前処理：グレースケール化、ノイズ除去、適応的二値化、軽い膨張
(function() {
    'use strict';
    
    function preprocess(canvas, opts = {}) {
        const src = cv.imread(canvas);
        const gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        
        // ノイズ除去（中央値フィルタ）
        const denoised = new cv.Mat();
        cv.medianBlur(gray, denoised, 3);
        
        // 二値化
        const binary = new cv.Mat();
        if (opts.threshold && opts.threshold > 0) {
            cv.threshold(denoised, binary, opts.threshold, 255, cv.THRESH_BINARY_INV);
        } else {
            // Otsu と適応的の両方を試して、より黒画素が「楽譜らしい」ほうを選ぶ
            const otsu = new cv.Mat();
            cv.threshold(denoised, otsu, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
            const adaptive = new cv.Mat();
            cv.adaptiveThreshold(
                denoised, adaptive, 255,
                cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV,
                25, 10
            );
            // 黒画素率が 5-25% の範囲に収まる方を選ぶ
            const otsuRatio = cv.countNonZero(otsu) / (otsu.rows * otsu.cols);
            const adaptiveRatio = cv.countNonZero(adaptive) / (adaptive.rows * adaptive.cols);
            const otsuScore = (otsuRatio > 0.05 && otsuRatio < 0.25) ? 1 : 0;
            const adaptiveScore = (adaptiveRatio > 0.05 && adaptiveRatio < 0.25) ? 1 : 0;
            if (otsuScore >= adaptiveScore) {
                otsu.copyTo(binary);
            } else {
                adaptive.copyTo(binary);
            }
            otsu.delete();
            adaptive.delete();
        }
        
        // 軽くClose（途切れた線を補修）
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
        const closed = new cv.Mat();
        cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel);
        kernel.delete();
        binary.delete();
        
        const cleanup = () => {
            [src, gray, denoised, closed].forEach(m => {
                try { m.delete(); } catch(e) {}
            });
        };
        
        return { src, gray, denoised, binary: closed, cleanup };
    }
    
    window.OMR_Preprocess = { preprocess };
})();
