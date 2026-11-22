package com.example.yemensurveyor.survey

import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.util.UUID

private const val PEER_TIMEOUT = 12_000L
private const val CAPTURE_TIMEOUT = 32_000L
private const val MAX_STATIONS = 12

enum class SurveyRole { REFERENCE, ROVER }

class SurveyHost(joinPage: ByteArray) : Closeable {
    private data class Station(
        val id: String, val name: String, val updatedAt: Long, val sequence: Long,
        val role: SurveyRole? = null, val fix: SurveyFix? = null, val control: Position? = null,
        val initialPosition: Position? = null, val relayPort: Int = 0,
        val relayAddresses: List<String> = emptyList(), val via: String = ""
    )

    private data class Shot(
        val id: String,
        val rover: String,
        val requestedAt: Long,
        val base: Position,
        val baseUncertainty: Double?,
        val requireRtk: Boolean,
        val participants: Set<String>,
        val readings: MutableMap<String, Pair<Station, SurveyFix>> = mutableMapOf(),
        var roverReceivedAt: Long? = null
    )

    private val key = SessionCipher.key()
    private val cipher = SessionCipher(key)
    private val peers = mutableMapOf<String, Station>()
    private val waypoints = mutableMapOf<String, Position>()
    private var pending: Shot? = null
    private var result: JSONObject? = null
    private var completed: JSONArray? = null
    private var feedback: String = ""
    private var closed = false
    private val endpoint = LanEndpoint(joinPage, ::exchange)

    fun invite(ip: String): String? = Invitation.create(ip, endpoint.port, key)?.webLink()

    @Synchronized
    fun assign(id: String, role: SurveyRole): Boolean {
        val station = peers[id] ?: return false
        if (!station.connected(SystemClock.elapsedRealtime())) return false
        if (station.role == role) return true
        peers[id] = station.copy(role = role, fix = null, initialPosition = null, relayPort = 0, relayAddresses = emptyList())
        waypoints.remove(id)
        if (pending?.participants?.contains(id) == true) cancelCapture()
        return true
    }

    @Synchronized
    fun capture(rover: String, control: Position?, baseFix: SurveyFix?, requireRtk: Boolean): String {
        val now = SystemClock.elapsedRealtime()
        settleShot(now)
        if (pending != null || result != null) return "انتظر اكتمال عملية الرفع السابقة"
        val station = peers[rover]
        if (station?.role != SurveyRole.ROVER || !station.connected(now)) return "اختر هاتفًا متحركًا متصلًا"
        val base = control ?: baseFix?.takeIf { it.canCapture(now, requireRtk) }?.position
            ?: return if (requireRtk) "أدخل إحداثيات المحطة المعروفة أو أوصل بها مستقبل RTK مستقرًا"
                else "ثبّت المحطة وانتظر استقرار موقعها أو أدخل إحداثياتها المعروفة"
        val baseUncertainty = if (control != null) null else baseFix?.let { it.horizontal95 ?: it.accuracy }
        val participants = peers.values.filter { it.role != null && it.connected(now) }.map { it.id }.toSet()
        pending = Shot(UUID.randomUUID().toString(), rover, now, base, baseUncertainty, requireRtk, participants)
        completed = null
        feedback = "أُرسلت إشارة القياس للأجهزة. ثبّت الهاتف المتحرك على النقطة."
        return feedback
    }

    @Synchronized
    fun setStakeout(rover: String, target: Position?): Boolean {
        val station = peers[rover] ?: return false
        if (station.role != SurveyRole.ROVER || !station.connected(SystemClock.elapsedRealtime())) return false
        if (target == null) waypoints.remove(rover) else waypoints[rover] = target
        return true
    }

    @Synchronized
    fun cancelCapture() {
        if (pending != null) {
            pending = null
            feedback = "أُلغي طلب القياس"
        }
    }

    @Synchronized
    fun acknowledge(id: String) {
        if (result?.optString("captureId") == id) result = null
    }

    @Synchronized
    fun status(base: Position?): JSONObject {
        val now = SystemClock.elapsedRealtime()
        settleShot(now)
        val stations = peers.values.filter { it.connected(now) }.map { peer ->
            stationJson(peer, peer.fix?.takeIf { it.isFresh(now) }, base, now)
        }
        return JSONObject().put("peers", JSONArray(stations)).put("capture", result ?: JSONObject.NULL)
            .put("lastShot", completed ?: JSONObject.NULL).put("busy", pending != null).put("message", feedback)
    }

    private fun Station.connected(now: Long): Boolean = now - updatedAt <= PEER_TIMEOUT

    private fun stationJson(peer: Station, fix: SurveyFix?, base: Position?, now: Long): JSONObject {
        val measurement = if (base != null && fix != null) base.observe(fix.position) else null
        val residual = if (fix != null) peer.control?.distanceTo(fix.position) else null
        val drift = if (fix != null) peer.initialPosition?.distanceTo(fix.position) else null
        return JSONObject().put("id", peer.id).put("name", peer.name).put("role", peer.role?.name ?: JSONObject.NULL)
            .put("fix", fix?.toJson(now) ?: JSONObject.NULL).put("range", measurement?.meters ?: JSONObject.NULL)
            .put("bearing", measurement?.bearing ?: JSONObject.NULL).put("relay", peer.via)
            .put("residual", residual ?: JSONObject.NULL).put("drift", drift ?: JSONObject.NULL)
    }

