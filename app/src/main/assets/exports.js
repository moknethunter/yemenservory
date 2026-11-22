'use strict';

const WGS84 = geodesic.Geodesic.WGS84;
const POINT_COLUMNS = [
    'ID', 'Latitude', 'Longitude', 'Altitude(m)', 'Height datum', 'Accuracy(m)',
    'R95(m)', 'Source', 'Satellites', 'Correction age(s)', 'Base distance(m)', 'True bearing(deg)', 'Base accuracy estimate(m)', 'Transport',
    'Timestamp'
];
const SOURCE_LABELS = {
    FUSED: 'موقع الهاتف المدمج', GNSS: 'أقمار GNSS', NETWORK: 'موقع الشبكة',
    RTK_FIXED: 'RTK ثابت', RTK_FLOAT: 'RTK عائم', RECEIVER: 'مستقبل GNSS',
    IMPORTED: 'مستوردة', LEGACY: 'مسجلة سابقًا'
};

function xml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fixed(value, decimals) {
    return Number.isFinite(value) ? value.toFixed(decimals) : '—';
}

function datumLabel(datum) {
    return ({ ELLIPSOID: 'إهليلجي', MSL: 'مستوى البحر حسب المستقبل' })[datum] || 'مرجع الارتفاع غير محدد';
}

function distance(a, b) {
    return WGS84.Inverse(a.lat, a.lon, b.lat, b.lon).s12;
}

function solveGeometry(points, closed) {
    const segments = [];
    const polygon = WGS84.Polygon(false);
    points.forEach(p => polygon.AddPoint(p.lat, p.lon));
    for (let i = 1; i < points.length; i++) {
        segments.push({ from: i - 1, to: i, meters: distance(points[i - 1], points[i]) });
    }
    const complete = closed && points.length >= 3;
    if (complete) segments.push({ from: points.length - 1, to: 0, meters: distance(points.at(-1), points[0]) });
    return {
        closed: complete, segments, area: complete ? Math.abs(polygon.Compute(false, true).area) : null,
        total: segments.reduce((sum, segment) => sum + segment.meters, 0),
        direct: points.length > 1 ? distance(points[0], points.at(-1)) : null
    };
}

function pointTable(points) {
    return [POINT_COLUMNS, ...points.map(p => [
        p.id, p.lat, p.lon, p.alt, p.datum, p.acc, p.horizontal95, p.source, p.satellites,
        p.correctionAge, p.baseline, p.bearing, p.baseAccuracy, p.relay ? 'RELAY' : p.captureId ? 'DIRECT' : '', p.timestamp
    ])];
}

function buildWorkbook(points) {
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(pointTable(points));
    sheet['!cols'] = [8, 15, 15, 14, 16, 14, 13, 15, 12, 14, 16, 16, 19, 14, 24].map(wch => ({ wch }));
    XLSX.utils.book_append_sheet(book, sheet, 'Points');
    return XLSX.write(book, { type: 'base64', bookType: 'xlsx', compression: true });
}

function buildCsv(points) {
    return '﻿' + XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet(pointTable(points)));
}

function utmGrid(points, requestedZone) {
    const start = points[0];
    if (!start) return null;
    const automatic = Math.min(60, Math.floor((start.lon + 180) / 6) + 1);
    const zone = requestedZone.trim() === '' ? automatic : Number(requestedZone);
    if (!Number.isInteger(zone) || zone < 1 || zone > 60) throw new Error('اختر منطقة UTM بين ١ و٦٠');
    const south = start.lat < 0;
    if (points.some(p => p.lat < -80 || p.lat > 84 || (p.lat < 0) !== south)) {
        throw new Error('اختر نقاطًا تقع في نطاق UTM وفي نصف الكرة نفسه');
    }
    const definition = '+proj=utm +zone=' + zone + (south ? ' +south' : '') + ' +datum=WGS84 +units=m +no_defs';
    const projection = proj4('WGS84', definition);
    const projected = points.map(point => {
        const [east, north] = projection.forward([point.lon, point.lat]);
        if (!Number.isFinite(east) || !Number.isFinite(north)) throw new Error('تعذر إسقاط إحدى النقاط في المنطقة المحددة');
        return { ...point, east, north };
    });
    return { zone, south, epsg: (south ? 32700 : 32600) + zone, points: projected };
}

