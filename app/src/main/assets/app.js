let savedPoints = [];
let calibrationProgress = 0;
let calibrationInterval = null;
let currentLocation = { lat: 0, lon: 0, alt: 0, acc: 0 };

function startCalibration() {
    if (window.DeviceMotionEvent) {
        window.addEventListener('devicemotion', handleMotion);
    }

    let elapsed = 0;
    calibrationInterval = setInterval(() => {
        elapsed += 100;
        calibrationProgress = Math.min((elapsed / 5000) * 100, 100);
        document.getElementById('calibrationProgress').style.width = calibrationProgress + '%';

        if (calibrationProgress >= 100) {
            clearInterval(calibrationInterval);
            window.removeEventListener('devicemotion', handleMotion);
            goToStabilize();
        }
    }, 100);
}

function handleMotion(event) {
    const acc = event.accelerationIncludingGravity;
    if (acc) {
        const magnitude = Math.sqrt(acc.x ** 2 + acc.y ** 2 + acc.z ** 2);
        if (magnitude > 2 && magnitude < 30) {
            document.getElementById('calibrationStatus').textContent = '✅ حركة مكتشفة... استمر!';
        }
    }
}

function goToStabilize() {
    showScreen('stabilizeScreen');
    document.getElementById('stabilizeStatus').textContent = '📡 جاري استقبال إشارات GPS...';

    if (window.Android && window.Android.startHighAccuracyTracking) {
        window.Android.startHighAccuracyTracking();
    }

    let stableCount = 0;
    const checkStable = setInterval(() => {
        stableCount++;
        if (stableCount >= 30) {
            clearInterval(checkStable);
            showResults();
        }
    }, 100);
}

function onLocationUpdate(lat, lon, alt, acc) {
    currentLocation = kalmanFilter(currentLocation, { lat, lon, alt, acc });

    document.getElementById('latValue').textContent = currentLocation.lat.toFixed(8);
    document.getElementById('lonValue').textContent = currentLocation.lon.toFixed(8);
    document.getElementById('altValue').textContent = currentLocation.alt.toFixed(2) + ' م';
    document.getElementById('accValue').textContent = currentLocation.acc.toFixed(2) + ' م';
}

function kalmanFilter(prev, curr) {
    if (prev.lat === 0 && prev.lon === 0) {
        return { ...curr };
    }
    const K = prev.acc / (prev.acc + curr.acc);
    return {
        lat: prev.lat + K * (curr.lat - prev.lat),
        lon: prev.lon + K * (curr.lon - prev.lon),
        alt: prev.alt + K * (curr.alt - prev.alt),
        acc: Math.min(prev.acc, curr.acc)
    };
}

function savePoint() {
    if (currentLocation.lat === 0 && currentLocation.lon === 0) {
        document.getElementById('saveStatus').textContent = '⚠️ لا توجد إحداثيات لحفظها';
        return;
    }

    savedPoints.push({
        id: savedPoints.length + 1,
        lat: currentLocation.lat,
        lon: currentLocation.lon,
        alt: currentLocation.alt,
        acc: currentLocation.acc,
        timestamp: new Date().toISOString()
    });

    updatePointsList();
    document.getElementById('saveStatus').textContent = '✅ تم حفظ النقطة ' + savedPoints.length;
}

function updatePointsList() {
    const list = document.getElementById('pointsList');
    const count = document.getElementById('pointCount');
    count.textContent = savedPoints.length;

    list.innerHTML = savedPoints.map(p => `
        <div class="point-item">
            <span>نقطة ${p.id}</span>
            <span class="coords">${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}</span>
        </div>
    `).join('');
}

function exportCSV() {
    if (savedPoints.length === 0) {
        document.getElementById('saveStatus').textContent = '⚠️ لا توجد نقاط للتصدير';
        return;
    }

    let csv = '\uFEFF';
    csv += 'المعرف,خط العرض,خط الطول,الارتفاع (م),دقة الموقع (م),التاريخ والوقت\n';

    savedPoints.forEach(p => {
        csv += `${p.id},${p.lat.toFixed(8)},${p.lon.toFixed(8)},${p.alt.toFixed(2)},${p.acc.toFixed(2)},${p.timestamp}\n`;
    });

    if (window.Android && window.Android.exportCSV) {
        const fileName = `survey_points_${Date.now()}.csv`;
        window.Android.exportCSV(csv, fileName);
        document.getElementById('saveStatus').textContent = '📊 تم تصدير الملف بنجاح';
    }
}

function resetApp() {
    currentLocation = { lat: 0, lon: 0, alt: 0, acc: 0 };
    document.getElementById('latValue').textContent = '--';
    document.getElementById('lonValue').textContent = '--';
    document.getElementById('altValue').textContent = '--';
    document.getElementById('accValue').textContent = '--';
    document.getElementById('saveStatus').textContent = '';

    if (window.Android && window.Android.stopTracking) {
        window.Android.stopTracking();
    }
    showScreen('calibrationScreen');
    calibrationProgress = 0;
    document.getElementById('calibrationProgress').style.width = '0%';
    document.getElementById('calibrationStatus').textContent = 'في انتظار الحركة...';
    startCalibration();
}

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}

function showResults() {
    showScreen('resultScreen');
}

document.addEventListener('DOMContentLoaded', () => {
    startCalibration();
});
