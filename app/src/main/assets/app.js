// ===== المتغيرات العامة =====
let savedPoints = [];
let calibrationProgress = 0;
let calibrationInterval = null;
let currentLocation = { lat: 0, lon: 0, alt: 0, acc: 0 };
const STORAGE_KEY = 'yemen_surveyor_points';

// ===== حفظ/تحميل النقاط محلياً =====
function persistPoints() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(savedPoints)); } catch (e) { console.error(e); }
}
function loadPersistedPoints() {
    try {
        const data = localStorage.getItem(STORAGE_KEY);
        if (data) { savedPoints = JSON.parse(data) || []; updatePointsList(); }
    } catch (e) { savedPoints = []; }
}

// ===== 1. المعايرة =====
function startCalibration() {
    if (window.DeviceMotionEvent) window.addEventListener('devicemotion', handleMotion);
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
        if (magnitude > 2 && magnitude < 30)
            document.getElementById('calibrationStatus').textContent = '✅ حركة مكتشفة... استمر!';
    }
}

// ===== 2. التثبيت =====
function goToStabilize() {
    showScreen('stabilizeScreen');
    document.getElementById('stabilizeStatus').textContent = '📡 جاري استقبال GPS...';
    if (window.Android && window.Android.startHighAccuracyTracking)
        window.Android.startHighAccuracyTracking();
    let stableCount = 0;
    const checkStable = setInterval(() => {
        stableCount++;
        if (stableCount >= 30) { clearInterval(checkStable); showResults(); }
    }, 100);
}

// ===== 3. تحديث الموقع =====
function onLocationUpdate(lat, lon, alt, acc) {
    currentLocation = kalmanFilter(currentLocation, { lat, lon, alt, acc });
    document.getElementById('latValue').textContent = currentLocation.lat.toFixed(8);
    document.getElementById('lonValue').textContent = currentLocation.lon.toFixed(8);
    document.getElementById('altValue').textContent = currentLocation.alt.toFixed(2) + ' م';
    document.getElementById('accValue').textContent = currentLocation.acc.toFixed(2) + ' م';
}

function kalmanFilter(prev, curr) {
    if (prev.lat === 0 && prev.lon === 0) return { ...curr };
    const K = prev.acc / (prev.acc + curr.acc);
    return {
        lat: prev.lat + K * (curr.lat - prev.lat),
        lon: prev.lon + K * (curr.lon - prev.lon),
        alt: prev.alt + K * (curr.alt - prev.alt),
        acc: Math.min(prev.acc, curr.acc)
    };
}

// ===== 4. حفظ النقطة =====
function savePoint() {
    if (currentLocation.lat === 0 && currentLocation.lon === 0) {
        document.getElementById('saveStatus').textContent = '⚠️ لا توجد إحداثيات';
        return;
    }
    savedPoints.push({
        id: savedPoints.length + 1,
        lat: currentLocation.lat, lon: currentLocation.lon,
        alt: currentLocation.alt, acc: currentLocation.acc,
        timestamp: new Date().toISOString()
    });
    updatePointsList(); persistPoints();
    document.getElementById('saveStatus').textContent = '✅ تم حفظ النقطة ' + savedPoints.length;
}

// ===== 5. قائمة النقاط =====
function updatePointsList() {
    const list = document.getElementById('pointsList');
    document.getElementById('pointCount').textContent = savedPoints.length;
    if (savedPoints.length === 0) {
        list.innerHTML = '<p style="text-align:center;color:#666;padding:12px;">لا توجد نقاط</p>';
        return;
    }
    list.innerHTML = savedPoints.map(p => `
        <div class="point-item">
            <span>${p.id}</span>
            <span class="coords">${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}</span>
            <button class="delete-btn" onclick="deletePoint(${p.id})">✕</button>
        </div>`).join('');
}
function deletePoint(id) {
    savedPoints = savedPoints.filter(p => p.id !== id);
    savedPoints.forEach((p, i) => p.id = i + 1);
    updatePointsList(); persistPoints();
}
function clearAllPoints() {
    if (savedPoints.length === 0) return;
    if (confirm('مسح جميع النقاط؟')) {
        savedPoints = []; updatePointsList(); persistPoints();
        document.getElementById('calcResults').innerHTML = '';
    }
}

