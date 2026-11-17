package com.example.yemensurveyor.gps
import android.location.Location
import kotlin.math.pow
data class GpsResult(
    val accepted: Boolean,
    val latitude: Double, val longitude: Double,
    val rawLat: Double, val rawLng: Double,
    val accuracy: Float, val message: String, val usedCount: Int
)
class GpsQualityEngine(
    private val maxAccuracy: Float = 12f,
    private val windowSize: Int = 15,
    private val maxSpeedMps: Float = 12f
) {
    private val kalman = KalmanFilter2D()
    private val window = ArrayDeque<Location>()
    private var lastAccepted: Location? = null
    fun reset() { window.clear(); lastAccepted = null; kalman.reset() }
    fun process(loc: Location): GpsResult {
        val now = System.currentTimeMillis()
        if (now - loc.time > 5000) return reject(loc, "قديمة")
        if (!loc.hasAccuracy() || loc.accuracy > maxAccuracy || loc.accuracy <= 0f)
            return reject(loc, "دقة ضعيفة ${loc.accuracy}m")
        lastAccepted?.let { prev ->
            val dist = prev.distanceTo(loc)
            val dt = ((loc.time - prev.time) / 1000f).coerceAtLeast(0.5f)
            if (dist / dt > maxSpeedMps && dist > 25) return reject(loc, "قفزة ${dist.toInt()}m")
        }
        window.addLast(loc)
        if (window.size > windowSize) window.removeFirst()
        val sLat = window.map { it.latitude }.sorted()
        val sLng = window.map { it.longitude }.sorted()
        val medianLat = sLat[sLat.size / 2]
        val medianLng = sLng[sLng.size / 2]
        var sumW = 0.0; var sumLat = 0.0; var sumLng = 0.0
        for (l in window) {
            val w = 1.0 / (l.accuracy.toDouble().pow(2.0) + 0.5)
            sumW += w; sumLat += l.latitude * w; sumLng += l.longitude * w
        }
        val fusedLat = (medianLat + sumLat / sumW) / 2.0
        val fusedLng = (medianLng + sumLng / sumW) / 2.0
        val (kLat, kLng) = kalman.process(fusedLat, fusedLng, loc.accuracy, loc.time)
        lastAccepted = loc
        return GpsResult(true, kLat, kLng, loc.latitude, loc.longitude, kalman.estimatedAccuracy, "OK ${window.size}", window.size)
    }
    private fun reject(loc: Location, msg: String) = GpsResult(false, 0.0, 0.0, loc.latitude, loc.longitude, loc.accuracy, msg, window.size)
}
