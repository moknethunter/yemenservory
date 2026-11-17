package com.example.yemensurveyor.gps
import android.location.Location
class SurveySessionManager {
    private val engine = GpsQualityEngine()
    private var stableCount = 0
    private var last: GpsResult? = null
    fun onLocation(loc: Location): GpsResult {
        val r = engine.process(loc)
        if (r.accepted) {
            val p = last
            if (p != null) {
                val d = FloatArray(1)
                Location.distanceBetween(p.latitude, p.longitude, r.latitude, r.longitude, d)
                stableCount = if (d[0] < 1.5f) stableCount + 1 else 0
            } else stableCount = 1
            last = r
        }
        return r
    }
    val canSave: Boolean get() = stableCount >= 8
    val stabilityText: String get() = "$stableCount / 8"
    fun reset() { engine.reset(); stableCount = 0; last = null }
}
