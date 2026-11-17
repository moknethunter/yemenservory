package com.example.yemensurveyor

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.os.Looper
import android.util.Log
import com.example.yemensurveyor.gps.GnssSatelliteMonitor
import com.example.yemensurveyor.gps.SurveySessionManager
import com.google.android.gms.location.*

class LocationHelper(private val context: Context) {

    private val fusedLocationClient: FusedLocationProviderClient =
        LocationServices.getFusedLocationProviderClient(context)

    private var locationCallback: LocationCallback? = null

    // المحرك الجديد - نفس الإعدادات اللي أرسلتها لك
    private val session = SurveySessionManager()
    private val satMonitor = GnssSatelliteMonitor(context)

    // خام + مصفى للمقارنة والتصدير
    var lastRawLat = 0.0; private set
    var lastRawLng = 0.0; private set
    var lastRawAccuracy = 999f; private set
    var lastFilteredLat = 0.0; private set
    var lastFilteredLng = 0.0; private set
    var lastFilteredAccuracy = 999f; private set
    var lastAltitude = 0.0; private set

    private val locationRequest = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 1000L)
        .setMinUpdateIntervalMillis(500L)
        .setMaxUpdateDelayMillis(1000L)
        .setWaitForAccurateLocation(true)
        .build()

    @SuppressLint("MissingPermission")
    fun startHighAccuracyTracking(onLocation: (Double, Double, Double, Float) -> Unit) {
        stopTracking()
        session.reset()
        satMonitor.start()

        locationCallback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                // القديم كان يأخذ lastLocation فقط، الجديد يعالج كل القراءات
                for (loc in result.locations) {
                    lastRawLat = loc.latitude
                    lastRawLng = loc.longitude
                    lastRawAccuracy = loc.accuracy
                    lastAltitude = loc.altitude

                    val r = session.onLocation(loc)
                    if (!r.accepted) {
                        Log.w("YemenSurveyor", "Rejected: ${r.message} rawAcc=${loc.accuracy}")
                        continue
                    }

                    lastFilteredLat = r.latitude
                    lastFilteredLng = r.longitude
                    lastFilteredAccuracy = r.accuracy

                    // نفس التوقيع القديم، بس نرسل المصفى مو الخام
                    // index.html و MainActivity ما يحتاجون أي تعديل
                    onLocation(r.latitude, r.longitude, loc.altitude, r.accuracy)
                }
            }
        }

        try {
            fusedLocationClient.requestLocationUpdates(
                locationRequest,
                locationCallback!!,
                Looper.getMainLooper()
            )
        } catch (e: SecurityException) {
            e.printStackTrace()
        }
    }

    fun stopTracking() {
        locationCallback?.let {
            fusedLocationClient.removeLocationUpdates(it)
            locationCallback = null
        }
        satMonitor.stop()
    }

    @SuppressLint("MissingPermission")
    fun getLastKnownLocation(): Location? {
        return try {
            fusedLocationClient.lastLocation.result
        } catch (e: Exception) {
            null
        }
    }

    // --- دوال جديدة للـ WebView ---
    fun canSavePoint(): Boolean = session.canSave && satMonitor.isFixReliable
    fun getStability(): String = session.stabilityText
    fun getSatInfo(): String = "${satMonitor.used} قمر | Cn0 ${satMonitor.avgCn0.toInt()} | used=${satMonitor.used} visible=${satMonitor.visible}"
    fun getRawVsFiltered(): String =
        "$lastRawLat,$lastRawLng,$lastRawAccuracy,$lastFilteredLat,$lastFilteredLng,$lastFilteredAccuracy"
}
