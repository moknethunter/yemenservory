package com.example.yemensurveyor.survey

/**
 * Pairs GGA and GST from the same receiver epoch. A GST horizontal radius is a
 * model-based estimate, so it is kept separate from phone provider accuracy.
 */
class NmeaRtk {
    private data class Gga(val time: Int, val fix: SurveyFix)

    private var lastTime: Int? = null
    private var gga: Gga? = null
    private var gst: Pair<Int, Double>? = null
    private var lastEvaluated: Int? = null
    private val strictRun = ArrayDeque<SurveyFix>()
    private val receiverRun = ArrayDeque<SurveyFix>()

    var lostFix: Boolean = false
        private set

    fun accept(line: String, now: Long): SurveyFix? {
        lostFix = false
        val fields = fields(line) ?: return null
        val time = fields.getOrNull(1)?.let(::epoch) ?: return null
        return when (fields[0].takeLast(3)) {
            "GGA" -> {
                if (lastTime?.let { forwardMillis(it, time) !in 1..43_200_000 } == true) return null
                if (lastTime != lastEvaluated) strictRun.clear()
                lastTime = time
                val fix = parseGga(fields, now)
                gga = fix?.let { Gga(time, it) }
                if (fix == null) {
                    strictRun.clear()
                    receiverRun.clear()
                    lostFix = true
                    return null
                }
                if (fix.source != FixSource.RTK_FIXED || fix.correctionAge == null ||
                    fix.correctionAge !in 0.0..MAX_CORRECTION_AGE) strictRun.clear()
                val fallback = updateRun(receiverRun, fix, 1.5)
                val sigma = gst?.takeIf { it.first == time }?.second
                if (sigma != null) evaluate(time, fallback, sigma) else fallback
            }
            "GST" -> {
                val sigma = parseGst(fields) ?: return null
                gst = time to sigma
                val pending = gga?.takeIf { it.time == time && it.fix.isFresh(now) }
                    ?: return null
                evaluate(time, pending.fix.copy(stable = receiverRun.size >= 3), sigma)
            }
            else -> null
        }
    }

    private fun evaluate(time: Int, fix: SurveyFix, horizontal95: Double): SurveyFix? {
        if (lastEvaluated == time) return null
        lastEvaluated = time
        val measured = fix.copy(horizontal95 = horizontal95)
        if (!measured.meetsRtkTarget()) {
            strictRun.clear()
            return measured
        }
        return updateRun(strictRun, measured, RTK_HORIZONTAL_TARGET)
    }

    private fun updateRun(run: ArrayDeque<SurveyFix>, fix: SurveyFix, radius: Double): SurveyFix {
        while (run.isNotEmpty() && fix.sampledAt - run.first().sampledAt > 3_000) run.removeFirst()
        if (run.any { it.position.distanceTo(fix.position) > radius || it.source != fix.source }) run.clear()
        if (run.size >= 80) run.removeFirst()
        run.addLast(fix)
        return fix.copy(stable = run.size >= 3 && fix.sampledAt - run.first().sampledAt >= 900L)
    }

    private fun parseGga(fields: List<String>, now: Long): SurveyFix? {
        val quality = fields.getOrNull(6)?.toIntOrNull() ?: return null
        if (quality !in 1..5) return null
        val lat = angle(fields.getOrNull(2), fields.getOrNull(3), true) ?: return null
        val lon = angle(fields.getOrNull(4), fields.getOrNull(5), false) ?: return null
        val satellites = fields.getOrNull(7)?.toIntOrNull()?.coerceIn(0, 99) ?: 0
        val elevation = fields.getOrNull(9)?.finiteNumber()?.takeIf { fields.getOrNull(10) == "M" }
        val source = when (quality) {
            4 -> FixSource.RTK_FIXED
            5 -> FixSource.RTK_FLOAT
            else -> FixSource.RECEIVER
        }
        return SurveyFix(
            Position(lat, lon), elevation, elevation?.let { HeightDatum.MSL }, null,
            source, now, satellites, correctionAge = fields.getOrNull(13)?.finiteNumber()?.takeIf { it >= 0 }
        )
    }

    private fun parseGst(fields: List<String>): Double? {
        val major = fields.getOrNull(3)?.finiteNumber()?.takeIf { it > 0 }
        val lat = fields.getOrNull(6)?.finiteNumber()?.takeIf { it > 0 }
        val lon = fields.getOrNull(7)?.finiteNumber()?.takeIf { it > 0 }
        val bound = if (major != null) maxOf(major, lat ?: 0.0, lon ?: 0.0)
            else Math.hypot(lat ?: return null, lon ?: return null)
        return (bound * 2.4477468307).takeIf(Double::isFinite)
    }

    private fun angle(raw: String?, hemisphere: String?, latitude: Boolean): Double? {
        if (raw == null || !raw.matches(if (latitude) LATITUDE else LONGITUDE)) return null
        val degrees = raw.take(if (latitude) 2 else 3).toInt()
        val minutes = raw.drop(if (latitude) 2 else 3).toDouble()
        val limit = if (latitude) 90 else 180
        if (degrees > limit || minutes >= 60 || (degrees == limit && minutes > 0)) return null
        val sign = if (latitude) {
            when (hemisphere) { "N" -> 1; "S" -> -1; else -> return null }
        } else {
            when (hemisphere) { "E" -> 1; "W" -> -1; else -> return null }
        }
        return sign * (degrees + minutes / 60.0)
    }

    private fun epoch(raw: String): Int? {
        if (!raw.matches(TIME)) return null
        val hour = raw.substring(0, 2).toInt()
        val minute = raw.substring(2, 4).toInt()
        val second = raw.substring(4, 6).toInt()
        if (hour > 23 || minute > 59 || second > 59) return null
        val fraction = raw.substringAfter('.', "").take(3).padEnd(3, '0').toInt()
        return ((hour * 60 + minute) * 60 + second) * 1000 + fraction
    }

    private fun forwardMillis(from: Int, to: Int): Int = (to - from + 86_400_000) % 86_400_000

    private fun fields(line: String): List<String>? {
        val star = line.indexOf('*')
        if (!line.startsWith('$') || star < 6 || star + 3 != line.length ||
            !line.substring(1, 6).matches(TALKER)) return null
        val payload = line.substring(1, star)
        val calculated = payload.fold(0) { sum, char -> sum xor char.code }
        if (calculated != line.substring(star + 1).toIntOrNull(16)) return null
        return payload.split(',')
    }

    private fun String.finiteNumber(): Double? = toDoubleOrNull()?.takeIf(Double::isFinite)

    private companion object {
        val LATITUDE = Regex("[0-9]{4}(\\.[0-9]+)?")
        val LONGITUDE = Regex("[0-9]{5}(\\.[0-9]+)?")
        val TIME = Regex("[0-9]{6}(\\.[0-9]+)?")
        val TALKER = Regex("[A-Z]{2}(GGA|GST)")
    }
}
