package com.example.yemensurveyor.survey

import net.sf.geographiclib.Geodesic

const val RTK_HORIZONTAL_TARGET = 0.05
const val MAX_CORRECTION_AGE = 5.0
const val FIX_LIFETIME_MS = 5_000L

data class Position(val lat: Double, val lon: Double) {
    init {
        require(lat in -90.0..90.0 && lon in -180.0..180.0)
    }

    fun distanceTo(other: Position): Double = Geodesic.WGS84.Inverse(lat, lon, other.lat, other.lon).s12

    fun observe(other: Position): Observation {
        val inverse = Geodesic.WGS84.Inverse(lat, lon, other.lat, other.lon)
        return Observation(inverse.s12, ((inverse.azi1 + 360) % 360).takeIf { inverse.s12 >= 0.001 })
    }
}

data class Observation(val meters: Double, val bearing: Double?)

enum class FixSource { FUSED, GNSS, NETWORK, RTK_FIXED, RTK_FLOAT, RECEIVER }

enum class HeightDatum { ELLIPSOID, MSL }

data class SurveyFix(
    val position: Position,
    val altitude: Double?,
    val datum: HeightDatum?,
    val accuracy: Double?,
    val source: FixSource,
    val sampledAt: Long,
    val satellites: Int = 0,
    val stable: Boolean = false,
    val correctionAge: Double? = null,
    val horizontal95: Double? = null
) {
    fun isFresh(now: Long): Boolean = now - sampledAt in 0..FIX_LIFETIME_MS

    fun meetsRtkTarget(): Boolean = source == FixSource.RTK_FIXED &&
        horizontal95 != null && horizontal95 > 0 && horizontal95 <= RTK_HORIZONTAL_TARGET &&
        correctionAge != null && correctionAge in 0.0..MAX_CORRECTION_AGE

    fun canCapture(now: Long, requireRtk: Boolean): Boolean =
        isFresh(now) && stable && if (requireRtk) {
            meetsRtkTarget()
        } else {
            accuracy?.let { it > 0 } == true || horizontal95?.let { it > 0 } == true
        }
}