function buildPnezd(grid) {
    const datum = grid.points[0].datum;
    if (!datum || grid.points.some(p => !Number.isFinite(p.alt) || p.datum !== datum)) {
        throw new Error('يتطلب PNEZD ارتفاعًا معلومًا ومرجع ارتفاع موحّدًا لجميع النقاط. يتوفر DXF أفقيًا وExcel لجميع النقاط.');
    }
    return grid.points.map(p =>
        [p.id, p.north.toFixed(3), p.east.toFixed(3), p.alt.toFixed(3), 'EPSG_' + grid.epsg + '_' + datum].join(',')
    ).join('\r\n') + '\r\n';
}

function buildDxf(grid, closed) {
    const data = [];
    function pair(code, value) { data.push(code, value); }
    pair(0, 'SECTION'); pair(2, 'HEADER');
    pair(9, '$ACADVER'); pair(1, 'AC1015');
    pair(9, '$INSUNITS'); pair(70, 6);
    pair(9, '$MEASUREMENT'); pair(70, 1);
    pair(999, 'WGS 84 / UTM EPSG:' + grid.epsg + '; horizontal grid in metres');
    pair(0, 'ENDSEC');

    pair(0, 'SECTION'); pair(2, 'TABLES');
    pair(0, 'TABLE'); pair(2, 'LAYER'); pair(70, 3);
    for (const [name, color] of [['SURVEY_POINTS', 3], ['SURVEY_IDS', 7], ['SURVEY_OUTLINE', 4]]) {
        pair(0, 'LAYER'); pair(100, 'AcDbSymbolTableRecord'); pair(100, 'AcDbLayerTableRecord');
        pair(2, name); pair(70, 0); pair(62, color); pair(6, 'CONTINUOUS');
    }
    pair(0, 'ENDTAB'); pair(0, 'ENDSEC');

    pair(0, 'SECTION'); pair(2, 'ENTITIES');
    function entity(type, layer, subclass) {
        pair(0, type); pair(100, 'AcDbEntity'); pair(8, layer); pair(100, subclass);
    }
    function xy(point) {
        pair(10, point.east.toFixed(3)); pair(20, point.north.toFixed(3));
    }
    if (grid.points.length >= 2) {
        entity('LWPOLYLINE', 'SURVEY_OUTLINE', 'AcDbPolyline');
        pair(90, grid.points.length); pair(70, closed && grid.points.length >= 3 ? 1 : 0);
        grid.points.forEach(xy);
    }
    for (const point of grid.points) {
        entity('POINT', 'SURVEY_POINTS', 'AcDbPoint');
        xy(point); pair(30, 0);
        entity('TEXT', 'SURVEY_IDS', 'AcDbText');
        xy(point); pair(30, 0); pair(40, 0.35); pair(1, 'P' + point.id);
        pair(100, 'AcDbText'); pair(73, 0);
    }
    pair(0, 'ENDSEC'); pair(0, 'EOF');
    return data.join('\r\n') + '\r\n';
}

function buildKml(points, closed) {
    function coordinates(point) { return point.lon.toFixed(8) + ',' + point.lat.toFixed(8); }
    const location = points.map(p => coordinates(p));
    const marks = points.map((p, index) => {
        const height = Number.isFinite(p.alt) ? fixed(p.alt, 2) + ' م (' + datumLabel(p.datum) + ')' : '—';
        const quality = p.horizontal95 ? 'R95 ' + fixed(p.horizontal95, 3) + ' م' : fixed(p.acc, 3) + ' م';
        return '<Placemark><name>نقطة ' + p.id + '</name><description>' +
            xml(SOURCE_LABELS[p.source] + ' | ' + quality + ' | الارتفاع ' + height) +
            '</description><Point><coordinates>' + location[index] + '</coordinates></Point></Placemark>';
    });
    if (points.length >= 3 && closed) {
        const ring = WGS84.Polygon(false);
        points.forEach(point => ring.AddPoint(point.lat, point.lon));
        if (ring.Compute(false, true).area < 0) location.reverse();
        location.push(location[0]);
        marks.push('<Placemark><name>حدود المسح</name><styleUrl>#outline</styleUrl><Polygon>' +
            '<outerBoundaryIs><LinearRing><coordinates>' + location.join(' ') +
            '</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>');
    } else if (points.length >= 2) {
        marks.push('<Placemark><name>مسار المسح</name><styleUrl>#outline</styleUrl><LineString><tessellate>1</tessellate>' +
            '<coordinates>' + location.join(' ') + '</coordinates></LineString></Placemark>');
    }
    return '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
        '<name>نقاط مسّاح اليمن</name><Style id="outline"><LineStyle><color>ffc1a43a</color><width>3</width></LineStyle>' +
        '<PolyStyle><color>37c1a43a</color></PolyStyle></Style>' + marks.join('') + '</Document></kml>';
}