    private fun settleShot(now: Long) {
        val shot = pending ?: return
        val elapsed = now - shot.requestedAt
        val mover = shot.readings[shot.rover]
        if (mover == null && elapsed <= CAPTURE_TIMEOUT) return
        val waiting = shot.participants.size - shot.readings.size
        if (mover != null && waiting > 0 && elapsed <= CAPTURE_TIMEOUT &&
            now - (shot.roverReceivedAt ?: now) < 2_300) return

        pending = null
        completed = JSONArray(shot.participants.map { id ->
            val observation = shot.readings[id]
            val station = observation?.first ?: peers[id]
            station?.let { stationJson(it, observation?.second, shot.base, now) }
        }.filterNotNull())
        if (mover == null) {
            feedback = "انتهت المهلة قبل وصول قراءة مستوفية لشروط الجهاز المتحرك"
            return
        }
        val (station, fix) = mover
        val observation = shot.base.observe(fix.position)
        result = fix.toJson(now).put("captureId", shot.id).put("station", station.name)
            .put("baseline", observation.meters).put("bearing", observation.bearing ?: JSONObject.NULL)
            .put("baseAccuracy", shot.baseUncertainty ?: JSONObject.NULL)
            .put("relay", station.via).put("strict", shot.requireRtk)
        feedback = "استُلمت قراءة النقطة من ${station.name} · ردّت ${shot.readings.size} من ${shot.participants.size} أجهزة"
    }

    private fun exchange(encrypted: String): String {
        val request = cipher.decrypt(encrypted, "request")
        val requestId = UUID.fromString(request.getString("request"))
        return cipher.encrypt(process(request), "response/$requestId")
    }

    @Synchronized
    private fun process(message: JSONObject): JSONObject {
        require(!closed)
        val id = UUID.fromString(message.getString("id")).toString()
        val sequence = message.getLong("seq")
        val name = message.getString("name").trim().take(40).ifBlank { "هاتف ميداني" }
        val now = SystemClock.elapsedRealtime()
        settleShot(now)
        peers.entries.removeAll {
            val expired = it.value.role == null && now - it.value.updatedAt > 120_000
            if (expired) waypoints.remove(it.key)
            expired
        }
        val old = peers[id]
        require(sequence > (old?.sequence ?: 0))
        require(old != null || peers.size < MAX_STATIONS)
        val role = old?.role
        val reading = if (role != null) message.optJSONObject("fix")?.fix(now) else null
        val isReference = role == SurveyRole.REFERENCE
        val control = if (isReference) message.optJSONObject("control")?.position() else null
        val initial = if (isReference) old?.initialPosition
            ?: reading?.takeIf { it.canCapture(now, false) }?.position else null
        val relayAddresses = if (isReference) message.optJSONArray("relayIps")?.let { items ->
            (0 until minOf(8, items.length())).map { items.optString(it) }.filter(::isPrivateIp).distinct()
        }.orEmpty() else emptyList()
        val relayPort = if (isReference) message.optInt("relayPort").takeIf { it in 1024..65535 } ?: 0 else 0
        val via = peers[message.optString("via")]?.takeIf { it.role == SurveyRole.REFERENCE && it.connected(now) }?.name.orEmpty()
        val peer = Station(id, name, now, sequence, role, reading, control, initial, relayPort, relayAddresses, via)
        peers[id] = peer

        val shot = pending
        if (shot != null && id in shot.participants && id !in shot.readings && reading != null &&
            message.optString("capture") == shot.id && reading.sampledAt >= shot.requestedAt &&
            (id != shot.rover || reading.canCapture(now, shot.requireRtk))) {
            shot.readings[id] = peer to reading
            if (id == shot.rover) shot.roverReceivedAt = now
            settleShot(now)
        }
        val next = pending?.takeIf { id in it.participants && id !in it.readings }
        val relays = peers.values.filter {
            it.id != id && it.role == SurveyRole.REFERENCE && it.connected(now) && it.relayPort != 0 &&
                it.relayAddresses.isNotEmpty() && it.via.isBlank()
        }.map { anchor ->
            JSONObject().put("id", anchor.id).put("name", anchor.name).put("port", anchor.relayPort)
                .put("ips", JSONArray(anchor.relayAddresses))
                .put("position", anchor.fix?.takeIf { it.isFresh(now) }?.position?.toJson() ?: JSONObject.NULL)
        }
        return JSONObject().put("command", next?.let {
            JSONObject().put("id", it.id).put("strict", it.requireRtk).put("rover", id == it.rover)
        } ?: JSONObject.NULL).put("role", role?.name ?: JSONObject.NULL)
            .put("relays", JSONArray(relays)).put("target", waypoints[id]?.toJson() ?: JSONObject.NULL)
    }

    @Synchronized
    override fun close() {
        closed = true
        endpoint.close()
    }
}