// ===== 6. بناء CSV =====
function buildCSV() {
    let csv = '\uFEFF';
    csv += 'ID,Latitude,Longitude,Altitude(m),Accuracy(m),Timestamp\n';
    savedPoints.forEach(p => {
        csv += `${p.id},${p.lat.toFixed(8)},${p.lon.toFixed(8)},${p.alt.toFixed(2)},${p.acc.toFixed(2)},${p.timestamp}\n`;
    });
    return csv;
}

// ===== 7. اسم الملف الافتراضي =====
function getDefaultFileName(ext) {
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-').substring(0, 19);
    return `survey_${stamp}.${ext}`;
}

// ===== 8. حفظ مع نافذة اختيار المسار والاسم =====
function saveWithDialog() {
    if (savedPoints.length === 0) {
        alert('⚠️ لا توجد نقاط');
        return;
    }
    const csv = buildCSV();
    const defaultName = getDefaultFileName('csv');
    if (window.Android && window.Android.saveCSVWithDialog) {
        window.Android.saveCSVWithDialog(csv, defaultName);
    }
}

// ===== 9. مشاركة CSV =====
function shareCSV() {
    if (savedPoints.length === 0) { alert('⚠️ لا توجد نقاط'); return; }
    const csv = buildCSV();
    const fileName = getDefaultFileName('csv');
    if (window.Android && window.Android.shareCSV)
        window.Android.shareCSV(csv, fileName);
}

// ===== 10. استيراد من Excel/CSV =====
function triggerImport() { document.getElementById('importFile').click(); }

function handleFileImport(event) {
    const file = event.target.files[0];
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    const reader = new FileReader();

    reader.onload = function (e) {
        if (ext === 'xlsx' || ext === 'xls') {
            parseExcel(e.target.result);
        } else {
            parseCSV(e.target.result);
        }
        event.target.value = '';
    };
    reader.onerror = () => alert('❌ فشل قراءة الملف');

    if (ext === 'xlsx' || ext === 'xls') {
        reader.readAsArrayBuffer(file);
    } else {
        reader.readAsText(file, 'UTF-8');
    }
}

// ===== 11. تحليل Excel =====
function parseExcel(arrayBuffer) {
    try {
        const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
        processRows(jsonData);
    } catch (e) {
        alert('❌ خطأ في قراءة Excel: ' + e.message);
    }
}

// ===== 12. تحليل CSV =====
function parseCSV(content) {
    if (content.charCodeAt(0) === 0xFEFF) content = content.substring(1);
    const firstLine = content.split(/\r?\n/)[0] || '';
    const sep = firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
    const rows = lines.map(l => l.split(sep).map(p => p.trim().replace(/^"|"$/g, '')));
    processRows(rows);
}

// ===== 13. معالجة الصفوف =====
function processRows(rows) {
    if (rows.length < 2) { alert('⚠️ الملف فارغ'); return; }

    const header = rows[0].map(h => String(h).toLowerCase().trim());
    const latIdx = header.findIndex(h => h.includes('lat') || h.includes('عرض'));
    const lonIdx = header.findIndex(h => h.includes('lon') || h.includes('lng') || h.includes('طول'));
    const altIdx = header.findIndex(h => h.includes('alt') || h.includes('ارتفاع'));
    const accIdx = header.findIndex(h => h.includes('acc') || h.includes('دقة'));

    if (latIdx === -1 || lonIdx === -1) {
        alert('❌ لم يتم العثور على أعمدة Latitude/Longitude');
        return;
    }

    let imported = 0, skipped = 0;
    const startId = savedPoints.length;

    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length < 2) { skipped++; continue; }
        const lat = parseFloat(row[latIdx]);
        const lon = parseFloat(row[lonIdx]);
        if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
            skipped++; continue;
        }
        savedPoints.push({
            id: startId + imported + 1,
            lat, lon,
            alt: altIdx >= 0 ? (parseFloat(row[altIdx]) || 0) : 0,
            acc: accIdx >= 0 ? (parseFloat(row[accIdx]) || 0) : 0,
            timestamp: new Date().toISOString()
        });
        imported++;
    }

    updatePointsList(); persistPoints();
    let msg = `✅ تم استيراد ${imported} نقطة`;
    if (skipped > 0) msg += `\n⚠️ تم تجاهل ${skipped} سطر`;
    alert(msg);
}

