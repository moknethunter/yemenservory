package com.example.yemensurveyor.gps
import kotlin.math.pow
import kotlin.math.sqrt
class KalmanFilter2D(private var qMeters: Double = 0.8) {
    private var lat = 0.0; private var lng = 0.0
    private var variance = -1.0; private var lastTimeMs = 0L
    fun reset() { variance = -1.0; lastTimeMs = 0L }
    fun process(latIn: Double, lngIn: Double, accuracy: Float, timeMs: Long): Pair<Double, Double> {
        if (variance < 0) {
            lat = latIn; lng = lngIn
            variance = accuracy.toDouble().pow(2.0)
            lastTimeMs = timeMs
            return lat to lng
        }
        val dtSec = ((timeMs - lastTimeMs).coerceAtLeast(0) / 1000.0).coerceAtMost(10.0)
        lastTimeMs = timeMs
        variance += (qMeters * qMeters) * dtSec
        val r = accuracy.toDouble().pow(2.0).coerceAtLeast(1.0)
        val k = variance / (variance + r)
        lat += k * (latIn - lat); lng += k * (lngIn - lng)
        variance = (1 - k) * variance
        return lat to lng
    }
    val estimatedAccuracy: Float get() = if (variance < 0) 999f else sqrt(variance).toFloat()
}
