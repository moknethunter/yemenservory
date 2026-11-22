package com.example.yemensurveyor.survey

import android.content.Context
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class SurveyGuest(
    private val context: Context,
    private val invitation: Invitation,
    private val name: String,
    private val control: Position?
) : Closeable {
    private data class Relay(
        val id: String, val name: String, val port: Int, val ips: List<String>, val position: Position?
    )
    private data class Command(val id: String, val receivedAt: Long, val strict: Boolean, val rover: Boolean)

    private val id = UUID.randomUUID().toString()
    private val worker = Executors.newSingleThreadScheduledExecutor { job ->
        Thread(job, "survey-companion").apply { isDaemon = true }
    }
    @Volatile var reading: SurveyFix? = null
    @Volatile private var closed = false
    @Volatile private var paused = false
    @Volatile var status: String = "جاري الاتصال بالمحطة الرئيسية…"
        private set
    @Volatile var target: Position? = null
        private set
    @Volatile var assignedRole: SurveyRole? = null
        private set

    private var sequence = 0L
    private var command: Command? = null
    private var relays = emptyList<Relay>()
    private var relay: LanEndpoint? = null
    private var publishedIps = emptyList<String>()
    private var refreshedAt = 0L

    init {
        worker.scheduleWithFixedDelay({ runCatching { exchangeWithHost() } }, 0, 700, TimeUnit.MILLISECONDS)
    }

    private fun exchangeWithHost() {
        if (closed || paused) return
        val now = SystemClock.elapsedRealtime()
        val current = reading?.takeIf { assignedRole != null && it.isFresh(now) }
        val pending = command
        val capture = pending?.takeIf {
            current != null && current.sampledAt > it.receivedAt &&
                (!it.rover || current.canCapture(now, it.strict))
        }?.id

        fun packet(): JSONObject = JSONObject().put("id", id).put("name", name).put("seq", ++sequence)
            .put("fix", current?.toJson(SystemClock.elapsedRealtime()) ?: JSONObject.NULL)
            .put("control", control?.toJson() ?: JSONObject.NULL).put("capture", capture ?: JSONObject.NULL)
            .put("relayPort", relay?.port ?: 0).put("relayIps", JSONArray(publishedIps))

        var response = runCatching { exchange(context, invitation, packet()) }.getOrNull()
        var byRelay = ""
        if (response == null && assignedRole == SurveyRole.ROVER) {
            val ordered = relays.sortedBy { relay ->
                if (current == null || relay.position == null) Double.POSITIVE_INFINITY
                else current.position.distanceTo(relay.position)
            }
            for (candidate in ordered.take(4)) {
                for (ip in candidate.ips) {
                    if (closed) return
                    response = runCatching {
                        exchange(context, invitation, packet().put("via", candidate.id), ip, candidate.port)
                    }.getOrNull()
                    if (response != null) {
                        byRelay = candidate.name
                        break
                    }
                }
                if (response != null) break
            }
        }
        if (response == null) {
            target = null
            status = "تعذر الاتصال المباشر أو الترحيل. تحقق من شبكة Wi-Fi."
            return
        }

        if (closed || paused) return
        assignedRole = SurveyRole.entries.firstOrNull { it.name == response.optString("role") }
        configureRelay()
        relays = response.optJSONArray("relays")?.let(::decodeRelays).orEmpty()
        target = runCatching { response.optJSONObject("target")?.position() }.getOrNull()
        val newCommand = response.optJSONObject("command")
        val nextId = newCommand?.getString("id")
        if (nextId != pending?.id) command = newCommand?.let {
            Command(it.getString("id"), SystemClock.elapsedRealtime(), it.optBoolean("strict"), it.optBoolean("rover"))
        }
        status = when {
            assignedRole == null -> "متصل. يعيّن مشغّل المحطة دور هذا الهاتف."
            nextId == null && capture != null -> "استلمت المحطة قراءة الجهاز"
            newCommand?.optBoolean("rover") == true && newCommand.optBoolean("strict") -> "ثبّت المستقبل على النقطة. المطلوب RTK ثابت ≤ ٥ سم."
            newCommand?.optBoolean("rover") == true -> "وصلت إشارة القياس. ثبّت الهاتف على النقطة."
            nextId != null -> "وصلت إشارة التحقق من الإحداثيات"
            assignedRole == SurveyRole.REFERENCE -> "متصل · مرجع ثابت وترحيل متاح"
            else -> "متصل · هاتف متحرك"
        } + if (byRelay.isBlank()) "" else " · عبر $byRelay"
    }

    @Synchronized
    private fun configureRelay() {
        if (closed || assignedRole != SurveyRole.REFERENCE) {
            relay?.close()
            relay = null
            publishedIps = emptyList()
            return
        }
        if (relay == null) relay = runCatching {
            LanEndpoint { encrypted -> forward(context, invitation.ip, invitation.port, encrypted) }
        }.getOrNull()
        val now = SystemClock.elapsedRealtime()
        if (now - refreshedAt >= 3_000 || publishedIps.isEmpty()) {
            publishedIps = localAddresses().map { it.ip }.take(4)
            refreshedAt = now
        }
    }

    private fun decodeRelays(array: JSONArray): List<Relay> = (0 until minOf(12, array.length())).mapNotNull { index ->
        runCatching {
            val anchor = array.getJSONObject(index)
            val addresses = anchor.getJSONArray("ips")
            val ips = (0 until minOf(4, addresses.length())).map { addresses.getString(it) }.filter(::isPrivateIp)
            Relay(anchor.getString("id"), anchor.getString("name"), anchor.getInt("port"), ips,
                anchor.optJSONObject("position")?.position())
        }.getOrNull()
    }

    fun pause() {
        paused = true
        reading = null
    }

    fun resume() {
        paused = false
    }

    @Synchronized
    override fun close() {
        closed = true
        worker.shutdownNow()
        relay?.close()
        relay = null
        reading = null
    }
}