// ===== 14. تصدير KML =====
function openInGoogleEarth() {
    if (savedPoints.length === 0) { alert('⚠️ لا توجد نقاط'); return; }
    const kml = buildKML();
    const fileName = getDefaultFileName('kml');
    if (window.Android && window.Android.exportKMLAndOpen) {
        window.Android.exportKMLAndOpen(kml, fileName);
    }
}

function buildKML() {
    let placemarks = '';
    savedPoints.forEach(p => {
        placemarks += `
    <Placemark>
      <name>نقطة ${p.id}</name>
      <description>الارتفاع: ${p.alt.toFixed(2)} م | الدقة: ${p.acc.toFixed(2)} م</description>
      <Point>
        <coordinates>${p.lon.toFixed(8)},${p.lat.toFixed(8)},${p.alt.toFixed(2)}</coordinates>
      </Point>
    </Placemark>`;
    });

    if (savedPoints.length > 1) {
        const coords = savedPoints.map(p => `${p.lon.toFixed(8)},${p.lat.toFixed(8)},${p.alt.toFixed(2)}`).join(' ');
        placemarks += `
    <Placemark>
      <name>مسار المسح</name>
      <LineString>
        <tessellate>1</tessellate>
        <coordinates>${coords}</coordinates>
      </LineString>
    </Placemark>`;
    }

    if (savedPoints.length >= 3) {
        const polyCoords = savedPoints.map(p => `${p.lon.toFixed(8)},${p.lat.toFixed(8)},${p.alt.toFixed(2)}`).join(' ');
        placemarks += `
    <Placemark>
      <name>المضلع</name>
      <styleUrl>#polyStyle</styleUrl>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>${polyCoords} ${savedPoints[0].lon.toFixed(8)},${savedPoints[0].lat.toFixed(8)},${savedPoints[0].alt.toFixed(2)}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>`;
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>نقاط مسّاح اليمن</name>
    <Style id="polyStyle">
      <LineStyle><color>ff00d4aa</color><width>2</width></LineStyle>
      <PolyStyle><color>4000d4aa</color></PolyStyle>
    </Style>${placemarks}
  </Document>
</kml>`;
}

// ===== 15. Vincenty =====
function vincentyDistance(lat1, lon1, lat2, lon2) {
    const a = 6378137.0;
    const f = 1 / 298.257223563;
    const b = (1 - f) * a;
    const L = (lon2 - lon1) * Math.PI / 180;
    const U1 = Math.atan((1 - f) * Math.tan(lat1 * Math.PI / 180));
    const U2 = Math.atan((1 - f) * Math.tan(lat2 * Math.PI / 180));
    const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
    const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);

    let lambda = L, lambdaP, iterLimit = 100;
    let sinLambda, cosLambda, sinSigma, cosSigma, sigma, sinAlpha;
    let cosSqAlpha, cos2SigmaM, C;

    do {
        sinLambda = Math.sin(lambda);
        cosLambda = Math.cos(lambda);
        sinSigma = Math.sqrt(
            (cosU2 * sinLambda) ** 2 +
            (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2
        );
        if (sinSigma === 0) return 0;
        cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
        sigma = Math.atan2(sinSigma, cosSigma);
        sinAlpha = cosU1 * cosU2 * sinLambda / sinSigma;
        cosSqAlpha = 1 - sinAlpha * sinAlpha;
        cos2SigmaM = cosSigma - 2 * sinU1 * sinU2 / cosSqAlpha;
        if (isNaN(cos2SigmaM)) cos2SigmaM = 0;
        C = f / 16 * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
        lambdaP = lambda;
        lambda = L + (1 - C) * f * sinAlpha * (
            sigma + C * sinSigma * (
                cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)
            )
        );
    } while (Math.abs(lambda - lambdaP) > 1e-12 && --iterLimit > 0);

    if (iterLimit === 0) return haversineDistance(lat1, lon1, lat2, lon2);

    const uSq = cosSqAlpha * (a * a - b * b) / (b * b);
    const A = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
    const B = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
    const deltaSigma = B * sinSigma * (
        cos2SigmaM + B / 4 * (
            cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
            B / 6 * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) *
            (-3 + 4 * cos2SigmaM * cos2SigmaM)
        )
    );
    return b * A * (sigma - deltaSigma);
}

function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ===== 16. مساحة المضلع =====
function polygonArea(points) {
    if (points.length < 3) return 0;
    const R = 6378137.0;
    let area = 0;
    for (let i = 0; i < points.length; i++) {
        const j = (i + 1) % points.length;
        const lat1 = points[i].lat * Math.PI / 180;
        const lat2 = points[j].lat * Math.PI / 180;
        const lon1 = points[i].lon * Math.PI / 180;
        const lon2 = points[j].lon * Math.PI / 180;
        area += (lon2 - lon1) * (2 + Math.sin(lat1) + Math.sin(lat2));
    }
    return Math.abs(area * R * R / 2);
}

// ===== 17. حساب الكل =====
function calculateAll() {
    const container = document.getElementById('calcResults');

    if (savedPoints.length < 2) {
        container.innerHTML = '<p class="warn">⚠️ تحتاج نقطتين على الأقل لحساب المسافات</p>';
        return;
    }

    let html = '<div class="calc-card">';

    html += '<h4>📏 المسافات بين النقاط (Vincenty)</h4>';
    let totalDistance = 0;
    for (let i = 0; i < savedPoints.length - 1; i++) {
        const d = vincentyDistance(
            savedPoints[i].lat, savedPoints[i].lon,
            savedPoints[i + 1].lat, savedPoints[i + 1].lon
        );
        totalDistance += d;
        const dStr = d >= 1000 ? (d / 1000).toFixed(4) + ' كم' : d.toFixed(2) + ' م';
        html += `<div class="calc-row"><span>${savedPoints[i].id} ← ${savedPoints[i + 1].id}</span><span class="val">${dStr}</span></div>`;
    }

    const totalStr = totalDistance >= 1000
        ? (totalDistance / 1000).toFixed(4) + ' كم'
        : totalDistance.toFixed(2) + ' م';
    html += `<div class="calc-row total"><span>المسافة الكلية (المحيط)</span><span class="val">${totalStr}</span></div>`;

    const first = savedPoints[0];
    const last = savedPoints[savedPoints.length - 1];
    const direct = vincentyDistance(first.lat, first.lon, last.lat, last.lon);
    const directStr = direct >= 1000 ? (direct / 1000).toFixed(4) + ' كم' : direct.toFixed(2) + ' م';
    html += `<div class="calc-row"><span>المسافة المباشرة (${first.id} ← ${last.id})</span><span class="val">${directStr}</span></div>`;

    if (savedPoints.length >= 3) {
        const area = polygonArea(savedPoints);
        const areaStr = area >= 10000
            ? (area / 10000).toFixed(4) + ' هكتار (' + (area / 1000000).toFixed(6) + ' كم²)'
            : area.toFixed(2) + ' م²';
        html += '<h4 style="margin-top:14px;">📐 المساحة</h4>';
        html += `<div class="calc-row total"><span>مساحة المضلع</span><span class="val">${areaStr}</span></div>`;
        html += `<div class="calc-row"><span>عدد النقاط</span><span class="val">${savedPoints.length}</span></div>`;
    } else {
        html += '<p class="warn" style="margin-top:10px;">⚠️ تحتاج 3 نقاط على الأقل لحساب المساحة</p>';
    }

    html += '</div>';
    container.innerHTML = html;
}

// ===== 18. إعادة الضبط =====
function resetApp() {
    currentLocation = { lat: 0, lon: 0, alt: 0, acc: 0 };
    ['latValue','lonValue','altValue','accValue'].forEach(id => document.getElementById(id).textContent = '--');
    document.getElementById('saveStatus').textContent = '';
    if (window.Android && window.Android.stopTracking) window.Android.stopTracking();
    showScreen('calibrationScreen');
    calibrationProgress = 0;
    document.getElementById('calibrationProgress').style.width = '0%';
    document.getElementById('calibrationStatus').textContent = 'في انتظار الحركة...';
    startCalibration();
}

// ===== 19. إدارة الشاشات =====
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}
function showResults() { showScreen('resultScreen'); }

// ===== 20. بدء التطبيق =====
document.addEventListener('DOMContentLoaded', () => {
    loadPersistedPoints();
    startCalibration();
});
